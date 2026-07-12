package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
)

type VerifiedDesktopAuthorizationCommandTicket struct {
	TokenHash               string
	NonceHash               string
	TokenID                 string
	ActorID                 string
	SessionID               string
	ExecutorID              string
	DeviceID                string
	OperationID             string
	Purpose                 string
	ExpectedSessionRevision int64
	IssuedAt                time.Time
	ExpiresAt               time.Time
}

type DesktopAuthorizationCommandTicketVerifier func(
	time.Time,
) (VerifiedDesktopAuthorizationCommandTicket, error)

type AcknowledgeDesktopAuthorizationCommandInput struct {
	SessionID               string
	OperationID             string
	Purpose                 string
	ExpectedSessionRevision int64
	Result                  string
	CompletedAt             time.Time
	FailureCode             string
	KeyGeneration           uint64
	Proof                   deviceauth.VerifiedRequest
	LedgerExpiresAt         time.Time
}

type AcknowledgeDesktopAuthorizationCommandResult struct {
	Command           DesktopAuthorizationCommandProjection
	ResponseReference string
	Replayed          bool
}

func (s *ControlStore) AcknowledgeDesktopAuthorizationCommand(
	ctx context.Context,
	input AcknowledgeDesktopAuthorizationCommandInput,
	verifier DesktopAuthorizationCommandTicketVerifier,
) (AcknowledgeDesktopAuthorizationCommandResult, error) {
	if !validDesktopAuthorizationCommandACKInput(input) || verifier == nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, ErrDesktopAuthorizationCommandInputInvalid
	}
	path := DesktopAuthorizationCommandACKPath(input.SessionID, input.OperationID)
	if err := validateVerifiedProof(input.Proof, input.Proof.DeviceID, path, input.KeyGeneration); err != nil ||
		validateStoreDigest(input.Proof.AuthorizationTokenHash, false) != nil {
		if err != nil {
			return AcknowledgeDesktopAuthorizationCommandResult{}, err
		}
		return AcknowledgeDesktopAuthorizationCommandResult{}, ErrDesktopAuthorizationCommandInputInvalid
	}
	ledgerRequest, err := ledgerRequestFromProof(input.Proof, input.KeyGeneration)
	if err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	responseReference := desktopAuthorizationCommandResponseReference(input.OperationID)
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	defer tx.Rollback()

	if replay, handled, err := replayDesktopAuthorizationCommandACK(
		ctx, tx, ledgerRequest, input, responseReference,
	); handled || err != nil {
		if err != nil {
			return AcknowledgeDesktopAuthorizationCommandResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return AcknowledgeDesktopAuthorizationCommandResult{}, classifyControlWrite(err)
		}
		return replay, nil
	}

	device, exists, err := loadDeviceForUpdate(ctx, tx, input.Proof.DeviceID)
	if err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	if !exists {
		return AcknowledgeDesktopAuthorizationCommandResult{}, ErrNotFound
	}
	if device.Projection.Status != "active" {
		return AcknowledgeDesktopAuthorizationCommandResult{}, ErrDeviceInactive
	}
	if device.Projection.KeyGeneration != input.KeyGeneration {
		return AcknowledgeDesktopAuthorizationCommandResult{}, ErrDeviceKeyGenerationMismatch
	}
	decision, existing, err := decideStoredLedger(
		ctx, tx, ledgerRequest, device.Projection.LastAcceptedSequence,
	)
	if err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	if decision.Action == deviceauth.LedgerReturnRecorded {
		if existing == nil || decision.ResponseReference != responseReference {
			return AcknowledgeDesktopAuthorizationCommandResult{}, ErrDeviceProofReplayed
		}
		item, err := loadDesktopAuthorizationCommand(
			ctx, tx, input.OperationID, input.SessionID, false,
		)
		if err != nil {
			return AcknowledgeDesktopAuthorizationCommandResult{}, err
		}
		if item.Status == "pending" || item.ACKRequestHash != input.Proof.RequestHash {
			return AcknowledgeDesktopAuthorizationCommandResult{}, ErrDesktopAuthorizationCommandStateInvalid
		}
		if err := tx.Commit(); err != nil {
			return AcknowledgeDesktopAuthorizationCommandResult{}, classifyControlWrite(err)
		}
		return AcknowledgeDesktopAuthorizationCommandResult{
			Command: item, ResponseReference: responseReference, Replayed: true,
		}, nil
	}
	if decision.Action == deviceauth.LedgerRejectReplay {
		return AcknowledgeDesktopAuthorizationCommandResult{}, ErrDeviceProofReplayed
	}
	databaseNow, err := transactionNow(ctx, tx)
	if err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	if err := deviceauth.ValidateTimestamp(input.Proof.TimestampMilli, databaseNow); err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	if err := validateLedgerExpiry(input.LedgerExpiresAt, databaseNow); err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	item, err := loadDesktopAuthorizationCommand(ctx, tx, input.OperationID, input.SessionID, true)
	if err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	if item.Status != "pending" || item.ACKRequestHash != "" ||
		item.DeviceID != input.Proof.DeviceID || !item.SecurityContractVerified {
		return AcknowledgeDesktopAuthorizationCommandResult{}, ErrDesktopAuthorizationCommandTicketMismatch
	}
	verified, err := verifier(databaseNow)
	if err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	if !matchesDesktopAuthorizationCommandTicket(item, input, verified) ||
		input.Proof.AuthorizationTokenHash != item.CommandTicketHash {
		return AcknowledgeDesktopAuthorizationCommandResult{}, ErrDesktopAuthorizationCommandTicketMismatch
	}
	if input.CompletedAt.Before(item.TokenIssuedAt.Add(-deviceauth.ClockWindow)) ||
		input.CompletedAt.After(databaseNow.Add(deviceauth.ClockWindow)) {
		return AcknowledgeDesktopAuthorizationCommandResult{}, ErrDesktopAuthorizationCommandCompletedAt
	}

	var sessionStatus string
	var sessionRevision int64
	err = tx.QueryRowContext(ctx, `
		SELECT status,revision FROM ky_ai_executor_authorization_session
		WHERE id=$1 FOR SHARE
	`, input.SessionID).Scan(&sessionStatus, &sessionRevision)
	if errors.Is(err, sql.ErrNoRows) {
		return AcknowledgeDesktopAuthorizationCommandResult{}, ErrNotFound
	}
	if err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	targetCurrent := false
	if item.Purpose == "authorization_cancel" {
		targetCurrent = sessionStatus == "cancelled" &&
			sessionRevision == item.ExpectedSessionRevision+1
	} else {
		targetCurrent = sessionStatus == "waiting_user" &&
			sessionRevision == item.ExpectedSessionRevision
	}
	finalStatus := input.Result
	if !targetCurrent || input.Result == "stale_target" {
		finalStatus = "stale_target"
	}
	failureCode := ""
	if finalStatus == "failed" {
		failureCode = input.FailureCode
	}
	item.Status = finalStatus
	item.FailureCode = failureCode
	item.ACKRequestHash = input.Proof.RequestHash
	item.ACKDeviceKeyGeneration = input.KeyGeneration
	item.ACKDeviceSequence = input.Proof.Sequence
	item.DeviceCompletedAt = input.CompletedAt.UTC()
	completedAt := databaseNow.UTC().Format(time.RFC3339Nano)
	item.CompletedAt = &completedAt

	updated, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_desktop_command_operation
		SET status=$2,failure_code=$3,ack_request_hash=$4,
		    ack_device_key_generation=$5,ack_device_sequence=$6,
		    device_completed_at=$7,completed_at=$8,updated_at=$8
		WHERE id=$1 AND status='pending' AND ack_request_hash=''
	`, item.OperationID, item.Status, item.FailureCode, item.ACKRequestHash,
		int64(item.ACKDeviceKeyGeneration), int64(item.ACKDeviceSequence),
		item.DeviceCompletedAt, databaseNow)
	if err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return AcknowledgeDesktopAuthorizationCommandResult{}, ErrDesktopAuthorizationCommandACKRecorded
	}
	if err := insertDesktopAuthorizationCommandAudit(
		ctx, tx, item, 2, item.Status, databaseNow,
	); err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	if err := insertControlOutbox(ctx, tx, "desktop_operation", item.OperationID, 2,
		"desktop_command."+item.Status, desktopAuthorizationCommandSafeReference(item)); err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	previousSequence := device.Projection.LastAcceptedSequence
	updated, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_device
		SET last_accepted_sequence=$2,updated_at=$3
		WHERE id=$1 AND status='active' AND key_generation=$4 AND last_accepted_sequence=$5
	`, item.DeviceID, int64(input.Proof.Sequence), databaseNow,
		int64(input.KeyGeneration), int64(previousSequence))
	if err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return AcknowledgeDesktopAuthorizationCommandResult{}, ErrDeviceProofReplayed
	}
	if err := insertDeviceLedger(
		ctx, tx, ledgerRequest, responseReference, databaseNow, input.LedgerExpiresAt,
	); err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, classifyControlWrite(err)
	}
	return AcknowledgeDesktopAuthorizationCommandResult{
		Command: item, ResponseReference: responseReference,
	}, nil
}

func replayDesktopAuthorizationCommandACK(
	ctx context.Context,
	tx *sql.Tx,
	request deviceauth.LedgerRequest,
	input AcknowledgeDesktopAuthorizationCommandInput,
	responseReference string,
) (AcknowledgeDesktopAuthorizationCommandResult, bool, error) {
	existing, err := loadExactDeviceLedger(ctx, tx, request)
	if err != nil || existing == nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, false, err
	}
	decision, err := decideExactDeviceLedger(request, existing)
	if err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, true, err
	}
	if decision.Action != deviceauth.LedgerReturnRecorded || decision.ResponseReference != responseReference {
		return AcknowledgeDesktopAuthorizationCommandResult{}, true, ErrDeviceProofReplayed
	}
	item, err := loadDesktopAuthorizationCommand(
		ctx, tx, input.OperationID, input.SessionID, false,
	)
	if err != nil {
		return AcknowledgeDesktopAuthorizationCommandResult{}, true, err
	}
	if item.Status == "pending" || item.ACKRequestHash != input.Proof.RequestHash {
		return AcknowledgeDesktopAuthorizationCommandResult{}, true, ErrDesktopAuthorizationCommandStateInvalid
	}
	return AcknowledgeDesktopAuthorizationCommandResult{
		Command: item, ResponseReference: responseReference, Replayed: true,
	}, true, nil
}

func matchesDesktopAuthorizationCommandTicket(
	item DesktopAuthorizationCommandProjection,
	input AcknowledgeDesktopAuthorizationCommandInput,
	verified VerifiedDesktopAuthorizationCommandTicket,
) bool {
	return verified.TokenHash == item.CommandTicketHash &&
		verified.NonceHash == item.TokenNonceHash && verified.TokenID == item.OperationID &&
		verified.ActorID == item.ActorID &&
		verified.SessionID == item.SessionID && verified.ExecutorID == item.ExecutorID &&
		verified.DeviceID == item.DeviceID && verified.OperationID == item.OperationID &&
		verified.Purpose == item.Purpose &&
		verified.ExpectedSessionRevision == item.ExpectedSessionRevision &&
		verified.IssuedAt.UTC().Equal(item.TokenIssuedAt.UTC()) &&
		verified.ExpiresAt.UTC().Format(time.RFC3339Nano) == item.ExpiresAt &&
		input.Purpose == item.Purpose &&
		input.ExpectedSessionRevision == item.ExpectedSessionRevision &&
		input.Proof.AuthorizationTokenHash == verified.TokenHash
}

func validDesktopAuthorizationCommandACKInput(input AcknowledgeDesktopAuthorizationCommandInput) bool {
	if !validOpaqueValue(input.SessionID) || !validOpaqueValue(input.OperationID) ||
		!desktopAuthorizationCommandPurpose(input.Purpose) || input.ExpectedSessionRevision <= 0 ||
		input.CompletedAt.IsZero() || input.KeyGeneration == 0 {
		return false
	}
	switch input.Result {
	case "succeeded", "stale_target":
		return input.FailureCode == ""
	case "failed":
		return input.FailureCode != "" && len(input.FailureCode) <= 64 &&
			safeStoredCode(input.FailureCode) == input.FailureCode
	default:
		return false
	}
}

func desktopAuthorizationCommandResponseReference(operationID string) string {
	return "desktop_command_" + operationID
}
