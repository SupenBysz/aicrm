// Package desktopactivation owns trusted Desktop account proof submission,
// fenced lease renewal and durable credential activation acknowledgement. Raw
// compact JWS values stay in memory; Store callbacks evaluate them against
// PostgreSQL transaction time.
package desktopactivation

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
	ErrInvalidConfiguration = errors.New("desktop activation configuration invalid")
	ErrInvalidInput         = errors.New("desktop activation input invalid")
	ErrTokenKeyUnavailable  = errors.New("desktop activation original signing key unavailable")
	ErrTokenReconstruction  = errors.New("desktop activation token reconstruction failed")
)

type Store interface {
	SubmitDesktopAuthorizationProof(context.Context, store.SubmitDesktopAuthorizationProofInput, store.DesktopClaimTokenVerifier, store.DesktopActivationTokenIssuer) (store.SubmitDesktopAuthorizationProofResult, error)
	RenewDesktopCredentialActivationLease(context.Context, store.RenewDesktopCredentialActivationLeaseInput, store.DesktopActivationTokenVerifier) (store.RenewDesktopCredentialActivationLeaseResult, error)
	AcknowledgeDesktopCredentialActivation(context.Context, store.AcknowledgeDesktopCredentialActivationInput, store.DesktopActivationTokenVerifier) (store.AcknowledgeDesktopCredentialActivationResult, error)
}

type Manager struct {
	store       Store
	signer      *trustedtoken.Signer
	verifier    *trustedtoken.Verifier
	nonceSecret []byte
	random      io.Reader
}

func New(
	activationStore Store,
	signer *trustedtoken.Signer,
	verificationKeys trustedtoken.KeySet,
	nonceSecret []byte,
) (*Manager, error) {
	verifier, err := trustedtoken.NewLegacyVerifier(verificationKeys)
	if err != nil {
		return nil, ErrInvalidConfiguration
	}
	return newManager(activationStore, signer, verifier, nonceSecret)
}

func NewWithKeyRing(
	activationStore Store,
	signer *trustedtoken.Signer,
	verificationKeys trustedtoken.VerificationKeyRing,
	nonceSecret []byte,
) (*Manager, error) {
	verifier, err := trustedtoken.NewKeyRingVerifier(verificationKeys)
	if err != nil {
		return nil, ErrInvalidConfiguration
	}
	return newManager(activationStore, signer, verifier, nonceSecret)
}

func newManager(
	activationStore Store,
	signer *trustedtoken.Signer,
	verifier *trustedtoken.Verifier,
	nonceSecret []byte,
) (*Manager, error) {
	if activationStore == nil || signer == nil || !verifier.MatchesSigner(signer) || len(nonceSecret) < 32 {
		return nil, ErrInvalidConfiguration
	}
	return &Manager{
		store: activationStore, signer: signer, verifier: verifier,
		nonceSecret: append([]byte(nil), nonceSecret...), random: rand.Reader,
	}, nil
}

type SubmitProofInput struct {
	ClaimToken             string
	SessionID              string
	HandoffID              string
	TargetDeviceID         string
	KeyGeneration          uint64
	SessionRevision        int64
	LoginIDHash            string
	Result                 string
	CheckedAt              time.Time
	AccountFingerprint     string
	CandidateBindingDigest string
	Proof                  deviceauth.VerifiedRequest
	LedgerExpiresAt        time.Time
}

type ActivationResult struct {
	ActivationID             string
	OperationID              string
	CredentialRevision       int64
	LeaseEpoch               int64
	SourceCredentialRevision int64
	RevocationEpoch          int64
	BindingDigest            string
	ActivationToken          string
	ExpiresAt                string
}

type SubmitProofResult struct {
	ProofID         string
	Result          string
	SessionRevision int64
	Activation      *ActivationResult
	Replayed        bool
}

func (m *Manager) SubmitProof(ctx context.Context, input SubmitProofInput) (SubmitProofResult, error) {
	if m == nil || m.store == nil || input.ClaimToken == "" || len(input.ClaimToken) > 16<<10 {
		return SubmitProofResult{}, ErrInvalidInput
	}
	proofID, err := m.randomID("desktop_proof_")
	if err != nil {
		return SubmitProofResult{}, err
	}
	operationID, activationID := "", ""
	if input.Result == "succeeded" {
		operationID, err = m.randomID("desktop_operation_")
		if err != nil {
			return SubmitProofResult{}, err
		}
		activationID, err = m.randomID("desktop_activation_")
		if err != nil {
			return SubmitProofResult{}, err
		}
	}
	result, err := m.store.SubmitDesktopAuthorizationProof(ctx, store.SubmitDesktopAuthorizationProofInput{
		ProofID: proofID, OperationID: operationID, ActivationID: activationID,
		SessionID: input.SessionID, HandoffID: input.HandoffID, TargetDeviceID: input.TargetDeviceID,
		KeyGeneration: input.KeyGeneration, SessionRevision: input.SessionRevision,
		LoginIDHash: input.LoginIDHash, Result: input.Result, CheckedAt: input.CheckedAt,
		AccountFingerprint:     input.AccountFingerprint,
		CandidateBindingDigest: input.CandidateBindingDigest,
		Proof:                  input.Proof, LedgerExpiresAt: input.LedgerExpiresAt,
	}, m.verifyClaimToken(input.ClaimToken), m.issueActivationToken)
	if err != nil {
		return SubmitProofResult{}, err
	}
	output := SubmitProofResult{
		ProofID: result.Proof.ID, Result: result.Proof.Result,
		SessionRevision: result.SessionRevision, Replayed: result.Replayed,
	}
	if result.Activation != nil {
		activation := result.Activation
		output.Activation = &ActivationResult{
			ActivationID: activation.ID, OperationID: activation.OperationID,
			CredentialRevision: activation.CredentialRevision, LeaseEpoch: activation.LeaseEpoch,
			SourceCredentialRevision: activation.SourceCredentialRevision,
			RevocationEpoch:          activation.RevocationEpoch, BindingDigest: activation.BindingDigest,
			ActivationToken: result.ActivationToken,
			ExpiresAt:       activation.ExpiresAt.UTC().Format(time.RFC3339Nano),
		}
	}
	return output, nil
}

type RenewLeaseInput struct {
	ActivationToken          string
	SessionID                string
	ActivationID             string
	TargetDeviceID           string
	KeyGeneration            uint64
	OperationID              string
	CredentialRevision       int64
	LeaseEpoch               int64
	SourceCredentialRevision int64
	RevocationEpoch          int64
	BindingDigest            string
	Proof                    deviceauth.VerifiedRequest
	LedgerExpiresAt          time.Time
}

type RenewLeaseResult struct {
	ActivationID             string
	ExecutorID               string
	OperationID              string
	CredentialRevision       int64
	LeaseEpoch               int64
	SourceCredentialRevision int64
	RevocationEpoch          int64
	RenewedAt                string
	LeaseExpiresAt           string
	Replayed                 bool
}

func (m *Manager) RenewLease(ctx context.Context, input RenewLeaseInput) (RenewLeaseResult, error) {
	if m == nil || m.store == nil || input.ActivationToken == "" || len(input.ActivationToken) > 16<<10 {
		return RenewLeaseResult{}, ErrInvalidInput
	}
	result, err := m.store.RenewDesktopCredentialActivationLease(ctx,
		store.RenewDesktopCredentialActivationLeaseInput{
			SessionID: input.SessionID, ActivationID: input.ActivationID,
			TargetDeviceID: input.TargetDeviceID, KeyGeneration: input.KeyGeneration,
			OperationID: input.OperationID, CredentialRevision: input.CredentialRevision,
			LeaseEpoch: input.LeaseEpoch, SourceCredentialRevision: input.SourceCredentialRevision,
			RevocationEpoch: input.RevocationEpoch, BindingDigest: input.BindingDigest,
			Proof: input.Proof, LedgerExpiresAt: input.LedgerExpiresAt,
		}, m.verifyActivationToken(input.ActivationToken))
	if err != nil {
		return RenewLeaseResult{}, err
	}
	return RenewLeaseResult{
		ActivationID: result.ActivationID, ExecutorID: result.ExecutorID,
		OperationID: result.OperationID, CredentialRevision: result.CredentialRevision,
		LeaseEpoch: result.LeaseEpoch, SourceCredentialRevision: result.SourceCredentialRevision,
		RevocationEpoch: result.RevocationEpoch,
		RenewedAt:       result.RenewedAt.UTC().Format(time.RFC3339Nano),
		LeaseExpiresAt:  result.LeaseExpiresAt.UTC().Format(time.RFC3339Nano),
		Replayed:        result.Replayed,
	}, nil
}

type AcknowledgeInput struct {
	ActivationToken           string
	SessionID                 string
	ActivationID              string
	TargetDeviceID            string
	KeyGeneration             uint64
	OperationID               string
	CredentialRevision        int64
	LeaseEpoch                int64
	SourceCredentialRevision  int64
	RevocationEpoch           int64
	DurableBarrierCompletedAt time.Time
	BindingDigest             string
	Proof                     deviceauth.VerifiedRequest
	LedgerExpiresAt           time.Time
}

type AcknowledgeResult struct {
	ActivationID       string
	ExecutorID         string
	CredentialRevision int64
	SessionRevision    int64
	Replayed           bool
}

func (m *Manager) Acknowledge(ctx context.Context, input AcknowledgeInput) (AcknowledgeResult, error) {
	if m == nil || m.store == nil || input.ActivationToken == "" || len(input.ActivationToken) > 16<<10 {
		return AcknowledgeResult{}, ErrInvalidInput
	}
	result, err := m.store.AcknowledgeDesktopCredentialActivation(ctx,
		store.AcknowledgeDesktopCredentialActivationInput{
			SessionID: input.SessionID, ActivationID: input.ActivationID,
			TargetDeviceID: input.TargetDeviceID, KeyGeneration: input.KeyGeneration,
			OperationID: input.OperationID, CredentialRevision: input.CredentialRevision,
			LeaseEpoch: input.LeaseEpoch, SourceCredentialRevision: input.SourceCredentialRevision,
			RevocationEpoch:           input.RevocationEpoch,
			DurableBarrierCompletedAt: input.DurableBarrierCompletedAt,
			BindingDigest:             input.BindingDigest, Proof: input.Proof,
			LedgerExpiresAt: input.LedgerExpiresAt,
		}, m.verifyActivationToken(input.ActivationToken))
	if err != nil {
		return AcknowledgeResult{}, err
	}
	return AcknowledgeResult{
		ActivationID: result.ActivationID, ExecutorID: result.ExecutorID,
		CredentialRevision: result.CredentialRevision,
		SessionRevision:    result.SessionRevision, Replayed: result.Replayed,
	}, nil
}

func (m *Manager) verifyClaimToken(token string) store.DesktopClaimTokenVerifier {
	return func(databaseNow time.Time) (store.VerifiedDesktopClaimToken, error) {
		claims, err := m.verifier.Verify(token, databaseNow,
			trustedtoken.AudienceClaim, trustedtoken.PurposeAuthorizationClaim)
		if err != nil {
			return store.VerifiedDesktopClaimToken{}, err
		}
		if claims.ExpectedSessionRevision == nil {
			return store.VerifiedDesktopClaimToken{}, ErrInvalidInput
		}
		return store.VerifiedDesktopClaimToken{
			TokenID: claims.TokenID, HandoffID: claims.HandoffID,
			SessionID: claims.SessionID, ExecutorID: claims.ExecutorID,
			DeviceID:                claims.DeviceID,
			ExpectedSessionRevision: *claims.ExpectedSessionRevision,
			TokenHash:               trustedtoken.Hash(token),
		}, nil
	}
}

func (m *Manager) verifyActivationToken(token string) store.DesktopActivationTokenVerifier {
	return func(databaseNow time.Time) (store.VerifiedDesktopActivationToken, error) {
		claims, err := m.verifier.Verify(token, databaseNow,
			trustedtoken.AudienceActivation, trustedtoken.PurposeCredentialActivation)
		if err != nil {
			return store.VerifiedDesktopActivationToken{}, err
		}
		if claims.CredentialRevision == nil || claims.LeaseEpoch == nil ||
			claims.SourceCredentialRevision == nil || claims.RevocationEpoch == nil {
			return store.VerifiedDesktopActivationToken{}, ErrInvalidInput
		}
		return store.VerifiedDesktopActivationToken{
			TokenID: claims.TokenID, ActivationID: claims.ActivationID,
			SessionID: claims.SessionID, ExecutorID: claims.ExecutorID,
			DeviceID: claims.DeviceID, OperationID: claims.OperationID,
			CredentialRevision:       *claims.CredentialRevision,
			LeaseEpoch:               *claims.LeaseEpoch,
			SourceCredentialRevision: *claims.SourceCredentialRevision,
			RevocationEpoch:          *claims.RevocationEpoch,
			BindingDigest:            claims.BindingDigest, TokenHash: trustedtoken.Hash(token),
		}, nil
	}
}

func (m *Manager) issueActivationToken(item store.DesktopCredentialActivationProjection, issuedAt time.Time) (store.IssuedDesktopToken, error) {
	if item.ActivationTokenKeyID != "" && item.ActivationTokenKeyID != m.signer.KeyID() {
		return store.IssuedDesktopToken{}, ErrTokenKeyUnavailable
	}
	nonce := m.tokenNonce(item.ID)
	if item.ActivationTokenNonceHash != "" &&
		!hmac.Equal([]byte(item.ActivationTokenNonceHash), []byte(digest(nonce))) {
		return store.IssuedDesktopToken{}, ErrTokenReconstruction
	}
	claims, err := trustedtoken.NewClaims(
		trustedtoken.AudienceActivation, trustedtoken.PurposeCredentialActivation,
		item.ID, nonce, issuedAt,
	)
	if err != nil {
		return store.IssuedDesktopToken{}, err
	}
	claims.SessionID = item.SessionID
	claims.ExecutorID = item.ExecutorID
	claims.DeviceID = item.DeviceID
	claims.OperationID = item.OperationID
	claims.ActivationID = item.ID
	claims.BindingDigest = item.BindingDigest
	credentialRevision := item.CredentialRevision
	leaseEpoch := item.LeaseEpoch
	sourceRevision := item.SourceCredentialRevision
	revocationEpoch := item.RevocationEpoch
	claims.CredentialRevision = &credentialRevision
	claims.LeaseEpoch = &leaseEpoch
	claims.SourceCredentialRevision = &sourceRevision
	claims.RevocationEpoch = &revocationEpoch
	token, err := m.signer.Issue(claims)
	if err != nil {
		return store.IssuedDesktopToken{}, err
	}
	return store.IssuedDesktopToken{
		Token: token, Hash: trustedtoken.Hash(token), KeyID: m.signer.KeyID(),
		Nonce: nonce, NonceHash: digest(nonce),
		ExpiresAt: time.Unix(claims.ExpiresAt, 0).UTC(),
	}, nil
}

func (m *Manager) tokenNonce(activationID string) string {
	mac := hmac.New(sha256.New, m.nonceSecret)
	_, _ = mac.Write([]byte("aicrm-desktop-activation-nonce-v1\n" + activationID))
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
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}
