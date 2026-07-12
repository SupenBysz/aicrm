// Package trustedtoken issues and verifies the short-lived, target-bound
// compact JWS values used by the AiCRM Desktop executor trust plane.
package trustedtoken

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"time"
)

const (
	Issuer = "aicrm-agent-executor"

	AudienceDesktop      = "aicrm-desktop"
	AudienceClaim        = "aicrm-desktop-claim"
	AudienceActivation   = "aicrm-desktop-activation"
	AudienceCommand      = "aicrm-desktop-command"
	AudienceConfirmation = "aicrm-operation-confirmation"

	PurposeAuthorizationHandoff = "authorization_handoff"
	PurposeAuthorizationClaim   = "authorization_claim"
	PurposeCredentialActivation = "credential_activation"
	PurposeAuthorizationCancel  = "authorization_cancel"
	PurposeAuthorizationReopen  = "authorization_reopen"
	PurposeCredentialVerify     = "credential_verify"
	PurposeModelCatalogRefresh  = "model_catalog_refresh"
	PurposeReadinessCheck       = "readiness_check"
	PurposeCredentialLogout     = "credential_logout"
	PurposeForceRevoke          = "force_revoke"
	PurposeRebindDevice         = "rebind_device"
	PurposeUnbindDevice         = "unbind_device"
)

var (
	ErrInvalidKey       = errors.New("invalid trusted token key")
	ErrInvalidClaims    = errors.New("invalid trusted token claims")
	ErrMalformed        = errors.New("malformed trusted token")
	ErrUnknownKey       = errors.New("unknown trusted token key")
	ErrInvalidSignature = errors.New("invalid trusted token signature")
	ErrAudienceMismatch = errors.New("trusted token audience mismatch")
	ErrPurposeMismatch  = errors.New("trusted token purpose mismatch")
	ErrNotYetValid      = errors.New("trusted token is not yet valid")
	ErrExpired          = errors.New("trusted token expired")
)

var (
	opaqueIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,160}$`)
	keyIDPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	hexDigest       = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type Claims struct {
	Version   int    `json:"v"`
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	TokenID   string `json:"jti"`
	Purpose   string `json:"purpose"`
	Nonce     string `json:"nonce"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`

	ActorID        string `json:"actorId,omitempty"`
	SessionID      string `json:"sessionId,omitempty"`
	ExecutorID     string `json:"executorId,omitempty"`
	DeviceID       string `json:"deviceId,omitempty"`
	HandoffID      string `json:"handoffId,omitempty"`
	ActivationID   string `json:"activationId,omitempty"`
	OperationID    string `json:"operationId,omitempty"`
	RevocationID   string `json:"revocationId,omitempty"`
	FromDeviceID   string `json:"fromDeviceId,omitempty"`
	TargetDeviceID string `json:"targetDeviceId,omitempty"`
	BindingDigest  string `json:"bindingDigest,omitempty"`

	ExpectedRevision           *int64 `json:"expectedRevision,omitempty"`
	ExpectedSessionRevision    *int64 `json:"expectedSessionRevision,omitempty"`
	ExpectedExecutorRevision   *int64 `json:"expectedExecutorRevision,omitempty"`
	ExpectedCredentialRevision *int64 `json:"expectedCredentialRevision,omitempty"`
	ExpectedCatalogRevision    *int64 `json:"expectedCatalogRevision,omitempty"`
	CredentialRevision         *int64 `json:"credentialRevision,omitempty"`
	LeaseEpoch                 *int64 `json:"leaseEpoch,omitempty"`
	SourceCredentialRevision   *int64 `json:"sourceCredentialRevision,omitempty"`
	RevocationEpoch            *int64 `json:"revocationEpoch,omitempty"`
}

type protectedHeader struct {
	Algorithm string `json:"alg"`
	KeyID     string `json:"kid"`
	Type      string `json:"typ"`
}

type Signer struct {
	keyID      string
	privateKey ed25519.PrivateKey
}

func NewSigner(keyID string, privateKey ed25519.PrivateKey) (*Signer, error) {
	if !keyIDPattern.MatchString(keyID) || len(privateKey) != ed25519.PrivateKeySize {
		return nil, ErrInvalidKey
	}
	copyKey := append(ed25519.PrivateKey(nil), privateKey...)
	return &Signer{keyID: keyID, privateKey: copyKey}, nil
}

// NewClaims creates the immutable time envelope. Callers then fill only the
// target fields required by the selected purpose before calling Issue.
func NewClaims(audience, purpose, tokenID, nonce string, issuedAt time.Time) (Claims, error) {
	ttl, ok := purposeTTL(audience, purpose)
	if !ok || !opaqueIDPattern.MatchString(tokenID) || !validNonce(nonce) || issuedAt.IsZero() {
		return Claims{}, ErrInvalidClaims
	}
	issued := issuedAt.UTC().Truncate(time.Second)
	if issued.Unix() <= 0 {
		return Claims{}, ErrInvalidClaims
	}
	return Claims{
		Version: 1, Issuer: Issuer, Audience: audience, Purpose: purpose,
		TokenID: tokenID, Nonce: nonce, IssuedAt: issued.Unix(), ExpiresAt: issued.Add(ttl).Unix(),
	}, nil
}

// Issue is deterministic for identical claims and key. This permits a retry
// to reconstruct the same ticket from persisted claims while storing only its
// SHA-256 hash in PostgreSQL.
func (s *Signer) Issue(claims Claims) (string, error) {
	if s == nil || len(s.privateKey) != ed25519.PrivateKeySize || validateClaims(claims) != nil {
		return "", ErrInvalidClaims
	}
	headerBytes, _ := json.Marshal(protectedHeader{Algorithm: "EdDSA", KeyID: s.keyID, Type: "JWT"})
	payloadBytes, err := json.Marshal(claims)
	if err != nil {
		return "", ErrInvalidClaims
	}
	header := base64.RawURLEncoding.EncodeToString(headerBytes)
	payload := base64.RawURLEncoding.EncodeToString(payloadBytes)
	signingInput := header + "." + payload
	signature := ed25519.Sign(s.privateKey, []byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

type KeySet map[string]ed25519.PublicKey

// Verify rejects non-canonical JSON/base64 representations, unknown fields,
// wrong target classes and expired values before returning claims.
func Verify(token string, keys KeySet, now time.Time, expectedAudience, expectedPurpose string) (Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || len(token) > 16<<10 {
		return Claims{}, ErrMalformed
	}
	headerBytes, err := decodeCanonicalSegment(parts[0], 2<<10)
	if err != nil {
		return Claims{}, ErrMalformed
	}
	payloadBytes, err := decodeCanonicalSegment(parts[1], 12<<10)
	if err != nil {
		return Claims{}, ErrMalformed
	}
	signature, err := decodeCanonicalSegment(parts[2], ed25519.SignatureSize)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return Claims{}, ErrMalformed
	}
	var header protectedHeader
	if decodeStrictCanonical(headerBytes, &header) != nil || header.Algorithm != "EdDSA" || header.Type != "JWT" || !keyIDPattern.MatchString(header.KeyID) {
		return Claims{}, ErrMalformed
	}
	publicKey, exists := keys[header.KeyID]
	if !exists || len(publicKey) != ed25519.PublicKeySize {
		return Claims{}, ErrUnknownKey
	}
	if !ed25519.Verify(publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		return Claims{}, ErrInvalidSignature
	}
	var claims Claims
	if decodeStrictCanonical(payloadBytes, &claims) != nil || validateClaims(claims) != nil {
		return Claims{}, ErrInvalidClaims
	}
	if claims.Audience != expectedAudience {
		return Claims{}, ErrAudienceMismatch
	}
	if claims.Purpose != expectedPurpose {
		return Claims{}, ErrPurposeMismatch
	}
	current := now.UTC().Unix()
	if current < claims.IssuedAt {
		return Claims{}, ErrNotYetValid
	}
	if current >= claims.ExpiresAt {
		return Claims{}, ErrExpired
	}
	return claims, nil
}

func Hash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func decodeCanonicalSegment(value string, maximum int) ([]byte, error) {
	if value == "" || strings.Contains(value, "=") {
		return nil, ErrMalformed
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) > maximum || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, ErrMalformed
	}
	return decoded, nil
}

func decodeStrictCanonical(raw []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return ErrMalformed
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrMalformed
	}
	canonical, err := json.Marshal(output)
	if err != nil || !bytes.Equal(canonical, raw) {
		return ErrMalformed
	}
	return nil
}

func validateClaims(claims Claims) error {
	ttl, ok := purposeTTL(claims.Audience, claims.Purpose)
	if !ok || claims.Version != 1 || claims.Issuer != Issuer || !opaqueIDPattern.MatchString(claims.TokenID) ||
		!validNonce(claims.Nonce) || claims.IssuedAt <= 0 || claims.ExpiresAt != claims.IssuedAt+int64(ttl/time.Second) {
		return ErrInvalidClaims
	}
	if !allOptionalIDsValid(claims) || (claims.BindingDigest != "" && !hexDigest.MatchString(claims.BindingDigest)) {
		return ErrInvalidClaims
	}
	if claims.DeviceID != "" && !hexDigest.MatchString(claims.DeviceID) {
		return ErrInvalidClaims
	}
	if claims.FromDeviceID != "" && !hexDigest.MatchString(claims.FromDeviceID) {
		return ErrInvalidClaims
	}
	if claims.TargetDeviceID != "" && !hexDigest.MatchString(claims.TargetDeviceID) {
		return ErrInvalidClaims
	}
	return validatePurposeClaims(claims)
}

func allOptionalIDsValid(claims Claims) bool {
	for _, value := range []string{
		claims.ActorID, claims.SessionID, claims.ExecutorID, claims.HandoffID,
		claims.ActivationID, claims.OperationID, claims.RevocationID,
	} {
		if value != "" && !opaqueIDPattern.MatchString(value) {
			return false
		}
	}
	return true
}

func validatePurposeClaims(c Claims) error {
	require := func(values ...string) bool {
		for _, value := range values {
			if value == "" {
				return false
			}
		}
		return true
	}
	positive := func(value *int64) bool { return value != nil && *value > 0 }
	nonNegative := func(value *int64) bool { return value != nil && *value >= 0 }
	switch c.Purpose {
	case PurposeAuthorizationHandoff:
		return validIf(require(c.ActorID, c.SessionID, c.ExecutorID, c.DeviceID, c.HandoffID) &&
			onlyTargets(c, "actorId", "sessionId", "executorId", "deviceId", "handoffId") &&
			positive(c.ExpectedSessionRevision) && onlyRevisions(c, "expectedSessionRevision"))
	case PurposeAuthorizationClaim:
		return validIf(require(c.SessionID, c.ExecutorID, c.DeviceID, c.HandoffID) &&
			onlyTargets(c, "sessionId", "executorId", "deviceId", "handoffId") &&
			positive(c.ExpectedSessionRevision) && onlyRevisions(c, "expectedSessionRevision"))
	case PurposeCredentialActivation:
		return validIf(require(c.SessionID, c.ExecutorID, c.DeviceID, c.OperationID, c.ActivationID, c.BindingDigest) &&
			onlyTargets(c, "sessionId", "executorId", "deviceId", "operationId", "activationId", "bindingDigest") &&
			positive(c.CredentialRevision) && positive(c.LeaseEpoch) && nonNegative(c.SourceCredentialRevision) && nonNegative(c.RevocationEpoch) &&
			onlyRevisions(c, "credentialRevision", "leaseEpoch", "sourceCredentialRevision", "revocationEpoch"))
	case PurposeAuthorizationCancel, PurposeAuthorizationReopen:
		return validIf(require(c.ActorID, c.SessionID, c.ExecutorID, c.DeviceID, c.OperationID) &&
			onlyTargets(c, "actorId", "sessionId", "executorId", "deviceId", "operationId") &&
			positive(c.ExpectedSessionRevision) && onlyRevisions(c, "expectedSessionRevision"))
	case PurposeCredentialVerify:
		return validIf(require(c.ActorID, c.ExecutorID, c.DeviceID, c.OperationID) &&
			onlyTargets(c, "actorId", "executorId", "deviceId", "operationId") &&
			positive(c.ExpectedExecutorRevision) && positive(c.ExpectedCredentialRevision) &&
			onlyRevisions(c, "expectedExecutorRevision", "expectedCredentialRevision"))
	case PurposeModelCatalogRefresh:
		return validIf(require(c.ActorID, c.ExecutorID, c.DeviceID, c.OperationID) &&
			onlyTargets(c, "actorId", "executorId", "deviceId", "operationId") &&
			positive(c.ExpectedExecutorRevision) && nonNegative(c.ExpectedCatalogRevision) &&
			onlyRevisions(c, "expectedExecutorRevision", "expectedCatalogRevision"))
	case PurposeReadinessCheck:
		return validIf(require(c.ActorID, c.ExecutorID, c.DeviceID, c.OperationID) &&
			onlyTargets(c, "actorId", "executorId", "deviceId", "operationId") &&
			positive(c.ExpectedExecutorRevision) && positive(c.ExpectedCredentialRevision) && nonNegative(c.ExpectedCatalogRevision) &&
			onlyRevisions(c, "expectedExecutorRevision", "expectedCredentialRevision", "expectedCatalogRevision"))
	case PurposeCredentialLogout:
		return validIf(require(c.ActorID, c.ExecutorID, c.DeviceID, c.OperationID, c.RevocationID) &&
			onlyTargets(c, "actorId", "executorId", "deviceId", "operationId", "revocationId") &&
			positive(c.CredentialRevision) && positive(c.RevocationEpoch) &&
			onlyRevisions(c, "credentialRevision", "revocationEpoch"))
	case PurposeForceRevoke:
		return validIf(require(c.ActorID, c.ExecutorID) && onlyTargets(c, "actorId", "executorId") &&
			positive(c.ExpectedRevision) && onlyRevisions(c, "expectedRevision"))
	case PurposeRebindDevice:
		return validIf(require(c.ActorID, c.ExecutorID, c.FromDeviceID, c.TargetDeviceID) && c.FromDeviceID != c.TargetDeviceID &&
			onlyTargets(c, "actorId", "executorId", "fromDeviceId", "targetDeviceId") &&
			positive(c.ExpectedRevision) && onlyRevisions(c, "expectedRevision"))
	case PurposeUnbindDevice:
		return validIf(require(c.ActorID, c.ExecutorID, c.FromDeviceID) &&
			onlyTargets(c, "actorId", "executorId", "fromDeviceId") &&
			positive(c.ExpectedRevision) && onlyRevisions(c, "expectedRevision"))
	default:
		return ErrInvalidClaims
	}
}

func onlyTargets(c Claims, allowed ...string) bool {
	allowedSet := make(map[string]bool, len(allowed))
	for _, name := range allowed {
		allowedSet[name] = true
	}
	for name, value := range map[string]string{
		"actorId": c.ActorID, "sessionId": c.SessionID, "executorId": c.ExecutorID,
		"deviceId": c.DeviceID, "handoffId": c.HandoffID, "activationId": c.ActivationID,
		"operationId": c.OperationID, "revocationId": c.RevocationID,
		"fromDeviceId": c.FromDeviceID, "targetDeviceId": c.TargetDeviceID,
		"bindingDigest": c.BindingDigest,
	} {
		if value != "" && !allowedSet[name] {
			return false
		}
	}
	return true
}

func onlyRevisions(c Claims, allowed ...string) bool {
	allowedSet := make(map[string]bool, len(allowed))
	for _, name := range allowed {
		allowedSet[name] = true
	}
	for name, value := range map[string]*int64{
		"expectedRevision":           c.ExpectedRevision,
		"expectedSessionRevision":    c.ExpectedSessionRevision,
		"expectedExecutorRevision":   c.ExpectedExecutorRevision,
		"expectedCredentialRevision": c.ExpectedCredentialRevision,
		"expectedCatalogRevision":    c.ExpectedCatalogRevision,
		"credentialRevision":         c.CredentialRevision,
		"leaseEpoch":                 c.LeaseEpoch,
		"sourceCredentialRevision":   c.SourceCredentialRevision,
		"revocationEpoch":            c.RevocationEpoch,
	} {
		if value != nil && !allowedSet[name] {
			return false
		}
	}
	return true
}

func validIf(ok bool) error {
	if !ok {
		return ErrInvalidClaims
	}
	return nil
}

func purposeTTL(audience, purpose string) (time.Duration, bool) {
	switch {
	case audience == AudienceDesktop && purpose == PurposeAuthorizationHandoff:
		return 120 * time.Second, true
	case audience == AudienceClaim && purpose == PurposeAuthorizationClaim:
		return 5 * time.Minute, true
	case audience == AudienceActivation && purpose == PurposeCredentialActivation:
		return 10 * time.Minute, true
	case audience == AudienceCommand && map[string]bool{
		PurposeAuthorizationCancel: true, PurposeAuthorizationReopen: true,
		PurposeCredentialVerify: true, PurposeModelCatalogRefresh: true,
		PurposeReadinessCheck: true, PurposeCredentialLogout: true,
	}[purpose]:
		return 120 * time.Second, true
	case audience == AudienceConfirmation && map[string]bool{
		PurposeForceRevoke: true, PurposeRebindDevice: true, PurposeUnbindDevice: true,
	}[purpose]:
		return 5 * time.Minute, true
	default:
		return 0, false
	}
}

func validNonce(value string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(raw) == 16 && base64.RawURLEncoding.EncodeToString(raw) == value
}
