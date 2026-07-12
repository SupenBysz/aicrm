// Package desktopcommand owns deterministic, target-bound command tickets
// for Desktop authorization cancel/reopen operations.
package desktopcommand

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

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

var (
	ErrInvalidConfiguration = errors.New("desktop authorization command configuration invalid")
	ErrInvalidInput         = errors.New("desktop authorization command input invalid")
	ErrTokenKeyUnavailable  = errors.New("desktop authorization command original signing key unavailable")
	ErrTokenReconstruction  = errors.New("desktop authorization command token reconstruction failed")
)

type Store interface {
	LookupDesktopAuthorizationCommand(context.Context, store.DesktopAuthorizationCommandRequest) (store.CreateDesktopAuthorizationCommandResult, bool, error)
	CreateDesktopAuthorizationCommand(context.Context, store.CreateDesktopAuthorizationCommandInput, store.DesktopAuthorizationCommandTicketIssuer) (store.CreateDesktopAuthorizationCommandResult, error)
	AcknowledgeDesktopAuthorizationCommand(context.Context, store.AcknowledgeDesktopAuthorizationCommandInput, store.DesktopAuthorizationCommandTicketVerifier) (store.AcknowledgeDesktopAuthorizationCommandResult, error)
}

type Manager struct {
	store       Store
	signer      *trustedtoken.Signer
	verifier    *trustedtoken.Verifier
	nonceSecret []byte
	random      io.Reader
}

func New(
	control Store,
	signer *trustedtoken.Signer,
	verificationKeys trustedtoken.KeySet,
	nonceSecret []byte,
) (*Manager, error) {
	verifier, err := trustedtoken.NewLegacyVerifier(verificationKeys)
	if err != nil {
		return nil, ErrInvalidConfiguration
	}
	return newManager(control, signer, verifier, nonceSecret)
}

func NewWithKeyRing(
	control Store,
	signer *trustedtoken.Signer,
	verificationKeys trustedtoken.VerificationKeyRing,
	nonceSecret []byte,
) (*Manager, error) {
	verifier, err := trustedtoken.NewKeyRingVerifier(verificationKeys)
	if err != nil {
		return nil, ErrInvalidConfiguration
	}
	return newManager(control, signer, verifier, nonceSecret)
}

func newManager(
	control Store,
	signer *trustedtoken.Signer,
	verifier *trustedtoken.Verifier,
	nonceSecret []byte,
) (*Manager, error) {
	if control == nil || signer == nil || !verifier.MatchesSigner(signer) || len(nonceSecret) < 32 {
		return nil, ErrInvalidConfiguration
	}
	return &Manager{
		store: control, signer: signer, verifier: verifier,
		nonceSecret: append([]byte(nil), nonceSecret...), random: rand.Reader,
	}, nil
}

type CreateInput struct {
	SessionID               string
	ActorID                 string
	ActorSessionID          string
	ExpectedSessionRevision int64
	IdempotencyKeyHash      string
	RequestHash             string
	CanCancelAny            bool
}

func (m *Manager) Cancel(
	ctx context.Context,
	input CreateInput,
) (store.CreateDesktopAuthorizationCommandResult, error) {
	return m.create(ctx, input, trustedtoken.PurposeAuthorizationCancel)
}

func (m *Manager) Reopen(
	ctx context.Context,
	input CreateInput,
) (store.CreateDesktopAuthorizationCommandResult, error) {
	if input.CanCancelAny {
		return store.CreateDesktopAuthorizationCommandResult{}, ErrInvalidInput
	}
	return m.create(ctx, input, trustedtoken.PurposeAuthorizationReopen)
}

func (m *Manager) create(
	ctx context.Context,
	input CreateInput,
	purpose string,
) (store.CreateDesktopAuthorizationCommandResult, error) {
	if m == nil || m.store == nil {
		return store.CreateDesktopAuthorizationCommandResult{}, ErrInvalidInput
	}
	request := store.DesktopAuthorizationCommandRequest{
		SessionID: input.SessionID, ActorID: input.ActorID,
		ActorSessionID: input.ActorSessionID, Purpose: purpose,
		ExpectedSessionRevision: input.ExpectedSessionRevision,
		IdempotencyKeyHash:      input.IdempotencyKeyHash, RequestHash: input.RequestHash,
		CanCancelAny: input.CanCancelAny,
	}
	if existing, found, err := m.store.LookupDesktopAuthorizationCommand(ctx, request); err != nil {
		return store.CreateDesktopAuthorizationCommandResult{}, err
	} else if found {
		return m.restoreTicket(existing)
	}
	operationID, err := m.randomID("desktop_command_")
	if err != nil {
		return store.CreateDesktopAuthorizationCommandResult{}, err
	}
	result, err := m.store.CreateDesktopAuthorizationCommand(ctx,
		store.CreateDesktopAuthorizationCommandInput{
			DesktopAuthorizationCommandRequest: request,
			OperationID:                        operationID,
		}, m.issueTicket)
	if err != nil {
		return store.CreateDesktopAuthorizationCommandResult{}, err
	}
	return m.restoreTicket(result)
}

func (m *Manager) Acknowledge(
	ctx context.Context,
	input store.AcknowledgeDesktopAuthorizationCommandInput,
	commandTicket string,
) (store.AcknowledgeDesktopAuthorizationCommandResult, error) {
	if m == nil || m.store == nil || commandTicket == "" || len(commandTicket) > 16<<10 {
		return store.AcknowledgeDesktopAuthorizationCommandResult{}, ErrInvalidInput
	}
	return m.store.AcknowledgeDesktopAuthorizationCommand(
		ctx, input, m.verifyTicket(commandTicket, input.Purpose),
	)
}

func (m *Manager) restoreTicket(
	result store.CreateDesktopAuthorizationCommandResult,
) (store.CreateDesktopAuthorizationCommandResult, error) {
	if !result.CommandCreated {
		result.CommandTicket = ""
		return result, nil
	}
	item := result.Command
	if !item.SecurityContractVerified || !desktopCommandPurpose(item.Purpose) ||
		item.TokenIssuedAt.IsZero() || item.ExpiresAt == "" {
		return store.CreateDesktopAuthorizationCommandResult{}, ErrTokenReconstruction
	}
	issued, err := m.issueTicket(item, item.TokenIssuedAt)
	if err != nil {
		return store.CreateDesktopAuthorizationCommandResult{}, err
	}
	if issued.Hash != item.CommandTicketHash || issued.KeyID != item.TokenKeyID ||
		issued.NonceHash != item.TokenNonceHash ||
		issued.ExpiresAt.UTC().Format(time.RFC3339Nano) != item.ExpiresAt {
		return store.CreateDesktopAuthorizationCommandResult{}, ErrTokenReconstruction
	}
	result.CommandTicket = issued.Token
	return result, nil
}

func (m *Manager) issueTicket(
	item store.DesktopAuthorizationCommandProjection,
	issuedAt time.Time,
) (store.IssuedDesktopAuthorizationCommandTicket, error) {
	if item.TokenKeyID != "" && item.TokenKeyID != m.signer.KeyID() {
		return store.IssuedDesktopAuthorizationCommandTicket{}, ErrTokenKeyUnavailable
	}
	nonce := m.tokenNonce(item.OperationID, item.Purpose)
	if item.TokenNonceHash != "" &&
		!hmac.Equal([]byte(item.TokenNonceHash), []byte(digest(nonce))) {
		return store.IssuedDesktopAuthorizationCommandTicket{}, ErrTokenReconstruction
	}
	claims, err := trustedtoken.NewClaims(
		trustedtoken.AudienceCommand, item.Purpose, item.OperationID, nonce, issuedAt,
	)
	if err != nil {
		return store.IssuedDesktopAuthorizationCommandTicket{}, err
	}
	claims.ActorID = item.ActorID
	claims.SessionID = item.SessionID
	claims.ExecutorID = item.ExecutorID
	claims.DeviceID = item.DeviceID
	claims.OperationID = item.OperationID
	claims.ExpectedSessionRevision = &item.ExpectedSessionRevision
	token, err := m.signer.Issue(claims)
	if err != nil {
		return store.IssuedDesktopAuthorizationCommandTicket{}, err
	}
	return store.IssuedDesktopAuthorizationCommandTicket{
		Token: token, Hash: trustedtoken.Hash(token), KeyID: m.signer.KeyID(),
		NonceHash: digest(nonce), ExpiresAt: time.Unix(claims.ExpiresAt, 0).UTC(),
	}, nil
}

func (m *Manager) verifyTicket(
	token string,
	purpose string,
) store.DesktopAuthorizationCommandTicketVerifier {
	return func(databaseNow time.Time) (store.VerifiedDesktopAuthorizationCommandTicket, error) {
		if !desktopCommandPurpose(purpose) {
			return store.VerifiedDesktopAuthorizationCommandTicket{}, ErrInvalidInput
		}
		claims, err := m.verifier.Verify(
			token, databaseNow,
			trustedtoken.AudienceCommand, purpose,
		)
		if err != nil {
			return store.VerifiedDesktopAuthorizationCommandTicket{}, err
		}
		if claims.ExpectedSessionRevision == nil {
			return store.VerifiedDesktopAuthorizationCommandTicket{}, ErrInvalidInput
		}
		return store.VerifiedDesktopAuthorizationCommandTicket{
			TokenHash: trustedtoken.Hash(token), NonceHash: digest(claims.Nonce),
			TokenID: claims.TokenID,
			ActorID: claims.ActorID, SessionID: claims.SessionID,
			ExecutorID: claims.ExecutorID, DeviceID: claims.DeviceID,
			OperationID: claims.OperationID, Purpose: claims.Purpose,
			ExpectedSessionRevision: *claims.ExpectedSessionRevision,
			IssuedAt:                time.Unix(claims.IssuedAt, 0).UTC(),
			ExpiresAt:               time.Unix(claims.ExpiresAt, 0).UTC(),
		}, nil
	}
}

func (m *Manager) tokenNonce(operationID, purpose string) string {
	mac := hmac.New(sha256.New, m.nonceSecret)
	_, _ = mac.Write([]byte("aicrm-desktop-authorization-command-nonce-v1\n" + purpose + "\n" + operationID))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:16])
}

func (m *Manager) randomID(prefix string) (string, error) {
	raw := make([]byte, 18)
	if _, err := io.ReadFull(m.random, raw); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

func desktopCommandPurpose(value string) bool {
	return value == trustedtoken.PurposeAuthorizationCancel ||
		value == trustedtoken.PurposeAuthorizationReopen
}

func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
