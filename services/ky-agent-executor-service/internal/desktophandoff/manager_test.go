package desktophandoff

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

type managerStoreStub struct {
	create func(context.Context, store.CreateDesktopHandoffInput, store.DesktopHandoffTicketIssuer) (store.CreateDesktopHandoffResult, error)
	claim  func(context.Context, store.ClaimDesktopHandoffInput, store.DesktopHandoffTicketVerifier, store.DesktopClaimTokenIssuer) (store.ClaimDesktopHandoffResult, error)
}

func (stub managerStoreStub) CreateDesktopHandoff(
	ctx context.Context,
	input store.CreateDesktopHandoffInput,
	issuer store.DesktopHandoffTicketIssuer,
) (store.CreateDesktopHandoffResult, error) {
	return stub.create(ctx, input, issuer)
}

func (stub managerStoreStub) ClaimDesktopHandoff(
	ctx context.Context,
	input store.ClaimDesktopHandoffInput,
	verifier store.DesktopHandoffTicketVerifier,
	issuer store.DesktopClaimTokenIssuer,
) (store.ClaimDesktopHandoffResult, error) {
	return stub.claim(ctx, input, verifier, issuer)
}

func TestManagerIssuesDeterministicTargetBoundTokens(t *testing.T) {
	issuedAt := time.Date(2026, time.July, 13, 1, 2, 3, 0, time.UTC)
	signer, publicKey := managerSigner(t, 11, "desktop-key-1")
	secret := bytes.Repeat([]byte{0x4a}, 32)

	var ticket string
	stub := managerStoreStub{}
	stub.create = func(_ context.Context, input store.CreateDesktopHandoffInput, issuer store.DesktopHandoffTicketIssuer) (store.CreateDesktopHandoffResult, error) {
		item := store.DesktopHandoffProjection{
			ID: input.ID, SessionID: input.SessionID, ExecutorID: "executor_desktop_1",
			DeviceID: input.DeviceID, RequestedBy: input.ActorID,
			ExpectedSessionRevision: input.ExpectedSessionRevision,
			IssuedAt:                issuedAt, ExpiresAt: issuedAt.Add(store.DesktopHandoffLifetime),
		}
		first, err := issuer(item, issuedAt)
		if err != nil {
			return store.CreateDesktopHandoffResult{}, err
		}
		second, err := issuer(item, issuedAt)
		if err != nil {
			return store.CreateDesktopHandoffResult{}, err
		}
		if first.Token != second.Token || first.Nonce != second.Nonce || first.Hash != second.Hash {
			t.Fatal("handoff ticket was not deterministically reconstructed")
		}
		ticket = first.Token
		item.TicketHash, item.TicketNonceHash, item.TokenKeyID = first.Hash, first.NonceHash, first.KeyID
		return store.CreateDesktopHandoffResult{Handoff: item, Ticket: first.Token, Nonce: first.Nonce, Created: true}, nil
	}
	stub.claim = func(_ context.Context, input store.ClaimDesktopHandoffInput, verifier store.DesktopHandoffTicketVerifier, issuer store.DesktopClaimTokenIssuer) (store.ClaimDesktopHandoffResult, error) {
		verified, err := verifier(issuedAt.Add(time.Minute))
		if err != nil {
			return store.ClaimDesktopHandoffResult{}, err
		}
		if verified.TokenID != input.HandoffID || verified.HandoffID != input.HandoffID ||
			verified.SessionID != input.SessionID || verified.DeviceID != input.TargetDeviceID ||
			verified.ExecutorID != "executor_desktop_1" || verified.ActorID != "owner_desktop_1" ||
			verified.ExpectedSessionRevision != 3 || verified.TokenHash != trustedtoken.Hash(ticket) {
			t.Fatalf("unexpected verified handoff claims: %#v", verified)
		}
		claimIssuedAt := issuedAt.Add(time.Minute)
		item := store.DesktopHandoffProjection{
			ID: input.HandoffID, SessionID: input.SessionID, ExecutorID: verified.ExecutorID,
			DeviceID: input.TargetDeviceID, RequestedBy: verified.ActorID,
			ClaimedSessionRevision: sql.NullInt64{Int64: 4, Valid: true},
			ClaimTokenIssuedAt:     sql.NullTime{Time: claimIssuedAt, Valid: true},
			ClaimExpiresAt:         sql.NullTime{Time: claimIssuedAt.Add(store.DesktopClaimTokenLifetime), Valid: true},
		}
		first, err := issuer(item, claimIssuedAt)
		if err != nil {
			return store.ClaimDesktopHandoffResult{}, err
		}
		second, err := issuer(item, claimIssuedAt)
		if err != nil {
			return store.ClaimDesktopHandoffResult{}, err
		}
		if first.Token != second.Token || first.Nonce != second.Nonce || first.Hash != second.Hash {
			t.Fatal("claim token was not deterministically reconstructed")
		}
		item.ClaimTokenHash, item.ClaimTokenKeyID, item.ClaimTokenNonceHash = first.Hash, first.KeyID, first.NonceHash
		return store.ClaimDesktopHandoffResult{Handoff: item, ClaimToken: first.Token, SessionRevision: 4}, nil
	}

	window, err := trustedtoken.NewKeyWindow(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	verificationKey, err := trustedtoken.NewVerificationKey(publicKey, window)
	if err != nil {
		t.Fatal(err)
	}
	verificationKeys := trustedtoken.VerificationKeyRing{"desktop-key-1": verificationKey}
	manager, err := NewWithKeyRing(stub, signer, verificationKeys, secret)
	if err != nil {
		t.Fatal(err)
	}
	manager.random = bytes.NewReader(bytes.Repeat([]byte{0x2d}, 36))
	deviceID := string(bytes.Repeat([]byte{'a'}, 64))
	created, err := manager.Create(context.Background(), CreateInput{
		SessionID: "session_desktop_1", ActorID: "owner_desktop_1", DeviceID: deviceID,
		ExpectedSessionRevision: 3, IdempotencyKeyHash: string(bytes.Repeat([]byte{'b'}, 64)),
		RequestHash: string(bytes.Repeat([]byte{'c'}, 64)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.HandoffTicket != ticket || created.HandoffID == "" || created.Nonce == "" || !created.Created {
		t.Fatalf("unexpected create result: %#v", created)
	}
	ticketClaims, err := trustedtoken.VerifyWithKeyRing(ticket, verificationKeys, issuedAt.Add(time.Second),
		trustedtoken.AudienceDesktop, trustedtoken.PurposeAuthorizationHandoff)
	if err != nil || ticketClaims.HandoffID != created.HandoffID || ticketClaims.ExpectedSessionRevision == nil ||
		*ticketClaims.ExpectedSessionRevision != 3 {
		t.Fatalf("ticket claims=%#v err=%v", ticketClaims, err)
	}

	claimed, err := manager.Claim(context.Background(), ClaimInput{
		HandoffTicket: ticket, SessionID: "session_desktop_1", HandoffID: created.HandoffID,
		TargetDeviceID: deviceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	claimClaims, err := trustedtoken.VerifyWithKeyRing(claimed.ClaimToken, verificationKeys, issuedAt.Add(61*time.Second),
		trustedtoken.AudienceClaim, trustedtoken.PurposeAuthorizationClaim)
	if err != nil || claimClaims.HandoffID != created.HandoffID || claimClaims.ExpectedSessionRevision == nil ||
		*claimClaims.ExpectedSessionRevision != 4 || claimed.ExecutorID != "executor_desktop_1" ||
		claimed.SessionRevision != 4 {
		t.Fatalf("claim claims=%#v result=%#v err=%v", claimClaims, claimed, err)
	}
}

func TestManagerUsesDatabaseTimeAndFailsClosedAcrossSigningKeyRotation(t *testing.T) {
	issuedAt := time.Date(2026, time.July, 13, 2, 3, 4, 0, time.UTC)
	oldSigner, oldPublic := managerSigner(t, 21, "desktop-key-old")
	newSigner, newPublic := managerSigner(t, 37, "desktop-key-new")
	keys := trustedtoken.KeySet{"desktop-key-old": oldPublic, "desktop-key-new": newPublic}
	secret := bytes.Repeat([]byte{0x6b}, 32)

	oldManager, err := New(managerStoreStub{
		create: func(_ context.Context, input store.CreateDesktopHandoffInput, issuer store.DesktopHandoffTicketIssuer) (store.CreateDesktopHandoffResult, error) {
			item := store.DesktopHandoffProjection{
				ID: input.ID, SessionID: input.SessionID, ExecutorID: "executor_rotation",
				DeviceID: input.DeviceID, RequestedBy: input.ActorID,
				ExpectedSessionRevision: input.ExpectedSessionRevision,
				IssuedAt:                issuedAt, ExpiresAt: issuedAt.Add(store.DesktopHandoffLifetime),
			}
			issued, issueErr := issuer(item, issuedAt)
			return store.CreateDesktopHandoffResult{Handoff: item, Ticket: issued.Token}, issueErr
		},
		claim: func(_ context.Context, _ store.ClaimDesktopHandoffInput, verifier store.DesktopHandoffTicketVerifier, _ store.DesktopClaimTokenIssuer) (store.ClaimDesktopHandoffResult, error) {
			_, verifyErr := verifier(issuedAt.Add(store.DesktopHandoffLifetime))
			return store.ClaimDesktopHandoffResult{}, verifyErr
		},
	}, oldSigner, keys, secret)
	if err != nil {
		t.Fatal(err)
	}
	oldManager.random = bytes.NewReader(bytes.Repeat([]byte{0x51}, 18))
	created, err := oldManager.Create(context.Background(), CreateInput{
		SessionID: "session_rotation", ActorID: "owner_rotation", DeviceID: string(bytes.Repeat([]byte{'d'}, 64)),
		ExpectedSessionRevision: 1, IdempotencyKeyHash: string(bytes.Repeat([]byte{'e'}, 64)),
		RequestHash: string(bytes.Repeat([]byte{'f'}, 64)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := oldManager.Claim(context.Background(), ClaimInput{
		HandoffTicket: created.HandoffTicket, SessionID: "session_rotation",
		HandoffID: created.HandoffID, TargetDeviceID: string(bytes.Repeat([]byte{'d'}, 64)),
	}); !errors.Is(err, trustedtoken.ErrExpired) {
		t.Fatalf("ticket was not evaluated with callback database time: %v", err)
	}

	rotated, err := New(managerStoreStub{
		create: func(_ context.Context, input store.CreateDesktopHandoffInput, issuer store.DesktopHandoffTicketIssuer) (store.CreateDesktopHandoffResult, error) {
			item := store.DesktopHandoffProjection{
				ID: input.ID, SessionID: input.SessionID, ExecutorID: "executor_rotation",
				DeviceID: input.DeviceID, RequestedBy: input.ActorID,
				ExpectedSessionRevision: input.ExpectedSessionRevision,
				IssuedAt:                issuedAt, ExpiresAt: issuedAt.Add(store.DesktopHandoffLifetime), TokenKeyID: "desktop-key-old",
			}
			_, issueErr := issuer(item, issuedAt)
			return store.CreateDesktopHandoffResult{}, issueErr
		},
		claim: func(_ context.Context, _ store.ClaimDesktopHandoffInput, _ store.DesktopHandoffTicketVerifier, issuer store.DesktopClaimTokenIssuer) (store.ClaimDesktopHandoffResult, error) {
			item := store.DesktopHandoffProjection{
				ID: "handoff_rotation", SessionID: "session_rotation", ExecutorID: "executor_rotation",
				DeviceID: string(bytes.Repeat([]byte{'d'}, 64)), ClaimTokenKeyID: "desktop-key-old",
				ClaimedSessionRevision: sql.NullInt64{Int64: 2, Valid: true},
			}
			_, issueErr := issuer(item, issuedAt)
			return store.ClaimDesktopHandoffResult{}, issueErr
		},
	}, newSigner, keys, secret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rotated.Create(context.Background(), CreateInput{
		SessionID: "session_rotation", ActorID: "owner_rotation", DeviceID: string(bytes.Repeat([]byte{'d'}, 64)),
		ExpectedSessionRevision: 1, IdempotencyKeyHash: string(bytes.Repeat([]byte{'e'}, 64)),
		RequestHash: string(bytes.Repeat([]byte{'f'}, 64)),
	}); !errors.Is(err, ErrTokenKeyUnavailable) {
		t.Fatalf("rotated signer rebuilt an old handoff ticket: %v", err)
	}
	if _, err := rotated.Claim(context.Background(), ClaimInput{HandoffTicket: "old", HandoffID: "handoff_rotation"}); !errors.Is(err, ErrTokenKeyUnavailable) {
		t.Fatalf("rotated signer rebuilt an old claim token: %v", err)
	}
}

func managerSigner(t *testing.T, seedByte byte, keyID string) (*trustedtoken.Signer, ed25519.PublicKey) {
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
