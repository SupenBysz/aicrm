package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
)

func CredentialRevocationACKPath(executorID, revocationID string) string {
	return fmt.Sprintf("/api/v1/ai-executors/%s/credential-revocations/%s/ack", executorID, revocationID)
}

func (s *ControlStore) AcknowledgeCredentialRevocation(
	ctx context.Context,
	input AcknowledgeCredentialRevocationInput,
	verifier CredentialLogoutTicketVerifier,
) (AcknowledgeCredentialRevocationResult, error) {
	if !validCredentialRevocationACKInput(input) || verifier == nil {
		return AcknowledgeCredentialRevocationResult{}, ErrCredentialRevocationInputInvalid
	}
	path := CredentialRevocationACKPath(input.ExecutorID, input.RevocationID)
	if err := validateVerifiedProof(input.Proof, input.Proof.DeviceID, path, input.KeyGeneration); err != nil ||
		validateStoreDigest(input.Proof.AuthorizationTokenHash, false) != nil {
		if err != nil {
			return AcknowledgeCredentialRevocationResult{}, err
		}
		return AcknowledgeCredentialRevocationResult{}, ErrCredentialRevocationInputInvalid
	}
	ledgerRequest, err := ledgerRequestFromProof(input.Proof, input.KeyGeneration)
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	responseReference := credentialRevocationResponseReference(input.RevocationID)
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	defer tx.Rollback()

	if replay, handled, err := replayCredentialRevocationACK(
		ctx, tx, ledgerRequest, input, responseReference,
	); handled || err != nil {
		if err != nil {
			return AcknowledgeCredentialRevocationResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return AcknowledgeCredentialRevocationResult{}, classifyControlWrite(err)
		}
		return replay, nil
	}

	device, exists, err := loadDeviceForUpdate(ctx, tx, input.Proof.DeviceID)
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	if !exists {
		return AcknowledgeCredentialRevocationResult{}, ErrNotFound
	}
	if device.Projection.Status != "active" {
		return AcknowledgeCredentialRevocationResult{}, ErrDeviceInactive
	}
	if device.Projection.KeyGeneration != input.KeyGeneration {
		return AcknowledgeCredentialRevocationResult{}, ErrDeviceKeyGenerationMismatch
	}
	decision, existing, err := decideStoredLedger(
		ctx, tx, ledgerRequest, device.Projection.LastAcceptedSequence,
	)
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	if decision.Action == deviceauth.LedgerReturnRecorded {
		if existing == nil || decision.ResponseReference != responseReference {
			return AcknowledgeCredentialRevocationResult{}, ErrDeviceProofReplayed
		}
		item, err := loadCredentialRevocationForACK(ctx, tx, input, false)
		if err != nil {
			return AcknowledgeCredentialRevocationResult{}, err
		}
		if item.Status == "awaiting_device" {
			return AcknowledgeCredentialRevocationResult{}, ErrCredentialRevocationStateInvalid
		}
		if err := tx.Commit(); err != nil {
			return AcknowledgeCredentialRevocationResult{}, classifyControlWrite(err)
		}
		return AcknowledgeCredentialRevocationResult{
			Revocation: item, ResponseReference: responseReference, Replayed: true,
		}, nil
	}
	if decision.Action == deviceauth.LedgerRejectReplay {
		return AcknowledgeCredentialRevocationResult{}, ErrDeviceProofReplayed
	}
	databaseNow, err := transactionNow(ctx, tx)
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	if err := deviceauth.ValidateTimestamp(input.Proof.TimestampMilli, databaseNow); err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	if err := validateLedgerExpiry(input.LedgerExpiresAt, databaseNow); err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	item, err := loadCredentialRevocationForACK(ctx, tx, input, true)
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	if item.DeviceID != input.Proof.DeviceID || item.Status != "awaiting_device" ||
		item.RuntimeType != "desktop" || !item.SecurityContractVerified {
		return AcknowledgeCredentialRevocationResult{}, ErrCredentialRevocationTicketMismatch
	}
	if item.ACKRequestHash != "" {
		return AcknowledgeCredentialRevocationResult{}, ErrCredentialRevocationACKRecorded
	}
	verified, err := verifier(databaseNow)
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	if !matchesCredentialLogoutTicket(item, input, verified) ||
		input.Proof.AuthorizationTokenHash != item.CommandTicketHash {
		return AcknowledgeCredentialRevocationResult{}, ErrCredentialRevocationTicketMismatch
	}
	if input.CompletedAt.Before(item.TokenIssuedAt.Add(-deviceauth.ClockWindow)) ||
		input.CompletedAt.After(databaseNow.Add(deviceauth.ClockWindow)) {
		return AcknowledgeCredentialRevocationResult{}, ErrCredentialRevocationCompletedAt
	}

	targetCurrent, err := credentialRevocationTargetIsCurrent(ctx, tx, item)
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	finalStatus := "stale_target"
	failureCode := ""
	quarantineDigest := ""
	if targetCurrent && input.Result != "stale_target" {
		var updated sql.Result
		if item.Force {
			updated, err = tx.ExecContext(ctx, `
				UPDATE ky_ai_executor_config SET updated_at=updated_at
				WHERE id=$1 AND runtime_type='desktop' AND credential_status='revoked'
				  AND current_credential_revision IS NULL AND runtime_binding_id=''
				  AND runtime_binding_revision=0 AND revocation_epoch=$2
			`, item.ExecutorID, item.RevocationEpoch)
		} else {
			updated, err = tx.ExecContext(ctx, `
				UPDATE ky_ai_executor_config
				SET current_credential_revision=NULL,runtime_binding_id='',
				    runtime_binding_revision=0,config_revision=config_revision+1,
				    updated_at=$3
				WHERE id=$1 AND runtime_type='desktop' AND credential_status='revoked'
				  AND current_credential_revision=$2 AND runtime_binding_id=$5
				  AND runtime_binding_revision=$6 AND revocation_epoch=$4
			`, item.ExecutorID, item.CredentialRevision, databaseNow, item.RevocationEpoch,
				item.RuntimeBindingID, item.RuntimeBindingRevision)
		}
		if err != nil {
			return AcknowledgeCredentialRevocationResult{}, err
		}
		if affected, _ := updated.RowsAffected(); affected != 1 {
			finalStatus = "stale_target"
		} else {
			bindingStatus := "active"
			if item.Force {
				bindingStatus = "revoked"
			}
			updated, err = tx.ExecContext(ctx, `
				UPDATE ky_ai_executor_credential_binding
				SET status='revoked',revoked_at=COALESCE(revoked_at,$4)
				WHERE executor_id=$1 AND revision=$2 AND status=$6
				  AND revocation_epoch=$3 AND runtime_type='desktop' AND device_id=$5
			`, item.ExecutorID, item.CredentialRevision, item.RevocationEpoch-1,
				databaseNow, item.DeviceID, bindingStatus)
			if err != nil {
				return AcknowledgeCredentialRevocationResult{}, err
			}
			if affected, _ := updated.RowsAffected(); affected != 1 {
				finalStatus = "stale_target"
			} else if input.Result == "succeeded" {
				finalStatus = "completed"
				quarantineDigest = input.QuarantineDigest
			} else {
				finalStatus = "failed"
				failureCode = "credential_logout_failed"
				quarantineDigest = input.QuarantineDigest
			}
		}
	}
	item.Status = finalStatus
	item.FailureCode = failureCode
	item.QuarantineDigest = quarantineDigest
	item.ACKRequestHash = input.Proof.RequestHash
	item.DeviceCompletedAt = input.CompletedAt.UTC()
	completedAt := databaseNow.UTC().Format(time.RFC3339Nano)
	item.CompletedAt = &completedAt

	updated, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_revocation
		SET status=$2,failure_code=$3,quarantine_digest=$4,ack_request_hash=$5,
		    device_completed_at=$6,completed_at=$7
		WHERE id=$1 AND status='awaiting_device' AND ack_request_hash=''
	`, item.RevocationID, item.Status, item.FailureCode, item.QuarantineDigest,
		item.ACKRequestHash, item.DeviceCompletedAt, databaseNow)
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return AcknowledgeCredentialRevocationResult{}, ErrCredentialRevocationACKRecorded
	}
	commandStatus := map[string]string{
		"completed": "succeeded", "failed": "failed", "stale_target": "stale_target",
	}[item.Status]
	updated, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_desktop_command_operation
		SET status=$2,failure_code=$3,ack_request_hash=$4,completed_at=$5,updated_at=$5
		WHERE id=$1 AND purpose='credential_logout' AND status='pending'
		  AND ack_request_hash='' AND revocation_id=$6
	`, item.OperationID, commandStatus, item.FailureCode,
		item.ACKRequestHash, databaseNow, item.RevocationID)
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return AcknowledgeCredentialRevocationResult{}, ErrCredentialRevocationStateInvalid
	}
	eventType := item.Status
	if err := insertCredentialRevocationAudit(ctx, tx, item, 2, eventType, databaseNow); err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	if err := insertControlOutbox(ctx, tx, "credential_revocation", item.RevocationID, 2,
		"credential_revocation."+eventType, credentialRevocationSafeReference(item)); err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	previousSequence := device.Projection.LastAcceptedSequence
	updated, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_device
		SET last_accepted_sequence=$2,updated_at=$3
		WHERE id=$1 AND status='active' AND key_generation=$4 AND last_accepted_sequence=$5
	`, item.DeviceID, int64(input.Proof.Sequence), databaseNow,
		int64(input.KeyGeneration), int64(previousSequence))
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return AcknowledgeCredentialRevocationResult{}, ErrDeviceProofReplayed
	}
	if err := insertDeviceLedger(
		ctx, tx, ledgerRequest, responseReference, databaseNow, input.LedgerExpiresAt,
	); err != nil {
		return AcknowledgeCredentialRevocationResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return AcknowledgeCredentialRevocationResult{}, classifyControlWrite(err)
	}
	return AcknowledgeCredentialRevocationResult{
		Revocation: item, ResponseReference: responseReference,
	}, nil
}

func replayCredentialRevocationACK(
	ctx context.Context,
	tx *sql.Tx,
	request deviceauth.LedgerRequest,
	input AcknowledgeCredentialRevocationInput,
	responseReference string,
) (AcknowledgeCredentialRevocationResult, bool, error) {
	existing, err := loadExactDeviceLedger(ctx, tx, request)
	if err != nil || existing == nil {
		return AcknowledgeCredentialRevocationResult{}, false, err
	}
	decision, err := decideExactDeviceLedger(request, existing)
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, true, err
	}
	if decision.Action != deviceauth.LedgerReturnRecorded || decision.ResponseReference != responseReference {
		return AcknowledgeCredentialRevocationResult{}, true, ErrDeviceProofReplayed
	}
	item, err := loadCredentialRevocationForACK(ctx, tx, input, false)
	if err != nil {
		return AcknowledgeCredentialRevocationResult{}, true, err
	}
	if item.Status == "awaiting_device" || item.ACKRequestHash != input.Proof.RequestHash {
		return AcknowledgeCredentialRevocationResult{}, true, ErrCredentialRevocationStateInvalid
	}
	return AcknowledgeCredentialRevocationResult{
		Revocation: item, ResponseReference: responseReference, Replayed: true,
	}, true, nil
}

func loadCredentialRevocationForACK(
	ctx context.Context,
	tx *sql.Tx,
	input AcknowledgeCredentialRevocationInput,
	forUpdate bool,
) (CredentialRevocationProjection, error) {
	lock := ""
	if forUpdate {
		lock = " FOR UPDATE"
	}
	item, err := scanCredentialRevocation(tx.QueryRowContext(ctx, credentialRevocationSelect+`
		WHERE id=$1 AND executor_id=$2
	`+lock, input.RevocationID, input.ExecutorID))
	if errors.Is(err, sql.ErrNoRows) {
		return CredentialRevocationProjection{}, ErrNotFound
	}
	if err != nil {
		return CredentialRevocationProjection{}, err
	}
	if item.OperationID != input.OperationID || item.CredentialRevision != input.CredentialRevision ||
		item.RevocationEpoch != input.RevocationEpoch {
		return CredentialRevocationProjection{}, ErrCredentialRevocationTicketMismatch
	}
	return item, nil
}

func matchesCredentialLogoutTicket(
	item CredentialRevocationProjection,
	input AcknowledgeCredentialRevocationInput,
	verified VerifiedCredentialLogoutTicket,
) bool {
	return verified.TokenHash == item.CommandTicketHash &&
		verified.NonceHash == item.TokenNonceHash &&
		verified.ActorID == item.ActorID && verified.ExecutorID == item.ExecutorID &&
		verified.DeviceID == item.DeviceID && verified.OperationID == item.OperationID &&
		verified.RevocationID == item.RevocationID &&
		verified.CredentialRevision == item.CredentialRevision &&
		verified.RevocationEpoch == item.RevocationEpoch &&
		verified.IssuedAt.UTC().Equal(item.TokenIssuedAt.UTC()) && item.ExpiresAt != nil &&
		verified.ExpiresAt.UTC().Format(time.RFC3339Nano) == *item.ExpiresAt &&
		input.Proof.AuthorizationTokenHash == verified.TokenHash
}

func credentialRevocationTargetIsCurrent(
	ctx context.Context,
	tx *sql.Tx,
	item CredentialRevocationProjection,
) (bool, error) {
	var runtimeType, credentialStatus, runtimeBindingID string
	var currentRevision sql.NullInt64
	var revocationEpoch, runtimeBindingRevision int64
	err := tx.QueryRowContext(ctx, `
		SELECT runtime_type,credential_status,current_credential_revision,revocation_epoch,
		       runtime_binding_id,runtime_binding_revision
		FROM ky_ai_executor_config WHERE id=$1 FOR UPDATE
	`, item.ExecutorID).Scan(&runtimeType, &credentialStatus, &currentRevision, &revocationEpoch,
		&runtimeBindingID, &runtimeBindingRevision)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if runtimeType != "desktop" || credentialStatus != "revoked" ||
		revocationEpoch != item.RevocationEpoch {
		return false, nil
	}
	if item.Force {
		if currentRevision.Valid || runtimeBindingID != "" || runtimeBindingRevision != 0 {
			return false, nil
		}
	} else if !currentRevision.Valid || currentRevision.Int64 != item.CredentialRevision ||
		runtimeBindingID != item.RuntimeBindingID || runtimeBindingRevision != item.RuntimeBindingRevision {
		return false, nil
	}
	var bindingStatus, bindingRuntime, bindingDevice, bindingRuntimeID string
	var bindingEpoch, bindingRuntimeRevision int64
	err = tx.QueryRowContext(ctx, `
		SELECT status,runtime_type,device_id,revocation_epoch,
		       runtime_binding_id,runtime_binding_revision
		FROM ky_ai_executor_credential_binding
		WHERE executor_id=$1 AND revision=$2 FOR UPDATE
	`, item.ExecutorID, item.CredentialRevision).Scan(
		&bindingStatus, &bindingRuntime, &bindingDevice, &bindingEpoch,
		&bindingRuntimeID, &bindingRuntimeRevision,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	expectedBindingStatus := "active"
	if item.Force {
		expectedBindingStatus = "revoked"
	}
	if bindingStatus != expectedBindingStatus || bindingRuntime != "desktop" ||
		bindingDevice != item.DeviceID || bindingEpoch != item.RevocationEpoch-1 ||
		bindingRuntimeID != item.RuntimeBindingID || bindingRuntimeRevision != item.RuntimeBindingRevision {
		return false, nil
	}
	var hasNewActive bool
	if err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
		 SELECT 1 FROM ky_ai_executor_credential_binding
		 WHERE executor_id=$1 AND status='active' AND revision<>$2
		)
	`, item.ExecutorID, item.CredentialRevision).Scan(&hasNewActive); err != nil {
		return false, err
	}
	return !hasNewActive, nil
}

func validCredentialRevocationACKInput(input AcknowledgeCredentialRevocationInput) bool {
	if !validOpaqueValue(input.ExecutorID) || !validOpaqueValue(input.RevocationID) ||
		!validOpaqueValue(input.OperationID) || input.CredentialRevision <= 0 ||
		input.RevocationEpoch <= 0 || input.CompletedAt.IsZero() || input.KeyGeneration == 0 {
		return false
	}
	switch input.Result {
	case "succeeded":
		return validateStoreDigest(input.QuarantineDigest, false) == nil
	case "failed":
		return validateStoreDigest(input.QuarantineDigest, true) == nil
	case "stale_target":
		return input.QuarantineDigest == ""
	default:
		return false
	}
}
