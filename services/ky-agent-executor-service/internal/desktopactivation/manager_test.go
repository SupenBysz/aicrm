package desktopactivation

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

type activationStoreStub struct {
	submit func(context.Context, store.SubmitDesktopAuthorizationProofInput, store.DesktopClaimTokenVerifier, store.DesktopActivationTokenIssuer) (store.SubmitDesktopAuthorizationProofResult, error)
	renew  func(context.Context, store.RenewDesktopCredentialActivationLeaseInput, store.DesktopActivationTokenVerifier) (store.RenewDesktopCredentialActivationLeaseResult, error)
	ack    func(context.Context, store.AcknowledgeDesktopCredentialActivationInput, store.DesktopActivationTokenVerifier) (store.AcknowledgeDesktopCredentialActivationResult, error)
}

func (stub activationStoreStub) SubmitDesktopAuthorizationProof(
	ctx context.Context,
	input store.SubmitDesktopAuthorizationProofInput,
	verifier store.DesktopClaimTokenVerifier,
	issuer store.DesktopActivationTokenIssuer,
) (store.SubmitDesktopAuthorizationProofResult, error) {
	return stub.submit(ctx, input, verifier, issuer)
}

func (stub activationStoreStub) AcknowledgeDesktopCredentialActivation(
	ctx context.Context,
	input store.AcknowledgeDesktopCredentialActivationInput,
	verifier store.DesktopActivationTokenVerifier,
) (store.AcknowledgeDesktopCredentialActivationResult, error) {
	return stub.ack(ctx, input, verifier)
}

func (stub activationStoreStub) RenewDesktopCredentialActivationLease(
	ctx context.Context,
	input store.RenewDesktopCredentialActivationLeaseInput,
	verifier store.DesktopActivationTokenVerifier,
) (store.RenewDesktopCredentialActivationLeaseResult, error) {
	return stub.renew(ctx, input, verifier)
}

func TestManagerBindsAndDeterministicallyReconstructsActivationToken(t *testing.T) {
	issuedAt := time.Date(2026, time.July, 13, 6, 7, 8, 0, time.UTC)
	signer, publicKey := activationTestSigner(t, 19, "activation-key-1")
	keys := trustedtoken.KeySet{"activation-key-1": publicKey}
	secret := bytes.Repeat([]byte{0x5a}, 32)
	deviceID := string(bytes.Repeat([]byte{'a'}, 64))
	bindingDigest := string(bytes.Repeat([]byte{'b'}, 64))
	claimToken := activationTestClaimToken(t, signer, issuedAt, deviceID)

	var activationToken string
	stub := activationStoreStub{}
	stub.submit = func(_ context.Context, input store.SubmitDesktopAuthorizationProofInput, verifier store.DesktopClaimTokenVerifier, issuer store.DesktopActivationTokenIssuer) (store.SubmitDesktopAuthorizationProofResult, error) {
		claim, err := verifier(issuedAt.Add(time.Minute))
		if err != nil {
			return store.SubmitDesktopAuthorizationProofResult{}, err
		}
		if claim.SessionID != "session_1" || claim.ExecutorID != "executor_1" ||
			claim.DeviceID != deviceID || claim.HandoffID != "handoff_1" ||
			claim.ExpectedSessionRevision != 2 || claim.TokenHash != trustedtoken.Hash(claimToken) {
			t.Fatalf("unexpected claim: %#v", claim)
		}
		activation := store.DesktopCredentialActivationProjection{
			ID: input.ActivationID, SessionID: input.SessionID, ProofID: input.ProofID,
			ExecutorID: "executor_1", DeviceID: input.TargetDeviceID,
			OperationID: input.OperationID, CredentialRevision: 3, LeaseEpoch: 7,
			SourceCredentialRevision: 2, RevocationEpoch: 4,
			BindingDigest: input.CandidateBindingDigest,
			IssuedAt:      issuedAt.Add(time.Minute),
			ExpiresAt:     issuedAt.Add(time.Minute).Add(store.DesktopActivationLifetime),
		}
		first, err := issuer(activation, activation.IssuedAt)
		if err != nil {
			return store.SubmitDesktopAuthorizationProofResult{}, err
		}
		second, err := issuer(activation, activation.IssuedAt)
		if err != nil {
			return store.SubmitDesktopAuthorizationProofResult{}, err
		}
		if first.Token != second.Token || first.Hash != second.Hash || first.Nonce != second.Nonce {
			t.Fatal("activation token reconstruction was not deterministic")
		}
		activationToken = first.Token
		activation.ActivationTokenHash = first.Hash
		activation.ActivationTokenKeyID = first.KeyID
		activation.ActivationTokenNonceHash = first.NonceHash
		proof := store.DesktopAuthorizationProofProjection{
			ID: input.ProofID, Result: input.Result,
		}
		return store.SubmitDesktopAuthorizationProofResult{
			Proof: proof, Activation: &activation, ActivationToken: first.Token,
			SessionRevision: 3,
		}, nil
	}
	stub.ack = func(_ context.Context, input store.AcknowledgeDesktopCredentialActivationInput, verifier store.DesktopActivationTokenVerifier) (store.AcknowledgeDesktopCredentialActivationResult, error) {
		token, err := verifier(issuedAt.Add(2 * time.Minute))
		if err != nil {
			return store.AcknowledgeDesktopCredentialActivationResult{}, err
		}
		if token.ActivationID != input.ActivationID || token.OperationID != input.OperationID ||
			token.CredentialRevision != 3 || token.LeaseEpoch != 7 ||
			token.SourceCredentialRevision != 2 || token.RevocationEpoch != 4 ||
			token.BindingDigest != bindingDigest || token.TokenHash != trustedtoken.Hash(activationToken) {
			t.Fatalf("unexpected activation claims: %#v", token)
		}
		return store.AcknowledgeDesktopCredentialActivationResult{
			ActivationID: input.ActivationID, ExecutorID: token.ExecutorID,
			CredentialRevision: token.CredentialRevision, SessionRevision: 4,
		}, nil
	}
	stub.renew = func(_ context.Context, input store.RenewDesktopCredentialActivationLeaseInput, verifier store.DesktopActivationTokenVerifier) (store.RenewDesktopCredentialActivationLeaseResult, error) {
		token, err := verifier(issuedAt.Add(90 * time.Second))
		if err != nil {
			return store.RenewDesktopCredentialActivationLeaseResult{}, err
		}
		if token.ActivationID != input.ActivationID || token.OperationID != input.OperationID ||
			token.CredentialRevision != 3 || token.LeaseEpoch != 7 ||
			token.SourceCredentialRevision != 2 || token.RevocationEpoch != 4 ||
			token.BindingDigest != bindingDigest || token.TokenHash != trustedtoken.Hash(activationToken) ||
			input.CredentialRevision != 3 || input.LeaseEpoch != 7 ||
			input.SourceCredentialRevision != 2 || input.RevocationEpoch != 4 ||
			input.BindingDigest != bindingDigest {
			t.Fatalf("unexpected renewal claims: %#v", token)
		}
		renewedAt := issuedAt.Add(90 * time.Second)
		return store.RenewDesktopCredentialActivationLeaseResult{
			ActivationID: input.ActivationID, ExecutorID: token.ExecutorID,
			OperationID: token.OperationID, CredentialRevision: token.CredentialRevision,
			LeaseEpoch: token.LeaseEpoch, SourceCredentialRevision: token.SourceCredentialRevision,
			RevocationEpoch: token.RevocationEpoch, RenewedAt: renewedAt,
			LeaseExpiresAt: renewedAt.Add(30 * time.Second), Replayed: true,
		}, nil
	}

	manager, err := New(stub, signer, keys, secret)
	if err != nil {
		t.Fatal(err)
	}
	manager.random = bytes.NewReader(bytes.Repeat([]byte{0x31}, 54))
	proof, err := manager.SubmitProof(context.Background(), SubmitProofInput{
		ClaimToken: claimToken, SessionID: "session_1", HandoffID: "handoff_1",
		TargetDeviceID: deviceID, SessionRevision: 2, Result: "succeeded",
		CandidateBindingDigest: bindingDigest,
	})
	if err != nil || proof.Activation == nil || proof.Activation.ActivationToken != activationToken {
		t.Fatalf("proof=%#v err=%v", proof, err)
	}
	claims, err := trustedtoken.Verify(activationToken, keys, issuedAt.Add(2*time.Minute),
		trustedtoken.AudienceActivation, trustedtoken.PurposeCredentialActivation)
	if err != nil || claims.ActivationID != proof.Activation.ActivationID ||
		claims.BindingDigest != bindingDigest {
		t.Fatalf("claims=%#v err=%v", claims, err)
	}
	renewed, err := manager.RenewLease(context.Background(), RenewLeaseInput{
		ActivationToken: activationToken, SessionID: "session_1",
		ActivationID: proof.Activation.ActivationID, TargetDeviceID: deviceID,
		OperationID:              proof.Activation.OperationID,
		CredentialRevision:       proof.Activation.CredentialRevision,
		LeaseEpoch:               proof.Activation.LeaseEpoch,
		SourceCredentialRevision: proof.Activation.SourceCredentialRevision,
		RevocationEpoch:          proof.Activation.RevocationEpoch,
		BindingDigest:            proof.Activation.BindingDigest,
	})
	if err != nil || renewed.CredentialRevision != 3 || renewed.LeaseEpoch != 7 ||
		renewed.RenewedAt != issuedAt.Add(90*time.Second).Format(time.RFC3339Nano) ||
		renewed.LeaseExpiresAt != issuedAt.Add(2*time.Minute).Format(time.RFC3339Nano) || !renewed.Replayed {
		t.Fatalf("renewed=%#v err=%v", renewed, err)
	}
	ack, err := manager.Acknowledge(context.Background(), AcknowledgeInput{
		ActivationToken: activationToken, SessionID: "session_1",
		ActivationID: proof.Activation.ActivationID, TargetDeviceID: deviceID,
		OperationID: proof.Activation.OperationID,
	})
	if err != nil || ack.CredentialRevision != 3 || ack.SessionRevision != 4 {
		t.Fatalf("ack=%#v err=%v", ack, err)
	}
}

func TestManagerUsesDatabaseTimeAndFailsClosedOnSigningKeyRotation(t *testing.T) {
	issuedAt := time.Date(2026, time.July, 13, 7, 8, 9, 0, time.UTC)
	oldSigner, oldPublic := activationTestSigner(t, 29, "activation-old")
	newSigner, newPublic := activationTestSigner(t, 43, "activation-new")
	keys := trustedtoken.KeySet{"activation-old": oldPublic, "activation-new": newPublic}
	deviceID := string(bytes.Repeat([]byte{'c'}, 64))
	claimToken := activationTestClaimToken(t, oldSigner, issuedAt, deviceID)
	secret := bytes.Repeat([]byte{0x6d}, 32)

	stub := activationStoreStub{
		submit: func(_ context.Context, input store.SubmitDesktopAuthorizationProofInput, verifier store.DesktopClaimTokenVerifier, issuer store.DesktopActivationTokenIssuer) (store.SubmitDesktopAuthorizationProofResult, error) {
			if _, err := verifier(issuedAt.Add(5 * time.Minute)); err != nil {
				return store.SubmitDesktopAuthorizationProofResult{}, err
			}
			_, err := issuer(store.DesktopCredentialActivationProjection{
				ID: input.ActivationID, ActivationTokenKeyID: "activation-old",
			}, issuedAt)
			return store.SubmitDesktopAuthorizationProofResult{}, err
		},
		ack: func(_ context.Context, _ store.AcknowledgeDesktopCredentialActivationInput, verifier store.DesktopActivationTokenVerifier) (store.AcknowledgeDesktopCredentialActivationResult, error) {
			_, err := verifier(issuedAt.Add(store.DesktopActivationLifetime))
			return store.AcknowledgeDesktopCredentialActivationResult{}, err
		},
	}
	manager, err := New(stub, newSigner, keys, secret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SubmitProof(context.Background(), SubmitProofInput{
		ClaimToken: claimToken, SessionID: "session_1", HandoffID: "handoff_1",
		TargetDeviceID: deviceID, Result: "succeeded",
	}); !errors.Is(err, trustedtoken.ErrExpired) {
		t.Fatalf("claim token did not use callback database time: %v", err)
	}

	// A persisted token signed by the retired key cannot be silently rebuilt
	// with the current private key.
	freshClaim := activationTestClaimToken(t, oldSigner, issuedAt.Add(4*time.Minute), deviceID)
	if _, err := manager.SubmitProof(context.Background(), SubmitProofInput{
		ClaimToken: freshClaim, SessionID: "session_1", HandoffID: "handoff_1",
		TargetDeviceID: deviceID, Result: "succeeded",
	}); !errors.Is(err, ErrTokenKeyUnavailable) {
		t.Fatalf("rotated signer rebuilt retired token: %v", err)
	}
}

func activationTestSigner(t *testing.T, seedByte byte, keyID string) (*trustedtoken.Signer, ed25519.PublicKey) {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = seedByte + byte(index)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	signer, err := trustedtoken.NewSigner(keyID, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return signer, append(ed25519.PublicKey(nil), privateKey.Public().(ed25519.PublicKey)...)
}

func activationTestClaimToken(t *testing.T, signer *trustedtoken.Signer, issuedAt time.Time, deviceID string) string {
	t.Helper()
	nonce := base64Nonce(0x7b)
	claims, err := trustedtoken.NewClaims(trustedtoken.AudienceClaim,
		trustedtoken.PurposeAuthorizationClaim, "handoff_1", nonce, issuedAt)
	if err != nil {
		t.Fatal(err)
	}
	claims.SessionID, claims.ExecutorID, claims.DeviceID = "session_1", "executor_1", deviceID
	claims.HandoffID = "handoff_1"
	revision := int64(2)
	claims.ExpectedSessionRevision = &revision
	token, err := signer.Issue(claims)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func base64Nonce(seed byte) string {
	raw := make([]byte, 16)
	for index := range raw {
		raw[index] = seed + byte(index)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}
