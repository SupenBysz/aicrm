package deviceauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	SignatureDomain = "AICRM-DEVICE-V1"
	ClockWindow     = 5 * time.Minute

	HeaderDeviceID      = "X-AiCRM-Device-Id"
	HeaderTimestamp     = "X-AiCRM-Device-Timestamp"
	HeaderNonce         = "X-AiCRM-Device-Nonce"
	HeaderSequence      = "X-AiCRM-Device-Sequence"
	HeaderContentSHA256 = "X-AiCRM-Content-SHA256"
	HeaderSignature     = "X-AiCRM-Device-Signature"
)

var (
	ErrInvalidHeader          = errors.New("invalid device proof header")
	ErrInvalidMethod          = errors.New("invalid canonical method")
	ErrInvalidCanonicalPath   = errors.New("invalid canonical path")
	ErrInvalidNonce           = errors.New("invalid device nonce")
	ErrInvalidDigest          = errors.New("invalid SHA-256 digest")
	ErrBodyHashMismatch       = errors.New("request body hash mismatch")
	ErrInvalidAuthorization   = errors.New("invalid authorization header")
	ErrAuthorizationScheme    = errors.New("authorization scheme is not allowed")
	ErrTimestampOutsideWindow = errors.New("device timestamp outside allowed window")
)

var (
	canonicalMethodPattern     = regexp.MustCompile(`^[A-Z]+$`)
	canonicalSegmentPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	authorizationSchemePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]*$`)
)

// ProofHeaders is the canonical safe subset parsed from the six required
// X-AiCRM device headers. Signature is raw bytes and is never serialized.
type ProofHeaders struct {
	DeviceID       string
	TimestampMilli int64
	Nonce          string
	Sequence       uint64
	BodySHA256     string
	Signature      []byte
}

type VerifyInput struct {
	PublicKey                   string
	Method                      string
	RequestTarget               string
	Headers                     http.Header
	Body                        []byte
	AllowedAuthorizationSchemes []string
	Now                         time.Time
}

// VerifiedRequest contains only values safe and necessary for the persistent
// replay ledger. It intentionally excludes the raw Authorization header,
// ticket, body, public key, and signature.
type VerifiedRequest struct {
	DeviceID               string
	TimestampMilli         int64
	Nonce                  string
	Sequence               uint64
	BodySHA256             string
	AuthorizationTokenHash string
	CanonicalMethod        string
	CanonicalPath          string
	RequestHash            string
}

func ParseProofHeaders(headers http.Header) (ProofHeaders, error) {
	deviceID, err := singleHeader(headers, HeaderDeviceID, true)
	if err != nil || ValidateDeviceID(deviceID) != nil {
		return ProofHeaders{}, fmt.Errorf("%w: device ID", ErrInvalidHeader)
	}

	timestampText, err := singleHeader(headers, HeaderTimestamp, true)
	if err != nil {
		return ProofHeaders{}, fmt.Errorf("%w: timestamp", ErrInvalidHeader)
	}
	timestamp, err := strconv.ParseInt(timestampText, 10, 64)
	if err != nil || timestamp <= 0 || strconv.FormatInt(timestamp, 10) != timestampText {
		return ProofHeaders{}, fmt.Errorf("%w: timestamp", ErrInvalidHeader)
	}

	nonce, err := singleHeader(headers, HeaderNonce, true)
	if err != nil || ValidateNonce(nonce) != nil {
		return ProofHeaders{}, fmt.Errorf("%w: nonce", ErrInvalidHeader)
	}

	sequenceText, err := singleHeader(headers, HeaderSequence, true)
	if err != nil {
		return ProofHeaders{}, fmt.Errorf("%w: sequence", ErrInvalidHeader)
	}
	sequence, err := strconv.ParseUint(sequenceText, 10, 64)
	if err != nil || sequence == 0 || strconv.FormatUint(sequence, 10) != sequenceText {
		return ProofHeaders{}, fmt.Errorf("%w: sequence", ErrInvalidHeader)
	}

	bodyHash, err := singleHeader(headers, HeaderContentSHA256, true)
	if err != nil || validateDigest(bodyHash, false) != nil {
		return ProofHeaders{}, fmt.Errorf("%w: content digest", ErrInvalidHeader)
	}

	signatureText, err := singleHeader(headers, HeaderSignature, true)
	if err != nil {
		return ProofHeaders{}, fmt.Errorf("%w: signature", ErrInvalidHeader)
	}
	signature, err := ParseSignature(signatureText)
	if err != nil {
		return ProofHeaders{}, fmt.Errorf("%w: signature", ErrInvalidHeader)
	}

	return ProofHeaders{
		DeviceID:       deviceID,
		TimestampMilli: timestamp,
		Nonce:          nonce,
		Sequence:       sequence,
		BodySHA256:     bodyHash,
		Signature:      signature,
	}, nil
}

func ValidateNonce(nonce string) error {
	raw, err := base64.RawURLEncoding.DecodeString(nonce)
	if err != nil || len(raw) != 16 || base64.RawURLEncoding.EncodeToString(raw) != nonce {
		return ErrInvalidNonce
	}
	return nil
}

// CanonicalMethod rejects lowercase or normalized method aliases.
func CanonicalMethod(method string) (string, error) {
	if method == "" || len(method) > 16 || !canonicalMethodPattern.MatchString(method) {
		return "", ErrInvalidMethod
	}
	return method, nil
}

// CanonicalPath validates the original ASCII request-target path without URL
// decoding or normalization. Every segment follows the locked resource-ID
// alphabet, which also covers the static route segments used by the API.
func CanonicalPath(requestTarget string) (string, error) {
	if len(requestTarget) < 2 || len(requestTarget) > 2048 || requestTarget[0] != '/' || strings.HasSuffix(requestTarget, "/") {
		return "", ErrInvalidCanonicalPath
	}
	for index := 0; index < len(requestTarget); index++ {
		if requestTarget[index] < 0x21 || requestTarget[index] > 0x7e {
			return "", ErrInvalidCanonicalPath
		}
	}
	if strings.ContainsAny(requestTarget, "?#+%\\") {
		return "", ErrInvalidCanonicalPath
	}
	for _, segment := range strings.Split(requestTarget[1:], "/") {
		if segment == "" || segment == "." || segment == ".." || len(segment) > 160 || !canonicalSegmentPattern.MatchString(segment) {
			return "", ErrInvalidCanonicalPath
		}
	}
	return requestTarget, nil
}

func HashBody(body []byte) string {
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

// AuthorizationTokenHash hashes only the raw ASCII bytes after the scheme.
// An empty header produces the contract's empty string. Non-empty headers are
// accepted only for an endpoint-provided scheme allowlist.
func AuthorizationTokenHash(authorization string, allowedSchemes []string) (string, error) {
	if authorization == "" {
		return "", nil
	}
	if len(authorization) > 8192 || strings.TrimSpace(authorization) != authorization {
		return "", ErrInvalidAuthorization
	}
	scheme, token, found := strings.Cut(authorization, " ")
	if !found || !authorizationSchemePattern.MatchString(scheme) || token == "" || strings.ContainsAny(token, " \t\r\n") {
		return "", ErrInvalidAuthorization
	}
	for index := 0; index < len(token); index++ {
		if token[index] < 0x21 || token[index] > 0x7e {
			return "", ErrInvalidAuthorization
		}
	}
	allowed := false
	for _, candidate := range allowedSchemes {
		if authorizationSchemePattern.MatchString(candidate) && strings.EqualFold(candidate, scheme) {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", ErrAuthorizationScheme
	}
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:]), nil
}

// SigningInput returns exactly eight newline-delimited UTF-8 fields with no
// trailing newline, as locked in authorization requirements section 20.3.
func SigningInput(method, path string, proof ProofHeaders, authorizationTokenHash string) ([]byte, error) {
	canonicalMethod, err := CanonicalMethod(method)
	if err != nil {
		return nil, err
	}
	canonicalPath, err := CanonicalPath(path)
	if err != nil {
		return nil, err
	}
	if err := ValidateDeviceID(proof.DeviceID); err != nil {
		return nil, err
	}
	if proof.TimestampMilli <= 0 || proof.Sequence == 0 || ValidateNonce(proof.Nonce) != nil || validateDigest(proof.BodySHA256, false) != nil {
		return nil, ErrInvalidHeader
	}
	if err := validateDigest(authorizationTokenHash, true); err != nil {
		return nil, err
	}
	return []byte(strings.Join([]string{
		SignatureDomain,
		canonicalMethod,
		canonicalPath,
		strconv.FormatInt(proof.TimestampMilli, 10),
		proof.Nonce,
		strconv.FormatUint(proof.Sequence, 10),
		proof.BodySHA256,
		authorizationTokenHash,
	}, "\n")), nil
}

func ValidateTimestamp(timestampMilli int64, now time.Time) error {
	window := ClockWindow.Milliseconds()
	nowMilli := now.UnixMilli()
	if timestampMilli <= 0 || timestampMilli < nowMilli-window || timestampMilli > nowMilli+window {
		return ErrTimestampOutsideWindow
	}
	return nil
}

func RequestHash(signingInput []byte) string {
	digest := sha256.Sum256(signingInput)
	return hex.EncodeToString(digest[:])
}

func VerifyRequest(input VerifyInput) (VerifiedRequest, error) {
	return verifyRequest(input, true)
}

// VerifyRequestForPersistentLedger verifies the exact request bytes, headers,
// authorization token hash, public-key binding, and Ed25519 signature while
// deliberately deferring only the clock-window decision. Callers must pass the
// result directly to a store transaction that checks an exact persisted ledger
// replay first and validates the timestamp against database time for every new
// request. It must never be used as a standalone authorization decision.
func VerifyRequestForPersistentLedger(input VerifyInput) (VerifiedRequest, error) {
	return verifyRequest(input, false)
}

func verifyRequest(input VerifyInput, validateTimestamp bool) (VerifiedRequest, error) {
	publicKey, err := ParsePublicKey(input.PublicKey)
	if err != nil {
		return VerifiedRequest{}, err
	}
	proof, err := ParseProofHeaders(input.Headers)
	if err != nil {
		return VerifiedRequest{}, err
	}
	if err := MatchDeviceID(publicKey, proof.DeviceID); err != nil {
		return VerifiedRequest{}, err
	}
	method, err := CanonicalMethod(input.Method)
	if err != nil {
		return VerifiedRequest{}, err
	}
	path, err := CanonicalPath(input.RequestTarget)
	if err != nil {
		return VerifiedRequest{}, err
	}
	bodyHash := HashBody(input.Body)
	if subtle.ConstantTimeCompare([]byte(bodyHash), []byte(proof.BodySHA256)) != 1 {
		return VerifiedRequest{}, ErrBodyHashMismatch
	}
	authorization, err := singleHeader(input.Headers, "Authorization", false)
	if err != nil {
		return VerifiedRequest{}, err
	}
	authorizationHash, err := AuthorizationTokenHash(authorization, input.AllowedAuthorizationSchemes)
	if err != nil {
		return VerifiedRequest{}, err
	}
	if validateTimestamp {
		if err := ValidateTimestamp(proof.TimestampMilli, input.Now); err != nil {
			return VerifiedRequest{}, err
		}
	}
	signingInput, err := SigningInput(method, path, proof, authorizationHash)
	if err != nil {
		return VerifiedRequest{}, err
	}
	if err := VerifySignature(publicKey, signingInput, proof.Signature); err != nil {
		return VerifiedRequest{}, err
	}
	return VerifiedRequest{
		DeviceID:               proof.DeviceID,
		TimestampMilli:         proof.TimestampMilli,
		Nonce:                  proof.Nonce,
		Sequence:               proof.Sequence,
		BodySHA256:             proof.BodySHA256,
		AuthorizationTokenHash: authorizationHash,
		CanonicalMethod:        method,
		CanonicalPath:          path,
		RequestHash:            RequestHash(signingInput),
	}, nil
}

func singleHeader(headers http.Header, name string, required bool) (string, error) {
	values := headers.Values(name)
	if len(values) == 0 && !required {
		return "", nil
	}
	if len(values) != 1 || values[0] == "" || strings.TrimSpace(values[0]) != values[0] {
		return "", fmt.Errorf("%w: %s", ErrInvalidHeader, name)
	}
	return values[0], nil
}

func validateDigest(value string, allowEmpty bool) error {
	if value == "" && allowEmpty {
		return nil
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size || hex.EncodeToString(decoded) != value {
		return ErrInvalidDigest
	}
	return nil
}
