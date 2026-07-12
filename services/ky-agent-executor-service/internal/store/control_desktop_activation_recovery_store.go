package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

const maxDesktopActivationRecoveryBatch = 256

type DesktopActivationReconciliationResult struct {
	Selected   int
	Reconciled int
}

type desktopActivationRecoveryCandidate struct {
	ActivationID string
	ExecutorID   string
	SessionID    string
}

type storedDesktopActivationLease struct {
	OperationID              string
	OwnerInstanceID          string
	LeaseEpoch               int64
	LeaseExpiresAt           time.Time
	SourceCredentialRevision int64
	RevocationEpoch          int64
	Status                   string
}

type storedDesktopActivationCandidateBinding struct {
	Status                   string
	AuthorizationSessionID   sql.NullString
	RuntimeType              string
	RuntimeBindingID         string
	RuntimeBindingRevision   int64
	DeviceID                 string
	OperationID              string
	LeaseEpoch               int64
	SourceCredentialRevision int64
	RevocationEpoch          int64
	BindingDigest            string
}

type desktopActivationRecoveryDecision struct {
	ActivationStatus string
	SessionStatus    string
	FailureCode      string
}

// ReconcileDesktopCredentialActivations terminalizes a bounded set of stale
// pending Desktop activations. Candidate discovery is deliberately unlocked;
// every candidate is re-read under the same executor -> session -> activation
// lock order used by activation ACK. The final state changes are full-tuple
// CAS operations, so an ACK or a newer lease epoch can be the only winner.
func (s *ControlStore) ReconcileDesktopCredentialActivations(
	ctx context.Context,
	limit int,
) (DesktopActivationReconciliationResult, error) {
	if s == nil || s.db == nil || limit <= 0 || limit > maxDesktopActivationRecoveryBatch {
		return DesktopActivationReconciliationResult{}, ErrDesktopActivationInputInvalid
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT activation.id,activation.executor_id,activation.session_id
		FROM ky_ai_executor_credential_activation activation
		JOIN ky_ai_executor_authorization_session session ON session.id=activation.session_id
		JOIN ky_ai_executor_config executor ON executor.id=activation.executor_id
		LEFT JOIN ky_ai_executor_operation_lease lease ON lease.executor_id=activation.executor_id
		LEFT JOIN ky_ai_executor_credential_binding candidate
		  ON candidate.executor_id=activation.executor_id
		 AND candidate.revision=activation.credential_revision
		LEFT JOIN ky_ai_executor_device_binding device_binding
		  ON device_binding.executor_id=activation.executor_id
		LEFT JOIN ky_ai_executor_device device ON device.id=activation.device_id
		WHERE activation.status='pending'
		  AND (
		    activation.expires_at<=transaction_timestamp()
		    OR session.session_deadline_at<=transaction_timestamp()
		    OR session.status IN ('succeeded','failed','cancelled','expired','interrupted','superseded')
		    OR session.status<>'verifying'
		    OR session.executor_id<>activation.executor_id
		    OR session.runtime_type<>'desktop' OR session.flow_type<>'browser'
		    OR session.bound_device_id<>activation.device_id
		    OR session.operation_id<>activation.operation_id
		    OR session.prepared_credential_revision IS DISTINCT FROM activation.credential_revision
		    OR lease.executor_id IS NULL
		    OR lease.operation_id<>activation.operation_id
		    OR lease.owner_instance_id<>('desktop_' || activation.device_id)
		    OR lease.lease_epoch<>activation.lease_epoch
		    OR lease.source_credential_revision<>activation.source_credential_revision
		    OR lease.revocation_epoch<>activation.revocation_epoch
		    OR lease.status<>'active' OR lease.lease_expires_at<=transaction_timestamp()
		    OR executor.runtime_type<>'desktop' OR executor.status<>'enabled'
		    OR executor.revocation_epoch<>activation.revocation_epoch
		    OR executor.credential_revision_counter<>activation.credential_revision
		    OR COALESCE(executor.current_credential_revision,0)<>activation.source_credential_revision
		    OR (
		      activation.source_credential_revision=0
		      AND (executor.runtime_binding_id<>'' OR executor.runtime_binding_revision<>0)
		    )
		    OR (
		      activation.source_credential_revision>0
		      AND (
		        executor.runtime_binding_id<>activation.device_id
		        OR executor.runtime_binding_revision<>activation.device_binding_revision
		      )
		    )
		    OR device_binding.executor_id IS NULL OR device_binding.status<>'active'
		    OR device_binding.device_id<>activation.device_id
		    OR device_binding.revision<>activation.device_binding_revision
		    OR device.id IS NULL OR device.status<>'active'
		    OR device.workspace_type<>'platform' OR device.workspace_id<>'platform_root'
		    OR candidate.executor_id IS NULL OR candidate.status<>'prepared'
		    OR candidate.authorization_session_id IS DISTINCT FROM activation.session_id
		    OR candidate.runtime_type<>'desktop'
		    OR candidate.runtime_binding_id<>activation.device_id
		    OR candidate.runtime_binding_revision<>activation.device_binding_revision
		    OR candidate.device_id<>activation.device_id
		    OR candidate.operation_id<>activation.operation_id
		    OR candidate.lease_epoch<>activation.lease_epoch
		    OR candidate.source_credential_revision<>activation.source_credential_revision
		    OR candidate.revocation_epoch<>activation.revocation_epoch
		    OR candidate.binding_digest<>activation.binding_digest
		  )
		ORDER BY activation.issued_at,activation.id
		LIMIT $1
	`, limit)
	if err != nil {
		return DesktopActivationReconciliationResult{}, err
	}
	candidates := make([]desktopActivationRecoveryCandidate, 0, limit)
	for rows.Next() {
		var item desktopActivationRecoveryCandidate
		if err := rows.Scan(&item.ActivationID, &item.ExecutorID, &item.SessionID); err != nil {
			_ = rows.Close()
			return DesktopActivationReconciliationResult{}, err
		}
		candidates = append(candidates, item)
	}
	if err := rows.Close(); err != nil {
		return DesktopActivationReconciliationResult{}, err
	}
	if err := rows.Err(); err != nil {
		return DesktopActivationReconciliationResult{}, err
	}

	result := DesktopActivationReconciliationResult{Selected: len(candidates)}
	for _, candidate := range candidates {
		changed, err := s.reconcileDesktopCredentialActivation(ctx, candidate)
		if err != nil {
			return result, err
		}
		if changed {
			result.Reconciled++
		}
	}
	return result, nil
}

func (s *ControlStore) reconcileDesktopCredentialActivation(
	ctx context.Context,
	candidate desktopActivationRecoveryCandidate,
) (bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	executor, found, err := loadDesktopActivationRecoveryExecutorForUpdate(ctx, tx, candidate.ExecutorID)
	if err != nil {
		return false, err
	}
	if !found {
		return false, ErrNotFound
	}
	session, found, err := loadDesktopActivationSessionForUpdate(ctx, tx, candidate.SessionID)
	if err != nil {
		return false, err
	}
	if !found {
		return false, ErrNotFound
	}
	activation, found, err := loadDesktopActivationByID(ctx, tx, candidate.ActivationID, true)
	if err != nil {
		return false, err
	}
	if !found || activation.Status != "pending" {
		return false, nil
	}
	if activation.ExecutorID != candidate.ExecutorID || activation.SessionID != candidate.SessionID {
		return false, ErrExecutorFenced
	}

	deviceBinding, deviceBindingFound, err := loadDeviceBindingForUpdate(ctx, tx, activation.ExecutorID)
	if err != nil {
		return false, err
	}
	device, deviceFound, err := loadDeviceForUpdate(ctx, tx, activation.DeviceID)
	if err != nil {
		return false, err
	}
	now, err := transactionNow(ctx, tx)
	if err != nil {
		return false, err
	}
	lease, leaseFound, err := loadDesktopActivationRecoveryLeaseForUpdate(ctx, tx, activation.ExecutorID)
	if err != nil {
		return false, err
	}
	binding, bindingFound, err := loadDesktopActivationRecoveryCandidateForUpdate(
		ctx, tx, activation.ExecutorID, activation.CredentialRevision,
	)
	if err != nil {
		return false, err
	}
	if !bindingFound || !desktopActivationCandidateTupleMatches(binding, activation) ||
		(binding.Status != "prepared" && binding.Status != "quarantined") {
		return false, ErrExecutorFenced
	}

	decision := decideDesktopActivationRecovery(
		executor, session, activation, lease, leaseFound, binding,
		deviceBinding, deviceBindingFound, device, deviceFound, now,
	)
	if decision.ActivationStatus == "" {
		return false, nil
	}

	if binding.Status == "prepared" {
		updated, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_credential_binding SET status='quarantined'
			WHERE executor_id=$1 AND revision=$2 AND status='prepared'
			  AND authorization_session_id=$3 AND runtime_type='desktop'
			  AND runtime_binding_id=$4 AND runtime_binding_revision=$5 AND device_id=$4
			  AND operation_id=$6 AND lease_epoch=$7
			  AND source_credential_revision=$8 AND revocation_epoch=$9
			  AND binding_digest=$10
		`, activation.ExecutorID, activation.CredentialRevision, activation.SessionID,
			activation.DeviceID, activation.DeviceBindingRevision, activation.OperationID,
			activation.LeaseEpoch, activation.SourceCredentialRevision,
			activation.RevocationEpoch, activation.BindingDigest)
		if err != nil {
			return false, err
		}
		if affected, _ := updated.RowsAffected(); affected != 1 {
			return false, ErrExecutorFenced
		}
	}

	updated, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_activation
		SET status=$2,updated_at=$3
		WHERE id=$1 AND status='pending' AND session_id=$4 AND executor_id=$5
		  AND device_id=$6 AND operation_id=$7 AND credential_revision=$8
		  AND lease_epoch=$9 AND source_credential_revision=$10
		  AND revocation_epoch=$11 AND device_binding_revision=$12
		  AND binding_digest=$13 AND activation_token_hash=$14
	`, activation.ID, decision.ActivationStatus, now, activation.SessionID,
		activation.ExecutorID, activation.DeviceID, activation.OperationID,
		activation.CredentialRevision, activation.LeaseEpoch,
		activation.SourceCredentialRevision, activation.RevocationEpoch,
		activation.DeviceBindingRevision, activation.BindingDigest,
		activation.ActivationTokenHash)
	if err != nil {
		return false, err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return false, ErrDesktopActivationConflict
	}

	leaseExact := leaseFound && desktopActivationLeaseTupleMatches(lease, activation)
	if leaseExact && lease.Status == "active" {
		updated, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_operation_lease
			SET status='expired',updated_at=$8
			WHERE executor_id=$1 AND operation_id=$2 AND owner_instance_id=$3
			  AND lease_epoch=$4 AND source_credential_revision=$5
			  AND revocation_epoch=$6 AND status='active' AND lease_expires_at=$7
		`, activation.ExecutorID, activation.OperationID, desktopLeaseOwner(activation.DeviceID),
			activation.LeaseEpoch, activation.SourceCredentialRevision,
			activation.RevocationEpoch, lease.LeaseExpiresAt, now)
		if err != nil {
			return false, err
		}
		if affected, _ := updated.RowsAffected(); affected != 1 {
			return false, ErrExecutorFenced
		}
	}

	sessionTransitioned := decision.SessionStatus != "" &&
		desktopActivationSessionMatches(session, activation)
	if sessionTransitioned {
		updated, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_authorization_session
			SET status=$2,failure_code=$3,current_sequence=current_sequence+3,
			    revision=revision+1,finished_at=$4,updated_at=$4
			WHERE id=$1 AND status='verifying' AND revision=$5
			  AND executor_id=$6 AND runtime_type='desktop' AND flow_type='browser'
			  AND bound_device_id=$7 AND operation_id=$8
			  AND prepared_credential_revision=$9
		`, session.ID, decision.SessionStatus, decision.FailureCode, now,
			session.Revision, activation.ExecutorID, activation.DeviceID,
			activation.OperationID, activation.CredentialRevision)
		if err != nil {
			return false, err
		}
		if affected, _ := updated.RowsAffected(); affected != 1 {
			return false, ErrRevisionConflict
		}
	}

	if err := insertDesktopActivationAudit(
		ctx, tx, activation, 2, decision.ActivationStatus, activation.RequestHash, now,
	); err != nil {
		return false, err
	}
	if sessionTransitioned {
		if err := insertSessionEvent(ctx, tx, session.ID, session.CurrentSequence+1,
			AuthorizationEventChanged, map[string]any{
				"change": decision.SessionStatus, "failureCode": decision.FailureCode,
			}); err != nil {
			return false, err
		}
		if err := insertSessionEvent(ctx, tx, session.ID, session.CurrentSequence+2,
			AuthorizationEventTerminal, map[string]any{
				"status": decision.SessionStatus, "failureCode": decision.FailureCode,
			}); err != nil {
			return false, err
		}
		if err := insertSessionEvent(ctx, tx, session.ID, session.CurrentSequence+3,
			AuthorizationEventClosed, map[string]any{"reason": "terminal"}); err != nil {
			return false, err
		}
	}

	if err := insertControlOutbox(ctx, tx, "credential_binding",
		activation.ExecutorID+":"+itoa64(activation.CredentialRevision), 2,
		"credential_quarantined", map[string]any{
			"executorId": activation.ExecutorID, "sessionId": activation.SessionID,
			"credentialRevision": activation.CredentialRevision,
			"activationStatus":   decision.ActivationStatus, "failureCode": decision.FailureCode,
		}); err != nil {
		return false, err
	}
	if sessionTransitioned {
		if err := insertControlOutbox(ctx, tx, "authorization_session", session.ID,
			session.Revision+1, decision.SessionStatus, map[string]any{
				"executorId": activation.ExecutorID, "failureCode": decision.FailureCode,
				"credentialRevision": activation.CredentialRevision,
			}); err != nil {
			return false, err
		}
	} else if err := insertControlOutbox(ctx, tx, "authorization_session", session.ID,
		session.Revision, "credential_quarantined", map[string]any{
			"executorId": activation.ExecutorID, "status": session.Status,
			"credentialRevision": activation.CredentialRevision,
		}); err != nil {
		return false, err
	}

	if err := tx.Commit(); err != nil {
		return false, classifyControlWrite(err)
	}
	return true, nil
}

func decideDesktopActivationRecovery(
	executor storedDesktopActivationExecutor,
	session storedDesktopActivationSession,
	activation DesktopCredentialActivationProjection,
	lease storedDesktopActivationLease,
	leaseFound bool,
	binding storedDesktopActivationCandidateBinding,
	deviceBinding storedDeviceBinding,
	deviceBindingFound bool,
	device storedDevice,
	deviceFound bool,
	now time.Time,
) desktopActivationRecoveryDecision {
	if desktopActivationSessionIsTerminal(session.Status) {
		return desktopActivationRecoveryDecision{ActivationStatus: "quarantined"}
	}
	if !now.Before(activation.ExpiresAt) || !now.Before(session.SessionDeadlineAt) {
		decision := desktopActivationRecoveryDecision{ActivationStatus: "expired"}
		if desktopActivationSessionMatches(session, activation) {
			decision.SessionStatus = "expired"
			decision.FailureCode = "session_deadline_exceeded"
		}
		return decision
	}
	leaseExact := leaseFound && desktopActivationLeaseTupleMatches(lease, activation)
	if leaseExact && (lease.Status == "expired" ||
		(lease.Status == "active" && !lease.LeaseExpiresAt.After(now))) {
		decision := desktopActivationRecoveryDecision{ActivationStatus: "expired"}
		if desktopActivationSessionMatches(session, activation) {
			decision.SessionStatus = "interrupted"
			decision.FailureCode = "desktop_disconnected"
		}
		return decision
	}
	if binding.Status == "quarantined" {
		decision := desktopActivationRecoveryDecision{ActivationStatus: "quarantined"}
		if desktopActivationSessionMatches(session, activation) {
			decision.SessionStatus = "interrupted"
			decision.FailureCode = "desktop_disconnected"
		}
		return decision
	}
	if !leaseExact || lease.Status != "active" ||
		executor.RuntimeType != "desktop" || executor.Status != "enabled" ||
		executor.RevocationEpoch != activation.RevocationEpoch ||
		executor.CredentialRevisionCounter != activation.CredentialRevision ||
		coalesceRevision(executor.CurrentCredentialRevision) != activation.SourceCredentialRevision ||
		!deviceBindingFound || deviceBinding.Status != "active" ||
		deviceBinding.ExecutorID != activation.ExecutorID ||
		deviceBinding.DeviceID != activation.DeviceID ||
		deviceBinding.Revision != activation.DeviceBindingRevision ||
		!desktopConfigRuntimeMatches(executor, deviceBinding, activation.DeviceID) ||
		!deviceFound || device.Projection.ID != activation.DeviceID ||
		device.Projection.Status != "active" || device.Projection.WorkspaceType != "platform" ||
		device.Projection.WorkspaceID != "platform_root" ||
		!desktopActivationSessionMatches(session, activation) {
		decision := desktopActivationRecoveryDecision{ActivationStatus: "fenced"}
		if desktopActivationSessionMatches(session, activation) {
			decision.SessionStatus = "interrupted"
			decision.FailureCode = "desktop_disconnected"
		}
		return decision
	}
	return desktopActivationRecoveryDecision{}
}

func loadDesktopActivationRecoveryExecutorForUpdate(
	ctx context.Context,
	tx *sql.Tx,
	executorID string,
) (storedDesktopActivationExecutor, bool, error) {
	var item storedDesktopActivationExecutor
	err := tx.QueryRowContext(ctx, `
		SELECT runtime_type,status,credential_status,current_credential_revision,
		       credential_revision_counter,revocation_epoch,
		       runtime_binding_id,runtime_binding_revision
		FROM ky_ai_executor_config
		WHERE id=$1 AND scope_type='platform' AND scope_id='platform_root'
		  AND executor_type='codex'
		FOR UPDATE
	`, executorID).Scan(&item.RuntimeType, &item.Status, &item.CredentialStatus,
		&item.CurrentCredentialRevision, &item.CredentialRevisionCounter,
		&item.RevocationEpoch, &item.RuntimeBindingID, &item.RuntimeBindingRevision)
	if errors.Is(err, sql.ErrNoRows) {
		return storedDesktopActivationExecutor{}, false, nil
	}
	return item, err == nil, err
}

func loadDesktopActivationRecoveryLeaseForUpdate(
	ctx context.Context,
	tx *sql.Tx,
	executorID string,
) (storedDesktopActivationLease, bool, error) {
	var item storedDesktopActivationLease
	err := tx.QueryRowContext(ctx, `
		SELECT operation_id,owner_instance_id,lease_epoch,lease_expires_at,
		       source_credential_revision,revocation_epoch,status
		FROM ky_ai_executor_operation_lease WHERE executor_id=$1 FOR UPDATE
	`, executorID).Scan(&item.OperationID, &item.OwnerInstanceID, &item.LeaseEpoch,
		&item.LeaseExpiresAt, &item.SourceCredentialRevision, &item.RevocationEpoch,
		&item.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return storedDesktopActivationLease{}, false, nil
	}
	return item, err == nil, err
}

func loadDesktopActivationRecoveryCandidateForUpdate(
	ctx context.Context,
	tx *sql.Tx,
	executorID string,
	revision int64,
) (storedDesktopActivationCandidateBinding, bool, error) {
	var item storedDesktopActivationCandidateBinding
	err := tx.QueryRowContext(ctx, `
		SELECT status,authorization_session_id,runtime_type,runtime_binding_id,
		       runtime_binding_revision,device_id,operation_id,lease_epoch,
		       source_credential_revision,revocation_epoch,binding_digest
		FROM ky_ai_executor_credential_binding
		WHERE executor_id=$1 AND revision=$2 FOR UPDATE
	`, executorID, revision).Scan(&item.Status, &item.AuthorizationSessionID,
		&item.RuntimeType, &item.RuntimeBindingID, &item.RuntimeBindingRevision,
		&item.DeviceID, &item.OperationID, &item.LeaseEpoch,
		&item.SourceCredentialRevision, &item.RevocationEpoch, &item.BindingDigest)
	if errors.Is(err, sql.ErrNoRows) {
		return storedDesktopActivationCandidateBinding{}, false, nil
	}
	return item, err == nil, err
}

func desktopActivationLeaseTupleMatches(
	lease storedDesktopActivationLease,
	activation DesktopCredentialActivationProjection,
) bool {
	return lease.OperationID == activation.OperationID &&
		lease.OwnerInstanceID == desktopLeaseOwner(activation.DeviceID) &&
		lease.LeaseEpoch == activation.LeaseEpoch &&
		lease.SourceCredentialRevision == activation.SourceCredentialRevision &&
		lease.RevocationEpoch == activation.RevocationEpoch
}

func desktopActivationCandidateTupleMatches(
	binding storedDesktopActivationCandidateBinding,
	activation DesktopCredentialActivationProjection,
) bool {
	return binding.AuthorizationSessionID.Valid &&
		binding.AuthorizationSessionID.String == activation.SessionID &&
		binding.RuntimeType == "desktop" && binding.RuntimeBindingID == activation.DeviceID &&
		binding.RuntimeBindingRevision == activation.DeviceBindingRevision &&
		binding.DeviceID == activation.DeviceID && binding.OperationID == activation.OperationID &&
		binding.LeaseEpoch == activation.LeaseEpoch &&
		binding.SourceCredentialRevision == activation.SourceCredentialRevision &&
		binding.RevocationEpoch == activation.RevocationEpoch &&
		binding.BindingDigest == activation.BindingDigest
}

func desktopActivationSessionMatches(
	session storedDesktopActivationSession,
	activation DesktopCredentialActivationProjection,
) bool {
	return session.ID == activation.SessionID && session.ExecutorID == activation.ExecutorID &&
		session.RuntimeType == "desktop" && session.FlowType == "browser" &&
		session.Status == "verifying" && session.BoundDeviceID == activation.DeviceID &&
		session.OperationID == activation.OperationID &&
		session.PreparedCredentialRevision.Valid &&
		session.PreparedCredentialRevision.Int64 == activation.CredentialRevision
}

func desktopActivationSessionIsTerminal(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled", "expired", "interrupted", "superseded":
		return true
	default:
		return false
	}
}
