package config

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

const maximumTrustedTokenKeyringBytes = 64 << 10

type trustedTokenKeyringDocument struct {
	SchemaVersion int               `json:"schemaVersion"`
	Revision      int64             `json:"revision"`
	ActiveKeyID   string            `json:"activeKid"`
	Keys          []json.RawMessage `json:"keys"`
}

type trustedTokenKeyDocument struct {
	KeyID            string  `json:"kid"`
	PublicKey        string  `json:"publicKey"`
	SigningNotBefore string  `json:"signingNotBefore"`
	SigningNotAfter  *string `json:"signingNotAfter"`
	VerifyUntil      *string `json:"verifyUntil"`
}

type TrustedTokenTrustMaterial struct {
	Active           TrustedTokenKeyMaterial
	SigningWindow    trustedtoken.KeyWindow
	VerificationKeys trustedtoken.VerificationKeyRing
	PublicProjection trustedtoken.PublicKeyRingProjection
}

// TrustedTokenTrustMaterial loads the reviewed public keyring while retaining
// the existing active signer environment variables. Write mode calls this
// method during validation, so an absent or incomplete keyring fails closed.
func (c Config) TrustedTokenTrustMaterial() (TrustedTokenTrustMaterial, error) {
	active, err := c.TrustedTokenKeyMaterial()
	if err != nil {
		return TrustedTokenTrustMaterial{}, err
	}
	if c.TrustedTokenKeyringFile == "" || strings.TrimSpace(c.TrustedTokenKeyringFile) != c.TrustedTokenKeyringFile {
		return TrustedTokenTrustMaterial{}, errors.New("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_KEYRING_FILE is invalid")
	}
	raw, err := readTrustedTokenKeyringFile(c.TrustedTokenKeyringFile)
	if err != nil {
		return TrustedTokenTrustMaterial{}, err
	}
	document, err := decodeTrustedTokenKeyring(raw)
	if err != nil {
		return TrustedTokenTrustMaterial{}, err
	}
	if document.ActiveKeyID != active.KeyID {
		return TrustedTokenTrustMaterial{}, errors.New("trusted-token active key does not match keyring activeKid")
	}

	keys := make(map[string]trustedtoken.VerificationKey, len(document.Keys))
	var activeWindow trustedtoken.KeyWindow
	for _, rawKey := range document.Keys {
		item, err := decodeTrustedTokenKey(rawKey)
		if err != nil {
			return TrustedTokenTrustMaterial{}, err
		}
		if _, exists := keys[item.KeyID]; exists {
			return TrustedTokenTrustMaterial{}, errors.New("trusted-token keyring contains duplicate kid")
		}
		publicKey, err := decodeCanonicalPublicKey(item.PublicKey)
		if err != nil {
			return TrustedTokenTrustMaterial{}, err
		}
		notBefore, err := parseCanonicalKeyTime(item.SigningNotBefore)
		if err != nil {
			return TrustedTokenTrustMaterial{}, err
		}
		notAfter, err := parseOptionalCanonicalKeyTime(item.SigningNotAfter)
		if err != nil {
			return TrustedTokenTrustMaterial{}, err
		}
		verifyUntil, err := parseOptionalCanonicalKeyTime(item.VerifyUntil)
		if err != nil {
			return TrustedTokenTrustMaterial{}, err
		}
		window, err := trustedtoken.NewKeyWindow(notBefore, notAfter, verifyUntil)
		if err != nil {
			return TrustedTokenTrustMaterial{}, errors.New("trusted-token keyring contains an invalid signing window")
		}
		verificationKey, err := trustedtoken.NewVerificationKey(publicKey, window)
		if err != nil {
			return TrustedTokenTrustMaterial{}, errors.New("trusted-token keyring contains an invalid verification key")
		}
		keys[item.KeyID] = verificationKey
		if item.KeyID == active.KeyID {
			if !bytes.Equal(publicKey, active.VerificationKey) {
				return TrustedTokenTrustMaterial{}, errors.New("trusted-token active private and public keys do not match")
			}
			activeWindow = window
		}
	}
	ring, err := trustedtoken.NewVerificationKeyRing(keys)
	if err != nil {
		return TrustedTokenTrustMaterial{}, errors.New("trusted-token keyring is incomplete")
	}
	if _, exists := ring[active.KeyID]; !exists {
		return TrustedTokenTrustMaterial{}, errors.New("trusted-token active key is missing from keyring")
	}
	projection, err := ring.PublicProjection(document.Revision, document.ActiveKeyID)
	if err != nil {
		return TrustedTokenTrustMaterial{}, errors.New("trusted-token public keyring projection is invalid")
	}
	return TrustedTokenTrustMaterial{
		Active: active, SigningWindow: activeWindow,
		VerificationKeys: ring, PublicProjection: projection,
	}, nil
}

func readTrustedTokenKeyringFile(path string) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Size() < 2 || before.Size() > maximumTrustedTokenKeyringBytes {
		return nil, errors.New("trusted-token keyring file is unavailable or unsafe")
	}
	if before.Mode().Perm()&0o022 != 0 {
		return nil, errors.New("trusted-token keyring file must not be group or world writable")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("trusted-token keyring file cannot be opened")
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) || after.Size() != before.Size() {
		return nil, errors.New("trusted-token keyring file changed while opening")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maximumTrustedTokenKeyringBytes+1))
	if err != nil || len(raw) != int(after.Size()) || len(raw) > maximumTrustedTokenKeyringBytes {
		return nil, errors.New("trusted-token keyring file cannot be read safely")
	}
	return raw, nil
}

func decodeTrustedTokenKeyring(raw []byte) (trustedTokenKeyringDocument, error) {
	if err := validateJSONStructure(raw); err != nil {
		return trustedTokenKeyringDocument{}, errors.New("trusted-token keyring JSON is invalid")
	}
	if !exactJSONObjectKeys(raw, "schemaVersion", "revision", "activeKid", "keys") {
		return trustedTokenKeyringDocument{}, errors.New("trusted-token keyring fields are invalid")
	}
	var document trustedTokenKeyringDocument
	if err := decodeStrictJSON(raw, &document); err != nil || document.SchemaVersion != 1 ||
		document.Revision <= 0 || document.Revision > 1<<53-1 ||
		!trustedTokenKeyIDPattern.MatchString(document.ActiveKeyID) || len(document.Keys) < 1 || len(document.Keys) > 8 {
		return trustedTokenKeyringDocument{}, errors.New("trusted-token keyring document is invalid")
	}
	return document, nil
}

func decodeTrustedTokenKey(raw json.RawMessage) (trustedTokenKeyDocument, error) {
	if !exactJSONObjectKeys(raw, "kid", "publicKey", "signingNotBefore", "signingNotAfter", "verifyUntil") {
		return trustedTokenKeyDocument{}, errors.New("trusted-token key fields are invalid")
	}
	var item trustedTokenKeyDocument
	if err := decodeStrictJSON(raw, &item); err != nil || !trustedTokenKeyIDPattern.MatchString(item.KeyID) ||
		item.PublicKey == "" || item.SigningNotBefore == "" {
		return trustedTokenKeyDocument{}, errors.New("trusted-token key entry is invalid")
	}
	return item, nil
}

func decodeCanonicalPublicKey(encoded string) ([]byte, error) {
	if strings.TrimSpace(encoded) != encoded || encoded == "" || strings.Contains(encoded, "=") {
		return nil, errors.New("trusted-token public key must be canonical base64url")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != encoded {
		return nil, errors.New("trusted-token public key must encode 32 raw Ed25519 bytes")
	}
	return decoded, nil
}

func parseCanonicalKeyTime(value string) (time.Time, error) {
	if strings.TrimSpace(value) != value || value == "" {
		return time.Time{}, errors.New("trusted-token key time is invalid")
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil || parsed.Location() != time.UTC || parsed.Nanosecond() != 0 || parsed.Format(time.RFC3339) != value || parsed.Unix() <= 0 {
		return time.Time{}, errors.New("trusted-token key time must be canonical UTC seconds")
	}
	return parsed, nil
}

func parseOptionalCanonicalKeyTime(value *string) (*time.Time, error) {
	if value == nil {
		return nil, nil
	}
	parsed, err := parseCanonicalKeyTime(*value)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func decodeStrictJSON(raw []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON value")
	}
	return nil
}

func exactJSONObjectKeys(raw []byte, expected ...string) bool {
	var values map[string]json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || len(values) != len(expected) {
		return false
	}
	for _, name := range expected {
		if _, exists := values[name]; !exists {
			return false
		}
	}
	return true
}

// validateJSONStructure rejects duplicate object keys before the typed decode.
func validateJSONStructure(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := consumeJSONValue(decoder); err != nil {
		return err
	}
	if token, err := decoder.Token(); err == nil || !errors.Is(err, io.EOF) {
		return fmt.Errorf("unexpected trailing token %v", token)
	}
	return nil
}

func consumeJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, composite := token.(json.Delim)
	if !composite {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]bool{}
		for decoder.More() {
			nameToken, err := decoder.Token()
			if err != nil {
				return err
			}
			name, ok := nameToken.(string)
			if !ok || seen[name] {
				return errors.New("duplicate or invalid object key")
			}
			seen[name] = true
			if err := consumeJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return errors.New("invalid object closing delimiter")
		}
	case '[':
		for decoder.More() {
			if err := consumeJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return errors.New("invalid array closing delimiter")
		}
	default:
		return errors.New("invalid opening delimiter")
	}
	return nil
}
