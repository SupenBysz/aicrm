package operationconfirmation

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

type fakeConfirmationStore struct {
	createdInput store.CreateOperationConfirmationInput
	created      store.OperationConfirmationProjection
	issuedFirst  string
	issuedAgain  string
	consumed     store.ConsumeOperationConfirmationInput
}

func (f *fakeConfirmationStore) ResolveOperationConfirmationAction(
	_ context.Context,
	confirmationID string,
	actorID string,
	actorSessionID string,
) (string, error) {
	if f.created.ID == confirmationID && f.created.ActorID == actorID && f.created.ActorSessionID == actorSessionID {
		return f.created.Action, nil
	}
	return "", store.ErrNotFound
}

func (f *fakeConfirmationStore) CreateOperationConfirmation(
	_ context.Context,
	input store.CreateOperationConfirmationInput,
) (store.CreateOperationConfirmationResult, error) {
	f.createdInput = input
	f.created = store.OperationConfirmationProjection{
		ID: input.ID, Action: input.Action, ExecutorID: input.ExecutorID,
		ActorID: input.ActorID, ActorSessionID: input.ActorSessionID,
		ExpectedRevision: input.ExpectedRevision, TargetDeviceID: input.TargetDeviceID,
		SecurityFactsVerified: true, OwnerVerified: input.OwnerVerified, LoginAuthenticatedAt: input.LoginAuthenticatedAt,
		MFARequired: input.MFARequired, MFAVerified: input.MFAVerified,
		ChallengeHash: input.ChallengeHash, RequestHash: input.RequestHash,
		Status: "pending", ExpiresAt: "2026-07-12T00:05:00Z",
	}
	return store.CreateOperationConfirmationResult{Confirmation: f.created, Created: true}, nil
}

func (f *fakeConfirmationStore) ConfirmOperationConfirmation(
	_ context.Context,
	_ store.ConfirmOperationConfirmationInput,
	issuer store.OperationConfirmationTokenIssuer,
) (store.ConfirmOperationConfirmationResult, error) {
	issuedAt := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	first, err := issuer(f.created, issuedAt)
	if err != nil {
		return store.ConfirmOperationConfirmationResult{}, err
	}
	again, err := issuer(f.created, issuedAt)
	if err != nil {
		return store.ConfirmOperationConfirmationResult{}, err
	}
	f.issuedFirst, f.issuedAgain = first.Token, again.Token
	expiresAt := first.ExpiresAt.Format(time.RFC3339Nano)
	projection := f.created
	projection.Status = "confirmed"
	projection.TokenExpiresAt = &expiresAt
	return store.ConfirmOperationConfirmationResult{Confirmation: projection, Token: first.Token}, nil
}

func (f *fakeConfirmationStore) ConsumeOperationConfirmation(
	_ context.Context,
	verifier store.OperationConfirmationTokenVerifier,
	_ store.OperationConfirmationMutation,
) (store.OperationConfirmationProjection, error) {
	input, err := verifier(time.Date(2026, 7, 12, 0, 0, 1, 0, time.UTC))
	if err != nil {
		return store.OperationConfirmationProjection{}, err
	}
	f.consumed = input
	projection := f.created
	projection.Status = "consumed"
	return projection, nil
}

func TestManagerKeepsChallengeDigestOnlyAndIssuesDeterministicBoundToken(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	signer, err := trustedtoken.NewSigner("confirmation_key_1", privateKey)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeConfirmationStore{}
	challengeSecret := bytes.Repeat([]byte{0x42}, 32)
	nonceSecret := bytes.Repeat([]byte{0x43}, 32)
	manager, err := New(fake, signer, trustedtoken.KeySet{
		"confirmation_key_1": privateKey.Public().(ed25519.PublicKey),
	}, challengeSecret, nonceSecret)
	if err != nil {
		t.Fatal(err)
	}
	manager.random = bytes.NewReader(bytes.Repeat([]byte{0x24}, 18))
	loginAt := time.Date(2026, 7, 11, 23, 55, 0, 0, time.UTC)
	created, err := manager.Create(context.Background(), CreateInput{
		Action: store.OperationConfirmationRebindDevice, ExecutorID: "executor_1",
		ActorID: "owner_1", ActorSessionID: "login_session_1", ExpectedRevision: 3,
		TargetDeviceID: strings.Repeat("b", 64), OwnerVerified: true,
		LoginAuthenticatedAt: loginAt, MFARequired: true, MFAVerified: true,
		IdempotencyKeyHash: digestForTest("key"), RequestHash: digestForTest("request"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.ChallengeText == "" || strings.Contains(fake.createdInput.ChallengeHash, created.ChallengeText) ||
		fake.createdInput.ChallengeHash != digestForTest(created.ChallengeText) {
		t.Fatalf("challenge was not reduced to its digest: %#v", fake.createdInput)
	}
	fake.created.FromDeviceID = strings.Repeat("a", 64)
	confirmed, err := manager.Confirm(context.Background(), ConfirmInput{
		ConfirmationID: created.ConfirmationID, ActorID: "owner_1", ActorSessionID: "login_session_1",
		ChallengeText: created.ChallengeText, OwnerVerified: true,
		LoginAuthenticatedAt: loginAt, MFARequired: true, MFAVerified: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if confirmed.ConfirmationToken == "" || fake.issuedFirst != fake.issuedAgain {
		t.Fatal("identical persisted claims did not produce the same compact JWS")
	}
	restarted, err := New(fake, signer, trustedtoken.KeySet{
		"confirmation_key_1": privateKey.Public().(ed25519.PublicKey),
	}, challengeSecret, nonceSecret)
	if err != nil {
		t.Fatal(err)
	}
	replayedAfterRestart, err := restarted.Confirm(context.Background(), ConfirmInput{
		ConfirmationID: created.ConfirmationID, ActorID: "owner_1", ActorSessionID: "login_session_1",
		ChallengeText: created.ChallengeText, OwnerVerified: true,
		LoginAuthenticatedAt: loginAt, MFARequired: true, MFAVerified: true,
	})
	if err != nil || replayedAfterRestart.ConfirmationToken != confirmed.ConfirmationToken {
		t.Fatalf("restart token replay=%#v err=%v", replayedAfterRestart, err)
	}
	claims, err := trustedtoken.Verify(
		confirmed.ConfirmationToken,
		trustedtoken.KeySet{"confirmation_key_1": privateKey.Public().(ed25519.PublicKey)},
		time.Date(2026, 7, 12, 0, 0, 1, 0, time.UTC),
		trustedtoken.AudienceConfirmation, trustedtoken.PurposeRebindDevice,
	)
	if err != nil {
		t.Fatal(err)
	}
	if claims.ActorID != "owner_1" || claims.SessionID != "login_session_1" ||
		claims.ExecutorID != "executor_1" || claims.FromDeviceID != strings.Repeat("a", 64) ||
		claims.TargetDeviceID != strings.Repeat("b", 64) || claims.ExpectedRevision == nil ||
		*claims.ExpectedRevision != 3 {
		t.Fatalf("token targets not frozen: %#v", claims)
	}
	consumed, err := manager.Consume(context.Background(), ConsumeInput{
		ConfirmationToken:    confirmed.ConfirmationToken,
		Action:               store.OperationConfirmationRebindDevice,
		ActorID:              "owner_1",
		ActorSessionID:       "login_session_1",
		ExecutorID:           "executor_1",
		ExpectedRevision:     3,
		FromDeviceID:         strings.Repeat("a", 64),
		TargetDeviceID:       strings.Repeat("b", 64),
		ConsumptionReference: "rebind_operation_1",
	}, func(context.Context, *sql.Tx, store.OperationConfirmationProjection) error { return nil })
	if err != nil || consumed.Status != "consumed" {
		t.Fatalf("database-clock token verification failed: consumed=%#v err=%v", consumed, err)
	}
}

func TestManagerRequiresIndependentChallengeAndTokenNonceSecrets(t *testing.T) {
	seed := bytes.Repeat([]byte{0x21}, ed25519.SeedSize)
	privateKey := ed25519.NewKeyFromSeed(seed)
	signer, err := trustedtoken.NewSigner("confirmation_key_1", privateKey)
	if err != nil {
		t.Fatal(err)
	}
	keys := trustedtoken.KeySet{"confirmation_key_1": privateKey.Public().(ed25519.PublicKey)}
	fake := &fakeConfirmationStore{}
	challenge := bytes.Repeat([]byte{0x31}, 32)
	if _, err := New(fake, signer, keys, challenge, challenge); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("reused challenge/nonce secret was accepted: %v", err)
	}
	if _, err := New(fake, signer, keys, challenge, []byte("too-short")); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("short nonce secret was accepted: %v", err)
	}
	nonceSecret := bytes.Repeat([]byte{0x32}, 32)
	first, err := New(fake, signer, keys, challenge, nonceSecret)
	if err != nil {
		t.Fatal(err)
	}
	second, err := New(fake, signer, keys, bytes.Repeat([]byte{0x33}, 32), nonceSecret)
	if err != nil {
		t.Fatal(err)
	}
	third, err := New(fake, signer, keys, challenge, bytes.Repeat([]byte{0x34}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if first.tokenNonce("confirmation_1") != second.tokenNonce("confirmation_1") ||
		first.challengeText("confirmation_1") == second.challengeText("confirmation_1") ||
		first.tokenNonce("confirmation_1") == third.tokenNonce("confirmation_1") {
		t.Fatal("challenge and trusted-token nonce derivation domains were not independent")
	}
}

func digestForTest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
