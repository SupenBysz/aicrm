package credentialrevocation

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/operationconfirmation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

type keyringCredentialRevocationStore struct{}

func (keyringCredentialRevocationStore) LookupCredentialRevocation(context.Context, store.CredentialRevocationRequest) (store.CreateCredentialRevocationResult, bool, error) {
	return store.CreateCredentialRevocationResult{}, false, nil
}

func (keyringCredentialRevocationStore) CreateNormalCredentialRevocation(context.Context, store.CreateCredentialRevocationInput, store.CredentialLogoutTicketIssuer) (store.CreateCredentialRevocationResult, error) {
	return store.CreateCredentialRevocationResult{}, nil
}

func (keyringCredentialRevocationStore) ForceCredentialRevocationMutation(store.CreateCredentialRevocationInput, *store.CreateCredentialRevocationResult, store.CredentialLogoutTicketIssuer) store.OperationConfirmationMutation {
	return nil
}

func (keyringCredentialRevocationStore) AcknowledgeCredentialRevocation(context.Context, store.AcknowledgeCredentialRevocationInput, store.CredentialLogoutTicketVerifier) (store.AcknowledgeCredentialRevocationResult, error) {
	return store.AcknowledgeCredentialRevocationResult{}, nil
}

type keyringConfirmationConsumer struct{}

func (keyringConfirmationConsumer) Consume(context.Context, operationconfirmation.ConsumeInput, store.OperationConfirmationMutation) (store.OperationConfirmationProjection, error) {
	return store.OperationConfirmationProjection{}, nil
}

func TestNewWithKeyRingUsesWindowedLogoutVerifier(t *testing.T) {
	start := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x71}, ed25519.SeedSize))
	signer, _ := trustedtoken.NewSigner("logout_key_1", privateKey)
	window, _ := trustedtoken.NewKeyWindow(start, nil, nil)
	verificationKey, _ := trustedtoken.NewVerificationKey(privateKey.Public().(ed25519.PublicKey), window)
	manager, err := NewWithKeyRing(
		keyringCredentialRevocationStore{}, keyringConfirmationConsumer{}, signer,
		trustedtoken.VerificationKeyRing{"logout_key_1": verificationKey},
		bytes.Repeat([]byte{0x72}, 32),
	)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := trustedtoken.NewClaims(
		trustedtoken.AudienceCommand, trustedtoken.PurposeCredentialLogout,
		"revocation_1", "AAECAwQFBgcICQoLDA0ODw", start,
	)
	if err != nil {
		t.Fatal(err)
	}
	revision, epoch := int64(2), int64(3)
	claims.ActorID, claims.ExecutorID = "actor_1", "executor_1"
	claims.DeviceID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	claims.OperationID, claims.RevocationID = "operation_1", "revocation_1"
	claims.CredentialRevision, claims.RevocationEpoch = &revision, &epoch
	token, err := signer.Issue(claims)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := manager.verifyLogoutTicket(token)(start)
	if err != nil || verified.RevocationID != "revocation_1" || verified.CredentialRevision != 2 {
		t.Fatalf("verified=%#v err=%v", verified, err)
	}

	beforeWindow := claims
	beforeWindow.IssuedAt--
	beforeWindow.ExpiresAt--
	invalidToken, err := signer.Issue(beforeWindow)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.verifyLogoutTicket(invalidToken)(start); !errors.Is(err, trustedtoken.ErrKeyWindowMismatch) {
		t.Fatalf("window mismatch was not enforced: %v", err)
	}
}
