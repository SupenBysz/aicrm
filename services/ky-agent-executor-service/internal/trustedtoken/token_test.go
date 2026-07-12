package trustedtoken

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

const (
	vectorDeviceID = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c"
	vectorNonce    = "AAECAwQFBgcICQoLDA0ODw"
)

func vectorSigner(t *testing.T) (*Signer, ed25519.PublicKey) {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	signer, err := NewSigner("server_key_1", privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return signer, privateKey.Public().(ed25519.PublicKey)
}

func handoffClaims(t *testing.T) Claims {
	t.Helper()
	claims, err := NewClaims(
		AudienceDesktop, PurposeAuthorizationHandoff, "handoff_ticket_1", vectorNonce,
		time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	revision := int64(3)
	claims.ActorID = "user_1"
	claims.SessionID = "authsession_1"
	claims.ExecutorID = "aiexec_1"
	claims.DeviceID = vectorDeviceID
	claims.HandoffID = "handoff_1"
	claims.ExpectedSessionRevision = &revision
	return claims
}

func TestDeterministicCompactJWSAndHash(t *testing.T) {
	signer, publicKey := vectorSigner(t)
	claims := handoffClaims(t)
	first, err := signer.Issue(claims)
	if err != nil {
		t.Fatal(err)
	}
	second, err := signer.Issue(claims)
	if err != nil || second != first {
		t.Fatal("same persisted claims did not reconstruct the same ticket")
	}
	if strings.Contains(first, "=") || len(strings.Split(first, ".")) != 3 {
		t.Fatal("ticket is not canonical compact JWS")
	}
	verified, err := Verify(first, KeySet{"server_key_1": publicKey}, time.Unix(claims.IssuedAt+1, 0), AudienceDesktop, PurposeAuthorizationHandoff)
	if err != nil || verified.TokenID != claims.TokenID || verified.DeviceID != vectorDeviceID {
		t.Fatalf("verification mismatch: claims=%+v err=%v", verified, err)
	}
	if value := Hash(first); !hexDigest.MatchString(value) {
		t.Fatalf("ticket hash is not canonical: %s", value)
	}
}

func TestVerifyRejectsTamperingTargetMismatchAndLifetime(t *testing.T) {
	signer, publicKey := vectorSigner(t)
	claims := handoffClaims(t)
	token, err := signer.Issue(claims)
	if err != nil {
		t.Fatal(err)
	}
	keys := KeySet{"server_key_1": publicKey}
	tests := []struct {
		name     string
		token    string
		now      time.Time
		audience string
		purpose  string
		want     error
	}{
		{"unknown key", token, time.Unix(claims.IssuedAt, 0), AudienceDesktop, PurposeAuthorizationHandoff, ErrUnknownKey},
		{"audience", token, time.Unix(claims.IssuedAt, 0), AudienceCommand, PurposeAuthorizationHandoff, ErrAudienceMismatch},
		{"purpose", token, time.Unix(claims.IssuedAt, 0), AudienceDesktop, PurposeAuthorizationClaim, ErrPurposeMismatch},
		{"before issued", token, time.Unix(claims.IssuedAt-1, 0), AudienceDesktop, PurposeAuthorizationHandoff, ErrNotYetValid},
		{"at expiry", token, time.Unix(claims.ExpiresAt, 0), AudienceDesktop, PurposeAuthorizationHandoff, ErrExpired},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			useKeys := keys
			if testCase.name == "unknown key" {
				useKeys = KeySet{}
			}
			if _, err := Verify(testCase.token, useKeys, testCase.now, testCase.audience, testCase.purpose); !errors.Is(err, testCase.want) {
				t.Fatalf("got %v, want %v", err, testCase.want)
			}
		})
	}
	parts := strings.Split(token, ".")
	decoded, _ := base64.RawURLEncoding.DecodeString(parts[1])
	decoded[len(decoded)-2] ^= 1
	parts[1] = base64.RawURLEncoding.EncodeToString(decoded)
	if _, err := Verify(strings.Join(parts, "."), keys, time.Unix(claims.IssuedAt, 0), AudienceDesktop, PurposeAuthorizationHandoff); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("tampered payload was not rejected: %v", err)
	}
}

func TestPurposeSpecificClaimsFailClosed(t *testing.T) {
	signer, _ := vectorSigner(t)
	base := handoffClaims(t)
	tests := []struct {
		name   string
		mutate func(*Claims)
	}{
		{"missing target", func(value *Claims) { value.DeviceID = "" }},
		{"unexpected revision", func(value *Claims) { revision := int64(1); value.CredentialRevision = &revision }},
		{"wrong ttl", func(value *Claims) { value.ExpiresAt++ }},
		{"bad nonce", func(value *Claims) { value.Nonce += "=" }},
		{"bad device", func(value *Claims) { value.DeviceID = strings.ToUpper(value.DeviceID) }},
		{"unknown audience", func(value *Claims) { value.Audience = "other" }},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			claims := base
			testCase.mutate(&claims)
			if _, err := signer.Issue(claims); !errors.Is(err, ErrInvalidClaims) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestEveryLockedPurposeHasExactLifetimeAndTargetShape(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	positive, zero := int64(2), int64(0)
	tests := []Claims{}
	add := func(audience, purpose string) *Claims {
		claims, err := NewClaims(audience, purpose, "ticket_"+strings.ReplaceAll(purpose, "_", "-"), vectorNonce, now)
		if err != nil {
			t.Fatal(err)
		}
		tests = append(tests, claims)
		return &tests[len(tests)-1]
	}
	claim := add(AudienceClaim, PurposeAuthorizationClaim)
	claim.SessionID, claim.ExecutorID, claim.DeviceID, claim.HandoffID = "session_1", "executor_1", vectorDeviceID, "handoff_1"
	claim.ExpectedSessionRevision = &positive
	activation := add(AudienceActivation, PurposeCredentialActivation)
	activation.SessionID, activation.ExecutorID, activation.DeviceID = "session_1", "executor_1", vectorDeviceID
	activation.OperationID, activation.ActivationID, activation.BindingDigest = "operation_1", "activation_1", strings.Repeat("a", 64)
	activation.CredentialRevision, activation.LeaseEpoch, activation.SourceCredentialRevision, activation.RevocationEpoch = &positive, &positive, &zero, &zero
	for _, purpose := range []string{PurposeAuthorizationCancel, PurposeAuthorizationReopen} {
		value := add(AudienceCommand, purpose)
		value.ActorID, value.SessionID, value.ExecutorID, value.DeviceID, value.OperationID = "user_1", "session_1", "executor_1", vectorDeviceID, "operation_1"
		value.ExpectedSessionRevision = &positive
	}
	verify := add(AudienceCommand, PurposeCredentialVerify)
	verify.ActorID, verify.ExecutorID, verify.DeviceID, verify.OperationID = "user_1", "executor_1", vectorDeviceID, "operation_1"
	verify.ExpectedExecutorRevision, verify.ExpectedCredentialRevision = &positive, &positive
	catalog := add(AudienceCommand, PurposeModelCatalogRefresh)
	catalog.ActorID, catalog.ExecutorID, catalog.DeviceID, catalog.OperationID = "user_1", "executor_1", vectorDeviceID, "operation_1"
	catalog.ExpectedExecutorRevision, catalog.ExpectedCatalogRevision = &positive, &zero
	readiness := add(AudienceCommand, PurposeReadinessCheck)
	readiness.ActorID, readiness.ExecutorID, readiness.DeviceID, readiness.OperationID = "user_1", "executor_1", vectorDeviceID, "operation_1"
	readiness.ExpectedExecutorRevision, readiness.ExpectedCredentialRevision, readiness.ExpectedCatalogRevision = &positive, &positive, &zero
	logout := add(AudienceCommand, PurposeCredentialLogout)
	logout.ActorID, logout.ExecutorID, logout.DeviceID, logout.OperationID, logout.RevocationID = "user_1", "executor_1", vectorDeviceID, "operation_1", "revocation_1"
	logout.CredentialRevision, logout.RevocationEpoch = &positive, &positive
	force := add(AudienceConfirmation, PurposeForceRevoke)
	force.ActorID, force.SessionID, force.ExecutorID, force.ExpectedRevision = "user_1", "session_1", "executor_1", &positive
	rebind := add(AudienceConfirmation, PurposeRebindDevice)
	rebind.ActorID, rebind.SessionID, rebind.ExecutorID, rebind.FromDeviceID, rebind.TargetDeviceID, rebind.ExpectedRevision = "user_1", "session_1", "executor_1", vectorDeviceID, strings.Repeat("b", 64), &positive
	unbind := add(AudienceConfirmation, PurposeUnbindDevice)
	unbind.ActorID, unbind.SessionID, unbind.ExecutorID, unbind.FromDeviceID, unbind.ExpectedRevision = "user_1", "session_1", "executor_1", vectorDeviceID, &positive

	signer, _ := vectorSigner(t)
	for _, claims := range tests {
		if _, err := signer.Issue(claims); err != nil {
			t.Errorf("%s/%s was rejected: %v", claims.Audience, claims.Purpose, err)
		}
	}
}

func TestConfirmationPurposesRequireFrozenActorSession(t *testing.T) {
	signer, _ := vectorSigner(t)
	claims, err := NewClaims(
		AudienceConfirmation, PurposeForceRevoke, "confirmation_1", vectorNonce,
		time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	revision := int64(2)
	claims.ActorID, claims.ExecutorID, claims.ExpectedRevision = "user_1", "executor_1", &revision
	if _, err := signer.Issue(claims); !errors.Is(err, ErrInvalidClaims) {
		t.Fatalf("confirmation without actor session was accepted: %v", err)
	}
	claims.SessionID = "session_1"
	if _, err := signer.Issue(claims); err != nil {
		t.Fatalf("confirmation with frozen actor session was rejected: %v", err)
	}
}
