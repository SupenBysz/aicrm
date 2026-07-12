package trustedtoken

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"testing"
	"time"
)

func TestVerifierCopiesKeysMatchesExactSignerAndUsesWindowedPolicy(t *testing.T) {
	start := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x55}, ed25519.SeedSize))
	signer, err := NewSigner("verifier_key_1", privateKey)
	if err != nil {
		t.Fatal(err)
	}
	window, _ := NewKeyWindow(start, nil, nil)
	verificationKey, _ := NewVerificationKey(privateKey.Public().(ed25519.PublicKey), window)
	ring, _ := NewVerificationKeyRing(map[string]VerificationKey{"verifier_key_1": verificationKey})
	verifier, err := NewKeyRingVerifier(ring)
	if err != nil || !verifier.MatchesSigner(signer) {
		t.Fatalf("windowed verifier did not match active signer: %v", err)
	}
	claims := validHandoffClaims(t, start)
	token, err := signer.Issue(claims)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifier.Verify(token, start, AudienceDesktop, PurposeAuthorizationHandoff); err != nil {
		t.Fatalf("windowed verifier rejected valid token: %v", err)
	}

	otherPrivate := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x56}, ed25519.SeedSize))
	otherSigner, _ := NewSigner("verifier_key_1", otherPrivate)
	if verifier.MatchesSigner(otherSigner) {
		t.Fatal("verifier accepted another private key under the same kid")
	}
	lateClaims := validHandoffClaims(t, start.Add(-time.Second))
	lateToken, _ := signer.Issue(lateClaims)
	if _, err := verifier.Verify(lateToken, start, AudienceDesktop, PurposeAuthorizationHandoff); !errors.Is(err, ErrKeyWindowMismatch) {
		t.Fatalf("verifier did not enforce key iat window: %v", err)
	}
}

func TestLegacyVerifierRemainsStrictButUnwindowed(t *testing.T) {
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x61}, ed25519.SeedSize))
	signer, _ := NewSigner("legacy_key_1", privateKey)
	publicKey := privateKey.Public().(ed25519.PublicKey)
	verifier, err := NewLegacyVerifier(KeySet{"legacy_key_1": publicKey})
	if err != nil || !verifier.MatchesSigner(signer) {
		t.Fatalf("legacy verifier rejected exact signer: %v", err)
	}
	publicKey[0] ^= 1
	if !verifier.MatchesSigner(signer) {
		t.Fatal("legacy verifier retained caller-owned mutable public-key bytes")
	}
	if _, err := NewLegacyVerifier(KeySet{}); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("empty legacy verifier was accepted: %v", err)
	}
}
