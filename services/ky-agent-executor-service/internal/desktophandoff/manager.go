// Package desktophandoff owns deterministic Desktop authorization handoff
// tickets and claim tokens. Raw compact JWS values stay in request/response
// memory; the Store persists only hashes, frozen claims and database times.
package desktophandoff

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

var (
	ErrInvalidConfiguration = errors.New("desktop handoff configuration invalid")
	ErrInvalidInput         = errors.New("desktop handoff input invalid")
	ErrTokenKeyUnavailable  = errors.New("desktop handoff original signing key unavailable")
	ErrTokenReconstruction  = errors.New("desktop handoff token reconstruction failed")
)

type Store interface {
	CreateDesktopHandoff(context.Context, store.CreateDesktopHandoffInput, store.DesktopHandoffTicketIssuer) (store.CreateDesktopHandoffResult, error)
	ClaimDesktopHandoff(context.Context, store.ClaimDesktopHandoffInput, store.DesktopHandoffTicketVerifier, store.DesktopClaimTokenIssuer) (store.ClaimDesktopHandoffResult, error)
}

type Manager struct {
	store       Store
	signer      *trustedtoken.Signer
	verifier    *trustedtoken.Verifier
	nonceSecret []byte
	random      io.Reader
}

func New(
	handoffStore Store,
	signer *trustedtoken.Signer,
	verificationKeys trustedtoken.KeySet,
	nonceSecret []byte,
) (*Manager, error) {
	verifier, err := trustedtoken.NewLegacyVerifier(verificationKeys)
	if err != nil {
		return nil, ErrInvalidConfiguration
	}
	return newManager(handoffStore, signer, verifier, nonceSecret)
}

func NewWithKeyRing(
	handoffStore Store,
	signer *trustedtoken.Signer,
	verificationKeys trustedtoken.VerificationKeyRing,
	nonceSecret []byte,
) (*Manager, error) {
	verifier, err := trustedtoken.NewKeyRingVerifier(verificationKeys)
	if err != nil {
		return nil, ErrInvalidConfiguration
	}
	return newManager(handoffStore, signer, verifier, nonceSecret)
}

func newManager(
	handoffStore Store,
	signer *trustedtoken.Signer,
	verifier *trustedtoken.Verifier,
	nonceSecret []byte,
) (*Manager, error) {
	if handoffStore == nil || signer == nil || !verifier.MatchesSigner(signer) || len(nonceSecret) < 32 {
		return nil, ErrInvalidConfiguration
	}
	return &Manager{
		store: handoffStore, signer: signer, verifier: verifier,
		nonceSecret: append([]byte(nil), nonceSecret...), random: rand.Reader,
	}, nil
}

type CreateInput struct {
	SessionID               string
	ActorID                 string
	DeviceID                string
	ExpectedSessionRevision int64
	IdempotencyKeyHash      string
	RequestHash             string
}

type CreateResult struct {
	HandoffID     string
	HandoffTicket string
	Nonce         string
	ExpiresAt     string
	Created       bool
}

func (m *Manager) Create(ctx context.Context, input CreateInput) (CreateResult, error) {
	if m == nil || m.store == nil {
		return CreateResult{}, ErrInvalidConfiguration
	}
	handoffID, err := m.randomID("handoff_")
	if err != nil {
		return CreateResult{}, err
	}
	result, err := m.store.CreateDesktopHandoff(ctx, store.CreateDesktopHandoffInput{
		ID: handoffID, SessionID: input.SessionID, ActorID: input.ActorID,
		DeviceID: input.DeviceID, ExpectedSessionRevision: input.ExpectedSessionRevision,
		IdempotencyKeyHash: input.IdempotencyKeyHash, RequestHash: input.RequestHash,
	}, m.issueHandoffTicket)
	if err != nil {
		return CreateResult{}, err
	}
	return CreateResult{
		HandoffID: result.Handoff.ID, HandoffTicket: result.Ticket, Nonce: result.Nonce,
		ExpiresAt: result.Handoff.ExpiresAt.UTC().Format(time.RFC3339Nano), Created: result.Created,
	}, nil
}

type ClaimInput struct {
	HandoffTicket   string
	SessionID       string
	HandoffID       string
	TargetDeviceID  string
	KeyGeneration   uint64
	Proof           deviceauth.VerifiedRequest
	ClaimedAt       time.Time
	LedgerExpiresAt time.Time
}

type ClaimResult struct {
	HandoffID       string
	ExecutorID      string
	ClaimToken      string
	ExpiresAt       string
	SessionRevision int64
	Replayed        bool
}

func (m *Manager) Claim(ctx context.Context, input ClaimInput) (ClaimResult, error) {
	if m == nil || m.store == nil || input.HandoffTicket == "" || len(input.HandoffTicket) > 16<<10 {
		return ClaimResult{}, ErrInvalidInput
	}
	result, err := m.store.ClaimDesktopHandoff(ctx, store.ClaimDesktopHandoffInput{
		SessionID: input.SessionID, HandoffID: input.HandoffID, TargetDeviceID: input.TargetDeviceID,
		KeyGeneration: input.KeyGeneration, Proof: input.Proof, ClaimedAt: input.ClaimedAt,
		LedgerExpiresAt: input.LedgerExpiresAt,
	}, m.verifyHandoffTicket(input.HandoffTicket), m.issueClaimToken)
	if err != nil {
		return ClaimResult{}, err
	}
	return ClaimResult{
		HandoffID: result.Handoff.ID, ExecutorID: result.Handoff.ExecutorID,
		ClaimToken:      result.ClaimToken,
		ExpiresAt:       result.Handoff.ClaimExpiresAt.Time.UTC().Format(time.RFC3339Nano),
		SessionRevision: result.SessionRevision, Replayed: result.Replayed,
	}, nil
}

func (m *Manager) verifyHandoffTicket(token string) store.DesktopHandoffTicketVerifier {
	return func(databaseNow time.Time) (store.VerifiedDesktopHandoffTicket, error) {
		claims, err := m.verifier.Verify(
			token, databaseNow,
			trustedtoken.AudienceDesktop, trustedtoken.PurposeAuthorizationHandoff,
		)
		if err != nil {
			return store.VerifiedDesktopHandoffTicket{}, err
		}
		if claims.ExpectedSessionRevision == nil {
			return store.VerifiedDesktopHandoffTicket{}, ErrInvalidInput
		}
		return store.VerifiedDesktopHandoffTicket{
			TokenID: claims.TokenID, HandoffID: claims.HandoffID, SessionID: claims.SessionID,
			ExecutorID: claims.ExecutorID, DeviceID: claims.DeviceID, ActorID: claims.ActorID,
			ExpectedSessionRevision: *claims.ExpectedSessionRevision, TokenHash: trustedtoken.Hash(token),
		}, nil
	}
}

func (m *Manager) issueHandoffTicket(item store.DesktopHandoffProjection, issuedAt time.Time) (store.IssuedDesktopToken, error) {
	if item.TokenKeyID != "" && item.TokenKeyID != m.signer.KeyID() {
		return store.IssuedDesktopToken{}, ErrTokenKeyUnavailable
	}
	nonce := m.tokenNonce("handoff-ticket", item.ID)
	if item.TicketNonceHash != "" && !hmac.Equal([]byte(item.TicketNonceHash), []byte(digest(nonce))) {
		return store.IssuedDesktopToken{}, ErrTokenReconstruction
	}
	claims, err := trustedtoken.NewClaims(
		trustedtoken.AudienceDesktop, trustedtoken.PurposeAuthorizationHandoff,
		item.ID, nonce, issuedAt,
	)
	if err != nil {
		return store.IssuedDesktopToken{}, err
	}
	claims.ActorID = item.RequestedBy
	claims.SessionID = item.SessionID
	claims.ExecutorID = item.ExecutorID
	claims.DeviceID = item.DeviceID
	claims.HandoffID = item.ID
	revision := item.ExpectedSessionRevision
	claims.ExpectedSessionRevision = &revision
	return m.issue(claims, nonce)
}

func (m *Manager) issueClaimToken(item store.DesktopHandoffProjection, issuedAt time.Time) (store.IssuedDesktopToken, error) {
	if item.ClaimTokenKeyID != "" && item.ClaimTokenKeyID != m.signer.KeyID() {
		return store.IssuedDesktopToken{}, ErrTokenKeyUnavailable
	}
	if !item.ClaimedSessionRevision.Valid || item.ClaimedSessionRevision.Int64 <= 0 {
		return store.IssuedDesktopToken{}, ErrInvalidInput
	}
	nonce := m.tokenNonce("claim-token", item.ID)
	if item.ClaimTokenNonceHash != "" && !hmac.Equal([]byte(item.ClaimTokenNonceHash), []byte(digest(nonce))) {
		return store.IssuedDesktopToken{}, ErrTokenReconstruction
	}
	claims, err := trustedtoken.NewClaims(
		trustedtoken.AudienceClaim, trustedtoken.PurposeAuthorizationClaim,
		item.ID, nonce, issuedAt,
	)
	if err != nil {
		return store.IssuedDesktopToken{}, err
	}
	claims.SessionID = item.SessionID
	claims.ExecutorID = item.ExecutorID
	claims.DeviceID = item.DeviceID
	claims.HandoffID = item.ID
	revision := item.ClaimedSessionRevision.Int64
	claims.ExpectedSessionRevision = &revision
	return m.issue(claims, nonce)
}

func (m *Manager) issue(claims trustedtoken.Claims, nonce string) (store.IssuedDesktopToken, error) {
	token, err := m.signer.Issue(claims)
	if err != nil {
		return store.IssuedDesktopToken{}, err
	}
	return store.IssuedDesktopToken{
		Token: token, Hash: trustedtoken.Hash(token), KeyID: m.signer.KeyID(),
		Nonce: nonce, NonceHash: digest(nonce), ExpiresAt: time.Unix(claims.ExpiresAt, 0).UTC(),
	}, nil
}

func (m *Manager) tokenNonce(class, handoffID string) string {
	mac := hmac.New(sha256.New, m.nonceSecret)
	_, _ = mac.Write([]byte("aicrm-desktop-handoff-" + class + "-nonce-v1\n" + handoffID))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:16])
}

func (m *Manager) randomID(prefix string) (string, error) {
	raw := make([]byte, 18)
	if _, err := io.ReadFull(m.random, raw); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

func digest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
