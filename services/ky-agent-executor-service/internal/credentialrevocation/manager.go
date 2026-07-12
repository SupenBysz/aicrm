// Package credentialrevocation owns deterministic credential-logout tickets
// and coordinates normal or confirmed force revocation with the control store.
// Compact JWS values exist only in process memory; PostgreSQL retains frozen
// claims, hashes and database timestamps.
package credentialrevocation

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/operationconfirmation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

var (
	ErrInvalidConfiguration = errors.New("credential revocation configuration invalid")
	ErrInvalidInput         = errors.New("credential revocation input invalid")
	ErrTokenKeyUnavailable  = errors.New("credential revocation original signing key unavailable")
	ErrTokenReconstruction  = errors.New("credential revocation token reconstruction failed")
)

type Store interface {
	LookupCredentialRevocation(context.Context, store.CredentialRevocationRequest) (store.CreateCredentialRevocationResult, bool, error)
	CreateNormalCredentialRevocation(context.Context, store.CreateCredentialRevocationInput, store.CredentialLogoutTicketIssuer) (store.CreateCredentialRevocationResult, error)
	ForceCredentialRevocationMutation(store.CreateCredentialRevocationInput, *store.CreateCredentialRevocationResult, store.CredentialLogoutTicketIssuer) store.OperationConfirmationMutation
	AcknowledgeCredentialRevocation(context.Context, store.AcknowledgeCredentialRevocationInput, store.CredentialLogoutTicketVerifier) (store.AcknowledgeCredentialRevocationResult, error)
}

type ConfirmationConsumer interface {
	Consume(context.Context, operationconfirmation.ConsumeInput, store.OperationConfirmationMutation) (store.OperationConfirmationProjection, error)
}

type Manager struct {
	store            Store
	confirmations    ConfirmationConsumer
	signer           *trustedtoken.Signer
	verificationKeys trustedtoken.KeySet
	nonceSecret      []byte
	random           io.Reader
}

func New(
	control Store,
	confirmations ConfirmationConsumer,
	signer *trustedtoken.Signer,
	verificationKeys trustedtoken.KeySet,
	nonceSecret []byte,
) (*Manager, error) {
	if control == nil || confirmations == nil || signer == nil || signer.KeyID() == "" || len(nonceSecret) < 32 {
		return nil, ErrInvalidConfiguration
	}
	if publicKey, ok := verificationKeys[signer.KeyID()]; !ok || len(publicKey) != ed25519.PublicKeySize {
		return nil, ErrInvalidConfiguration
	}
	keys := make(trustedtoken.KeySet, len(verificationKeys))
	for keyID, publicKey := range verificationKeys {
		if keyID == "" || len(publicKey) != ed25519.PublicKeySize {
			return nil, ErrInvalidConfiguration
		}
		keys[keyID] = append(ed25519.PublicKey(nil), publicKey...)
	}
	return &Manager{
		store: control, confirmations: confirmations, signer: signer,
		verificationKeys: keys, nonceSecret: append([]byte(nil), nonceSecret...), random: rand.Reader,
	}, nil
}

type RevokeInput struct {
	ExecutorID                 string
	ActorID                    string
	ActorSessionID             string
	ExpectedCredentialRevision int64
	Force                      bool
	IdempotencyKeyHash         string
	RequestHash                string
	ConfirmationToken          string
}

func (m *Manager) Revoke(ctx context.Context, input RevokeInput) (store.CreateCredentialRevocationResult, error) {
	if m == nil || m.store == nil || (input.Force && input.ConfirmationToken == "") ||
		(!input.Force && input.ConfirmationToken != "") || len(input.ConfirmationToken) > 16<<10 {
		return store.CreateCredentialRevocationResult{}, ErrInvalidInput
	}
	request := store.CredentialRevocationRequest{
		ExecutorID: input.ExecutorID, ActorID: input.ActorID, ActorSessionID: input.ActorSessionID,
		ExpectedCredentialRevision: input.ExpectedCredentialRevision, Force: input.Force,
		IdempotencyKeyHash: input.IdempotencyKeyHash, RequestHash: input.RequestHash,
	}
	if !input.Force {
		if existing, found, err := m.store.LookupCredentialRevocation(ctx, request); err != nil {
			return store.CreateCredentialRevocationResult{}, err
		} else if found {
			return m.restoreTicket(existing)
		}
	}
	revocationID, err := m.randomID("revocation_")
	if err != nil {
		return store.CreateCredentialRevocationResult{}, err
	}
	operationID, err := m.randomID("credential_logout_")
	if err != nil {
		return store.CreateCredentialRevocationResult{}, err
	}
	create := store.CreateCredentialRevocationInput{
		CredentialRevocationRequest: request, RevocationID: revocationID, OperationID: operationID,
	}
	var result store.CreateCredentialRevocationResult
	if !input.Force {
		result, err = m.store.CreateNormalCredentialRevocation(ctx, create, m.issueLogoutTicket)
	} else {
		_, err = m.confirmations.Consume(ctx, operationconfirmation.ConsumeInput{
			ConfirmationToken:    input.ConfirmationToken,
			Action:               store.OperationConfirmationForceRevoke,
			ActorID:              input.ActorID,
			ActorSessionID:       input.ActorSessionID,
			ExecutorID:           input.ExecutorID,
			ExpectedRevision:     input.ExpectedCredentialRevision,
			ConsumptionReference: operationID,
		}, m.store.ForceCredentialRevocationMutation(create, &result, m.issueLogoutTicket))
		if errors.Is(err, store.ErrOperationConfirmationTokenConsumed) {
			if replay, found, lookupErr := m.store.LookupCredentialRevocation(ctx, request); lookupErr != nil {
				return store.CreateCredentialRevocationResult{}, lookupErr
			} else if found {
				return m.restoreTicket(replay)
			}
		}
	}
	if err != nil {
		return store.CreateCredentialRevocationResult{}, err
	}
	return m.restoreTicket(result)
}

func (m *Manager) Acknowledge(
	ctx context.Context,
	input store.AcknowledgeCredentialRevocationInput,
	commandTicket string,
) (store.AcknowledgeCredentialRevocationResult, error) {
	if m == nil || m.store == nil || commandTicket == "" || len(commandTicket) > 16<<10 {
		return store.AcknowledgeCredentialRevocationResult{}, ErrInvalidInput
	}
	return m.store.AcknowledgeCredentialRevocation(ctx, input, m.verifyLogoutTicket(commandTicket))
}

func (m *Manager) restoreTicket(
	result store.CreateCredentialRevocationResult,
) (store.CreateCredentialRevocationResult, error) {
	item := result.Revocation
	if !item.SecurityContractVerified {
		return store.CreateCredentialRevocationResult{}, ErrTokenReconstruction
	}
	if item.RuntimeType == "server" {
		if item.CommandTicketHash != "" || item.TokenKeyID != "" || item.DeviceID != "" {
			return store.CreateCredentialRevocationResult{}, ErrTokenReconstruction
		}
		result.CommandTicket = ""
		return result, nil
	}
	if item.RuntimeType != "desktop" || item.TokenIssuedAt.IsZero() || item.ExpiresAt == nil {
		return store.CreateCredentialRevocationResult{}, ErrTokenReconstruction
	}
	issued, err := m.issueLogoutTicket(item, item.TokenIssuedAt)
	if err != nil {
		return store.CreateCredentialRevocationResult{}, err
	}
	if issued.Hash != item.CommandTicketHash || issued.KeyID != item.TokenKeyID ||
		issued.NonceHash != item.TokenNonceHash ||
		issued.ExpiresAt.UTC().Format(time.RFC3339Nano) != *item.ExpiresAt {
		return store.CreateCredentialRevocationResult{}, ErrTokenReconstruction
	}
	result.CommandTicket = issued.Token
	return result, nil
}

func (m *Manager) issueLogoutTicket(
	item store.CredentialRevocationProjection,
	issuedAt time.Time,
) (store.IssuedCredentialLogoutTicket, error) {
	if item.TokenKeyID != "" && item.TokenKeyID != m.signer.KeyID() {
		return store.IssuedCredentialLogoutTicket{}, ErrTokenKeyUnavailable
	}
	nonce := m.tokenNonce(item.RevocationID)
	if item.TokenNonceHash != "" && !hmac.Equal([]byte(item.TokenNonceHash), []byte(digest(nonce))) {
		return store.IssuedCredentialLogoutTicket{}, ErrTokenReconstruction
	}
	claims, err := trustedtoken.NewClaims(
		trustedtoken.AudienceCommand, trustedtoken.PurposeCredentialLogout,
		item.RevocationID, nonce, issuedAt,
	)
	if err != nil {
		return store.IssuedCredentialLogoutTicket{}, err
	}
	claims.ActorID = item.ActorID
	claims.ExecutorID = item.ExecutorID
	claims.DeviceID = item.DeviceID
	claims.OperationID = item.OperationID
	claims.RevocationID = item.RevocationID
	claims.CredentialRevision = &item.CredentialRevision
	claims.RevocationEpoch = &item.RevocationEpoch
	token, err := m.signer.Issue(claims)
	if err != nil {
		return store.IssuedCredentialLogoutTicket{}, err
	}
	return store.IssuedCredentialLogoutTicket{
		Token: token, Hash: trustedtoken.Hash(token), KeyID: m.signer.KeyID(),
		NonceHash: digest(nonce), ExpiresAt: time.Unix(claims.ExpiresAt, 0).UTC(),
	}, nil
}

func (m *Manager) verifyLogoutTicket(token string) store.CredentialLogoutTicketVerifier {
	return func(databaseNow time.Time) (store.VerifiedCredentialLogoutTicket, error) {
		claims, err := trustedtoken.Verify(
			token, m.verificationKeys, databaseNow,
			trustedtoken.AudienceCommand, trustedtoken.PurposeCredentialLogout,
		)
		if err != nil {
			return store.VerifiedCredentialLogoutTicket{}, err
		}
		if claims.CredentialRevision == nil || claims.RevocationEpoch == nil {
			return store.VerifiedCredentialLogoutTicket{}, ErrInvalidInput
		}
		return store.VerifiedCredentialLogoutTicket{
			TokenHash: trustedtoken.Hash(token), NonceHash: digest(claims.Nonce),
			ActorID: claims.ActorID, ExecutorID: claims.ExecutorID, DeviceID: claims.DeviceID,
			OperationID: claims.OperationID, RevocationID: claims.RevocationID,
			CredentialRevision: *claims.CredentialRevision, RevocationEpoch: *claims.RevocationEpoch,
			IssuedAt: time.Unix(claims.IssuedAt, 0).UTC(), ExpiresAt: time.Unix(claims.ExpiresAt, 0).UTC(),
		}, nil
	}
}

func (m *Manager) tokenNonce(revocationID string) string {
	mac := hmac.New(sha256.New, m.nonceSecret)
	_, _ = mac.Write([]byte("aicrm-credential-logout-ticket-nonce-v1\n" + revocationID))
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
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
