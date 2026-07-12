package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
)

const CredentialLogoutTicketLifetime = 120 * time.Second

var (
	ErrCredentialRevocationInputInvalid   = errors.New("credential revocation input invalid")
	ErrCredentialRevocationActiveWork     = errors.New("executor has active tasks")
	ErrCredentialRevocationReplayRace     = errors.New("credential revocation replay won race")
	ErrCredentialRevocationTicketMismatch = errors.New("credential revocation ticket mismatch")
	ErrCredentialRevocationACKRecorded    = errors.New("credential revocation ACK already recorded")
	ErrCredentialRevocationStateInvalid   = errors.New("credential revocation state invalid")
	ErrCredentialRevocationCompletedAt    = errors.New("credential revocation completion time invalid")
	ErrCredentialRevocationConfirmation   = errors.New("credential revocation confirmation mismatch")
)

type CredentialRevocationRequest struct {
	ExecutorID                 string
	ActorID                    string
	ActorSessionID             string
	ExpectedCredentialRevision int64
	Force                      bool
	IdempotencyKeyHash         string
	RequestHash                string
}

type CreateCredentialRevocationInput struct {
	CredentialRevocationRequest
	RevocationID   string
	OperationID    string
	ConfirmationID string
}

type CredentialCleanupTarget struct {
	ExecutorID             string `json:"executorId"`
	RuntimeType            string `json:"runtimeType"`
	RuntimeBindingID       string `json:"runtimeBindingId"`
	RuntimeBindingRevision int64  `json:"runtimeBindingRevision"`
	DeviceID               string `json:"deviceId,omitempty"`
	RevocationID           string `json:"revocationId"`
	OperationID            string `json:"operationId"`
	CredentialRevision     int64  `json:"credentialRevision"`
	RevocationEpoch        int64  `json:"revocationEpoch"`
	Action                 string `json:"action"`
}

type CredentialRevocationProjection struct {
	RevocationID       string  `json:"revocationId"`
	OperationID        string  `json:"operationId"`
	ExecutorID         string  `json:"executorId"`
	RuntimeType        string  `json:"runtimeType"`
	CredentialRevision int64   `json:"credentialRevision"`
	RevocationEpoch    int64   `json:"revocationEpoch"`
	Force              bool    `json:"force"`
	Status             string  `json:"status"`
	FailureCode        string  `json:"failureCode,omitempty"`
	QuarantineDigest   string  `json:"quarantineDigest,omitempty"`
	ExpiresAt          *string `json:"expiresAt,omitempty"`
	CompletedAt        *string `json:"completedAt,omitempty"`
	CreatedAt          string  `json:"createdAt"`

	DeviceID                 string    `json:"-"`
	ActorID                  string    `json:"-"`
	ActorSessionID           string    `json:"-"`
	IdempotencyKeyHash       string    `json:"-"`
	RequestHash              string    `json:"-"`
	CommandTicketHash        string    `json:"-"`
	TokenKeyID               string    `json:"-"`
	TokenNonceHash           string    `json:"-"`
	TokenIssuedAt            time.Time `json:"-"`
	ACKRequestHash           string    `json:"-"`
	DeviceCompletedAt        time.Time `json:"-"`
	SecurityContractVerified bool      `json:"-"`
	ConfirmationID           string    `json:"-"`
	RuntimeBindingID         string    `json:"-"`
	RuntimeBindingRevision   int64     `json:"-"`
}

type IssuedCredentialLogoutTicket struct {
	Token     string
	Hash      string
	KeyID     string
	NonceHash string
	ExpiresAt time.Time
}

type CredentialLogoutTicketIssuer func(CredentialRevocationProjection, time.Time) (IssuedCredentialLogoutTicket, error)

type CreateCredentialRevocationResult struct {
	Revocation    CredentialRevocationProjection
	CleanupTarget CredentialCleanupTarget
	CommandTicket string
	Created       bool
}

type VerifiedCredentialLogoutTicket struct {
	TokenHash          string
	NonceHash          string
	ActorID            string
	ExecutorID         string
	DeviceID           string
	OperationID        string
	RevocationID       string
	CredentialRevision int64
	RevocationEpoch    int64
	IssuedAt           time.Time
	ExpiresAt          time.Time
}

type CredentialLogoutTicketVerifier func(time.Time) (VerifiedCredentialLogoutTicket, error)

type AcknowledgeCredentialRevocationInput struct {
	ExecutorID         string
	RevocationID       string
	OperationID        string
	CredentialRevision int64
	RevocationEpoch    int64
	CompletedAt        time.Time
	QuarantineDigest   string
	Result             string
	KeyGeneration      uint64
	Proof              deviceauth.VerifiedRequest
	LedgerExpiresAt    time.Time
}

type AcknowledgeCredentialRevocationResult struct {
	Revocation        CredentialRevocationProjection
	ResponseReference string
	Replayed          bool
}

func (s *ControlStore) LookupCredentialRevocation(
	ctx context.Context,
	request CredentialRevocationRequest,
) (CreateCredentialRevocationResult, bool, error) {
	if !validCredentialRevocationRequest(request) {
		return CreateCredentialRevocationResult{}, false, ErrCredentialRevocationInputInvalid
	}
	item, err := scanCredentialRevocation(s.db.QueryRowContext(ctx, credentialRevocationSelect+`
		WHERE requested_by=$1 AND executor_id=$2 AND credential_revision=$3
		  AND force=$4 AND idempotency_key_hash=$5
	`, request.ActorID, request.ExecutorID, request.ExpectedCredentialRevision,
		request.Force, request.IdempotencyKeyHash))
	if errors.Is(err, sql.ErrNoRows) {
		return CreateCredentialRevocationResult{}, false, nil
	}
	if err != nil {
		return CreateCredentialRevocationResult{}, false, err
	}
	if err := validateCredentialRevocationReplay(item, request); err != nil {
		return CreateCredentialRevocationResult{}, true, err
	}
	return credentialRevocationResult(item, "", false), true, nil
}

func (s *ControlStore) CreateNormalCredentialRevocation(
	ctx context.Context,
	input CreateCredentialRevocationInput,
	issuer CredentialLogoutTicketIssuer,
) (CreateCredentialRevocationResult, error) {
	if input.Force || !validCreateCredentialRevocationInput(input) {
		return CreateCredentialRevocationResult{}, ErrCredentialRevocationInputInvalid
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return CreateCredentialRevocationResult{}, err
	}
	defer tx.Rollback()
	result, err := createCredentialRevocationTx(ctx, tx, input, issuer, false)
	if err != nil {
		return CreateCredentialRevocationResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return CreateCredentialRevocationResult{}, classifyControlWrite(err)
	}
	return result, nil
}

// CreateForceCredentialRevocationTx is only intended as an
// OperationConfirmationMutation. The caller must let the confirmation store
// burn its one-time token in this same transaction after this method returns.
func (s *ControlStore) CreateForceCredentialRevocationTx(
	ctx context.Context,
	tx *sql.Tx,
	input CreateCredentialRevocationInput,
	issuer CredentialLogoutTicketIssuer,
) (CreateCredentialRevocationResult, error) {
	if tx == nil || !input.Force || !validCreateCredentialRevocationInput(input) {
		return CreateCredentialRevocationResult{}, ErrCredentialRevocationInputInvalid
	}
	return createCredentialRevocationTx(ctx, tx, input, issuer, true)
}

// ForceCredentialRevocationMutation binds the force-revoke mutation to the
// exact high-risk confirmation that is burned by ConsumeOperationConfirmation.
// The revocation, executor/binding fences, task fanout, audit/outbox rows and
// confirmation consumption therefore commit or roll back as one unit.
func (s *ControlStore) ForceCredentialRevocationMutation(
	input CreateCredentialRevocationInput,
	capture *CreateCredentialRevocationResult,
	issuer CredentialLogoutTicketIssuer,
) OperationConfirmationMutation {
	return func(ctx context.Context, tx *sql.Tx, confirmation OperationConfirmationProjection) error {
		if capture == nil || confirmation.Action != OperationConfirmationForceRevoke ||
			confirmation.ActorID != input.ActorID ||
			confirmation.ActorSessionID != input.ActorSessionID ||
			confirmation.ExecutorID != input.ExecutorID ||
			confirmation.ExpectedRevision != input.ExpectedCredentialRevision ||
			confirmation.FromDeviceID != "" || confirmation.TargetDeviceID != "" {
			return ErrCredentialRevocationConfirmation
		}
		input.ConfirmationID = confirmation.ID
		result, err := s.CreateForceCredentialRevocationTx(ctx, tx, input, issuer)
		if err != nil {
			return err
		}
		*capture = result
		return nil
	}
}

type credentialRevocationExecutor struct {
	RuntimeType               string
	CredentialStatus          string
	CurrentCredentialRevision sql.NullInt64
	RevocationEpoch           int64
}

type credentialRevocationTask struct {
	ID                       string
	WorkspaceType            string
	WorkspaceID              string
	OperationID              string
	Status                   string
	Revision                 int64
	Sequence                 int64
	LeaseEpoch               int64
	SourceCredentialRevision int64
	RevocationEpoch          int64
	CredentialRevision       sql.NullInt64
}

func createCredentialRevocationTx(
	ctx context.Context,
	tx *sql.Tx,
	input CreateCredentialRevocationInput,
	issuer CredentialLogoutTicketIssuer,
	failOnReplay bool,
) (CreateCredentialRevocationResult, error) {
	executor, err := lockCredentialRevocationExecutor(ctx, tx, input.ExecutorID)
	if err != nil {
		return CreateCredentialRevocationResult{}, err
	}
	if existing, found, err := loadCredentialRevocationByIdempotency(ctx, tx, input.CredentialRevocationRequest); err != nil {
		return CreateCredentialRevocationResult{}, err
	} else if found {
		if failOnReplay {
			return CreateCredentialRevocationResult{}, ErrCredentialRevocationReplayRace
		}
		return credentialRevocationResult(existing, "", false), nil
	}
	if !executor.CurrentCredentialRevision.Valid ||
		executor.CurrentCredentialRevision.Int64 != input.ExpectedCredentialRevision ||
		(executor.CredentialStatus != "authorized" && executor.CredentialStatus != "expired") {
		return CreateCredentialRevocationResult{}, ErrRevisionConflict
	}

	var bindingStatus, bindingRuntimeType, bindingDeviceID, bindingRuntimeID string
	var bindingRevocationEpoch, bindingRuntimeRevision int64
	err = tx.QueryRowContext(ctx, `
		SELECT status,runtime_type,device_id,revocation_epoch,
		       runtime_binding_id,runtime_binding_revision
		FROM ky_ai_executor_credential_binding
		WHERE executor_id=$1 AND revision=$2
		FOR UPDATE
	`, input.ExecutorID, input.ExpectedCredentialRevision).Scan(
		&bindingStatus, &bindingRuntimeType, &bindingDeviceID, &bindingRevocationEpoch,
		&bindingRuntimeID, &bindingRuntimeRevision,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return CreateCredentialRevocationResult{}, ErrRevisionConflict
	}
	if err != nil {
		return CreateCredentialRevocationResult{}, err
	}
	if bindingStatus != "active" || bindingRuntimeType != executor.RuntimeType ||
		bindingRevocationEpoch != executor.RevocationEpoch ||
		bindingRuntimeID == "" || bindingRuntimeRevision <= 0 ||
		(executor.RuntimeType == "desktop" && deviceauth.ValidateDeviceID(bindingDeviceID) != nil) ||
		(executor.RuntimeType == "server" && bindingDeviceID != "") {
		return CreateCredentialRevocationResult{}, ErrCredentialRevocationStateInvalid
	}

	leaseActive, err := lockCredentialRevocationLease(ctx, tx, input.ExecutorID)
	if err != nil {
		return CreateCredentialRevocationResult{}, err
	}
	tasks, err := lockCredentialRevocationTasks(ctx, tx, input.ExecutorID)
	if err != nil {
		return CreateCredentialRevocationResult{}, err
	}
	if !input.Force && (leaseActive || len(tasks) != 0) {
		return CreateCredentialRevocationResult{}, ErrCredentialRevocationActiveWork
	}
	if executor.RevocationEpoch == int64(^uint64(0)>>1) {
		return CreateCredentialRevocationResult{}, ErrCredentialRevocationStateInvalid
	}
	now, err := transactionNow(ctx, tx)
	if err != nil {
		return CreateCredentialRevocationResult{}, err
	}
	item := CredentialRevocationProjection{
		RevocationID: input.RevocationID, OperationID: input.OperationID,
		ExecutorID: input.ExecutorID, RuntimeType: executor.RuntimeType,
		CredentialRevision: input.ExpectedCredentialRevision,
		RevocationEpoch:    executor.RevocationEpoch + 1, Force: input.Force,
		DeviceID: bindingDeviceID, ActorID: input.ActorID, ActorSessionID: input.ActorSessionID,
		IdempotencyKeyHash: input.IdempotencyKeyHash, RequestHash: input.RequestHash,
		SecurityContractVerified: true, ConfirmationID: input.ConfirmationID,
		RuntimeBindingID: bindingRuntimeID, RuntimeBindingRevision: bindingRuntimeRevision,
	}
	item.CreatedAt = now.UTC().Format(time.RFC3339Nano)
	var issued IssuedCredentialLogoutTicket
	if executor.RuntimeType == "desktop" {
		if issuer == nil {
			return CreateCredentialRevocationResult{}, ErrCredentialRevocationInputInvalid
		}
		issued, err = issuer(item, now)
		if err != nil {
			return CreateCredentialRevocationResult{}, err
		}
		if !validIssuedCredentialLogoutTicket(issued, now) {
			return CreateCredentialRevocationResult{}, ErrCredentialRevocationTicketMismatch
		}
		item.Status = "awaiting_device"
		item.CommandTicketHash = issued.Hash
		item.TokenKeyID = issued.KeyID
		item.TokenNonceHash = issued.NonceHash
		item.TokenIssuedAt = now.UTC().Truncate(time.Second)
		expiresAt := issued.ExpiresAt.UTC().Format(time.RFC3339Nano)
		item.ExpiresAt = &expiresAt
	} else if executor.RuntimeType == "server" {
		item.Status = "completed"
		completedAt := now.UTC().Format(time.RFC3339Nano)
		item.CompletedAt = &completedAt
	} else {
		return CreateCredentialRevocationResult{}, ErrCredentialRevocationStateInvalid
	}

	if err := insertCredentialRevocation(ctx, tx, item, issued, now); err != nil {
		return CreateCredentialRevocationResult{}, err
	}
	if executor.RuntimeType == "desktop" {
		if err := insertCredentialLogoutCommand(ctx, tx, item, issued, now); err != nil {
			return CreateCredentialRevocationResult{}, err
		}
	}
	preserveDesktopTarget := executor.RuntimeType == "desktop" && !input.Force
	clearCurrent := !preserveDesktopTarget
	updated, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_config
		SET credential_status='revoked',
		    current_credential_revision=CASE WHEN $7 THEN NULL ELSE current_credential_revision END,
		    runtime_binding_id=CASE WHEN $7 THEN '' ELSE runtime_binding_id END,
		    runtime_binding_revision=CASE WHEN $7 THEN 0 ELSE runtime_binding_revision END,
		    revocation_epoch=$2,config_revision=config_revision+1,
		    readiness_status='unavailable',readiness_reason_code='credential_revoked',
		    readiness_revision=readiness_revision+1,updated_by=$3,updated_at=$4
		WHERE id=$1 AND current_credential_revision=$5 AND revocation_epoch=$6
		  AND credential_status IN ('authorized','expired')
	`, item.ExecutorID, item.RevocationEpoch, item.ActorID, now,
		item.CredentialRevision, executor.RevocationEpoch, clearCurrent)
	if err != nil {
		return CreateCredentialRevocationResult{}, err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return CreateCredentialRevocationResult{}, ErrRevisionConflict
	}
	if clearCurrent {
		updated, err = tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_credential_binding
			SET status='revoked',revoked_at=$4
			WHERE executor_id=$1 AND revision=$2 AND status='active' AND revocation_epoch=$3
		`, item.ExecutorID, item.CredentialRevision, executor.RevocationEpoch, now)
		if err != nil {
			return CreateCredentialRevocationResult{}, err
		}
		if affected, _ := updated.RowsAffected(); affected != 1 {
			return CreateCredentialRevocationResult{}, ErrRevisionConflict
		}
	}
	if input.Force {
		if _, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_operation_lease
			SET status='fenced',updated_at=$2
			WHERE executor_id=$1 AND status='active'
		`, item.ExecutorID, now); err != nil {
			return CreateCredentialRevocationResult{}, err
		}
		for _, task := range tasks {
			meta := taskEventMeta{
				TaskID: task.ID, Status: "cancelled", WorkspaceType: task.WorkspaceType,
				WorkspaceID: task.WorkspaceID, ExecutorID: item.ExecutorID,
				OperationID: task.OperationID, LeaseEpoch: task.LeaseEpoch,
				SourceCredentialRevision: task.SourceCredentialRevision,
				RevocationEpoch:          task.RevocationEpoch,
			}
			if task.Status == "waiting_user_scan" {
				updated, err := tx.ExecContext(ctx, `
					UPDATE ky_ai_executor_task SET status='pending'
					WHERE id=$1 AND revision=$2 AND status='waiting_user_scan'
				`, task.ID, task.Revision)
				if err != nil {
					return CreateCredentialRevocationResult{}, err
				}
				if affected, _ := updated.RowsAffected(); affected != 1 {
					return CreateCredentialRevocationResult{}, ErrExecutorFenced
				}
			}
			if err := terminalizeControlTask(
				ctx, tx, meta, task.Revision, task.Sequence,
				"cancelled", "credential_revoked", nil,
			); err != nil {
				return CreateCredentialRevocationResult{}, err
			}
		}
	}
	if err := insertCredentialRevocationAudit(ctx, tx, item, 1, "created", now); err != nil {
		return CreateCredentialRevocationResult{}, err
	}
	if err := insertControlOutbox(ctx, tx, "credential_revocation", item.RevocationID, 1,
		"credential_revocation.created", credentialRevocationSafeReference(item)); err != nil {
		return CreateCredentialRevocationResult{}, err
	}
	if item.RuntimeType == "server" {
		if err := insertCredentialRevocationAudit(ctx, tx, item, 2, "completed", now); err != nil {
			return CreateCredentialRevocationResult{}, err
		}
		if err := insertControlOutbox(ctx, tx, "credential_revocation", item.RevocationID, 2,
			"credential_revocation.completed", credentialRevocationSafeReference(item)); err != nil {
			return CreateCredentialRevocationResult{}, err
		}
	}
	return credentialRevocationResult(item, issued.Token, true), nil
}

func lockCredentialRevocationExecutor(ctx context.Context, tx *sql.Tx, executorID string) (credentialRevocationExecutor, error) {
	var item credentialRevocationExecutor
	err := tx.QueryRowContext(ctx, `
		SELECT runtime_type,credential_status,current_credential_revision,revocation_epoch
		FROM ky_ai_executor_config
		WHERE id=$1 AND scope_type='platform' AND scope_id='platform_root' AND executor_type='codex'
		FOR UPDATE
	`, executorID).Scan(&item.RuntimeType, &item.CredentialStatus,
		&item.CurrentCredentialRevision, &item.RevocationEpoch)
	if errors.Is(err, sql.ErrNoRows) {
		return credentialRevocationExecutor{}, ErrNotFound
	}
	return item, err
}

func lockCredentialRevocationLease(ctx context.Context, tx *sql.Tx, executorID string) (bool, error) {
	var status string
	var expiresAt time.Time
	err := tx.QueryRowContext(ctx, `
		SELECT status,lease_expires_at
		FROM ky_ai_executor_operation_lease WHERE executor_id=$1 FOR UPDATE
	`, executorID).Scan(&status, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	now, err := transactionNow(ctx, tx)
	if err != nil {
		return false, err
	}
	return status == "active" && expiresAt.After(now), nil
}

func lockCredentialRevocationTasks(ctx context.Context, tx *sql.Tx, executorID string) ([]credentialRevocationTask, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT id,workspace_type,workspace_id,operation_id,status,revision,current_sequence,
		       lease_epoch,source_credential_revision,revocation_epoch,credential_binding_revision
		FROM ky_ai_executor_task
		WHERE COALESCE(NULLIF(effective_executor_id,''),executor_id)=$1
		  AND status IN ('pending','waiting_executor','running','waiting_user_scan')
		ORDER BY id
		FOR UPDATE
	`, executorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []credentialRevocationTask{}
	for rows.Next() {
		var item credentialRevocationTask
		if err := rows.Scan(
			&item.ID, &item.WorkspaceType, &item.WorkspaceID, &item.OperationID,
			&item.Status, &item.Revision, &item.Sequence, &item.LeaseEpoch,
			&item.SourceCredentialRevision, &item.RevocationEpoch, &item.CredentialRevision,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func loadCredentialRevocationByIdempotency(
	ctx context.Context,
	tx *sql.Tx,
	request CredentialRevocationRequest,
) (CredentialRevocationProjection, bool, error) {
	item, err := scanCredentialRevocation(tx.QueryRowContext(ctx, credentialRevocationSelect+`
		WHERE requested_by=$1 AND executor_id=$2 AND credential_revision=$3
		  AND force=$4 AND idempotency_key_hash=$5
		FOR SHARE
	`, request.ActorID, request.ExecutorID, request.ExpectedCredentialRevision,
		request.Force, request.IdempotencyKeyHash))
	if errors.Is(err, sql.ErrNoRows) {
		return CredentialRevocationProjection{}, false, nil
	}
	if err != nil {
		return CredentialRevocationProjection{}, false, err
	}
	if err := validateCredentialRevocationReplay(item, request); err != nil {
		return CredentialRevocationProjection{}, true, err
	}
	return item, true, nil
}

func validateCredentialRevocationReplay(item CredentialRevocationProjection, request CredentialRevocationRequest) error {
	if !item.SecurityContractVerified {
		return ErrCredentialRevocationStateInvalid
	}
	if item.ActorID != request.ActorID || item.ActorSessionID != request.ActorSessionID ||
		item.ExecutorID != request.ExecutorID || item.CredentialRevision != request.ExpectedCredentialRevision ||
		item.Force != request.Force || item.IdempotencyKeyHash != request.IdempotencyKeyHash ||
		item.RequestHash != request.RequestHash {
		return ErrIdempotencyReuse
	}
	return nil
}

func insertCredentialRevocation(
	ctx context.Context,
	tx *sql.Tx,
	item CredentialRevocationProjection,
	issued IssuedCredentialLogoutTicket,
	now time.Time,
) error {
	var tokenIssuedAt, tokenExpiresAt, completedAt any
	if item.RuntimeType == "desktop" {
		tokenIssuedAt = item.TokenIssuedAt
		tokenExpiresAt = issued.ExpiresAt.UTC()
	} else {
		completedAt = now
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_revocation (
		 id,executor_id,device_id,credential_revision,revocation_epoch,operation_id,
		 requested_by,actor_session_id,runtime_type,force,idempotency_key_hash,request_hash,
		 command_ticket_hash,token_key_id,token_nonce_hash,token_issued_at,token_expires_at,
		 status,failure_code,quarantine_digest,created_at,completed_at,security_contract_verified,
		 confirmation_id,runtime_binding_id,runtime_binding_revision
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'','',$19,$20,true,$21,$22,$23)
	`, item.RevocationID, item.ExecutorID, item.DeviceID, item.CredentialRevision,
		item.RevocationEpoch, item.OperationID, item.ActorID, item.ActorSessionID,
		item.RuntimeType, item.Force, item.IdempotencyKeyHash, item.RequestHash,
		item.CommandTicketHash, item.TokenKeyID, item.TokenNonceHash,
		tokenIssuedAt, tokenExpiresAt, item.Status, now, completedAt,
		nullCredentialConfirmation(item.ConfirmationID), item.RuntimeBindingID,
		item.RuntimeBindingRevision)
	return classifyControlWrite(err)
}

func insertCredentialLogoutCommand(
	ctx context.Context,
	tx *sql.Tx,
	item CredentialRevocationProjection,
	issued IssuedCredentialLogoutTicket,
	now time.Time,
) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_desktop_command_operation (
		 id,executor_id,device_id,requested_by,purpose,expected_credential_revision,
		 revocation_id,revocation_epoch,idempotency_key_hash,request_hash,
		 command_ticket_hash,token_key_id,token_nonce_hash,status,issued_at,expires_at,
		 created_at,updated_at,security_contract_verified
		) VALUES ($1,$2,$3,$4,'credential_logout',$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,$14,$13,$13,true)
	`, item.OperationID, item.ExecutorID, item.DeviceID, item.ActorID,
		item.CredentialRevision, item.RevocationID, item.RevocationEpoch,
		item.IdempotencyKeyHash, item.RequestHash, item.CommandTicketHash,
		item.TokenKeyID, item.TokenNonceHash, now.UTC().Truncate(time.Second), issued.ExpiresAt.UTC())
	return classifyControlWrite(err)
}

func validCredentialRevocationRequest(input CredentialRevocationRequest) bool {
	return validOpaqueValue(input.ExecutorID) && validOpaqueValue(input.ActorID) &&
		validOpaqueValue(input.ActorSessionID) && input.ExpectedCredentialRevision > 0 &&
		validateStoreDigest(input.IdempotencyKeyHash, false) == nil &&
		validateStoreDigest(input.RequestHash, false) == nil
}

func validCreateCredentialRevocationInput(input CreateCredentialRevocationInput) bool {
	if !validCredentialRevocationRequest(input.CredentialRevocationRequest) ||
		!validOpaqueValue(input.RevocationID) || !validOpaqueValue(input.OperationID) {
		return false
	}
	if input.Force {
		return validOpaqueValue(input.ConfirmationID)
	}
	return input.ConfirmationID == ""
}

func validIssuedCredentialLogoutTicket(issued IssuedCredentialLogoutTicket, issuedAt time.Time) bool {
	return issued.Token != "" && len(issued.Token) <= 16<<10 &&
		validateStoreDigest(issued.Hash, false) == nil &&
		validateStoreDigest(issued.NonceHash, false) == nil &&
		confirmationKeyIDPattern.MatchString(issued.KeyID) &&
		issued.ExpiresAt.UTC().Equal(issuedAt.UTC().Truncate(time.Second).Add(CredentialLogoutTicketLifetime))
}

const credentialRevocationSelect = `
	SELECT id,operation_id,executor_id,runtime_type,device_id,credential_revision,
	       revocation_epoch,requested_by,actor_session_id,force,idempotency_key_hash,
	       request_hash,command_ticket_hash,token_key_id,token_nonce_hash,
	       token_issued_at,token_expires_at,status,failure_code,quarantine_digest,
	       ack_request_hash,device_completed_at,security_contract_verified,
	       COALESCE(confirmation_id,''),runtime_binding_id,runtime_binding_revision,
	       created_at,completed_at
	FROM ky_ai_executor_credential_revocation
`

func scanCredentialRevocation(row rowScanner) (CredentialRevocationProjection, error) {
	var item CredentialRevocationProjection
	var tokenIssuedAt, tokenExpiresAt, deviceCompletedAt, completedAt sql.NullTime
	var createdAt time.Time
	err := row.Scan(
		&item.RevocationID, &item.OperationID, &item.ExecutorID, &item.RuntimeType,
		&item.DeviceID, &item.CredentialRevision, &item.RevocationEpoch,
		&item.ActorID, &item.ActorSessionID, &item.Force, &item.IdempotencyKeyHash,
		&item.RequestHash, &item.CommandTicketHash, &item.TokenKeyID, &item.TokenNonceHash,
		&tokenIssuedAt, &tokenExpiresAt, &item.Status, &item.FailureCode,
		&item.QuarantineDigest, &item.ACKRequestHash, &deviceCompletedAt,
		&item.SecurityContractVerified, &item.ConfirmationID,
		&item.RuntimeBindingID, &item.RuntimeBindingRevision, &createdAt, &completedAt,
	)
	if err != nil {
		return CredentialRevocationProjection{}, err
	}
	item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	if tokenIssuedAt.Valid {
		item.TokenIssuedAt = tokenIssuedAt.Time.UTC()
	}
	if tokenExpiresAt.Valid {
		value := tokenExpiresAt.Time.UTC().Format(time.RFC3339Nano)
		item.ExpiresAt = &value
	}
	if deviceCompletedAt.Valid {
		item.DeviceCompletedAt = deviceCompletedAt.Time.UTC()
	}
	if completedAt.Valid {
		value := completedAt.Time.UTC().Format(time.RFC3339Nano)
		item.CompletedAt = &value
	}
	return item, nil
}

func credentialRevocationResult(
	item CredentialRevocationProjection,
	ticket string,
	created bool,
) CreateCredentialRevocationResult {
	return CreateCredentialRevocationResult{
		Revocation: item, CommandTicket: ticket, Created: created,
		CleanupTarget: CredentialCleanupTarget{
			ExecutorID: item.ExecutorID, RuntimeType: item.RuntimeType,
			RuntimeBindingID: item.RuntimeBindingID, RuntimeBindingRevision: item.RuntimeBindingRevision,
			DeviceID:     item.DeviceID,
			RevocationID: item.RevocationID, OperationID: item.OperationID,
			CredentialRevision: item.CredentialRevision, RevocationEpoch: item.RevocationEpoch,
			Action: "quarantine",
		},
	}
}

func insertCredentialRevocationAudit(
	ctx context.Context,
	tx *sql.Tx,
	item CredentialRevocationProjection,
	sequence int64,
	eventType string,
	occurredAt time.Time,
) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_revocation_audit (
		 revocation_id,sequence,event_type,actor_id,actor_session_id,executor_id,
		 runtime_type,device_id,credential_revision,revocation_epoch,operation_id,
		 force,status,failure_code,quarantine_digest,request_hash,confirmation_id,
		 runtime_binding_id,runtime_binding_revision,occurred_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
	`, item.RevocationID, sequence, eventType, item.ActorID, item.ActorSessionID,
		item.ExecutorID, item.RuntimeType, item.DeviceID, item.CredentialRevision,
		item.RevocationEpoch, item.OperationID, item.Force, item.Status,
		item.FailureCode, item.QuarantineDigest, item.RequestHash,
		nullCredentialConfirmation(item.ConfirmationID), item.RuntimeBindingID,
		item.RuntimeBindingRevision, occurredAt)
	return classifyControlWrite(err)
}

func credentialRevocationSafeReference(item CredentialRevocationProjection) map[string]any {
	return map[string]any{
		"revocationId": item.RevocationID, "operationId": item.OperationID,
		"executorId": item.ExecutorID, "runtimeType": item.RuntimeType,
		"credentialRevision": item.CredentialRevision,
		"revocationEpoch":    item.RevocationEpoch, "force": item.Force,
		"status": item.Status, "failureCode": item.FailureCode,
	}
}

func credentialRevocationResponseReference(revocationID string) string {
	return fmt.Sprintf("credential_revocation_%s", revocationID)
}

func nullCredentialConfirmation(value string) any {
	if value == "" {
		return nil
	}
	return value
}
