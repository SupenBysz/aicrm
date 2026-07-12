package trustedtoken

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestWindowedSignerAndVerificationRingEnforceHalfOpenIssuanceWindow(t *testing.T) {
	notBefore := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	notAfter := notBefore.Add(time.Hour)
	verifyUntil := notAfter.Add(MaximumLifetime)
	window, err := NewKeyWindow(notBefore, &notAfter, &verifyUntil)
	if err != nil {
		t.Fatal(err)
	}
	if window.AllowsIssuedAt(notBefore.Add(-time.Nanosecond)) || !window.AllowsIssuedAt(notBefore) ||
		!window.AllowsIssuedAt(notAfter.Add(-time.Nanosecond)) || window.AllowsIssuedAt(notAfter) {
		t.Fatal("database-time signing-window boundary was not half-open at whole-second precision")
	}
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x21}, ed25519.SeedSize))
	signer, err := NewWindowedSigner("rotating_key_1", privateKey, window)
	if err != nil {
		t.Fatal(err)
	}
	claims := validHandoffClaims(t, notAfter.Add(-time.Second))
	token, err := signer.Issue(claims)
	if err != nil {
		t.Fatal(err)
	}
	verificationKey, err := NewVerificationKey(privateKey.Public().(ed25519.PublicKey), window)
	if err != nil {
		t.Fatal(err)
	}
	ring, err := NewVerificationKeyRing(map[string]VerificationKey{"rotating_key_1": verificationKey})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyWithKeyRing(token, ring, time.Unix(claims.IssuedAt, 0), AudienceDesktop, PurposeAuthorizationHandoff); err != nil {
		t.Fatalf("valid pre-cutover token rejected: %v", err)
	}

	afterCutover := validHandoffClaims(t, notAfter)
	if _, err := signer.Issue(afterCutover); !errors.Is(err, ErrKeyWindowMismatch) {
		t.Fatalf("windowed signer issued at half-open cutoff: %v", err)
	}
	unbounded, err := NewSigner("rotating_key_1", privateKey)
	if err != nil {
		t.Fatal(err)
	}
	forgedAfterCutover, err := unbounded.Issue(afterCutover)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyWithKeyRing(forgedAfterCutover, ring, notAfter, AudienceDesktop, PurposeAuthorizationHandoff); !errors.Is(err, ErrKeyWindowMismatch) {
		t.Fatalf("post-cutover claim was accepted by verify-only key: %v", err)
	}
	if _, err := VerifyWithKeyRing(token, ring, verifyUntil, AudienceDesktop, PurposeAuthorizationHandoff); !errors.Is(err, ErrKeyRetired) {
		t.Fatalf("retired key remained usable: %v", err)
	}
}

func TestKeyWindowRequiresExactMaximumLifetimeRetirementGrace(t *testing.T) {
	start := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	for _, candidate := range []*time.Time{
		nil,
		timePointer(end.Add(MaximumLifetime - time.Second)),
		timePointer(end.Add(MaximumLifetime + time.Second)),
	} {
		if _, err := NewKeyWindow(start, &end, candidate); !errors.Is(err, ErrInvalidKey) {
			t.Fatalf("invalid verifyUntil %#v was accepted: %v", candidate, err)
		}
	}
	valid := end.Add(MaximumLifetime)
	if _, err := NewKeyWindow(start, &end, &valid); err != nil {
		t.Fatalf("exact retirement grace rejected: %v", err)
	}
	if _, err := NewKeyWindow(start, nil, nil); err != nil {
		t.Fatalf("open active window rejected: %v", err)
	}
	fractional := start.Add(time.Nanosecond)
	if _, err := NewKeyWindow(fractional, nil, nil); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("fractional key time accepted: %v", err)
	}
}

func TestVerificationKeyRingRejectsOverlappingSigningWindows(t *testing.T) {
	start := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	retire := end.Add(MaximumLifetime)
	oldWindow, _ := NewKeyWindow(start, &end, &retire)
	newWindow, _ := NewKeyWindow(end.Add(-time.Second), nil, nil)
	oldPrivate := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x31}, ed25519.SeedSize))
	newPrivate := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x32}, ed25519.SeedSize))
	oldKey, _ := NewVerificationKey(oldPrivate.Public().(ed25519.PublicKey), oldWindow)
	newKey, _ := NewVerificationKey(newPrivate.Public().(ed25519.PublicKey), newWindow)
	if _, err := NewVerificationKeyRing(map[string]VerificationKey{"old": oldKey, "new": newKey}); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("overlapping signing windows were accepted: %v", err)
	}
}

func TestPublicKeyRingProjectionIsSortedStableAndPrivateFree(t *testing.T) {
	start := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	oldStart := start.Add(-24 * time.Hour)
	oldVerifyUntil := start.Add(MaximumLifetime)
	oldWindow, _ := NewKeyWindow(oldStart, &start, &oldVerifyUntil)
	activeWindow, _ := NewKeyWindow(start, nil, nil)
	firstPrivate := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x41}, ed25519.SeedSize))
	secondPrivate := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x42}, ed25519.SeedSize))
	first, _ := NewVerificationKey(firstPrivate.Public().(ed25519.PublicKey), oldWindow)
	second, _ := NewVerificationKey(secondPrivate.Public().(ed25519.PublicKey), activeWindow)
	ring, err := NewVerificationKeyRing(map[string]VerificationKey{
		"z_key": second,
		"a_key": first,
	})
	if err != nil {
		t.Fatal(err)
	}
	projection, err := ring.PublicProjection(11, "z_key")
	if err != nil {
		t.Fatal(err)
	}
	again, err := ring.PublicProjection(11, "z_key")
	if err != nil {
		t.Fatal(err)
	}
	if projection.Keys[0].KeyID != "a_key" || projection.Keys[1].KeyID != "z_key" ||
		projection.KeyRingDigest != again.KeyRingDigest ||
		projection.KeyRingDigest != "6ff9c0469356f330884c62682757dd877db754443f6cc48990b35293da60d3c0" {
		t.Fatalf("projection was not sorted or stable: %#v", projection)
	}
	encoded, err := json.Marshal(projection)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, firstPrivate) || bytes.Contains(encoded, secondPrivate) ||
		projection.Issuer != Issuer || projection.MaximumLifetimeSeconds != 600 ||
		len(projection.DesktopAudiences) != 4 || len(projection.KeyRingDigest) != 64 {
		t.Fatalf("unsafe public projection: %s", encoded)
	}
}

func validHandoffClaims(t *testing.T, issuedAt time.Time) Claims {
	t.Helper()
	claims, err := NewClaims(AudienceDesktop, PurposeAuthorizationHandoff, "handoff_window", vectorNonce, issuedAt)
	if err != nil {
		t.Fatal(err)
	}
	revision := int64(2)
	claims.ActorID = "user_1"
	claims.SessionID = "session_1"
	claims.ExecutorID = "executor_1"
	claims.DeviceID = vectorDeviceID
	claims.HandoffID = "handoff_window"
	claims.ExpectedSessionRevision = &revision
	return claims
}

func timePointer(value time.Time) *time.Time {
	return &value
}
