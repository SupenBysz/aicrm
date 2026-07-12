// Package operationconfirmation owns deterministic, digest-only high-risk
// operation challenges and their short-lived trusted tokens.
package operationconfirmation

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

var (
	ErrInvalidConfiguration = errors.New("operation confirmation configuration invalid")
	ErrInvalidInput         = errors.New("operation confirmation input invalid")
	ErrChallengeSecret      = errors.New("operation confirmation challenge secret mismatch")
)

type Store interface {
	ResolveOperationConfirmationAction(context.Context, string, string, string) (string, error)
	CreateOperationConfirmation(context.Context, store.CreateOperationConfirmationInput) (store.CreateOperationConfirmationResult, error)
	ConfirmOperationConfirmation(context.Context, store.ConfirmOperationConfirmationInput, store.OperationConfirmationTokenIssuer) (store.ConfirmOperationConfirmationResult, error)
	ConsumeOperationConfirmation(context.Context, store.OperationConfirmationTokenVerifier, store.OperationConfirmationMutation) (store.OperationConfirmationProjection, error)
}

func (m *Manager) ResolveOperationConfirmationAction(
	ctx context.Context,
	confirmationID string,
	actorID string,
	actorSessionID string,
) (string, error) {
	if m == nil || m.store == nil {
		return "", ErrInvalidConfiguration
	}
	return m.store.ResolveOperationConfirmationAction(ctx, confirmationID, actorID, actorSessionID)
}

type Manager struct {
	store            Store
	signer           *trustedtoken.Signer
	verificationKeys trustedtoken.KeySet
	challengeSecret  []byte
	tokenNonceSecret []byte
	random           io.Reader
}

func New(
	control Store,
	signer *trustedtoken.Signer,
	verificationKeys trustedtoken.KeySet,
	challengeSecret []byte,
	tokenNonceSecret []byte,
) (*Manager, error) {
	if control == nil || signer == nil || signer.KeyID() == "" || len(challengeSecret) < 32 ||
		len(tokenNonceSecret) < 32 || hmac.Equal(challengeSecret, tokenNonceSecret) {
		return nil, ErrInvalidConfiguration
	}
	if publicKey, ok := verificationKeys[signer.KeyID()]; !ok || len(publicKey) != ed25519.PublicKeySize {
		return nil, ErrInvalidConfiguration
	}
	keys := make(trustedtoken.KeySet, len(verificationKeys))
	for keyID, publicKey := range verificationKeys {
		if len(publicKey) != ed25519.PublicKeySize {
			return nil, ErrInvalidConfiguration
		}
		keys[keyID] = append(ed25519.PublicKey(nil), publicKey...)
	}
	return &Manager{
		store: control, signer: signer, verificationKeys: keys,
		challengeSecret:  append([]byte(nil), challengeSecret...),
		tokenNonceSecret: append([]byte(nil), tokenNonceSecret...), random: rand.Reader,
	}, nil
}

type CreateInput struct {
	Action               string
	ExecutorID           string
	ActorID              string
	ActorSessionID       string
	ExpectedRevision     int64
	TargetDeviceID       string
	OwnerVerified        bool
	LoginAuthenticatedAt time.Time
	MFARequired          bool
	MFAVerified          bool
	IdempotencyKeyHash   string
	RequestHash          string
}

type CreateResult struct {
	ConfirmationID string `json:"confirmationId"`
	ChallengeText  string `json:"challengeText"`
	ExpiresAt      string `json:"expiresAt"`
	Created        bool   `json:"-"`
}

func (m *Manager) Create(ctx context.Context, input CreateInput) (CreateResult, error) {
	if m == nil || m.store == nil {
		return CreateResult{}, ErrInvalidConfiguration
	}
	confirmationID, err := m.randomID("confirmation_")
	if err != nil {
		return CreateResult{}, err
	}
	challenge := m.challengeText(confirmationID)
	created, err := m.store.CreateOperationConfirmation(ctx, store.CreateOperationConfirmationInput{
		ID: confirmationID, Action: input.Action, ExecutorID: input.ExecutorID,
		ActorID: input.ActorID, ActorSessionID: input.ActorSessionID,
		ExpectedRevision: input.ExpectedRevision, TargetDeviceID: input.TargetDeviceID,
		OwnerVerified: input.OwnerVerified, LoginAuthenticatedAt: input.LoginAuthenticatedAt,
		MFARequired: input.MFARequired, MFAVerified: input.MFAVerified,
		ChallengeHash: digest(challenge), IdempotencyKeyHash: input.IdempotencyKeyHash,
		RequestHash: input.RequestHash,
	})
	if err != nil {
		return CreateResult{}, err
	}
	challenge = m.challengeText(created.Confirmation.ID)
	if !hmac.Equal([]byte(created.Confirmation.ChallengeHash), []byte(digest(challenge))) {
		return CreateResult{}, ErrChallengeSecret
	}
	return CreateResult{
		ConfirmationID: created.Confirmation.ID, ChallengeText: challenge,
		ExpiresAt: created.Confirmation.ExpiresAt, Created: created.Created,
	}, nil
}

type ConfirmInput struct {
	ConfirmationID       string
	ActorID              string
	ActorSessionID       string
	ChallengeText        string
	OwnerVerified        bool
	LoginAuthenticatedAt time.Time
	MFARequired          bool
	MFAVerified          bool
}

type ConfirmResult struct {
	ConfirmationToken string `json:"confirmationToken"`
	ExpiresAt         string `json:"expiresAt"`
}

func (m *Manager) Confirm(ctx context.Context, input ConfirmInput) (ConfirmResult, error) {
	if m == nil || m.store == nil || input.ChallengeText == "" || len(input.ChallengeText) > 128 {
		return ConfirmResult{}, ErrInvalidInput
	}
	confirmed, err := m.store.ConfirmOperationConfirmation(ctx, store.ConfirmOperationConfirmationInput{
		ConfirmationID: input.ConfirmationID, ActorID: input.ActorID,
		ActorSessionID: input.ActorSessionID, ChallengeHash: digest(input.ChallengeText),
		OwnerVerified: input.OwnerVerified, LoginAuthenticatedAt: input.LoginAuthenticatedAt,
		MFARequired: input.MFARequired, MFAVerified: input.MFAVerified,
	}, m.issueToken)
	if err != nil {
		return ConfirmResult{}, err
	}
	if confirmed.Confirmation.TokenExpiresAt == nil {
		return ConfirmResult{}, ErrInvalidConfiguration
	}
	return ConfirmResult{ConfirmationToken: confirmed.Token, ExpiresAt: *confirmed.Confirmation.TokenExpiresAt}, nil
}

type ConsumeInput struct {
	ConfirmationToken    string
	Action               string
	ActorID              string
	ActorSessionID       string
	ExecutorID           string
	ExpectedRevision     int64
	FromDeviceID         string
	TargetDeviceID       string
	ConsumptionReference string
}

func (m *Manager) Consume(
	ctx context.Context,
	input ConsumeInput,
	mutation store.OperationConfirmationMutation,
) (store.OperationConfirmationProjection, error) {
	if m == nil || m.store == nil || input.ConfirmationToken == "" || len(input.ConfirmationToken) > 16<<10 {
		return store.OperationConfirmationProjection{}, ErrInvalidInput
	}
	purpose, ok := tokenPurpose(input.Action)
	if !ok {
		return store.OperationConfirmationProjection{}, ErrInvalidInput
	}
	return m.store.ConsumeOperationConfirmation(ctx, func(databaseNow time.Time) (store.ConsumeOperationConfirmationInput, error) {
		claims, err := trustedtoken.Verify(
			input.ConfirmationToken, m.verificationKeys, databaseNow,
			trustedtoken.AudienceConfirmation, purpose,
		)
		if err != nil {
			return store.ConsumeOperationConfirmationInput{}, err
		}
		if claims.ActorID != input.ActorID || claims.SessionID != input.ActorSessionID ||
			claims.ExecutorID != input.ExecutorID || claims.ExpectedRevision == nil ||
			*claims.ExpectedRevision != input.ExpectedRevision || claims.FromDeviceID != input.FromDeviceID ||
			claims.TargetDeviceID != input.TargetDeviceID {
			return store.ConsumeOperationConfirmationInput{}, store.ErrOperationConfirmationTokenMismatch
		}
		return store.ConsumeOperationConfirmationInput{
			ConfirmationID: claims.TokenID, ActorID: input.ActorID, ActorSessionID: input.ActorSessionID,
			Action: input.Action, ExecutorID: input.ExecutorID, ExpectedRevision: input.ExpectedRevision,
			FromDeviceID: input.FromDeviceID, TargetDeviceID: input.TargetDeviceID,
			TokenHash: trustedtoken.Hash(input.ConfirmationToken), ConsumptionReference: input.ConsumptionReference,
		}, nil
	}, mutation)
}

func (m *Manager) issueToken(
	item store.OperationConfirmationProjection,
	issuedAt time.Time,
) (store.IssuedOperationConfirmationToken, error) {
	challenge := m.challengeText(item.ID)
	if !hmac.Equal([]byte(item.ChallengeHash), []byte(digest(challenge))) {
		return store.IssuedOperationConfirmationToken{}, ErrChallengeSecret
	}
	purpose, ok := tokenPurpose(item.Action)
	if !ok {
		return store.IssuedOperationConfirmationToken{}, ErrInvalidInput
	}
	nonce := m.tokenNonce(item.ID)
	claims, err := trustedtoken.NewClaims(
		trustedtoken.AudienceConfirmation, purpose, item.ID, nonce, issuedAt,
	)
	if err != nil {
		return store.IssuedOperationConfirmationToken{}, err
	}
	claims.ActorID = item.ActorID
	claims.SessionID = item.ActorSessionID
	claims.ExecutorID = item.ExecutorID
	claims.ExpectedRevision = &item.ExpectedRevision
	claims.FromDeviceID = item.FromDeviceID
	claims.TargetDeviceID = item.TargetDeviceID
	token, err := m.signer.Issue(claims)
	if err != nil {
		return store.IssuedOperationConfirmationToken{}, err
	}
	return store.IssuedOperationConfirmationToken{
		Token: token, Hash: trustedtoken.Hash(token), KeyID: m.signer.KeyID(),
		NonceHash: digest(nonce), ExpiresAt: time.Unix(claims.ExpiresAt, 0).UTC(),
	}, nil
}

func (m *Manager) challengeText(confirmationID string) string {
	mac := hmac.New(sha256.New, m.challengeSecret)
	_, _ = mac.Write([]byte("aicrm-operation-confirmation-challenge-v1\n" + confirmationID))
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(mac.Sum(nil)[:20])
	groups := make([]string, 0, 8)
	for len(encoded) > 0 {
		take := 4
		if len(encoded) < take {
			take = len(encoded)
		}
		groups = append(groups, encoded[:take])
		encoded = encoded[take:]
	}
	return "AICRM-" + strings.Join(groups, "-")
}

func (m *Manager) tokenNonce(confirmationID string) string {
	mac := hmac.New(sha256.New, m.tokenNonceSecret)
	_, _ = mac.Write([]byte("aicrm-operation-confirmation-token-nonce-v1\n" + confirmationID))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:16])
}

func (m *Manager) randomID(prefix string) (string, error) {
	raw := make([]byte, 18)
	if _, err := io.ReadFull(m.random, raw); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

func tokenPurpose(action string) (string, bool) {
	switch action {
	case store.OperationConfirmationForceRevoke:
		return trustedtoken.PurposeForceRevoke, true
	case store.OperationConfirmationRebindDevice:
		return trustedtoken.PurposeRebindDevice, true
	case store.OperationConfirmationUnbindDevice:
		return trustedtoken.PurposeUnbindDevice, true
	default:
		return "", false
	}
}

func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
