package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrAuthorizationConflict      = errors.New("authorization session conflict")
	ErrAuthorizationTerminal      = errors.New("authorization session terminal")
	ErrExecutorBusy               = errors.New("executor operation busy")
	ErrExecutorFenced             = errors.New("executor operation fenced")
	ErrRequesterMismatch          = errors.New("authorization requester mismatch")
	ErrCredentialRecoveryRequired = errors.New("prepared credential recovery is required")
)

const (
	AuthorizationEventChanged  = "authorization.session.changed"
	AuthorizationEventTerminal = "authorization.session.terminal"
	AuthorizationEventClosed   = "authorization.stream.closed"
)

type AuthorizationRecoveryItem struct {
	SessionID                  string
	ExecutorID                 string
	PreparedCredentialRevision *int64
	OperationID                string
}

type AuthorizationSessionProjection struct {
	ID                    string          `json:"id"`
	ExecutorID            string          `json:"executorId"`
	RuntimeType           string          `json:"runtimeType"`
	FlowType              string          `json:"flowType"`
	Intent                string          `json:"intent"`
	Status                string          `json:"status"`
	Sequence              int64           `json:"sequence"`
	Revision              int64           `json:"revision"`
	RequestedBy           string          `json:"-"`
	UserActionRequired    bool            `json:"userActionRequired"`
	SessionDeadlineAt     string          `json:"sessionDeadlineAt"`
	AccountSummary        json.RawMessage `json:"accountSummary"`
	Failure               *SessionFailure `json:"failure"`
	PreparedCredentialRev *int64          `json:"-"`
	StartedAt             string          `json:"startedAt"`
	FinishedAt            *string         `json:"finishedAt"`
	CreatedAt             string          `json:"createdAt"`
	UpdatedAt             string          `json:"updatedAt"`
}

type SessionFailure struct {
	Code string `json:"code"`
}

type CreateAuthorizationSessionInput struct {
	ID                 string
	ExecutorID         string
	Intent             string
	ActorID            string
	IdempotencyKeyHash string
	RequestHash        string
	Deadline           time.Time
}

type CreateAuthorizationSessionResult struct {
	Session AuthorizationSessionProjection
	Created bool
}

func (s *ControlStore) CreateAuthorizationSession(ctx context.Context, input CreateAuthorizationSessionInput) (CreateAuthorizationSessionResult, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return CreateAuthorizationSessionResult{}, err
	}
	defer tx.Rollback()

	var existingID, existingHash string
	err = tx.QueryRowContext(ctx, `
		SELECT id, request_hash FROM ky_ai_executor_authorization_session
		WHERE requested_by=$1 AND executor_id=$2 AND idempotency_key_hash=$3
	`, input.ActorID, input.ExecutorID, input.IdempotencyKeyHash).Scan(&existingID, &existingHash)
	if err == nil {
		if existingHash != input.RequestHash {
			return CreateAuthorizationSessionResult{}, ErrIdempotencyReuse
		}
		_ = tx.Rollback()
		item, getErr := s.GetAuthorizationSession(ctx, existingID)
		return CreateAuthorizationSessionResult{Session: item, Created: false}, getErr
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return CreateAuthorizationSessionResult{}, err
	}

	var runtimeType, status string
	err = tx.QueryRowContext(ctx, `
		SELECT runtime_type, status FROM ky_ai_executor_config WHERE id=$1 FOR UPDATE
	`, input.ExecutorID).Scan(&runtimeType, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return CreateAuthorizationSessionResult{}, ErrNotFound
	}
	if err != nil {
		return CreateAuthorizationSessionResult{}, err
	}
	if status != "enabled" {
		return CreateAuthorizationSessionResult{}, ErrConflict
	}
	flowType := ""
	switch runtimeType {
	case "server":
		flowType = "device_code"
	case "desktop":
		flowType = "browser"
	default:
		return CreateAuthorizationSessionResult{}, ErrConflict
	}
	var activeID string
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM ky_ai_executor_authorization_session
		WHERE executor_id=$1 AND status IN ('starting','waiting_user','verifying')
		LIMIT 1 FOR UPDATE
	`, input.ExecutorID).Scan(&activeID)
	if err == nil {
		return CreateAuthorizationSessionResult{}, ErrAuthorizationConflict
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return CreateAuthorizationSessionResult{}, err
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_authorization_session (
		  id, executor_id, runtime_type, flow_type, intent, status, requested_by,
		  revision, current_sequence, idempotency_key_hash, request_hash,
		  session_deadline_at, started_at
		) VALUES ($1,$2,$3,$4,$5,'starting',$6,1,1,$7,$8,$9,now())
	`, input.ID, input.ExecutorID, runtimeType, flowType, input.Intent, input.ActorID,
		input.IdempotencyKeyHash, input.RequestHash, input.Deadline.UTC())
	if err != nil {
		return CreateAuthorizationSessionResult{}, classifyControlWrite(err)
	}
	if err := insertSessionEvent(ctx, tx, input.ID, 1, AuthorizationEventChanged, map[string]any{"change": "started", "intent": input.Intent}); err != nil {
		return CreateAuthorizationSessionResult{}, err
	}
	if err := insertControlOutbox(ctx, tx, "authorization_session", input.ID, 1, "started", map[string]any{"executorId": input.ExecutorID}); err != nil {
		return CreateAuthorizationSessionResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return CreateAuthorizationSessionResult{}, classifyControlWrite(err)
	}
	item, err := s.GetAuthorizationSession(ctx, input.ID)
	return CreateAuthorizationSessionResult{Session: item, Created: true}, err
}

func (s *ControlStore) GetCurrentAuthorizationSession(ctx context.Context, executorID string) (AuthorizationSessionProjection, error) {
	row := s.db.QueryRowContext(ctx, authorizationSessionSelect+`
		WHERE executor_id=$1 AND status IN ('starting','waiting_user','verifying')
		ORDER BY created_at DESC LIMIT 1
	`, executorID)
	item, err := scanAuthorizationSession(row)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthorizationSessionProjection{}, ErrNotFound
	}
	return item, err
}

func (s *ControlStore) GetAuthorizationSession(ctx context.Context, sessionID string) (AuthorizationSessionProjection, error) {
	item, err := scanAuthorizationSession(s.db.QueryRowContext(ctx, authorizationSessionSelect+` WHERE id=$1`, sessionID))
	if errors.Is(err, sql.ErrNoRows) {
		return AuthorizationSessionProjection{}, ErrNotFound
	}
	return item, err
}

const authorizationSessionSelect = `
	SELECT id, executor_id, runtime_type, flow_type, intent, status,
	       current_sequence, revision, requested_by, session_deadline_at,
	       account_summary_json, failure_code, prepared_credential_revision,
	       started_at, finished_at, created_at, updated_at
	FROM ky_ai_executor_authorization_session
`

func scanAuthorizationSession(row rowScanner) (AuthorizationSessionProjection, error) {
	var item AuthorizationSessionProjection
	var summary []byte
	var failureCode string
	var prepared sql.NullInt64
	var startedAt, deadlineAt, createdAt, updatedAt time.Time
	var finishedAt sql.NullTime
	err := row.Scan(&item.ID, &item.ExecutorID, &item.RuntimeType, &item.FlowType,
		&item.Intent, &item.Status, &item.Sequence, &item.Revision, &item.RequestedBy,
		&deadlineAt, &summary, &failureCode, &prepared, &startedAt, &finishedAt,
		&createdAt, &updatedAt)
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	item.UserActionRequired = item.FlowType == "device_code" && item.Status == "waiting_user"
	item.SessionDeadlineAt = deadlineAt.UTC().Format(time.RFC3339Nano)
	item.AccountSummary = append(json.RawMessage(nil), summary...)
	if len(item.AccountSummary) == 0 {
		item.AccountSummary = json.RawMessage(`{}`)
	}
	failureCode = safeStoredCode(failureCode)
	if failureCode != "" {
		item.Failure = &SessionFailure{Code: failureCode}
	}
	item.PreparedCredentialRev = nullableInt64(prepared)
	item.StartedAt = startedAt.UTC().Format(time.RFC3339Nano)
	item.FinishedAt = nullableTime(finishedAt)
	item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	item.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	return item, nil
}

func (s *ControlStore) MarkAuthorizationWaiting(ctx context.Context, sessionID, ownerInstanceID, loginIDHash string, expectedRevision int64) (AuthorizationSessionProjection, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	defer tx.Rollback()
	var executorID string
	var sequence, revision int64
	err = tx.QueryRowContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET status='waiting_user', runtime_owner_instance_id=$1, login_id_hash=$2,
		    revision=revision+1, current_sequence=current_sequence+1, updated_at=now()
		WHERE id=$3 AND revision=$4 AND status='starting'
		RETURNING executor_id,current_sequence,revision
	`, ownerInstanceID, loginIDHash, sessionID, expectedRevision).Scan(&executorID, &sequence, &revision)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthorizationSessionProjection{}, ErrRevisionConflict
	}
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := insertSessionEvent(ctx, tx, sessionID, sequence, AuthorizationEventChanged, map[string]any{"change": "waiting_user"}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := insertControlOutbox(ctx, tx, "authorization_session", sessionID, revision, "waiting_user", map[string]any{"executorId": executorID}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := tx.Commit(); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	return s.GetAuthorizationSession(ctx, sessionID)
}

func (s *ControlStore) MarkAuthorizationVerifying(ctx context.Context, sessionID, ownerInstanceID string, expectedRevision int64) (AuthorizationSessionProjection, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	defer tx.Rollback()
	var executorID string
	var sequence, revision int64
	err = tx.QueryRowContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET status='verifying', revision=revision+1, current_sequence=current_sequence+1, updated_at=now()
		WHERE id=$1 AND revision=$2 AND status='waiting_user' AND runtime_owner_instance_id=$3
		RETURNING executor_id,current_sequence,revision
	`, sessionID, expectedRevision, ownerInstanceID).Scan(&executorID, &sequence, &revision)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthorizationSessionProjection{}, ErrRevisionConflict
	}
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := insertSessionEvent(ctx, tx, sessionID, sequence, AuthorizationEventChanged, map[string]any{"change": "verifying"}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := insertControlOutbox(ctx, tx, "authorization_session", sessionID, revision, "verifying", map[string]any{"executorId": executorID}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := tx.Commit(); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	return s.GetAuthorizationSession(ctx, sessionID)
}

type AuthorizationEventProjection struct {
	Sequence    int64           `json:"sequence"`
	EventType   string          `json:"eventType"`
	SafePayload json.RawMessage `json:"safePayload"`
	OccurredAt  string          `json:"occurredAt"`
}

func (s *ControlStore) ListAuthorizationEvents(ctx context.Context, sessionID string, after int64, limit int) ([]AuthorizationEventProjection, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT sequence, event_type, safe_payload_json, occurred_at
		FROM ky_ai_executor_authorization_session_event
		WHERE session_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3
	`, sessionID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AuthorizationEventProjection{}
	for rows.Next() {
		var item AuthorizationEventProjection
		var payload []byte
		var occurredAt time.Time
		if err := rows.Scan(&item.Sequence, &item.EventType, &payload, &occurredAt); err != nil {
			return nil, err
		}
		item.EventType = safeAuthorizationEventType(item.EventType)
		item.SafePayload = append(json.RawMessage(nil), payload...)
		item.OccurredAt = occurredAt.UTC().Format(time.RFC3339Nano)
		items = append(items, item)
	}
	return items, rows.Err()
}

type CredentialPreparationInput struct {
	SessionID               string
	ExpectedSessionRevision int64
	OwnerInstanceID         string
	OperationID             string
	RuntimeBindingID        string
	RuntimeBindingRevision  int64
	AccountFingerprint      string
	PlanType                string
	BindingDigest           string
}

type CredentialPreparation struct {
	ExecutorID               string
	OwnerInstanceID          string
	CredentialRevision       int64
	SessionRevision          int64
	LeaseEpoch               int64
	SourceCredentialRevision int64
	RevocationEpoch          int64
	BindingDigest            string
}

func (s *ControlStore) PrepareServerCredential(ctx context.Context, input CredentialPreparationInput) (CredentialPreparation, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return CredentialPreparation{}, err
	}
	defer tx.Rollback()
	var executorID, status, owner string
	var revision int64
	err = tx.QueryRowContext(ctx, `
		SELECT executor_id, status, revision, runtime_owner_instance_id
		FROM ky_ai_executor_authorization_session WHERE id=$1 FOR UPDATE
	`, input.SessionID).Scan(&executorID, &status, &revision, &owner)
	if errors.Is(err, sql.ErrNoRows) {
		return CredentialPreparation{}, ErrNotFound
	}
	if err != nil {
		return CredentialPreparation{}, err
	}
	if status != "verifying" || revision != input.ExpectedSessionRevision || owner != input.OwnerInstanceID {
		return CredentialPreparation{}, ErrRevisionConflict
	}
	var currentRevision sql.NullInt64
	var counter, revocationEpoch int64
	var runtimeType string
	err = tx.QueryRowContext(ctx, `
		SELECT runtime_type, current_credential_revision, credential_revision_counter, revocation_epoch
		FROM ky_ai_executor_config WHERE id=$1 FOR UPDATE
	`, executorID).Scan(&runtimeType, &currentRevision, &counter, &revocationEpoch)
	if err != nil {
		return CredentialPreparation{}, err
	}
	if runtimeType != "server" {
		return CredentialPreparation{}, ErrConflict
	}
	sourceRevision := int64(0)
	if currentRevision.Valid {
		sourceRevision = currentRevision.Int64
	}
	var leaseEpoch int64
	err = tx.QueryRowContext(ctx, `
		INSERT INTO ky_ai_executor_operation_lease (
		  executor_id, operation_id, owner_instance_id, lease_epoch, lease_expires_at,
		  source_credential_revision, revocation_epoch, status
		) VALUES ($1,$2,$3,1,now()+interval '30 seconds',$4,$5,'active')
		ON CONFLICT (executor_id) DO UPDATE SET
		  operation_id=EXCLUDED.operation_id,
		  owner_instance_id=EXCLUDED.owner_instance_id,
		  lease_epoch=ky_ai_executor_operation_lease.lease_epoch+1,
		  lease_expires_at=EXCLUDED.lease_expires_at,
		  source_credential_revision=EXCLUDED.source_credential_revision,
		  revocation_epoch=EXCLUDED.revocation_epoch,
		  status='active', updated_at=now()
		WHERE ky_ai_executor_operation_lease.status<>'active'
		   OR ky_ai_executor_operation_lease.lease_expires_at<=now()
		RETURNING lease_epoch
	`, executorID, input.OperationID, input.OwnerInstanceID, sourceRevision, revocationEpoch).Scan(&leaseEpoch)
	if errors.Is(err, sql.ErrNoRows) {
		return CredentialPreparation{}, ErrExecutorBusy
	}
	if err != nil {
		return CredentialPreparation{}, classifyControlWrite(err)
	}
	credentialRevision := counter + 1
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_binding (
		  executor_id, revision, status, authorization_session_id, runtime_type,
		  runtime_binding_id, runtime_binding_revision, account_fingerprint,
		  auth_mode, plan_type, binding_digest, revocation_epoch,
		  operation_id, lease_epoch, source_credential_revision, digest_algorithm
		) VALUES ($1,$2,'prepared',$3,'server',$4,$5,$6,'device_code',$7,$8,$9,$10,$11,$12,$13)
	`, executorID, credentialRevision, input.SessionID, input.RuntimeBindingID,
		input.RuntimeBindingRevision, input.AccountFingerprint, input.PlanType,
		input.BindingDigest, revocationEpoch, input.OperationID, leaseEpoch,
		sourceRevision, "aicrm-credential-tree-rfc8785-nfc-v1")
	if err != nil {
		return CredentialPreparation{}, classifyControlWrite(err)
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_config SET credential_revision_counter=$1, updated_at=now()
		WHERE id=$2 AND credential_revision_counter=$3 AND revocation_epoch=$4
	`, credentialRevision, executorID, counter, revocationEpoch)
	if err != nil {
		return CredentialPreparation{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return CredentialPreparation{}, ErrExecutorFenced
	}
	result, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET prepared_credential_revision=$1, operation_id=$2, revision=revision+1, updated_at=now()
		WHERE id=$3 AND revision=$4 AND status='verifying'
	`, credentialRevision, input.OperationID, input.SessionID, input.ExpectedSessionRevision)
	if err != nil {
		return CredentialPreparation{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return CredentialPreparation{}, ErrRevisionConflict
	}
	if err := insertControlOutbox(ctx, tx, "credential_binding", executorID+":"+itoa64(credentialRevision), 1, "credential_prepared", map[string]any{"executorId": executorID, "sessionId": input.SessionID}); err != nil {
		return CredentialPreparation{}, err
	}
	if err := tx.Commit(); err != nil {
		return CredentialPreparation{}, classifyControlWrite(err)
	}
	return CredentialPreparation{
		ExecutorID: executorID, OwnerInstanceID: input.OwnerInstanceID,
		CredentialRevision: credentialRevision,
		SessionRevision:    input.ExpectedSessionRevision + 1, LeaseEpoch: leaseEpoch,
		SourceCredentialRevision: sourceRevision, RevocationEpoch: revocationEpoch,
		BindingDigest: input.BindingDigest,
	}, nil
}

func (s *ControlStore) MarkCredentialCommitting(ctx context.Context, prep CredentialPreparation, operationID string) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_binding binding
		SET status='committing'
		WHERE binding.executor_id=$1 AND binding.revision=$2 AND binding.status IN ('prepared','committing')
		  AND binding.binding_digest=$3 AND binding.revocation_epoch=$4
		  AND binding.operation_id=$5 AND binding.lease_epoch=$6
		  AND binding.source_credential_revision=$7
		  AND EXISTS (
		    SELECT 1 FROM ky_ai_executor_operation_lease lease
		    WHERE lease.executor_id=binding.executor_id AND lease.operation_id=$5
		      AND lease.owner_instance_id=$8 AND lease.lease_epoch=$6
		      AND lease.source_credential_revision=$7 AND lease.revocation_epoch=$4
		      AND lease.status='active' AND lease.lease_expires_at>now()
		  )
	`, prep.ExecutorID, prep.CredentialRevision, prep.BindingDigest, prep.RevocationEpoch,
		operationID, prep.LeaseEpoch, prep.SourceCredentialRevision, prep.OwnerInstanceID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrExecutorFenced
	}
	return nil
}

func (s *ControlStore) RenewServerCredentialLease(ctx context.Context, prep CredentialPreparation, operationID string) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease
		SET lease_expires_at=now()+interval '30 seconds',updated_at=now()
		WHERE executor_id=$1 AND operation_id=$2 AND owner_instance_id=$3
		  AND lease_epoch=$4 AND source_credential_revision=$5 AND revocation_epoch=$6
		  AND status='active' AND lease_expires_at>now()
	`, prep.ExecutorID, operationID, prep.OwnerInstanceID, prep.LeaseEpoch,
		prep.SourceCredentialRevision, prep.RevocationEpoch)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrExecutorFenced
	}
	return nil
}

func (s *ControlStore) QuarantineServerCredential(ctx context.Context, sessionID string, prep CredentialPreparation, operationID, terminalStatus, failureCode string) (AuthorizationSessionProjection, bool, error) {
	if terminalStatus != "failed" && terminalStatus != "expired" && terminalStatus != "interrupted" {
		return AuthorizationSessionProjection{}, false, ErrConflict
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	defer tx.Rollback()
	var sessionStatus, owner string
	var sessionRevision, sequence int64
	err = tx.QueryRowContext(ctx, `
		SELECT status,revision,current_sequence,runtime_owner_instance_id
		FROM ky_ai_executor_authorization_session WHERE id=$1 FOR UPDATE
	`, sessionID).Scan(&sessionStatus, &sessionRevision, &sequence, &owner)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthorizationSessionProjection{}, false, ErrNotFound
	}
	if err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	var bindingStatus, digest string
	err = tx.QueryRowContext(ctx, `
		SELECT status,binding_digest FROM ky_ai_executor_credential_binding
		WHERE executor_id=$1 AND revision=$2 AND operation_id=$3 AND lease_epoch=$4
		  AND source_credential_revision=$5 AND revocation_epoch=$6 FOR UPDATE
	`, prep.ExecutorID, prep.CredentialRevision, operationID, prep.LeaseEpoch,
		prep.SourceCredentialRevision, prep.RevocationEpoch).Scan(&bindingStatus, &digest)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthorizationSessionProjection{}, false, ErrExecutorFenced
	}
	if err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	terminal := sessionStatus == "succeeded" || sessionStatus == "failed" || sessionStatus == "cancelled" ||
		sessionStatus == "expired" || sessionStatus == "interrupted" || sessionStatus == "superseded"
	if terminal {
		_ = tx.Rollback()
		item, getErr := s.GetAuthorizationSession(ctx, sessionID)
		return item, bindingStatus == "quarantined", getErr
	}
	if sessionStatus != "verifying" || sessionRevision != prep.SessionRevision ||
		owner != prep.OwnerInstanceID || bindingStatus != "prepared" && bindingStatus != "committing" ||
		digest != prep.BindingDigest {
		return AuthorizationSessionProjection{}, false, ErrExecutorFenced
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_binding
		SET status='quarantined'
		WHERE executor_id=$1 AND revision=$2 AND status IN ('prepared','committing')
		  AND operation_id=$3 AND lease_epoch=$4 AND source_credential_revision=$5
		  AND revocation_epoch=$6 AND binding_digest=$7
	`, prep.ExecutorID, prep.CredentialRevision, operationID, prep.LeaseEpoch,
		prep.SourceCredentialRevision, prep.RevocationEpoch, prep.BindingDigest)
	if err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return AuthorizationSessionProjection{}, false, ErrExecutorFenced
	}
	safeFailure := safeStoredCode(failureCode)
	result, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET status=$1,failure_code=$2,current_sequence=current_sequence+3,
		    revision=revision+1,finished_at=now(),updated_at=now()
		WHERE id=$3 AND revision=$4 AND status='verifying' AND runtime_owner_instance_id=$5
	`, terminalStatus, safeFailure, sessionID, prep.SessionRevision, prep.OwnerInstanceID)
	if err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return AuthorizationSessionProjection{}, false, ErrExecutorFenced
	}
	result, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease SET status='fenced',updated_at=now()
		WHERE executor_id=$1 AND operation_id=$2 AND owner_instance_id=$3
		  AND lease_epoch=$4 AND source_credential_revision=$5 AND revocation_epoch=$6
		  AND status='active'
	`, prep.ExecutorID, operationID, prep.OwnerInstanceID, prep.LeaseEpoch,
		prep.SourceCredentialRevision, prep.RevocationEpoch)
	if err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return AuthorizationSessionProjection{}, false, ErrExecutorFenced
	}
	if err := insertSessionEvent(ctx, tx, sessionID, sequence+1, AuthorizationEventChanged, map[string]any{"change": terminalStatus, "failureCode": safeFailure}); err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	if err := insertSessionEvent(ctx, tx, sessionID, sequence+2, AuthorizationEventTerminal, map[string]any{"status": terminalStatus, "failureCode": safeFailure}); err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	if err := insertSessionEvent(ctx, tx, sessionID, sequence+3, AuthorizationEventClosed, map[string]any{"reason": "terminal"}); err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	if err := insertControlOutbox(ctx, tx, "credential_binding", prep.ExecutorID+":"+itoa64(prep.CredentialRevision), 2, "credential_quarantined", map[string]any{"executorId": prep.ExecutorID, "sessionId": sessionID, "failureCode": safeFailure}); err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	if err := insertControlOutbox(ctx, tx, "authorization_session", sessionID, prep.SessionRevision+1, terminalStatus, map[string]any{"executorId": prep.ExecutorID, "failureCode": safeFailure}); err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return AuthorizationSessionProjection{}, false, classifyControlWrite(err)
	}
	item, err := s.GetAuthorizationSession(ctx, sessionID)
	return item, true, err
}

type ModelCatalogEntry struct {
	CatalogItemID          string
	ModelKey               string
	DisplayName            string
	InputModalitiesJSON    []byte
	SupportedReasoningJSON []byte
	Hidden                 bool
	UpgradeModelKey        string
}

type ActivateServerCredentialInput struct {
	SessionID              string
	OwnerInstanceID        string
	OperationID            string
	Preparation            CredentialPreparation
	AccountSummaryJSON     []byte
	AccountFingerprint     string
	RuntimeBindingID       string
	RuntimeBindingRevision int64
	CodexVersion           string
	Models                 []ModelCatalogEntry
}

func (s *ControlStore) ActivateServerCredential(ctx context.Context, input ActivateServerCredentialInput) (AuthorizationSessionProjection, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	defer tx.Rollback()
	prep := input.Preparation
	var configRevocation, catalogRevision int64
	var currentRevision sql.NullInt64
	var defaultModel sql.NullString
	err = tx.QueryRowContext(ctx, `
		SELECT current_credential_revision, revocation_epoch, catalog_revision, default_model_key
		FROM ky_ai_executor_config WHERE id=$1 FOR UPDATE
	`, prep.ExecutorID).Scan(&currentRevision, &configRevocation, &catalogRevision, &defaultModel)
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	current := int64(0)
	if currentRevision.Valid {
		current = currentRevision.Int64
	}
	if configRevocation != prep.RevocationEpoch || current != prep.SourceCredentialRevision {
		return AuthorizationSessionProjection{}, ErrExecutorFenced
	}
	var leaseStatus string
	var leaseExpiry time.Time
	err = tx.QueryRowContext(ctx, `
		SELECT status, lease_expires_at FROM ky_ai_executor_operation_lease
		WHERE executor_id=$1 AND operation_id=$2 AND owner_instance_id=$3 AND lease_epoch=$4
		  AND source_credential_revision=$5 AND revocation_epoch=$6 FOR UPDATE
	`, prep.ExecutorID, input.OperationID, input.OwnerInstanceID, prep.LeaseEpoch,
		prep.SourceCredentialRevision, prep.RevocationEpoch).Scan(&leaseStatus, &leaseExpiry)
	if err != nil || leaseStatus != "active" || !leaseExpiry.After(time.Now()) {
		return AuthorizationSessionProjection{}, ErrExecutorFenced
	}
	var sessionStatus, owner string
	var sessionRevision, sequence int64
	err = tx.QueryRowContext(ctx, `
		SELECT status, revision, current_sequence, runtime_owner_instance_id
		FROM ky_ai_executor_authorization_session WHERE id=$1 FOR UPDATE
	`, input.SessionID).Scan(&sessionStatus, &sessionRevision, &sequence, &owner)
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if sessionStatus != "verifying" || sessionRevision != prep.SessionRevision || owner != input.OwnerInstanceID {
		return AuthorizationSessionProjection{}, ErrRevisionConflict
	}
	var bindingStatus, digest string
	err = tx.QueryRowContext(ctx, `
		SELECT status, binding_digest FROM ky_ai_executor_credential_binding
		WHERE executor_id=$1 AND revision=$2 AND operation_id=$3 AND lease_epoch=$4
		  AND source_credential_revision=$5 AND revocation_epoch=$6 FOR UPDATE
	`, prep.ExecutorID, prep.CredentialRevision, input.OperationID, prep.LeaseEpoch,
		prep.SourceCredentialRevision, prep.RevocationEpoch).Scan(&bindingStatus, &digest)
	if err != nil || bindingStatus != "committing" || digest != prep.BindingDigest {
		return AuthorizationSessionProjection{}, ErrExecutorFenced
	}
	if current > 0 {
		if _, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_credential_binding
			SET status='revoked',revoked_at=now()
			WHERE executor_id=$1 AND revision=$2 AND status='active'
		`, prep.ExecutorID, current); err != nil {
			return AuthorizationSessionProjection{}, err
		}
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_binding
		SET status='active', verified_at=now(), activated_at=now()
		WHERE executor_id=$1 AND revision=$2 AND status='committing'
		  AND operation_id=$3 AND lease_epoch=$4 AND source_credential_revision=$5
		  AND revocation_epoch=$6
	`, prep.ExecutorID, prep.CredentialRevision, input.OperationID, prep.LeaseEpoch,
		prep.SourceCredentialRevision, prep.RevocationEpoch)
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return AuthorizationSessionProjection{}, ErrExecutorFenced
	}
	newCatalogRevision := catalogRevision + 1
	for _, model := range input.Models {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_model_catalog (
			  executor_id, catalog_revision, model_key, display_name, metadata_json,
			  account_fingerprint, last_seen_at, status, catalog_item_id,
			  input_modalities_json, supported_reasoning_json, hidden,
			  upgrade_model_key, codex_version
			) VALUES ($1,$2,$3,$4,'{}'::jsonb,$5,now(),'available',$6,$7::jsonb,$8::jsonb,$9,$10,$11)
		`, prep.ExecutorID, newCatalogRevision, model.ModelKey, model.DisplayName,
			input.AccountFingerprint, model.CatalogItemID, string(model.InputModalitiesJSON),
			string(model.SupportedReasoningJSON), model.Hidden, model.UpgradeModelKey,
			input.CodexVersion)
		if err != nil {
			return AuthorizationSessionProjection{}, classifyControlWrite(err)
		}
	}
	readinessStatus, reason := "degraded", "default_model_missing"
	if defaultModel.Valid {
		var available bool
		if err := tx.QueryRowContext(ctx, `
			SELECT EXISTS (
			 SELECT 1 FROM ky_ai_executor_model_catalog
			 WHERE executor_id=$1 AND catalog_revision=$2 AND model_key=$3
			   AND status='available' AND NOT hidden
			   AND input_modalities_json @> '["text","image"]'::jsonb
			)
		`, prep.ExecutorID, newCatalogRevision, defaultModel.String).Scan(&available); err != nil {
			return AuthorizationSessionProjection{}, err
		}
		if available {
			readinessStatus, reason = "ready", ""
		} else {
			reason = "model_unavailable"
		}
	}
	result, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_config
		SET credential_status='authorized', current_credential_revision=$1,
		    runtime_binding_id=$2, runtime_binding_revision=$3,
		    catalog_revision=$4, readiness_status=$5, readiness_reason_code=$6,
		    readiness_revision=readiness_revision+1, worker_heartbeat_at=now(),
		    queue_enabled=false, updated_at=now()
		WHERE id=$7 AND revocation_epoch=$8
	`, prep.CredentialRevision, input.RuntimeBindingID, input.RuntimeBindingRevision,
		newCatalogRevision, readinessStatus, reason, prep.ExecutorID, prep.RevocationEpoch)
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return AuthorizationSessionProjection{}, ErrExecutorFenced
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_runtime_worker (
		  executor_id, runtime_binding_id, runtime_binding_revision,
		  owner_instance_id, codex_version, queue_enabled, status, heartbeat_at
		) VALUES ($1,$2,$3,$4,$5,false,'online',now())
		ON CONFLICT (executor_id) DO UPDATE SET
		  runtime_binding_id=EXCLUDED.runtime_binding_id,
		  runtime_binding_revision=EXCLUDED.runtime_binding_revision,
		  owner_instance_id=EXCLUDED.owner_instance_id,
		  codex_version=EXCLUDED.codex_version,
		  queue_enabled=false, status='online', revision=ky_ai_executor_runtime_worker.revision+1,
		  heartbeat_at=now(), updated_at=now()
	`, prep.ExecutorID, input.RuntimeBindingID, input.RuntimeBindingRevision,
		input.OwnerInstanceID, input.CodexVersion)
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	result, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET status='succeeded', account_summary_json=$1::jsonb,
		    current_sequence=current_sequence+3, revision=revision+1,
		    finished_at=now(), updated_at=now()
		WHERE id=$2 AND revision=$3 AND status='verifying'
	`, string(input.AccountSummaryJSON), input.SessionID, prep.SessionRevision)
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return AuthorizationSessionProjection{}, ErrRevisionConflict
	}
	if err := insertSessionEvent(ctx, tx, input.SessionID, sequence+1, AuthorizationEventChanged, map[string]any{"change": "credential_promoted", "credentialRevision": prep.CredentialRevision}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := insertSessionEvent(ctx, tx, input.SessionID, sequence+2, AuthorizationEventTerminal, map[string]any{"status": "succeeded"}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := insertSessionEvent(ctx, tx, input.SessionID, sequence+3, AuthorizationEventClosed, map[string]any{"reason": "terminal"}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease SET status='released', updated_at=now()
		WHERE executor_id=$1 AND operation_id=$2 AND lease_epoch=$3 AND status='active'
	`, prep.ExecutorID, input.OperationID, prep.LeaseEpoch); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := insertControlOutbox(ctx, tx, "credential_binding", prep.ExecutorID+":"+itoa64(prep.CredentialRevision), 2, "credential_promoted", map[string]any{"executorId": prep.ExecutorID, "sessionId": input.SessionID}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := insertControlOutbox(ctx, tx, "authorization_session", input.SessionID, prep.SessionRevision+1, "succeeded", map[string]any{"executorId": prep.ExecutorID}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := tx.Commit(); err != nil {
		return AuthorizationSessionProjection{}, classifyControlWrite(err)
	}
	return s.GetAuthorizationSession(ctx, input.SessionID)
}

func (s *ControlStore) FailAuthorizationSession(ctx context.Context, sessionID, ownerInstanceID, terminalStatus, failureCode string) (AuthorizationSessionProjection, error) {
	if terminalStatus != "failed" && terminalStatus != "expired" && terminalStatus != "interrupted" {
		return AuthorizationSessionProjection{}, ErrConflict
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	defer tx.Rollback()
	var executorID, status, owner, operationID string
	var sequence, revision int64
	var prepared sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT executor_id,status,runtime_owner_instance_id,current_sequence,revision,
		       prepared_credential_revision,operation_id
		FROM ky_ai_executor_authorization_session WHERE id=$1 FOR UPDATE
	`, sessionID).Scan(&executorID, &status, &owner, &sequence, &revision, &prepared, &operationID)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthorizationSessionProjection{}, ErrNotFound
	}
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if status == "succeeded" || status == "failed" || status == "cancelled" || status == "expired" || status == "interrupted" || status == "superseded" {
		_ = tx.Rollback()
		return s.GetAuthorizationSession(ctx, sessionID)
	}
	if owner != "" && ownerInstanceID != owner {
		return AuthorizationSessionProjection{}, ErrExecutorFenced
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET status=$1, failure_code=$2, current_sequence=current_sequence+3,
		    revision=revision+1, finished_at=now(), updated_at=now()
		WHERE id=$3 AND revision=$4
	`, terminalStatus, safeStoredCode(failureCode), sessionID, revision)
	if err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return AuthorizationSessionProjection{}, ErrRevisionConflict
	}
	if prepared.Valid {
		_, _ = tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_credential_binding SET status='quarantined'
			WHERE executor_id=$1 AND revision=$2 AND status IN ('prepared','committing')
		`, executorID, prepared.Int64)
	}
	if operationID != "" {
		_, _ = tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_operation_lease SET status='released', updated_at=now()
			WHERE executor_id=$1 AND operation_id=$2 AND owner_instance_id=$3 AND status='active'
		`, executorID, operationID, owner)
	}
	safeFailure := safeStoredCode(failureCode)
	if err := insertSessionEvent(ctx, tx, sessionID, sequence+1, AuthorizationEventChanged, map[string]any{"change": terminalStatus, "failureCode": safeFailure}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := insertSessionEvent(ctx, tx, sessionID, sequence+2, AuthorizationEventTerminal, map[string]any{"status": terminalStatus, "failureCode": safeFailure}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := insertSessionEvent(ctx, tx, sessionID, sequence+3, AuthorizationEventClosed, map[string]any{"reason": "terminal"}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := insertControlOutbox(ctx, tx, "authorization_session", sessionID, revision+1, terminalStatus, map[string]any{"executorId": executorID, "failureCode": safeStoredCode(failureCode)}); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	if err := tx.Commit(); err != nil {
		return AuthorizationSessionProjection{}, err
	}
	return s.GetAuthorizationSession(ctx, sessionID)
}

// RecoverInterruptedAuthorizationSessions is called by the single writer
// before it accepts HTTP traffic. A device-code challenge and its App Server
// stdio channel cannot survive process loss, so pre-prepare sessions are
// fenced, audited and made retryable through a new session. Prepared or
// committing candidates stop startup until the locked recovery matrix runs.
func (s *ControlStore) RecoverInterruptedAuthorizationSessions(ctx context.Context, _ string) ([]AuthorizationRecoveryItem, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `
		SELECT id,executor_id,current_sequence,revision,prepared_credential_revision,operation_id
		FROM ky_ai_executor_authorization_session
		WHERE runtime_type='server' AND status IN ('starting','waiting_user','verifying')
		ORDER BY created_at FOR UPDATE
	`)
	if err != nil {
		return nil, err
	}
	type pendingRecovery struct {
		item     AuthorizationRecoveryItem
		sequence int64
		revision int64
	}
	pending := []pendingRecovery{}
	for rows.Next() {
		var current pendingRecovery
		var prepared sql.NullInt64
		if err := rows.Scan(&current.item.SessionID, &current.item.ExecutorID, &current.sequence,
			&current.revision, &prepared, &current.item.OperationID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		current.item.PreparedCredentialRevision = nullableInt64(prepared)
		pending = append(pending, current)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, current := range pending {
		if current.item.PreparedCredentialRevision != nil {
			// A prepared or committing candidate must follow the locked
			// filesystem recovery matrix. Until that recovery path completes,
			// refuse startup without changing the session, binding or lease.
			return nil, ErrCredentialRecoveryRequired
		}
	}
	for _, current := range pending {
		result, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_authorization_session
			SET status='interrupted',failure_code='service_restarted',
			    current_sequence=current_sequence+3,revision=revision+1,
			    finished_at=now(),updated_at=now()
			WHERE id=$1 AND revision=$2 AND status IN ('starting','waiting_user','verifying')
		`, current.item.SessionID, current.revision)
		if err != nil {
			return nil, err
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return nil, ErrRevisionConflict
		}
		if current.item.OperationID != "" {
			if _, err := tx.ExecContext(ctx, `
				UPDATE ky_ai_executor_operation_lease SET status='released',updated_at=now()
				WHERE executor_id=$1 AND operation_id=$2 AND status='active'
			`, current.item.ExecutorID, current.item.OperationID); err != nil {
				return nil, err
			}
		}
		if err := insertSessionEvent(ctx, tx, current.item.SessionID, current.sequence+1, AuthorizationEventChanged, map[string]any{"change": "interrupted", "failureCode": "service_restarted"}); err != nil {
			return nil, err
		}
		if err := insertSessionEvent(ctx, tx, current.item.SessionID, current.sequence+2, AuthorizationEventTerminal, map[string]any{"status": "interrupted", "failureCode": "service_restarted"}); err != nil {
			return nil, err
		}
		if err := insertSessionEvent(ctx, tx, current.item.SessionID, current.sequence+3, AuthorizationEventClosed, map[string]any{"reason": "terminal"}); err != nil {
			return nil, err
		}
		if err := insertControlOutbox(ctx, tx, "authorization_session", current.item.SessionID, current.revision+1, "interrupted", map[string]any{"executorId": current.item.ExecutorID, "failureCode": "service_restarted"}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, classifyControlWrite(err)
	}
	// Include prior interrupted sessions so a crash between the database
	// transition and filesystem quarantine is repaired idempotently.
	rows, err = s.db.QueryContext(ctx, `
		SELECT id,executor_id,prepared_credential_revision,operation_id
		FROM ky_ai_executor_authorization_session
		WHERE runtime_type='server' AND status='interrupted' AND failure_code='service_restarted'
		ORDER BY created_at
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AuthorizationRecoveryItem{}
	for rows.Next() {
		var item AuthorizationRecoveryItem
		var prepared sql.NullInt64
		if err := rows.Scan(&item.SessionID, &item.ExecutorID, &prepared, &item.OperationID); err != nil {
			return nil, err
		}
		item.PreparedCredentialRevision = nullableInt64(prepared)
		items = append(items, item)
	}
	return items, rows.Err()
}

type CancelAuthorizationInput struct {
	SessionID          string
	ActorID            string
	ExpectedRevision   int64
	IdempotencyKeyHash string
	RequestHash        string
	CanCancelAny       bool
}

func (s *ControlStore) CancelAuthorizationSession(ctx context.Context, input CancelAuthorizationInput) (AuthorizationSessionProjection, bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	defer tx.Rollback()
	var previousHash, resourceID string
	err = tx.QueryRowContext(ctx, `
		SELECT request_hash,resource_id FROM ky_ai_executor_api_idempotency
		WHERE actor_id=$1 AND action='cancel_authorization' AND scope_id=$2 AND idempotency_key_hash=$3
	`, input.ActorID, input.SessionID, input.IdempotencyKeyHash).Scan(&previousHash, &resourceID)
	if err == nil {
		if previousHash != input.RequestHash {
			return AuthorizationSessionProjection{}, false, ErrIdempotencyReuse
		}
		_ = tx.Rollback()
		item, getErr := s.GetAuthorizationSession(ctx, resourceID)
		return item, false, getErr
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return AuthorizationSessionProjection{}, false, err
	}
	var status, executorID, operationID, requestedBy, runtimeOwner string
	var revision, sequence int64
	var prepared sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT status,revision,current_sequence,executor_id,prepared_credential_revision,operation_id,requested_by,runtime_owner_instance_id
		FROM ky_ai_executor_authorization_session
		WHERE id=$1 FOR UPDATE
	`, input.SessionID).Scan(&status, &revision, &sequence, &executorID, &prepared, &operationID, &requestedBy, &runtimeOwner)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthorizationSessionProjection{}, false, ErrNotFound
	}
	if err != nil {
		return AuthorizationSessionProjection{}, false, err
	}
	if revision != input.ExpectedRevision {
		return AuthorizationSessionProjection{}, false, ErrRevisionConflict
	}
	if requestedBy != input.ActorID && !input.CanCancelAny {
		return AuthorizationSessionProjection{}, false, ErrRequesterMismatch
	}
	terminal := status == "succeeded" || status == "failed" || status == "cancelled" || status == "expired" || status == "interrupted" || status == "superseded"
	transitioned := false
	if !terminal {
		result, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_authorization_session
			SET status='cancelled',failure_code='',revision=revision+1,
			    current_sequence=current_sequence+3,finished_at=now(),updated_at=now()
			WHERE id=$1 AND revision=$2
		`, input.SessionID, revision)
		if err != nil {
			return AuthorizationSessionProjection{}, false, err
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return AuthorizationSessionProjection{}, false, ErrRevisionConflict
		}
		if err := insertSessionEvent(ctx, tx, input.SessionID, sequence+1, AuthorizationEventChanged, map[string]any{"change": "cancelled"}); err != nil {
			return AuthorizationSessionProjection{}, false, err
		}
		if err := insertSessionEvent(ctx, tx, input.SessionID, sequence+2, AuthorizationEventTerminal, map[string]any{"status": "cancelled"}); err != nil {
			return AuthorizationSessionProjection{}, false, err
		}
		if err := insertSessionEvent(ctx, tx, input.SessionID, sequence+3, AuthorizationEventClosed, map[string]any{"reason": "terminal"}); err != nil {
			return AuthorizationSessionProjection{}, false, err
		}
		if err := insertControlOutbox(ctx, tx, "authorization_session", input.SessionID, revision+1, "cancelled", map[string]any{}); err != nil {
			return AuthorizationSessionProjection{}, false, err
		}
		if prepared.Valid {
			if _, err := tx.ExecContext(ctx, `
				UPDATE ky_ai_executor_credential_binding SET status='quarantined'
				WHERE executor_id=$1 AND revision=$2 AND status IN ('prepared','committing')
			`, executorID, prepared.Int64); err != nil {
				return AuthorizationSessionProjection{}, false, err
			}
		}
		if operationID != "" {
			if _, err := tx.ExecContext(ctx, `
				UPDATE ky_ai_executor_operation_lease SET status='released',updated_at=now()
				WHERE executor_id=$1 AND operation_id=$2 AND owner_instance_id=$3 AND status='active'
			`, executorID, operationID, runtimeOwner); err != nil {
				return AuthorizationSessionProjection{}, false, err
			}
		}
		transitioned = true
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_api_idempotency (
		 actor_id,action,scope_id,idempotency_key_hash,request_hash,resource_type,resource_id,response_status
		) VALUES ($1,'cancel_authorization',$2,$3,$4,'authorization_session',$2,200)
	`, input.ActorID, input.SessionID, input.IdempotencyKeyHash, input.RequestHash); err != nil {
		return AuthorizationSessionProjection{}, false, classifyControlWrite(err)
	}
	if err := tx.Commit(); err != nil {
		return AuthorizationSessionProjection{}, false, classifyControlWrite(err)
	}
	item, err := s.GetAuthorizationSession(ctx, input.SessionID)
	return item, transitioned, err
}

func (s *ControlStore) RecordAuthorizationReopen(ctx context.Context, sessionID, actorID, keyHash, requestHash string) error {
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_api_idempotency (
		 actor_id,action,scope_id,idempotency_key_hash,request_hash,resource_type,resource_id,response_status
		) VALUES ($1,'reopen_authorization',$2,$3,$4,'authorization_session',$2,200)
		ON CONFLICT (actor_id,action,scope_id,idempotency_key_hash) DO NOTHING
	`, actorID, sessionID, keyHash, requestHash)
	if err != nil {
		return classifyControlWrite(err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		var existing string
		if err := s.db.QueryRowContext(ctx, `SELECT request_hash FROM ky_ai_executor_api_idempotency WHERE actor_id=$1 AND action='reopen_authorization' AND scope_id=$2 AND idempotency_key_hash=$3`, actorID, sessionID, keyHash).Scan(&existing); err != nil {
			return err
		}
		if existing != requestHash {
			return ErrIdempotencyReuse
		}
	}
	return nil
}

func insertSessionEvent(ctx context.Context, tx *sql.Tx, sessionID string, sequence int64, eventType string, payload map[string]any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_authorization_session_event
		(id,session_id,sequence,event_type,safe_payload_json,occurred_at)
		VALUES ($1,$2,$3,$4,$5::jsonb,now())
	`, "auth_event_"+sessionID+"_"+itoa64(sequence), sessionID, sequence, eventType, string(encoded))
	return err
}

func safeAuthorizationEventType(value string) string {
	switch value {
	case AuthorizationEventChanged, AuthorizationEventTerminal, AuthorizationEventClosed:
		return value
	default:
		// Older P2A development rows used transition names as event types. They
		// are still safe to replay as a generic change, but arbitrary database
		// content must never become an SSE event name.
		return AuthorizationEventChanged
	}
}

func insertControlOutbox(ctx context.Context, tx *sql.Tx, aggregateType, aggregateID string, revision int64, eventType string, reference map[string]any) error {
	encoded, err := json.Marshal(reference)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_control_outbox
		(id,aggregate_type,aggregate_id,aggregate_revision,event_type,safe_reference_json,occurred_at)
		VALUES ($1,$2,$3,$4,$5,$6::jsonb,now())
	`, "control_outbox_"+aggregateID+"_"+itoa64(revision)+"_"+eventType,
		aggregateType, aggregateID, revision, eventType, string(encoded))
	return err
}

func itoa64(value int64) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var buffer [20]byte
	position := len(buffer)
	for value > 0 {
		position--
		buffer[position] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		position--
		buffer[position] = '-'
	}
	return string(buffer[position:])
}
