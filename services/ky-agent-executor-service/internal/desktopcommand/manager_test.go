package desktopcommand

import (
	"context"
	"crypto/ed25519"
	"errors"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

type fakeDesktopCommandStore struct {
	lookupResult store.CreateDesktopAuthorizationCommandResult
	lookupFound  bool
	lookupErr    error
	lookupInput  store.DesktopAuthorizationCommandRequest
	createInput  store.CreateDesktopAuthorizationCommandInput
	createResult store.CreateDesktopAuthorizationCommandResult
	createErr    error
	ackInput     store.AcknowledgeDesktopAuthorizationCommandInput
	ackVerifier  store.DesktopAuthorizationCommandTicketVerifier
	ackResult    store.AcknowledgeDesktopAuthorizationCommandResult
	ackErr       error
	databaseNow  time.Time
	lookupCalls  int
	createCalls  int
	ackCalls     int
}

func (f *fakeDesktopCommandStore) LookupDesktopAuthorizationCommand(
	_ context.Context,
	input store.DesktopAuthorizationCommandRequest,
) (store.CreateDesktopAuthorizationCommandResult, bool, error) {
	f.lookupCalls++
	f.lookupInput = input
	return f.lookupResult, f.lookupFound, f.lookupErr
}

func (f *fakeDesktopCommandStore) CreateDesktopAuthorizationCommand(
	_ context.Context,
	input store.CreateDesktopAuthorizationCommandInput,
	issuer store.DesktopAuthorizationCommandTicketIssuer,
) (store.CreateDesktopAuthorizationCommandResult, error) {
	f.createCalls++
	f.createInput = input
	if f.createErr != nil {
		return store.CreateDesktopAuthorizationCommandResult{}, f.createErr
	}
	result := f.createResult
	if !result.CommandCreated {
		return result, nil
	}
	result.Command.OperationID = input.OperationID
	result.Command.SessionID = input.SessionID
	result.Command.ActorID = input.ActorID
	result.Command.ActorSessionID = input.ActorSessionID
	result.Command.Purpose = input.Purpose
	result.Command.ExpectedSessionRevision = input.ExpectedSessionRevision
	result.Command.IdempotencyKeyHash = input.IdempotencyKeyHash
	result.Command.RequestHash = input.RequestHash
	issued, err := issuer(result.Command, f.databaseNow)
	if err != nil {
		return store.CreateDesktopAuthorizationCommandResult{}, err
	}
	result.Command.CommandTicketHash = issued.Hash
	result.Command.TokenKeyID = issued.KeyID
	result.Command.TokenNonceHash = issued.NonceHash
	result.Command.TokenIssuedAt = f.databaseNow.UTC().Truncate(time.Second)
	result.Command.ExpiresAt = issued.ExpiresAt.UTC().Format(time.RFC3339Nano)
	result.Command.SecurityContractVerified = true
	return result, nil
}

func (f *fakeDesktopCommandStore) AcknowledgeDesktopAuthorizationCommand(
	_ context.Context,
	input store.AcknowledgeDesktopAuthorizationCommandInput,
	verifier store.DesktopAuthorizationCommandTicketVerifier,
) (store.AcknowledgeDesktopAuthorizationCommandResult, error) {
	f.ackCalls++
	f.ackInput = input
	f.ackVerifier = verifier
	return f.ackResult, f.ackErr
}

func desktopCommandSigner(t *testing.T, seedByte byte, keyID string) (*trustedtoken.Signer, ed25519.PublicKey) {
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

func desktopCommandManager(t *testing.T, control Store, seedByte byte, keyID string) (*Manager, ed25519.PublicKey) {
	t.Helper()
	signer, publicKey := desktopCommandSigner(t, seedByte, keyID)
	manager, err := New(control, signer, trustedtoken.KeySet{keyID: publicKey}, []byte("desktop-command-independent-nonce-secret-0001"))
	if err != nil {
		t.Fatal(err)
	}
	return manager, publicKey
}

func desktopCommandCreateInput() CreateInput {
	return CreateInput{
		SessionID: "auth_session_1", ActorID: "actor_1", ActorSessionID: "actor_session_1",
		ExpectedSessionRevision: 4,
		IdempotencyKeyHash:      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RequestHash:             "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	}
}

func TestManagerCreatesTargetBoundDeterministicCancelTicket(t *testing.T) {
	now := time.Date(2026, 7, 13, 3, 0, 0, 987000000, time.UTC)
	control := &fakeDesktopCommandStore{
		databaseNow: now,
		createResult: store.CreateDesktopAuthorizationCommandResult{
			Session: store.AuthorizationSessionProjection{ID: "auth_session_1", ExecutorID: "executor_1", Status: "cancelled", Revision: 5},
			Command: store.DesktopAuthorizationCommandProjection{
				ExecutorID: "executor_1", DeviceID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			},
			CommandCreated: true, Transitioned: true,
		},
	}
	signer, publicKey := desktopCommandSigner(t, 7, "desktop-command-key-1")
	window, err := trustedtoken.NewKeyWindow(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	verificationKey, err := trustedtoken.NewVerificationKey(publicKey, window)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := NewWithKeyRing(control, signer, trustedtoken.VerificationKeyRing{
		"desktop-command-key-1": verificationKey,
	}, []byte("desktop-command-independent-nonce-secret-0001"))
	if err != nil {
		t.Fatal(err)
	}
	result, err := manager.Cancel(context.Background(), desktopCommandCreateInput())
	if err != nil {
		t.Fatal(err)
	}
	if control.lookupCalls != 1 || control.createCalls != 1 || result.CommandTicket == "" ||
		result.Command.Purpose != trustedtoken.PurposeAuthorizationCancel || !result.Transitioned {
		t.Fatalf("unexpected result=%#v lookup=%d create=%d", result, control.lookupCalls, control.createCalls)
	}
	claims, err := trustedtoken.Verify(result.CommandTicket,
		trustedtoken.KeySet{"desktop-command-key-1": publicKey}, now,
		trustedtoken.AudienceCommand, trustedtoken.PurposeAuthorizationCancel)
	if err != nil {
		t.Fatal(err)
	}
	if claims.ActorID != "actor_1" || claims.SessionID != "auth_session_1" ||
		claims.ExecutorID != "executor_1" || claims.DeviceID != result.Command.DeviceID ||
		claims.TokenID != result.Command.OperationID ||
		claims.OperationID != result.Command.OperationID || claims.ExpectedSessionRevision == nil ||
		*claims.ExpectedSessionRevision != 4 || claims.ExpiresAt-claims.IssuedAt != 120 {
		t.Fatalf("unexpected claims: %#v", claims)
	}

	control.lookupFound = true
	control.lookupResult = result
	control.lookupResult.CommandTicket = ""
	replay, err := manager.Cancel(context.Background(), desktopCommandCreateInput())
	if err != nil || replay.CommandTicket != result.CommandTicket || control.createCalls != 1 {
		t.Fatalf("replay=%#v err=%v createCalls=%d", replay, err, control.createCalls)
	}
}

func TestManagerTerminalCancelWithoutCommandNeverIssuesTicket(t *testing.T) {
	control := &fakeDesktopCommandStore{lookupFound: true, lookupResult: store.CreateDesktopAuthorizationCommandResult{
		Session: store.AuthorizationSessionProjection{ID: "auth_session_1", Status: "cancelled", Revision: 5},
	}}
	manager, _ := desktopCommandManager(t, control, 17, "desktop-command-key-1")
	result, err := manager.Cancel(context.Background(), desktopCommandCreateInput())
	if err != nil || result.CommandCreated || result.CommandTicket != "" || control.createCalls != 0 {
		t.Fatalf("result=%#v err=%v calls=%d", result, err, control.createCalls)
	}
}

func TestManagerOldPrivateKeyRotationFailsClosedOnReconstruction(t *testing.T) {
	control := &fakeDesktopCommandStore{databaseNow: time.Date(2026, 7, 13, 3, 0, 0, 0, time.UTC),
		createResult: store.CreateDesktopAuthorizationCommandResult{
			Session: store.AuthorizationSessionProjection{ID: "auth_session_1"},
			Command: store.DesktopAuthorizationCommandProjection{
				ExecutorID: "executor_1", DeviceID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			}, CommandCreated: true,
		}}
	oldManager, oldPublic := desktopCommandManager(t, control, 27, "old-command-key")
	created, err := oldManager.Reopen(context.Background(), desktopCommandCreateInput())
	if err != nil {
		t.Fatal(err)
	}
	control.lookupFound = true
	control.lookupResult = created
	control.lookupResult.CommandTicket = ""
	newSigner, newPublic := desktopCommandSigner(t, 37, "new-command-key")
	rotated, err := New(control, newSigner, trustedtoken.KeySet{
		"old-command-key": oldPublic, "new-command-key": newPublic,
	}, []byte("desktop-command-independent-nonce-secret-0001"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = rotated.Reopen(context.Background(), desktopCommandCreateInput())
	if !errors.Is(err, ErrTokenKeyUnavailable) {
		t.Fatalf("expected key unavailable, got %v", err)
	}
}

func TestManagerACKVerifierUsesDatabaseClockAndExactPurpose(t *testing.T) {
	now := time.Date(2026, 7, 13, 3, 0, 0, 0, time.UTC)
	control := &fakeDesktopCommandStore{databaseNow: now, createResult: store.CreateDesktopAuthorizationCommandResult{
		Session: store.AuthorizationSessionProjection{ID: "auth_session_1"},
		Command: store.DesktopAuthorizationCommandProjection{
			ExecutorID: "executor_1", DeviceID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		}, CommandCreated: true,
	}}
	manager, _ := desktopCommandManager(t, control, 47, "desktop-command-key-1")
	created, err := manager.Reopen(context.Background(), desktopCommandCreateInput())
	if err != nil {
		t.Fatal(err)
	}
	ackInput := store.AcknowledgeDesktopAuthorizationCommandInput{
		SessionID: "auth_session_1", OperationID: created.Command.OperationID,
		Purpose: trustedtoken.PurposeAuthorizationReopen, ExpectedSessionRevision: 4,
		Result: "succeeded", CompletedAt: now,
	}
	if _, err := manager.Acknowledge(context.Background(), ackInput, created.CommandTicket); err != nil {
		t.Fatal(err)
	}
	verified, err := control.ackVerifier(now.Add(time.Minute))
	if err != nil || verified.TokenID != created.Command.OperationID ||
		verified.OperationID != created.Command.OperationID ||
		verified.Purpose != trustedtoken.PurposeAuthorizationReopen {
		t.Fatalf("verified=%#v err=%v", verified, err)
	}
	if _, err := control.ackVerifier(now.Add(DesktopAuthorizationCommandExpiryDelta)); !errors.Is(err, trustedtoken.ErrExpired) {
		t.Fatalf("expected expiry, got %v", err)
	}
}

const DesktopAuthorizationCommandExpiryDelta = 2 * time.Minute
