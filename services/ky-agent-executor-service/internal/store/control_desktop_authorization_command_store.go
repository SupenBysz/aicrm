package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

const DesktopAuthorizationCommandTicketLifetime = 120 * time.Second

var (
	ErrDesktopAuthorizationCommandInputInvalid   = errors.New("desktop authorization command input invalid")
	ErrDesktopAuthorizationCommandStateInvalid   = errors.New("desktop authorization command state invalid")
	ErrDesktopAuthorizationCommandTicketMismatch = errors.New("desktop authorization command ticket mismatch")
	ErrDesktopAuthorizationCommandACKRecorded    = errors.New("desktop authorization command ACK already recorded")
	ErrDesktopAuthorizationCommandCompletedAt    = errors.New("desktop authorization command completion time invalid")
)

type DesktopAuthorizationCommandRequest struct {
	SessionID               string
	ActorID                 string
	ActorSessionID          string
	Purpose                 string
	ExpectedSessionRevision int64
	IdempotencyKeyHash      string
	RequestHash             string
	CanCancelAny            bool
}

type CreateDesktopAuthorizationCommandInput struct {
	DesktopAuthorizationCommandRequest
	OperationID string
}

type DesktopAuthorizationCommandProjection struct {
	OperationID             string  `json:"operationId"`
	SessionID               string  `json:"sessionId"`
	ExecutorID              string  `json:"executorId"`
	DeviceID                string  `json:"-"`
	Purpose                 string  `json:"purpose"`
	ExpectedSessionRevision int64   `json:"expectedSessionRevision"`
	Status                  string  `json:"status"`
	FailureCode             string  `json:"failureCode,omitempty"`
	ExpiresAt               string  `json:"expiresAt"`
	CompletedAt             *string `json:"completedAt,omitempty"`
	CreatedAt               string  `json:"createdAt"`

	ActorID                  string    `json:"-"`
	ActorSessionID           string    `json:"-"`
	IdempotencyKeyHash       string    `json:"-"`
	RequestHash              string    `json:"-"`
	CommandTicketHash        string    `json:"-"`
	TokenKeyID               string    `json:"-"`
	TokenNonceHash           string    `json:"-"`
	TokenIssuedAt            time.Time `json:"-"`
	ACKRequestHash           string    `json:"-"`
	ACKDeviceKeyGeneration   uint64    `json:"-"`
	ACKDeviceSequence        uint64    `json:"-"`
	DeviceCompletedAt        time.Time `json:"-"`
	SecurityContractVerified bool      `json:"-"`
}

type IssuedDesktopAuthorizationCommandTicket struct {
	Token     string
	Hash      string
	KeyID     string
	NonceHash string
	ExpiresAt time.Time
}

type DesktopAuthorizationCommandTicketIssuer func(
	DesktopAuthorizationCommandProjection,
	time.Time,
) (IssuedDesktopAuthorizationCommandTicket, error)

type CreateDesktopAuthorizationCommandResult struct {
	Session        AuthorizationSessionProjection
	Command        DesktopAuthorizationCommandProjection
	CommandTicket  string
	CommandCreated bool
	Transitioned   bool
	Replayed       bool
}

func (s *ControlStore) LookupDesktopAuthorizationCommand(
	ctx context.Context,
	request DesktopAuthorizationCommandRequest,
) (CreateDesktopAuthorizationCommandResult, bool, error) {
	if !validDesktopAuthorizationCommandRequest(request) {
		return CreateDesktopAuthorizationCommandResult{}, false, ErrDesktopAuthorizationCommandInputInvalid
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted, ReadOnly: true})
	if err != nil {
		return CreateDesktopAuthorizationCommandResult{}, false, err
	}
	defer tx.Rollback()
	result, found, err := lookupDesktopAuthorizationCommandReplayTx(ctx, tx, request)
	if err != nil || !found {
		return CreateDesktopAuthorizationCommandResult{}, found, err
	}
	if err := tx.Commit(); err != nil {
		return CreateDesktopAuthorizationCommandResult{}, false, classifyControlWrite(err)
	}
	result.Replayed = true
	return result, true, nil
}

func (s *ControlStore) CreateDesktopAuthorizationCommand(
	ctx context.Context,
	input CreateDesktopAuthorizationCommandInput,
	issuer DesktopAuthorizationCommandTicketIssuer,
) (CreateDesktopAuthorizationCommandResult, error) {
	if !validCreateDesktopAuthorizationCommandInput(input) || issuer == nil {
		return CreateDesktopAuthorizationCommandResult{}, ErrDesktopAuthorizationCommandInputInvalid
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return CreateDesktopAuthorizationCommandResult{}, err
	}
	defer tx.Rollback()
	if replay, found, err := lookupDesktopAuthorizationCommandReplayTx(
		ctx, tx, input.DesktopAuthorizationCommandRequest,
	); err != nil {
		return CreateDesktopAuthorizationCommandResult{}, err
	} else if found {
		if err := tx.Commit(); err != nil {
			return CreateDesktopAuthorizationCommandResult{}, classifyControlWrite(err)
		}
		replay.Replayed = true
		return replay, nil
	}

	session, err := scanAuthorizationSession(tx.QueryRowContext(
		ctx, authorizationSessionSelect+` WHERE id=$1 FOR UPDATE`, input.SessionID,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return CreateDesktopAuthorizationCommandResult{}, ErrNotFound
	}
	if err != nil {
		return CreateDesktopAuthorizationCommandResult{}, err
	}
	// Re-check after the session row lock so a concurrent exact request that
	// committed while this transaction waited is replayed instead of racing the
	// unique indexes or issuing a second ticket.
	if replay, found, err := lookupDesktopAuthorizationCommandReplayTx(
		ctx, tx, input.DesktopAuthorizationCommandRequest,
	); err != nil {
		return CreateDesktopAuthorizationCommandResult{}, err
	} else if found {
		if err := tx.Commit(); err != nil {
			return CreateDesktopAuthorizationCommandResult{}, classifyControlWrite(err)
		}
		replay.Replayed = true
		return replay, nil
	}
	if session.RuntimeType != "desktop" || session.FlowType != "browser" ||
		session.Revision != input.ExpectedSessionRevision {
		return CreateDesktopAuthorizationCommandResult{}, ErrRevisionConflict
	}
	if input.Purpose == "authorization_cancel" {
		if session.RequestedBy != input.ActorID && !input.CanCancelAny {
			return CreateDesktopAuthorizationCommandResult{}, ErrRequesterMismatch
		}
	} else if session.RequestedBy != input.ActorID {
		return CreateDesktopAuthorizationCommandResult{}, ErrRequesterMismatch
	}

	terminal := desktopAuthorizationSessionTerminal(session.Status)
	if terminal {
		if input.Purpose != "authorization_cancel" {
			return CreateDesktopAuthorizationCommandResult{}, ErrAuthorizationTerminal
		}
		if err := insertDesktopAuthorizationCommandRegistry(
			ctx, tx, input.DesktopAuthorizationCommandRequest,
			"authorization_session", input.SessionID, 200,
		); err != nil {
			return CreateDesktopAuthorizationCommandResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return CreateDesktopAuthorizationCommandResult{}, classifyControlWrite(err)
		}
		return CreateDesktopAuthorizationCommandResult{Session: session}, nil
	}
	if input.Purpose == "authorization_reopen" && session.Status != "waiting_user" {
		return CreateDesktopAuthorizationCommandResult{}, ErrDesktopAuthorizationCommandStateInvalid
	}

	var boundDeviceID, runtimeOperationID, runtimeOwner string
	var prepared sql.NullInt64
	if err := tx.QueryRowContext(ctx, `
		SELECT bound_device_id,prepared_credential_revision,operation_id,runtime_owner_instance_id
		FROM ky_ai_executor_authorization_session WHERE id=$1
	`, input.SessionID).Scan(&boundDeviceID, &prepared, &runtimeOperationID, &runtimeOwner); err != nil {
		return CreateDesktopAuthorizationCommandResult{}, err
	}
	var deviceID string
	deviceAvailable := false
	// The session's bound device is the frozen command target.  In particular,
	// a starting session has no trusted target yet and must never inherit the
	// executor's current active binding for a destructive cancel command.
	if boundDeviceID != "" {
		err = tx.QueryRowContext(ctx, `
			SELECT binding.device_id
			FROM ky_ai_executor_device_binding binding
			JOIN ky_ai_executor_device device ON device.id=binding.device_id
			WHERE binding.executor_id=$1 AND binding.device_id=$2
			  AND binding.status='active' AND device.status='active'
			FOR UPDATE OF binding,device
		`, session.ExecutorID, boundDeviceID).Scan(&deviceID)
		deviceAvailable = err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return CreateDesktopAuthorizationCommandResult{}, err
		}
	}
	if !deviceAvailable && input.Purpose == "authorization_reopen" {
		return CreateDesktopAuthorizationCommandResult{}, ErrDeviceMismatch
	}
	databaseNow, err := transactionNow(ctx, tx)
	if err != nil {
		return CreateDesktopAuthorizationCommandResult{}, err
	}
	command := DesktopAuthorizationCommandProjection{}
	issued := IssuedDesktopAuthorizationCommandTicket{}
	if deviceAvailable {
		command = DesktopAuthorizationCommandProjection{
			OperationID: input.OperationID, SessionID: input.SessionID,
			ExecutorID: session.ExecutorID, DeviceID: deviceID,
			ActorID: input.ActorID, ActorSessionID: input.ActorSessionID,
			Purpose: input.Purpose, ExpectedSessionRevision: input.ExpectedSessionRevision,
			IdempotencyKeyHash: input.IdempotencyKeyHash, RequestHash: input.RequestHash,
			Status: "pending", SecurityContractVerified: true,
		}
		issued, err = issuer(command, databaseNow)
		if err != nil {
			return CreateDesktopAuthorizationCommandResult{}, err
		}
		if !validIssuedDesktopAuthorizationCommandTicket(issued, databaseNow) {
			return CreateDesktopAuthorizationCommandResult{}, ErrDesktopAuthorizationCommandTicketMismatch
		}
		command.CommandTicketHash = issued.Hash
		command.TokenKeyID = issued.KeyID
		command.TokenNonceHash = issued.NonceHash
		command.TokenIssuedAt = databaseNow.UTC().Truncate(time.Second)
		command.ExpiresAt = issued.ExpiresAt.UTC().Format(time.RFC3339Nano)
		command.CreatedAt = databaseNow.UTC().Format(time.RFC3339Nano)
	}

	transitioned := false
	if input.Purpose == "authorization_cancel" {
		updated, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_authorization_session
			SET status='cancelled',failure_code='',revision=revision+1,
			    current_sequence=current_sequence+3,finished_at=$3,updated_at=$3
			WHERE id=$1 AND revision=$2
		`, input.SessionID, input.ExpectedSessionRevision, databaseNow)
		if err != nil {
			return CreateDesktopAuthorizationCommandResult{}, err
		}
		if affected, _ := updated.RowsAffected(); affected != 1 {
			return CreateDesktopAuthorizationCommandResult{}, ErrRevisionConflict
		}
		if prepared.Valid {
			updated, err := tx.ExecContext(ctx, `
				UPDATE ky_ai_executor_credential_binding SET status='quarantined'
				WHERE executor_id=$1 AND revision=$2 AND status IN ('prepared','committing')
			`, session.ExecutorID, prepared.Int64)
			if err != nil {
				return CreateDesktopAuthorizationCommandResult{}, err
			}
			if affected, _ := updated.RowsAffected(); affected != 1 {
				return CreateDesktopAuthorizationCommandResult{}, ErrExecutorFenced
			}
		}
		handoffUpdate, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_desktop_handoff
			SET status='cancelled',
			    claim_consumed_at=CASE
			      WHEN claim_token_hash<>'' THEN COALESCE(claim_consumed_at,$2)
			      ELSE claim_consumed_at
			    END
			WHERE session_id=$1 AND status IN ('pending','claimed','proof_submitted')
		`, input.SessionID, databaseNow)
		if err != nil {
			return CreateDesktopAuthorizationCommandResult{}, err
		}
		if affected, _ := handoffUpdate.RowsAffected(); (session.Status == "waiting_user" || session.Status == "verifying") && affected != 1 {
			return CreateDesktopAuthorizationCommandResult{}, ErrExecutorFenced
		}
		activationUpdate, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_credential_activation
			SET status='quarantined',updated_at=$2
			WHERE session_id=$1 AND status='pending'
		`, input.SessionID, databaseNow)
		if err != nil {
			return CreateDesktopAuthorizationCommandResult{}, err
		}
		if affected, _ := activationUpdate.RowsAffected(); (affected == 1) != prepared.Valid {
			return CreateDesktopAuthorizationCommandResult{}, ErrExecutorFenced
		}
		if runtimeOperationID != "" {
			updated, err := tx.ExecContext(ctx, `
				UPDATE ky_ai_executor_operation_lease SET status='fenced',updated_at=$4
				WHERE executor_id=$1 AND operation_id=$2 AND owner_instance_id=$3 AND status='active'
			`, session.ExecutorID, runtimeOperationID, runtimeOwner, databaseNow)
			if err != nil {
				return CreateDesktopAuthorizationCommandResult{}, err
			}
			if affected, _ := updated.RowsAffected(); affected != 1 {
				return CreateDesktopAuthorizationCommandResult{}, ErrExecutorFenced
			}
		}
		if err := insertSessionEvent(ctx, tx, input.SessionID, session.Sequence+1,
			AuthorizationEventChanged, map[string]any{"change": "cancelled"}); err != nil {
			return CreateDesktopAuthorizationCommandResult{}, err
		}
		if err := insertSessionEvent(ctx, tx, input.SessionID, session.Sequence+2,
			AuthorizationEventTerminal, map[string]any{"status": "cancelled"}); err != nil {
			return CreateDesktopAuthorizationCommandResult{}, err
		}
		if err := insertSessionEvent(ctx, tx, input.SessionID, session.Sequence+3,
			AuthorizationEventClosed, map[string]any{"reason": "terminal"}); err != nil {
			return CreateDesktopAuthorizationCommandResult{}, err
		}
		if err := insertControlOutbox(ctx, tx, "authorization_session", input.SessionID,
			input.ExpectedSessionRevision+1, "cancelled", map[string]any{"executorId": session.ExecutorID}); err != nil {
			return CreateDesktopAuthorizationCommandResult{}, err
		}
		transitioned = true
	}
	if !deviceAvailable {
		if err := insertDesktopAuthorizationCommandRegistry(
			ctx, tx, input.DesktopAuthorizationCommandRequest,
			"authorization_session", input.SessionID, 200,
		); err != nil {
			return CreateDesktopAuthorizationCommandResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return CreateDesktopAuthorizationCommandResult{}, classifyControlWrite(err)
		}
		session, err = s.GetAuthorizationSession(ctx, input.SessionID)
		if err != nil {
			return CreateDesktopAuthorizationCommandResult{}, err
		}
		return CreateDesktopAuthorizationCommandResult{
			Session: session, Transitioned: transitioned,
		}, nil
	}

	if err := insertDesktopAuthorizationCommand(ctx, tx, command, issued, databaseNow); err != nil {
		return CreateDesktopAuthorizationCommandResult{}, err
	}
	if err := insertDesktopAuthorizationCommandAudit(ctx, tx, command, 1, "created", databaseNow); err != nil {
		return CreateDesktopAuthorizationCommandResult{}, err
	}
	if err := insertControlOutbox(ctx, tx, "desktop_operation", command.OperationID, 1,
		"desktop_command.created", desktopAuthorizationCommandSafeReference(command)); err != nil {
		return CreateDesktopAuthorizationCommandResult{}, err
	}
	if err := insertDesktopAuthorizationCommandRegistry(
		ctx, tx, input.DesktopAuthorizationCommandRequest,
		"desktop_operation", input.OperationID, 202,
	); err != nil {
		return CreateDesktopAuthorizationCommandResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return CreateDesktopAuthorizationCommandResult{}, classifyControlWrite(err)
	}
	session, err = s.GetAuthorizationSession(ctx, input.SessionID)
	if err != nil {
		return CreateDesktopAuthorizationCommandResult{}, err
	}
	return CreateDesktopAuthorizationCommandResult{
		Session: session, Command: command, CommandTicket: issued.Token,
		CommandCreated: true, Transitioned: transitioned,
	}, nil
}

func lookupDesktopAuthorizationCommandReplayTx(
	ctx context.Context,
	tx *sql.Tx,
	request DesktopAuthorizationCommandRequest,
) (CreateDesktopAuthorizationCommandResult, bool, error) {
	var requestHash, resourceType, resourceID string
	err := tx.QueryRowContext(ctx, `
		SELECT request_hash,resource_type,resource_id
		FROM ky_ai_executor_api_idempotency
		WHERE actor_id=$1 AND action=$2 AND scope_id=$3 AND idempotency_key_hash=$4
	`, request.ActorID, desktopAuthorizationCommandIdempotencyAction(request.Purpose),
		request.SessionID, request.IdempotencyKeyHash).Scan(&requestHash, &resourceType, &resourceID)
	if errors.Is(err, sql.ErrNoRows) {
		return CreateDesktopAuthorizationCommandResult{}, false, nil
	}
	if err != nil {
		return CreateDesktopAuthorizationCommandResult{}, false, err
	}
	if requestHash != request.RequestHash {
		return CreateDesktopAuthorizationCommandResult{}, true, ErrIdempotencyReuse
	}
	session, err := scanAuthorizationSession(tx.QueryRowContext(
		ctx, authorizationSessionSelect+` WHERE id=$1`, request.SessionID,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return CreateDesktopAuthorizationCommandResult{}, true, ErrNotFound
	}
	if err != nil {
		return CreateDesktopAuthorizationCommandResult{}, true, err
	}
	if session.RequestedBy != request.ActorID &&
		(request.Purpose != "authorization_cancel" || !request.CanCancelAny) {
		return CreateDesktopAuthorizationCommandResult{}, true, ErrRequesterMismatch
	}
	if resourceType == "authorization_session" && resourceID == request.SessionID {
		return CreateDesktopAuthorizationCommandResult{Session: session, Replayed: true}, true, nil
	}
	if resourceType != "desktop_operation" {
		return CreateDesktopAuthorizationCommandResult{}, true, ErrDesktopAuthorizationCommandStateInvalid
	}
	command, err := loadDesktopAuthorizationCommand(ctx, tx, resourceID, request.SessionID, false)
	if err != nil {
		return CreateDesktopAuthorizationCommandResult{}, true, err
	}
	if !matchesDesktopAuthorizationCommandRequest(command, request) {
		return CreateDesktopAuthorizationCommandResult{}, true, ErrIdempotencyReuse
	}
	return CreateDesktopAuthorizationCommandResult{
		Session: session, Command: command, CommandCreated: true, Replayed: true,
	}, true, nil
}

func insertDesktopAuthorizationCommand(
	ctx context.Context,
	tx *sql.Tx,
	item DesktopAuthorizationCommandProjection,
	issued IssuedDesktopAuthorizationCommandTicket,
	now time.Time,
) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_desktop_command_operation (
		 id,executor_id,session_id,device_id,requested_by,actor_session_id,purpose,
		 expected_session_revision,idempotency_key_hash,request_hash,
		 command_ticket_hash,token_key_id,token_nonce_hash,status,issued_at,expires_at,
		 created_at,updated_at,security_contract_verified
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15,$14,$14,true)
	`, item.OperationID, item.ExecutorID, item.SessionID, item.DeviceID,
		item.ActorID, item.ActorSessionID, item.Purpose, item.ExpectedSessionRevision,
		item.IdempotencyKeyHash, item.RequestHash, issued.Hash, issued.KeyID,
		issued.NonceHash, now.UTC().Truncate(time.Second), issued.ExpiresAt.UTC())
	return classifyControlWrite(err)
}

func insertDesktopAuthorizationCommandRegistry(
	ctx context.Context,
	tx *sql.Tx,
	request DesktopAuthorizationCommandRequest,
	resourceType string,
	resourceID string,
	responseStatus int,
) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_api_idempotency (
		 actor_id,action,scope_id,idempotency_key_hash,request_hash,
		 resource_type,resource_id,response_status
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
	`, request.ActorID, desktopAuthorizationCommandIdempotencyAction(request.Purpose),
		request.SessionID, request.IdempotencyKeyHash, request.RequestHash,
		resourceType, resourceID, responseStatus)
	return classifyControlWrite(err)
}

func insertDesktopAuthorizationCommandAudit(
	ctx context.Context,
	tx *sql.Tx,
	item DesktopAuthorizationCommandProjection,
	sequence int64,
	eventType string,
	occurredAt time.Time,
) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_desktop_command_audit (
		 operation_id,sequence,event_type,session_id,executor_id,device_id,
		 actor_id,actor_session_id,purpose,expected_session_revision,status,
		 failure_code,request_hash,ack_request_hash,proof_key_generation,
		 proof_sequence,occurred_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
	`, item.OperationID, sequence, eventType, item.SessionID, item.ExecutorID,
		item.DeviceID, item.ActorID, item.ActorSessionID, item.Purpose,
		item.ExpectedSessionRevision, item.Status, item.FailureCode, item.RequestHash,
		item.ACKRequestHash, int64(item.ACKDeviceKeyGeneration),
		int64(item.ACKDeviceSequence), occurredAt)
	return classifyControlWrite(err)
}

func loadDesktopAuthorizationCommand(
	ctx context.Context,
	tx *sql.Tx,
	operationID string,
	sessionID string,
	forUpdate bool,
) (DesktopAuthorizationCommandProjection, error) {
	lock := ""
	if forUpdate {
		lock = " FOR UPDATE"
	}
	item, err := scanDesktopAuthorizationCommand(tx.QueryRowContext(ctx,
		desktopAuthorizationCommandSelect+` WHERE id=$1 AND session_id=$2`+lock,
		operationID, sessionID,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return DesktopAuthorizationCommandProjection{}, ErrNotFound
	}
	return item, err
}

const desktopAuthorizationCommandSelect = `
	SELECT id,COALESCE(session_id,''),executor_id,device_id,requested_by,
	       actor_session_id,purpose,COALESCE(expected_session_revision,0),
	       idempotency_key_hash,request_hash,command_ticket_hash,token_key_id,
	       token_nonce_hash,status,failure_code,issued_at,expires_at,
	       ack_request_hash,ack_device_key_generation,ack_device_sequence,
	       device_completed_at,security_contract_verified,created_at,completed_at
	FROM ky_ai_executor_desktop_command_operation
`

func scanDesktopAuthorizationCommand(row rowScanner) (DesktopAuthorizationCommandProjection, error) {
	var item DesktopAuthorizationCommandProjection
	var issuedAt, expiresAt, createdAt time.Time
	var completedAt, deviceCompletedAt sql.NullTime
	var ackKeyGeneration, ackSequence int64
	err := row.Scan(
		&item.OperationID, &item.SessionID, &item.ExecutorID, &item.DeviceID,
		&item.ActorID, &item.ActorSessionID, &item.Purpose,
		&item.ExpectedSessionRevision, &item.IdempotencyKeyHash, &item.RequestHash,
		&item.CommandTicketHash, &item.TokenKeyID, &item.TokenNonceHash,
		&item.Status, &item.FailureCode, &issuedAt, &expiresAt,
		&item.ACKRequestHash, &ackKeyGeneration, &ackSequence, &deviceCompletedAt,
		&item.SecurityContractVerified, &createdAt, &completedAt,
	)
	if err != nil {
		return DesktopAuthorizationCommandProjection{}, err
	}
	if ackKeyGeneration < 0 || ackSequence < 0 {
		return DesktopAuthorizationCommandProjection{}, ErrDesktopAuthorizationCommandStateInvalid
	}
	item.TokenIssuedAt = issuedAt.UTC()
	item.ExpiresAt = expiresAt.UTC().Format(time.RFC3339Nano)
	item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	item.ACKDeviceKeyGeneration = uint64(ackKeyGeneration)
	item.ACKDeviceSequence = uint64(ackSequence)
	if deviceCompletedAt.Valid {
		item.DeviceCompletedAt = deviceCompletedAt.Time.UTC()
	}
	if completedAt.Valid {
		value := completedAt.Time.UTC().Format(time.RFC3339Nano)
		item.CompletedAt = &value
	}
	return item, nil
}

func desktopAuthorizationCommandSafeReference(item DesktopAuthorizationCommandProjection) map[string]any {
	return map[string]any{
		"operationId": item.OperationID, "sessionId": item.SessionID,
		"executorId": item.ExecutorID, "purpose": item.Purpose,
		"expectedSessionRevision": item.ExpectedSessionRevision,
		"status":                  item.Status, "failureCode": item.FailureCode,
	}
}

func matchesDesktopAuthorizationCommandRequest(
	item DesktopAuthorizationCommandProjection,
	request DesktopAuthorizationCommandRequest,
) bool {
	return item.SecurityContractVerified && item.SessionID == request.SessionID &&
		item.ActorID == request.ActorID &&
		item.Purpose == request.Purpose &&
		item.ExpectedSessionRevision == request.ExpectedSessionRevision &&
		item.IdempotencyKeyHash == request.IdempotencyKeyHash && item.RequestHash == request.RequestHash
}

func validDesktopAuthorizationCommandRequest(input DesktopAuthorizationCommandRequest) bool {
	return validOpaqueValue(input.SessionID) && validOpaqueValue(input.ActorID) &&
		validOpaqueValue(input.ActorSessionID) && desktopAuthorizationCommandPurpose(input.Purpose) &&
		input.ExpectedSessionRevision > 0 &&
		validateStoreDigest(input.IdempotencyKeyHash, false) == nil &&
		validateStoreDigest(input.RequestHash, false) == nil
}

func validCreateDesktopAuthorizationCommandInput(input CreateDesktopAuthorizationCommandInput) bool {
	return validDesktopAuthorizationCommandRequest(input.DesktopAuthorizationCommandRequest) &&
		validOpaqueValue(input.OperationID)
}

func validIssuedDesktopAuthorizationCommandTicket(
	issued IssuedDesktopAuthorizationCommandTicket,
	issuedAt time.Time,
) bool {
	return issued.Token != "" && len(issued.Token) <= 16<<10 &&
		validateStoreDigest(issued.Hash, false) == nil &&
		validateStoreDigest(issued.NonceHash, false) == nil &&
		confirmationKeyIDPattern.MatchString(issued.KeyID) &&
		issued.ExpiresAt.UTC().Equal(issuedAt.UTC().Truncate(time.Second).Add(DesktopAuthorizationCommandTicketLifetime))
}

func desktopAuthorizationCommandPurpose(value string) bool {
	return value == "authorization_cancel" || value == "authorization_reopen"
}

func desktopAuthorizationCommandIdempotencyAction(purpose string) string {
	if purpose == "authorization_cancel" {
		return "cancel_authorization"
	}
	return "reopen_authorization"
}

func desktopAuthorizationSessionTerminal(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled", "expired", "interrupted", "superseded":
		return true
	default:
		return false
	}
}

func DesktopAuthorizationCommandACKPath(sessionID, operationID string) string {
	return fmt.Sprintf(
		"/api/v1/ai-executor-authorization-sessions/%s/desktop-commands/%s/ack",
		sessionID, operationID,
	)
}
