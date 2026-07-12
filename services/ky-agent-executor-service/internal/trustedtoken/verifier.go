package trustedtoken

import (
	"bytes"
	"crypto/ed25519"
	"time"
)

// Verifier is an immutable trusted-token verification policy. Legacy key sets
// remain available to existing tests while production uses a windowed keyring.
type Verifier struct {
	legacy  KeySet
	keyring VerificationKeyRing
}

func NewLegacyVerifier(values KeySet) (*Verifier, error) {
	if len(values) < 1 || len(values) > maximumKeyCount {
		return nil, ErrInvalidKey
	}
	keys := make(KeySet, len(values))
	for keyID, publicKey := range values {
		if !keyIDPattern.MatchString(keyID) || len(publicKey) != ed25519.PublicKeySize {
			return nil, ErrInvalidKey
		}
		keys[keyID] = append(ed25519.PublicKey(nil), publicKey...)
	}
	return &Verifier{legacy: keys}, nil
}

func NewKeyRingVerifier(values VerificationKeyRing) (*Verifier, error) {
	keys, err := NewVerificationKeyRing(values)
	if err != nil {
		return nil, err
	}
	return &Verifier{keyring: keys}, nil
}

func (v *Verifier) MatchesSigner(signer *Signer) bool {
	if v == nil || signer == nil || signer.KeyID() == "" {
		return false
	}
	publicKey := signer.VerificationKey()
	if len(v.keyring) > 0 {
		key, exists := v.keyring[signer.KeyID()]
		return exists && bytes.Equal(key.publicKey, publicKey)
	}
	key, exists := v.legacy[signer.KeyID()]
	return exists && bytes.Equal(key, publicKey)
}

func (v *Verifier) Verify(token string, now time.Time, expectedAudience, expectedPurpose string) (Claims, error) {
	if v == nil {
		return Claims{}, ErrInvalidKey
	}
	if len(v.keyring) > 0 {
		return VerifyWithKeyRing(token, v.keyring, now, expectedAudience, expectedPurpose)
	}
	return Verify(token, v.legacy, now, expectedAudience, expectedPurpose)
}
