package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"time"
)

const (
	OperationConfirmationChallengeLifetime = 5 * time.Minute
	OperationConfirmationTokenLifetime     = 5 * time.Minute
	OperationConfirmationFreshLoginWindow  = 10 * time.Minute
)

const (
	OperationConfirmationForceRevoke  = "force_revoke"
	OperationConfirmationRebindDevice = "rebind_device"
	OperationConfirmationUnbindDevice = "unbind_device"
)

var (
	ErrOperationConfirmationInputInvalid     = errors.New("operation confirmation input invalid")
	ErrOperationConfirmationOwnerRequired    = errors.New("operation confirmation owner required")
	ErrOperationConfirmationFreshLogin       = errors.New("operation confirmation fresh login required")
	ErrOperationConfirmationMFARequired      = errors.New("operation confirmation MFA required")
	ErrOperationConfirmationTargetMismatch   = errors.New("operation confirmation target mismatch")
	ErrOperationConfirmationChallengeInvalid = errors.New("operation confirmation challenge invalid")
	ErrOperationConfirmationChallengeUsed    = errors.New("operation confirmation challenge already used")
	ErrOperationConfirmationChallengeExpired = errors.New("operation confirmation challenge expired")
	ErrOperationConfirmationTokenMismatch    = errors.New("operation confirmation token mismatch")
	ErrOperationConfirmationTokenConsumed    = errors.New("operation confirmation token consumed")
	ErrOperationConfirmationTokenExpired     = errors.New("operation confirmation token expired")
)

var (
	confirmationDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	confirmationKeyIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

type CreateOperationConfirmationInput struct {
	ID                   string
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
	ChallengeHash        string
	IdempotencyKeyHash   string
	RequestHash          string
}

type OperationConfirmationProjection struct {
	ID               string  `json:"confirmationId"`
	Action           string  `json:"action"`
	ExecutorID       string  `json:"executorId"`
	ExpectedRevision int64   `json:"expectedRevision"`
	FromDeviceID     string  `json:"fromDeviceId,omitempty"`
	TargetDeviceID   string  `json:"targetDeviceId,omitempty"`
	Status           string  `json:"status"`
	ExpiresAt        string  `json:"expiresAt"`
	TokenExpiresAt   *string `json:"tokenExpiresAt,omitempty"`
	ConfirmedAt      *string `json:"confirmedAt,omitempty"`
	ConsumedAt       *string `json:"consumedAt,omitempty"`
	CreatedAt        string  `json:"createdAt"`

	ActorID               string    `json:"-"`
	ActorSessionID        string    `json:"-"`
	SecurityFactsVerified bool      `json:"-"`
	OwnerVerified         bool      `json:"-"`
	LoginAuthenticatedAt  time.Time `json:"-"`
	MFARequired           bool      `json:"-"`
	MFAVerified           bool      `json:"-"`
	ChallengeHash         string    `json:"-"`
	IdempotencyKeyHash    string    `json:"-"`
	RequestHash           string    `json:"-"`
	TokenHash             string    `json:"-"`
	TokenKeyID            string    `json:"-"`
	TokenNonceHash        string    `json:"-"`
	TokenIssuedAt         time.Time `json:"-"`
	ConsumptionReference  string    `json:"-"`
}

type CreateOperationConfirmationResult struct {
	Confirmation OperationConfirmationProjection
	Created      bool
}

type ConfirmOperationConfirmationInput struct {
	ConfirmationID       string
	ActorID              string
	ActorSessionID       string
	ChallengeHash        string
	OwnerVerified        bool
	LoginAuthenticatedAt time.Time
	MFARequired          bool
	MFAVerified          bool
}

type IssuedOperationConfirmationToken struct {
	Token     string
	Hash      string
	KeyID     string
	NonceHash string
	ExpiresAt time.Time
}

type OperationConfirmationTokenIssuer func(OperationConfirmationProjection, time.Time) (IssuedOperationConfirmationToken, error)

// OperationConfirmationTokenVerifier runs inside the consumption SQL
// transaction and receives PostgreSQL transaction_timestamp as its sole clock.
type OperationConfirmationTokenVerifier func(time.Time) (ConsumeOperationConfirmationInput, error)

type ConfirmOperationConfirmationResult struct {
	Confirmation OperationConfirmationProjection
	Token        string
}

type ConsumeOperationConfirmationInput struct {
	ConfirmationID       string
	ActorID              string
	ActorSessionID       string
	Action               string
	ExecutorID           string
	ExpectedRevision     int64
	FromDeviceID         string
	TargetDeviceID       string
	TokenHash            string
	ConsumptionReference string
}

// OperationConfirmationMutation executes the protected business mutation on
// the same SQL transaction that burns the one-time token.  A nil mutation is
// rejected so callers cannot consume confirmation independently of its action.
type OperationConfirmationMutation func(context.Context, *sql.Tx, OperationConfirmationProjection) error

// ResolveOperationConfirmationAction returns only the action frozen into a
// confirmation.  Actor and browser-session mismatches deliberately collapse to
// ErrNotFound so callers cannot use this read path to enumerate confirmations.
// Lifecycle state is intentionally not considered here: Confirm and Consume
// remain responsible for locking and revalidating the mutable state.
func (s *ControlStore) ResolveOperationConfirmationAction(
	ctx context.Context,
	confirmationID string,
	actorID string,
	actorSessionID string,
) (string, error) {
	if !validOpaqueValue(confirmationID) || !validOpaqueValue(actorID) || !validOpaqueValue(actorSessionID) {
		return "", ErrNotFound
	}
	var action string
	err := s.db.QueryRowContext(ctx, `
		SELECT action
		FROM ky_ai_executor_operation_confirmation
		WHERE id=$1 AND actor_id=$2 AND actor_session_id=$3
		  AND security_facts_verified
	`, confirmationID, actorID, actorSessionID).Scan(&action)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if !validOperationConfirmationAction(action) {
		return "", ErrNotFound
	}
	return action, nil
}

func (s *ControlStore) CreateOperationConfirmation(
	ctx context.Context,
	input CreateOperationConfirmationInput,
) (CreateOperationConfirmationResult, error) {
	if !validCreateOperationConfirmation(input) {
		return CreateOperationConfirmationResult{}, ErrOperationConfirmationInputInvalid
	}
	if err := validateOperationConfirmationSecurityFacts(
		input.OwnerVerified, input.LoginAuthenticatedAt, input.MFARequired, input.MFAVerified, time.Time{},
	); err != nil && !errors.Is(err, ErrOperationConfirmationFreshLogin) {
		return CreateOperationConfirmationResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return CreateOperationConfirmationResult{}, err
	}
	defer tx.Rollback()

	if existing, found, err := loadOperationConfirmationByIdempotency(ctx, tx, input); err != nil {
		return CreateOperationConfirmationResult{}, err
	} else if found {
		if !sameOperationConfirmationRequest(existing, input) {
			return CreateOperationConfirmationResult{}, ErrIdempotencyReuse
		}
		if err := tx.Commit(); err != nil {
			return CreateOperationConfirmationResult{}, classifyControlWrite(err)
		}
		return CreateOperationConfirmationResult{Confirmation: existing, Created: false}, nil
	}

	now, err := transactionNow(ctx, tx)
	if err != nil {
		return CreateOperationConfirmationResult{}, err
	}
	if err := validateOperationConfirmationSecurityFacts(
		input.OwnerVerified, input.LoginAuthenticatedAt, input.MFARequired, input.MFAVerified, now,
	); err != nil {
		return CreateOperationConfirmationResult{}, err
	}
	fromDeviceID, err := freezeOperationConfirmationTarget(ctx, tx, input)
	if err != nil {
		return CreateOperationConfirmationResult{}, err
	}

	row := tx.QueryRowContext(ctx, `
		INSERT INTO ky_ai_executor_operation_confirmation (
		 id,action,executor_id,actor_id,actor_session_id,expected_revision,
		 from_device_id,target_device_id,challenge_hash,request_hash,
		 idempotency_key_hash,status,expires_at,created_at,updated_at,
		 security_facts_verified,owner_verified,login_authenticated_at,
		 mfa_required,mfa_verified
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,$13,true,$14,$15,$16,$17)
		ON CONFLICT (actor_id,executor_id,action,idempotency_key_hash) DO NOTHING
		RETURNING `+operationConfirmationColumns,
		input.ID, input.Action, input.ExecutorID, input.ActorID, input.ActorSessionID,
		input.ExpectedRevision, fromDeviceID, input.TargetDeviceID, input.ChallengeHash,
		input.RequestHash, input.IdempotencyKeyHash,
		now.Add(OperationConfirmationChallengeLifetime), now,
		input.OwnerVerified, input.LoginAuthenticatedAt.UTC(), input.MFARequired, input.MFAVerified)
	created, scanErr := scanOperationConfirmation(row)
	if errors.Is(scanErr, sql.ErrNoRows) {
		created, scanErr = loadOperationConfirmationByIdempotencyRequired(ctx, tx, input)
		if scanErr == nil && !sameOperationConfirmationRequest(created, input) {
			return CreateOperationConfirmationResult{}, ErrIdempotencyReuse
		}
		if scanErr == nil {
			if err := tx.Commit(); err != nil {
				return CreateOperationConfirmationResult{}, classifyControlWrite(err)
			}
			return CreateOperationConfirmationResult{Confirmation: created, Created: false}, nil
		}
	}
	if scanErr != nil {
		return CreateOperationConfirmationResult{}, classifyControlWrite(scanErr)
	}

	scopeID := operationConfirmationIdempotencyScope(input.ActorSessionID, input.ExecutorID, input.Action)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_api_idempotency (
		 actor_id,action,scope_id,idempotency_key_hash,request_hash,
		 resource_type,resource_id,response_status
		) VALUES ($1,'create_operation_confirmation',$2,$3,$4,'operation_confirmation',$5,201)
	`, input.ActorID, scopeID, input.IdempotencyKeyHash, input.RequestHash, created.ID); err != nil {
		return CreateOperationConfirmationResult{}, classifyControlWrite(err)
	}
	if err := insertOperationConfirmationAudit(ctx, tx, created, 1, "created", "", now); err != nil {
		return CreateOperationConfirmationResult{}, err
	}
	if err := insertControlOutbox(ctx, tx, "operation_confirmation", created.ID, 1,
		"operation_confirmation.created", operationConfirmationSafeReference(created)); err != nil {
		return CreateOperationConfirmationResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return CreateOperationConfirmationResult{}, classifyControlWrite(err)
	}
	return CreateOperationConfirmationResult{Confirmation: created, Created: true}, nil
}

func (s *ControlStore) ConfirmOperationConfirmation(
	ctx context.Context,
	input ConfirmOperationConfirmationInput,
	issuer OperationConfirmationTokenIssuer,
) (ConfirmOperationConfirmationResult, error) {
	if !validOpaqueValue(input.ConfirmationID) || !validOpaqueValue(input.ActorID) ||
		!validOpaqueValue(input.ActorSessionID) || !confirmationDigestPattern.MatchString(input.ChallengeHash) || issuer == nil {
		return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationInputInvalid
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return ConfirmOperationConfirmationResult{}, err
	}
	defer tx.Rollback()
	item, err := loadOperationConfirmationForUpdate(ctx, tx, input.ConfirmationID)
	if err != nil {
		return ConfirmOperationConfirmationResult{}, err
	}
	if !item.SecurityFactsVerified || !item.OwnerVerified || !sameOperationConfirmationSecurityFacts(item, input) {
		return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationTargetMismatch
	}
	if item.ActorID != input.ActorID || item.ActorSessionID != input.ActorSessionID {
		return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationTargetMismatch
	}
	now, err := transactionNow(ctx, tx)
	if err != nil {
		return ConfirmOperationConfirmationResult{}, err
	}
	switch item.Status {
	case "confirmed":
		if item.ChallengeHash != input.ChallengeHash {
			return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationChallengeInvalid
		}
		if item.TokenExpiresAt == nil || !now.Before(mustParseProjectionTime(*item.TokenExpiresAt)) {
			if err := expireOperationConfirmation(ctx, tx, item, 3, "token_expired", now); err != nil {
				return ConfirmOperationConfirmationResult{}, err
			}
			if err := tx.Commit(); err != nil {
				return ConfirmOperationConfirmationResult{}, classifyControlWrite(err)
			}
			return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationTokenExpired
		}
		issued, err := issuer(item, item.TokenIssuedAt)
		if err != nil {
			return ConfirmOperationConfirmationResult{}, err
		}
		if !matchesPersistedIssuedToken(item, issued) {
			return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationTokenMismatch
		}
		if err := tx.Commit(); err != nil {
			return ConfirmOperationConfirmationResult{}, classifyControlWrite(err)
		}
		return ConfirmOperationConfirmationResult{Confirmation: item, Token: issued.Token}, nil
	case "consumed":
		return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationTokenConsumed
	case "expired":
		if item.TokenHash != "" {
			return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationTokenExpired
		}
		return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationChallengeExpired
	case "pending":
	default:
		return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationInputInvalid
	}
	if err := validateOperationConfirmationSecurityFacts(
		input.OwnerVerified, input.LoginAuthenticatedAt, input.MFARequired, input.MFAVerified, now,
	); err != nil {
		return ConfirmOperationConfirmationResult{}, err
	}
	if !now.Before(mustParseProjectionTime(item.ExpiresAt)) {
		if err := expireOperationConfirmation(ctx, tx, item, 2, "challenge_expired", now); err != nil {
			return ConfirmOperationConfirmationResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return ConfirmOperationConfirmationResult{}, classifyControlWrite(err)
		}
		return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationChallengeExpired
	}
	if item.ChallengeHash != input.ChallengeHash {
		return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationChallengeInvalid
	}
	issuedAt := now.UTC().Truncate(time.Second)
	issued, err := issuer(item, issuedAt)
	if err != nil || !validIssuedOperationConfirmationToken(issued) ||
		!issued.ExpiresAt.Equal(issuedAt.Add(OperationConfirmationTokenLifetime)) {
		if err != nil {
			return ConfirmOperationConfirmationResult{}, err
		}
		return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationInputInvalid
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_confirmation
		SET status='confirmed',confirmation_token_hash=$2,token_key_id=$3,
		    token_nonce_hash=$4,token_issued_at=$5,token_expires_at=$6,
		    confirmed_at=$5,updated_at=$5
		WHERE id=$1 AND status='pending'
	`, item.ID, issued.Hash, issued.KeyID, issued.NonceHash, issuedAt, issued.ExpiresAt)
	if err != nil {
		return ConfirmOperationConfirmationResult{}, classifyControlWrite(err)
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ConfirmOperationConfirmationResult{}, ErrOperationConfirmationChallengeUsed
	}
	item.Status = "confirmed"
	item.TokenHash, item.TokenKeyID, item.TokenNonceHash = issued.Hash, issued.KeyID, issued.NonceHash
	item.TokenIssuedAt = issuedAt
	item.TokenExpiresAt = projectionTimePointer(issued.ExpiresAt)
	item.ConfirmedAt = projectionTimePointer(issuedAt)
	if err := insertOperationConfirmationAudit(ctx, tx, item, 2, "confirmed", "", now); err != nil {
		return ConfirmOperationConfirmationResult{}, err
	}
	if err := insertControlOutbox(ctx, tx, "operation_confirmation", item.ID, 2,
		"operation_confirmation.confirmed", operationConfirmationSafeReference(item)); err != nil {
		return ConfirmOperationConfirmationResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return ConfirmOperationConfirmationResult{}, classifyControlWrite(err)
	}
	return ConfirmOperationConfirmationResult{Confirmation: item, Token: issued.Token}, nil
}

func (s *ControlStore) ConsumeOperationConfirmation(
	ctx context.Context,
	verifier OperationConfirmationTokenVerifier,
	mutation OperationConfirmationMutation,
) (OperationConfirmationProjection, error) {
	if verifier == nil || mutation == nil {
		return OperationConfirmationProjection{}, ErrOperationConfirmationInputInvalid
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return OperationConfirmationProjection{}, err
	}
	defer tx.Rollback()
	now, err := transactionNow(ctx, tx)
	if err != nil {
		return OperationConfirmationProjection{}, err
	}
	input, err := verifier(now)
	if err != nil {
		return OperationConfirmationProjection{}, err
	}
	if !validConsumeOperationConfirmation(input) {
		return OperationConfirmationProjection{}, ErrOperationConfirmationInputInvalid
	}
	item, err := loadOperationConfirmationForUpdate(ctx, tx, input.ConfirmationID)
	if err != nil {
		return OperationConfirmationProjection{}, err
	}
	if !item.SecurityFactsVerified {
		return OperationConfirmationProjection{}, ErrOperationConfirmationTokenMismatch
	}
	if item.Status == "consumed" {
		return OperationConfirmationProjection{}, ErrOperationConfirmationTokenConsumed
	}
	if item.Status != "confirmed" {
		if item.Status == "expired" {
			return OperationConfirmationProjection{}, ErrOperationConfirmationTokenExpired
		}
		return OperationConfirmationProjection{}, ErrOperationConfirmationTokenMismatch
	}
	if !matchesOperationConfirmationConsumption(item, input) {
		return OperationConfirmationProjection{}, ErrOperationConfirmationTokenMismatch
	}
	if item.TokenExpiresAt == nil || !now.Before(mustParseProjectionTime(*item.TokenExpiresAt)) {
		if err := expireOperationConfirmation(ctx, tx, item, 3, "token_expired", now); err != nil {
			return OperationConfirmationProjection{}, err
		}
		if err := tx.Commit(); err != nil {
			return OperationConfirmationProjection{}, classifyControlWrite(err)
		}
		return OperationConfirmationProjection{}, ErrOperationConfirmationTokenExpired
	}
	if err := mutation(ctx, tx, item); err != nil {
		return OperationConfirmationProjection{}, err
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_confirmation
		SET status='consumed',consumed_at=$2,consumption_reference=$3,updated_at=$2
		WHERE id=$1 AND status='confirmed' AND confirmation_token_hash=$4
	`, item.ID, now, input.ConsumptionReference, input.TokenHash)
	if err != nil {
		return OperationConfirmationProjection{}, classifyControlWrite(err)
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return OperationConfirmationProjection{}, ErrOperationConfirmationTokenConsumed
	}
	item.Status = "consumed"
	item.ConsumptionReference = input.ConsumptionReference
	item.ConsumedAt = projectionTimePointer(now)
	if err := insertOperationConfirmationAudit(ctx, tx, item, 3, "consumed", input.ConsumptionReference, now); err != nil {
		return OperationConfirmationProjection{}, err
	}
	if err := insertControlOutbox(ctx, tx, "operation_confirmation", item.ID, 3,
		"operation_confirmation.consumed", operationConfirmationSafeReference(item)); err != nil {
		return OperationConfirmationProjection{}, err
	}
	if err := tx.Commit(); err != nil {
		return OperationConfirmationProjection{}, classifyControlWrite(err)
	}
	return item, nil
}

func validCreateOperationConfirmation(input CreateOperationConfirmationInput) bool {
	if !validOpaqueValue(input.ID) || !validOpaqueValue(input.ExecutorID) || !validOpaqueValue(input.ActorID) ||
		!validOpaqueValue(input.ActorSessionID) || input.ExpectedRevision <= 0 || input.LoginAuthenticatedAt.IsZero() ||
		!confirmationDigestPattern.MatchString(input.ChallengeHash) ||
		!confirmationDigestPattern.MatchString(input.IdempotencyKeyHash) ||
		!confirmationDigestPattern.MatchString(input.RequestHash) {
		return false
	}
	switch input.Action {
	case OperationConfirmationForceRevoke, OperationConfirmationUnbindDevice:
		return input.TargetDeviceID == ""
	case OperationConfirmationRebindDevice:
		return confirmationDigestPattern.MatchString(input.TargetDeviceID)
	default:
		return false
	}
}

func validOperationConfirmationAction(action string) bool {
	switch action {
	case OperationConfirmationForceRevoke, OperationConfirmationRebindDevice, OperationConfirmationUnbindDevice:
		return true
	default:
		return false
	}
}

func validConsumeOperationConfirmation(input ConsumeOperationConfirmationInput) bool {
	if !validOpaqueValue(input.ConfirmationID) || !validOpaqueValue(input.ActorID) ||
		!validOpaqueValue(input.ActorSessionID) || !validOpaqueValue(input.ExecutorID) ||
		input.ExpectedRevision <= 0 || !confirmationDigestPattern.MatchString(input.TokenHash) ||
		!validOpaqueValue(input.ConsumptionReference) {
		return false
	}
	switch input.Action {
	case OperationConfirmationForceRevoke:
		return input.FromDeviceID == "" && input.TargetDeviceID == ""
	case OperationConfirmationRebindDevice:
		return confirmationDigestPattern.MatchString(input.FromDeviceID) &&
			confirmationDigestPattern.MatchString(input.TargetDeviceID) && input.FromDeviceID != input.TargetDeviceID
	case OperationConfirmationUnbindDevice:
		return confirmationDigestPattern.MatchString(input.FromDeviceID) && input.TargetDeviceID == ""
	default:
		return false
	}
}

func validateOperationConfirmationSecurityFacts(owner bool, loginAt time.Time, mfaRequired, mfaVerified bool, now time.Time) error {
	if !owner {
		return ErrOperationConfirmationOwnerRequired
	}
	if mfaRequired && !mfaVerified {
		return ErrOperationConfirmationMFARequired
	}
	if loginAt.IsZero() {
		return ErrOperationConfirmationFreshLogin
	}
	if !now.IsZero() {
		loginAt = loginAt.UTC()
		if loginAt.After(now) || now.Sub(loginAt) > OperationConfirmationFreshLoginWindow {
			return ErrOperationConfirmationFreshLogin
		}
	}
	return nil
}

func freezeOperationConfirmationTarget(ctx context.Context, tx *sql.Tx, input CreateOperationConfirmationInput) (string, error) {
	var currentCredential sql.NullInt64
	if err := tx.QueryRowContext(ctx, `
		SELECT current_credential_revision
		FROM ky_ai_executor_config
		WHERE id=$1 AND scope_type='platform' AND scope_id='platform_root' AND executor_type='codex'
		FOR SHARE
	`, input.ExecutorID).Scan(&currentCredential); errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	} else if err != nil {
		return "", err
	}
	if input.Action == OperationConfirmationForceRevoke {
		if !currentCredential.Valid || currentCredential.Int64 != input.ExpectedRevision {
			return "", ErrRevisionConflict
		}
		return "", nil
	}
	var fromDeviceID, status string
	var bindingRevision int64
	if err := tx.QueryRowContext(ctx, `
		SELECT device_id,revision,status
		FROM ky_ai_executor_device_binding WHERE executor_id=$1 FOR SHARE
	`, input.ExecutorID).Scan(&fromDeviceID, &bindingRevision, &status); errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	} else if err != nil {
		return "", err
	}
	if status != "active" || bindingRevision != input.ExpectedRevision {
		return "", ErrRevisionConflict
	}
	if input.Action == OperationConfirmationRebindDevice {
		if fromDeviceID == input.TargetDeviceID {
			return "", ErrOperationConfirmationTargetMismatch
		}
		var active bool
		if err := tx.QueryRowContext(ctx, `
			SELECT status='active' AND workspace_type='platform' AND workspace_id='platform_root'
			FROM ky_ai_executor_device WHERE id=$1
		`, input.TargetDeviceID).Scan(&active); errors.Is(err, sql.ErrNoRows) {
			return "", ErrNotFound
		} else if err != nil {
			return "", err
		}
		if !active {
			return "", ErrDeviceInactive
		}
	}
	return fromDeviceID, nil
}

func loadOperationConfirmationByIdempotency(
	ctx context.Context,
	tx *sql.Tx,
	input CreateOperationConfirmationInput,
) (OperationConfirmationProjection, bool, error) {
	item, err := scanOperationConfirmation(tx.QueryRowContext(ctx, `
		SELECT `+operationConfirmationColumns+`
		FROM ky_ai_executor_operation_confirmation
		WHERE actor_id=$1 AND executor_id=$2 AND action=$3 AND idempotency_key_hash=$4
		FOR SHARE
	`, input.ActorID, input.ExecutorID, input.Action, input.IdempotencyKeyHash))
	if errors.Is(err, sql.ErrNoRows) {
		return OperationConfirmationProjection{}, false, nil
	}
	return item, err == nil, err
}

func loadOperationConfirmationByIdempotencyRequired(
	ctx context.Context,
	tx *sql.Tx,
	input CreateOperationConfirmationInput,
) (OperationConfirmationProjection, error) {
	item, found, err := loadOperationConfirmationByIdempotency(ctx, tx, input)
	if err != nil {
		return OperationConfirmationProjection{}, err
	}
	if !found {
		return OperationConfirmationProjection{}, ErrConflict
	}
	return item, nil
}

func loadOperationConfirmationForUpdate(ctx context.Context, tx *sql.Tx, id string) (OperationConfirmationProjection, error) {
	item, err := scanOperationConfirmation(tx.QueryRowContext(ctx, `
		SELECT `+operationConfirmationColumns+`
		FROM ky_ai_executor_operation_confirmation WHERE id=$1 FOR UPDATE
	`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return OperationConfirmationProjection{}, ErrNotFound
	}
	return item, err
}

const operationConfirmationColumns = `
	id,action,executor_id,actor_id,actor_session_id,expected_revision,
	from_device_id,target_device_id,status,expires_at,token_expires_at,
	confirmed_at,consumed_at,created_at,owner_verified,login_authenticated_at,
	security_facts_verified,mfa_required,mfa_verified,challenge_hash,idempotency_key_hash,request_hash,
	confirmation_token_hash,token_key_id,token_nonce_hash,token_issued_at,
	consumption_reference`

func scanOperationConfirmation(row rowScanner) (OperationConfirmationProjection, error) {
	var item OperationConfirmationProjection
	var expiresAt, createdAt time.Time
	var tokenExpires, confirmedAt, consumedAt, tokenIssuedAt sql.NullTime
	if err := row.Scan(
		&item.ID, &item.Action, &item.ExecutorID, &item.ActorID, &item.ActorSessionID,
		&item.ExpectedRevision, &item.FromDeviceID, &item.TargetDeviceID, &item.Status,
		&expiresAt, &tokenExpires, &confirmedAt, &consumedAt, &createdAt,
		&item.OwnerVerified, &item.LoginAuthenticatedAt, &item.SecurityFactsVerified,
		&item.MFARequired, &item.MFAVerified,
		&item.ChallengeHash, &item.IdempotencyKeyHash, &item.RequestHash, &item.TokenHash,
		&item.TokenKeyID, &item.TokenNonceHash, &tokenIssuedAt, &item.ConsumptionReference,
	); err != nil {
		return OperationConfirmationProjection{}, err
	}
	item.ExpiresAt = expiresAt.UTC().Format(time.RFC3339Nano)
	item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	item.LoginAuthenticatedAt = item.LoginAuthenticatedAt.UTC()
	if tokenExpires.Valid {
		item.TokenExpiresAt = projectionTimePointer(tokenExpires.Time)
	}
	if confirmedAt.Valid {
		item.ConfirmedAt = projectionTimePointer(confirmedAt.Time)
	}
	if consumedAt.Valid {
		item.ConsumedAt = projectionTimePointer(consumedAt.Time)
	}
	if tokenIssuedAt.Valid {
		item.TokenIssuedAt = tokenIssuedAt.Time.UTC()
	}
	return item, nil
}

func sameOperationConfirmationRequest(item OperationConfirmationProjection, input CreateOperationConfirmationInput) bool {
	return item.SecurityFactsVerified && item.RequestHash == input.RequestHash && item.ActorID == input.ActorID &&
		item.ActorSessionID == input.ActorSessionID && item.Action == input.Action &&
		item.ExecutorID == input.ExecutorID && item.ExpectedRevision == input.ExpectedRevision &&
		item.TargetDeviceID == input.TargetDeviceID && item.OwnerVerified == input.OwnerVerified &&
		item.LoginAuthenticatedAt.Equal(input.LoginAuthenticatedAt.UTC()) &&
		item.MFARequired == input.MFARequired && item.MFAVerified == input.MFAVerified
}

func sameOperationConfirmationSecurityFacts(item OperationConfirmationProjection, input ConfirmOperationConfirmationInput) bool {
	return item.OwnerVerified == input.OwnerVerified &&
		item.LoginAuthenticatedAt.Equal(input.LoginAuthenticatedAt.UTC()) &&
		item.MFARequired == input.MFARequired && item.MFAVerified == input.MFAVerified
}

func matchesOperationConfirmationConsumption(item OperationConfirmationProjection, input ConsumeOperationConfirmationInput) bool {
	return item.ID == input.ConfirmationID && item.ActorID == input.ActorID &&
		item.ActorSessionID == input.ActorSessionID && item.Action == input.Action &&
		item.ExecutorID == input.ExecutorID && item.ExpectedRevision == input.ExpectedRevision &&
		item.FromDeviceID == input.FromDeviceID && item.TargetDeviceID == input.TargetDeviceID &&
		item.TokenHash == input.TokenHash
}

func validIssuedOperationConfirmationToken(issued IssuedOperationConfirmationToken) bool {
	return issued.Token != "" && len(issued.Token) <= 16<<10 &&
		confirmationDigestPattern.MatchString(issued.Hash) && operationConfirmationTokenDigest(issued.Token) == issued.Hash &&
		confirmationKeyIDPattern.MatchString(issued.KeyID) &&
		confirmationDigestPattern.MatchString(issued.NonceHash) && !issued.ExpiresAt.IsZero()
}

func matchesPersistedIssuedToken(item OperationConfirmationProjection, issued IssuedOperationConfirmationToken) bool {
	return validIssuedOperationConfirmationToken(issued) && !item.TokenIssuedAt.IsZero() &&
		item.TokenExpiresAt != nil && issued.Hash == item.TokenHash && issued.KeyID == item.TokenKeyID &&
		issued.NonceHash == item.TokenNonceHash &&
		issued.ExpiresAt.Equal(mustParseProjectionTime(*item.TokenExpiresAt))
}

func expireOperationConfirmation(
	ctx context.Context,
	tx *sql.Tx,
	item OperationConfirmationProjection,
	sequence int64,
	eventType string,
	now time.Time,
) error {
	if _, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_confirmation SET status='expired',updated_at=$2
		WHERE id=$1 AND status IN ('pending','confirmed')
	`, item.ID, now); err != nil {
		return classifyControlWrite(err)
	}
	item.Status = "expired"
	if err := insertOperationConfirmationAudit(ctx, tx, item, sequence, eventType, "", now); err != nil {
		return err
	}
	return insertControlOutbox(ctx, tx, "operation_confirmation", item.ID, sequence,
		"operation_confirmation."+eventType, operationConfirmationSafeReference(item))
}

func insertOperationConfirmationAudit(
	ctx context.Context,
	tx *sql.Tx,
	item OperationConfirmationProjection,
	sequence int64,
	eventType string,
	consumptionReference string,
	occurredAt time.Time,
) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_operation_confirmation_audit (
		 confirmation_id,sequence,event_type,actor_id,actor_session_id,action,
		 executor_id,expected_revision,from_device_id,target_device_id,
		 owner_verified,login_authenticated_at,mfa_required,mfa_verified,
		 request_hash,consumption_reference,occurred_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
	`, item.ID, sequence, eventType, item.ActorID, item.ActorSessionID, item.Action,
		item.ExecutorID, item.ExpectedRevision, item.FromDeviceID, item.TargetDeviceID,
		item.OwnerVerified, item.LoginAuthenticatedAt, item.MFARequired, item.MFAVerified,
		item.RequestHash, consumptionReference, occurredAt)
	return classifyControlWrite(err)
}

func operationConfirmationSafeReference(item OperationConfirmationProjection) map[string]any {
	result := map[string]any{
		"action": item.Action, "executorId": item.ExecutorID, "status": item.Status,
	}
	if item.FromDeviceID != "" {
		result["fromDeviceId"] = item.FromDeviceID
	}
	if item.TargetDeviceID != "" {
		result["targetDeviceId"] = item.TargetDeviceID
	}
	if item.ConsumptionReference != "" {
		result["consumptionReference"] = item.ConsumptionReference
	}
	return result
}

func operationConfirmationIdempotencyScope(sessionID, executorID, action string) string {
	return fmt.Sprintf("%s:%s:%s", sessionID, executorID, action)
}

func projectionTimePointer(value time.Time) *string {
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}

func operationConfirmationTokenDigest(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func mustParseProjectionTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed
}
