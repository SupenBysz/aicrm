package trustedtoken

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"sort"
	"time"
)

const (
	// MaximumLifetime is the longest lifetime of any trusted token issued by
	// this package. Retired verification keys remain available for exactly this
	// grace period after their signing window closes.
	MaximumLifetime = 10 * time.Minute
	maximumKeyCount = 8
)

var desktopAudiences = []string{
	AudienceDesktop,
	AudienceClaim,
	AudienceActivation,
	AudienceCommand,
}

// KeyWindow is the half-open interval in which a key may sign token claims.
// A retired key has both SigningNotAfter and VerifyUntil; an active or pending
// key has neither. All values are canonical whole Unix seconds.
type KeyWindow struct {
	SigningNotBefore int64
	SigningNotAfter  *int64
	VerifyUntil      *int64
}

func NewKeyWindow(signingNotBefore time.Time, signingNotAfter, verifyUntil *time.Time) (KeyWindow, error) {
	window := KeyWindow{SigningNotBefore: canonicalUnixSecond(signingNotBefore)}
	if signingNotAfter != nil {
		value := canonicalUnixSecond(*signingNotAfter)
		window.SigningNotAfter = &value
	}
	if verifyUntil != nil {
		value := canonicalUnixSecond(*verifyUntil)
		window.VerifyUntil = &value
	}
	if !window.valid() {
		return KeyWindow{}, ErrInvalidKey
	}
	return window, nil
}

func (w KeyWindow) valid() bool {
	if w.SigningNotBefore <= 0 || (w.SigningNotAfter == nil) != (w.VerifyUntil == nil) {
		return false
	}
	if w.SigningNotAfter == nil {
		return true
	}
	return *w.SigningNotAfter > w.SigningNotBefore &&
		*w.VerifyUntil == *w.SigningNotAfter+int64(MaximumLifetime/time.Second)
}

func (w KeyWindow) acceptsIssuedAt(issuedAt int64) bool {
	return w.valid() && issuedAt >= w.SigningNotBefore &&
		(w.SigningNotAfter == nil || issuedAt < *w.SigningNotAfter)
}

// AllowsIssuedAt applies the same whole-second normalization as NewClaims.
// It is used with writer-database time during startup so an expired or not-yet
// active signing key cannot leave the control plane reporting ready.
func (w KeyWindow) AllowsIssuedAt(value time.Time) bool {
	if value.IsZero() {
		return false
	}
	return w.acceptsIssuedAt(value.UTC().Truncate(time.Second).Unix())
}

func (w KeyWindow) retiredAt(now int64) bool {
	return w.VerifyUntil != nil && now >= *w.VerifyUntil
}

func (w KeyWindow) clone() KeyWindow {
	return KeyWindow{
		SigningNotBefore: w.SigningNotBefore,
		SigningNotAfter:  cloneInt64(w.SigningNotAfter),
		VerifyUntil:      cloneInt64(w.VerifyUntil),
	}
}

// VerificationKey binds a public key to the only claim issuance interval in
// which signatures from that key are accepted.
type VerificationKey struct {
	publicKey ed25519.PublicKey
	window    KeyWindow
}

func NewVerificationKey(publicKey ed25519.PublicKey, window KeyWindow) (VerificationKey, error) {
	if len(publicKey) != ed25519.PublicKeySize || !window.valid() {
		return VerificationKey{}, ErrInvalidKey
	}
	return VerificationKey{
		publicKey: append(ed25519.PublicKey(nil), publicKey...),
		window:    window.clone(),
	}, nil
}

func (k VerificationKey) PublicKey() ed25519.PublicKey {
	return append(ed25519.PublicKey(nil), k.publicKey...)
}

func (k VerificationKey) Window() KeyWindow {
	return k.window.clone()
}

type VerificationKeyRing map[string]VerificationKey

func NewVerificationKeyRing(values map[string]VerificationKey) (VerificationKeyRing, error) {
	if len(values) < 1 || len(values) > maximumKeyCount {
		return nil, ErrInvalidKey
	}
	result := make(VerificationKeyRing, len(values))
	for keyID, value := range values {
		if !keyIDPattern.MatchString(keyID) || len(value.publicKey) != ed25519.PublicKeySize || !value.window.valid() {
			return nil, ErrInvalidKey
		}
		result[keyID] = VerificationKey{
			publicKey: append(ed25519.PublicKey(nil), value.publicKey...),
			window:    value.window.clone(),
		}
	}
	if !nonOverlappingSigningWindows(result) {
		return nil, ErrInvalidKey
	}
	return result, nil
}

func nonOverlappingSigningWindows(values VerificationKeyRing) bool {
	windows := make([]KeyWindow, 0, len(values))
	for _, value := range values {
		windows = append(windows, value.window)
	}
	sort.Slice(windows, func(left, right int) bool {
		return windows[left].SigningNotBefore < windows[right].SigningNotBefore
	})
	for index := 1; index < len(windows); index++ {
		previous := windows[index-1]
		if previous.SigningNotAfter == nil || *previous.SigningNotAfter > windows[index].SigningNotBefore {
			return false
		}
	}
	return true
}

type PublicVerificationKeyProjection struct {
	KeyID            string  `json:"kid"`
	KeyType          string  `json:"kty"`
	Curve            string  `json:"crv"`
	Algorithm        string  `json:"alg"`
	Use              string  `json:"use"`
	PublicKey        string  `json:"x"`
	SigningNotBefore string  `json:"signingNotBefore"`
	SigningNotAfter  *string `json:"signingNotAfter"`
	VerifyUntil      *string `json:"verifyUntil"`
}

type PublicKeyRingProjection struct {
	SchemaVersion          int                               `json:"schemaVersion"`
	Issuer                 string                            `json:"issuer"`
	Revision               int64                             `json:"revision"`
	ActiveKeyID            string                            `json:"activeKid"`
	MaximumLifetimeSeconds int64                             `json:"maxTokenLifetimeSeconds"`
	DesktopAudiences       []string                          `json:"desktopAudiences"`
	KeyRingDigest          string                            `json:"keyringDigest"`
	Keys                   []PublicVerificationKeyProjection `json:"keys"`
}

type publicKeyRingDigestPayload struct {
	SchemaVersion          int                               `json:"schemaVersion"`
	Issuer                 string                            `json:"issuer"`
	Revision               int64                             `json:"revision"`
	ActiveKeyID            string                            `json:"activeKid"`
	MaximumLifetimeSeconds int64                             `json:"maxTokenLifetimeSeconds"`
	DesktopAudiences       []string                          `json:"desktopAudiences"`
	Keys                   []PublicVerificationKeyProjection `json:"keys"`
}

// PublicProjection returns a deterministic, private-material-free keyring.
// The digest covers the exact canonical JSON projection except for the digest
// field itself and is stable across map iteration and process restarts.
func (r VerificationKeyRing) PublicProjection(revision int64, activeKeyID string) (PublicKeyRingProjection, error) {
	if revision <= 0 || revision > 1<<53-1 || !keyIDPattern.MatchString(activeKeyID) {
		return PublicKeyRingProjection{}, ErrInvalidKey
	}
	validated, err := NewVerificationKeyRing(r)
	if err != nil {
		return PublicKeyRingProjection{}, err
	}
	if _, ok := validated[activeKeyID]; !ok {
		return PublicKeyRingProjection{}, ErrInvalidKey
	}
	keyIDs := make([]string, 0, len(validated))
	for keyID := range validated {
		keyIDs = append(keyIDs, keyID)
	}
	sort.Strings(keyIDs)
	keys := make([]PublicVerificationKeyProjection, 0, len(keyIDs))
	for _, keyID := range keyIDs {
		key := validated[keyID]
		keys = append(keys, PublicVerificationKeyProjection{
			KeyID: keyID, KeyType: "OKP", Curve: "Ed25519", Algorithm: "EdDSA", Use: "sig",
			PublicKey:        base64.RawURLEncoding.EncodeToString(key.publicKey),
			SigningNotBefore: formatUnixSecond(key.window.SigningNotBefore),
			SigningNotAfter:  formatOptionalUnixSecond(key.window.SigningNotAfter),
			VerifyUntil:      formatOptionalUnixSecond(key.window.VerifyUntil),
		})
	}
	payload := publicKeyRingDigestPayload{
		SchemaVersion: 1, Issuer: Issuer, Revision: revision, ActiveKeyID: activeKeyID,
		MaximumLifetimeSeconds: int64(MaximumLifetime / time.Second),
		DesktopAudiences:       append([]string(nil), desktopAudiences...),
		Keys:                   keys,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return PublicKeyRingProjection{}, ErrInvalidKey
	}
	digest := sha256.Sum256(encoded)
	return PublicKeyRingProjection{
		SchemaVersion: payload.SchemaVersion, Issuer: payload.Issuer, Revision: payload.Revision,
		ActiveKeyID: payload.ActiveKeyID, MaximumLifetimeSeconds: payload.MaximumLifetimeSeconds,
		DesktopAudiences: append([]string(nil), payload.DesktopAudiences...),
		KeyRingDigest:    hex.EncodeToString(digest[:]), Keys: append([]PublicVerificationKeyProjection(nil), keys...),
	}, nil
}

func canonicalUnixSecond(value time.Time) int64 {
	if value.IsZero() || value.Nanosecond() != 0 || value.Location() != time.UTC {
		return 0
	}
	return value.Unix()
}

func formatUnixSecond(value int64) string {
	return time.Unix(value, 0).UTC().Format(time.RFC3339)
}

func formatOptionalUnixSecond(value *int64) *string {
	if value == nil {
		return nil
	}
	formatted := formatUnixSecond(*value)
	return &formatted
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}
