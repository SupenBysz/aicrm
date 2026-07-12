package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type ControlTaskWork struct {
	TaskID                 string
	WorkspaceType          string
	WorkspaceID            string
	ExecutorID             string
	TaskType               string
	OperationID            string
	OwnerInstanceID        string
	LeaseEpoch             int64
	ExecutorConfigRevision int64
	CredentialRevision     int64
	CatalogRevision        int64
	RuntimeBindingID       string
	RuntimeBindingRevision int64
	RevocationEpoch        int64
	DefaultModelKey        string
	AccountFingerprint     string
	PlanType               string
	AuthMode               string
	BindingDigest          string
	TaskTimeoutSeconds     int
}

type CompleteControlTaskInput struct {
	Work                       ControlTaskWork
	CredentialAuthorized       *bool
	ReadinessStatus            string
	ReadinessReasonCode        string
	Models                     []ModelCatalogEntry
	CodexVersion               string
	PromotedCredentialRevision *int64
	PromotedBindingDigest      string
}

// ControlTaskRecoveryItem is a database-fenced recovery instruction.  A
// claimed item carries the only lease epoch allowed to touch its credential
// candidate.  A terminalized item is safe for filesystem quarantine because
// the database candidate was fenced first.
type ControlTaskRecoveryItem struct {
	Work              ControlTaskWork
	CandidateRevision *int64
	BindingStatus     string
	BindingDigest     string
	CleanupRevisions  []int64
	Terminalized      bool
}

type controlTaskCandidate struct {
	revision               int64
	status                 string
	digest                 string
	accountFingerprint     string
	planType               string
	authMode               string
	runtimeBindingID       string
	runtimeBindingRevision int64
}

func (s *ControlStore) ClaimControlTask(ctx context.Context, ownerInstanceID, codexVersion string) (resultWork ControlTaskWork, found bool, err error) {
	defer func() { err = classifyControlWrite(err) }()
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return ControlTaskWork{}, false, err
	}
	defer tx.Rollback()
	var work ControlTaskWork
	var taskSequence, taskRevision int64
	err = tx.QueryRowContext(ctx, `
		SELECT task.id,task.workspace_type,task.workspace_id,
		       COALESCE(NULLIF(task.effective_executor_id,''),task.executor_id),
		       task.task_type,task.operation_id,
		       COALESCE(task.executor_config_revision,0),
		       COALESCE(task.credential_binding_revision,0),
		       COALESCE(task.model_catalog_revision,0),task.runtime_binding_id,
		       COALESCE(task.runtime_binding_revision,0),task.revocation_epoch,
		       task.current_sequence,task.revision
		FROM ky_ai_executor_task task
		WHERE task.task_type IN ('credential_verify','model_catalog_refresh','readiness_check')
		  AND task.status='pending'
		  AND NOT EXISTS (
		    SELECT 1 FROM ky_ai_executor_task active_task
		    WHERE active_task.status IN ('waiting_executor','running')
		      AND COALESCE(NULLIF(active_task.effective_executor_id,''),active_task.executor_id)
		          = COALESCE(NULLIF(task.effective_executor_id,''),task.executor_id)
		  )
		  AND NOT EXISTS (
		    SELECT 1 FROM ky_ai_executor_operation_lease lease
		    WHERE lease.executor_id=COALESCE(NULLIF(task.effective_executor_id,''),task.executor_id)
		      AND lease.status='active' AND lease.lease_expires_at>now()
		  )
		ORDER BY task.created_at,task.id
		FOR UPDATE OF task SKIP LOCKED LIMIT 1
	`).Scan(
		&work.TaskID, &work.WorkspaceType, &work.WorkspaceID, &work.ExecutorID,
		&work.TaskType, &work.OperationID, &work.ExecutorConfigRevision,
		&work.CredentialRevision, &work.CatalogRevision, &work.RuntimeBindingID,
		&work.RuntimeBindingRevision, &work.RevocationEpoch, &taskSequence, &taskRevision,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ControlTaskWork{}, false, nil
	}
	if err != nil {
		return ControlTaskWork{}, false, err
	}
	work.OwnerInstanceID = ownerInstanceID

	var runtimeType, executorStatus, credentialStatus, runtimeBindingID, defaultModel string
	var configRevision, currentCredential, catalogRevision, runtimeBindingRevision, revocationEpoch int64
	var timeoutSeconds int
	err = tx.QueryRowContext(ctx, `
		SELECT runtime_type,status,config_revision,credential_status,
		       COALESCE(current_credential_revision,0),catalog_revision,
		       runtime_binding_id,runtime_binding_revision,revocation_epoch,
		       COALESCE(default_model_key,''),task_timeout_seconds
		FROM ky_ai_executor_config WHERE id=$1 FOR UPDATE
	`, work.ExecutorID).Scan(
		&runtimeType, &executorStatus, &configRevision, &credentialStatus,
		&currentCredential, &catalogRevision, &runtimeBindingID, &runtimeBindingRevision,
		&revocationEpoch, &defaultModel, &timeoutSeconds,
	)
	if err != nil {
		return ControlTaskWork{}, false, err
	}
	var bindingStatus string
	err = tx.QueryRowContext(ctx, `
		SELECT status,account_fingerprint,plan_type,auth_mode,binding_digest
		FROM ky_ai_executor_credential_binding
		WHERE executor_id=$1 AND revision=$2 AND revocation_epoch=$3 FOR UPDATE
	`, work.ExecutorID, work.CredentialRevision, work.RevocationEpoch).Scan(
		&bindingStatus, &work.AccountFingerprint, &work.PlanType, &work.AuthMode, &work.BindingDigest,
	)
	if errors.Is(err, sql.ErrNoRows) {
		bindingStatus = ""
	} else if err != nil {
		return ControlTaskWork{}, false, err
	}
	work.DefaultModelKey = defaultModel
	work.TaskTimeoutSeconds = timeoutSeconds
	validCredentialStatus := credentialStatus == "authorized" ||
		(work.TaskType == "credential_verify" && credentialStatus == "expired")
	valid := runtimeType == "server" && executorStatus == "enabled" && validCredentialStatus &&
		configRevision == work.ExecutorConfigRevision && currentCredential == work.CredentialRevision &&
		catalogRevision == work.CatalogRevision && runtimeBindingID == work.RuntimeBindingID &&
		runtimeBindingRevision == work.RuntimeBindingRevision && revocationEpoch == work.RevocationEpoch &&
		bindingStatus == "active" && work.AccountFingerprint != "" && work.BindingDigest != ""
	if !valid {
		code := "executor_operation_fenced"
		if executorStatus != "enabled" {
			code = "executor_disabled"
		} else if !validCredentialStatus {
			code = "credential_expired"
		}
		meta := taskEventMeta{
			TaskID: work.TaskID, Status: "failed", WorkspaceType: work.WorkspaceType,
			WorkspaceID: work.WorkspaceID, ExecutorID: work.ExecutorID,
			OperationID: work.OperationID, SourceCredentialRevision: work.CredentialRevision,
			RevocationEpoch: work.RevocationEpoch,
		}
		if err := terminalizeControlTask(ctx, tx, meta, taskRevision, taskSequence, "failed", code, nil); err != nil {
			return ControlTaskWork{}, false, err
		}
		if err := tx.Commit(); err != nil {
			return ControlTaskWork{}, false, classifyControlWrite(err)
		}
		return ControlTaskWork{}, false, nil
	}

	var previousEpoch int64
	var leaseStatus string
	var leaseUnexpired bool
	err = tx.QueryRowContext(ctx, `
		SELECT lease_epoch,status,lease_expires_at > now()
		FROM ky_ai_executor_operation_lease WHERE executor_id=$1 FOR UPDATE
	`, work.ExecutorID).Scan(&previousEpoch, &leaseStatus, &leaseUnexpired)
	if errors.Is(err, sql.ErrNoRows) {
		work.LeaseEpoch = 1
		_, err = tx.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_operation_lease (
			  executor_id,operation_id,owner_instance_id,lease_epoch,lease_expires_at,
			  source_credential_revision,revocation_epoch,status
			) VALUES ($1,$2,$3,1,now()+interval '30 seconds',$4,$5,'active')
		`, work.ExecutorID, work.OperationID, ownerInstanceID, work.CredentialRevision, work.RevocationEpoch)
	} else if err == nil {
		if leaseStatus == "active" && leaseUnexpired {
			return ControlTaskWork{}, false, ErrExecutorBusy
		}
		work.LeaseEpoch = previousEpoch + 1
		_, err = tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_operation_lease
			SET operation_id=$1,owner_instance_id=$2,lease_epoch=$3,
			    lease_expires_at=now()+interval '30 seconds',source_credential_revision=$4,
			    revocation_epoch=$5,status='active',updated_at=now()
			WHERE executor_id=$6
		`, work.OperationID, ownerInstanceID, work.LeaseEpoch, work.CredentialRevision,
			work.RevocationEpoch, work.ExecutorID)
	}
	if err != nil {
		return ControlTaskWork{}, false, err
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_task
		SET status='waiting_executor',lease_epoch=$1,source_credential_revision=$2,
		    revision=revision+1,current_sequence=current_sequence+1,updated_at=now()
		WHERE id=$3 AND revision=$4 AND status='pending'
	`, work.LeaseEpoch, work.CredentialRevision, work.TaskID, taskRevision)
	if err != nil {
		return ControlTaskWork{}, false, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ControlTaskWork{}, false, ErrExecutorFenced
	}
	meta := taskEventMeta{
		TaskID: work.TaskID, Status: "waiting_executor", WorkspaceType: work.WorkspaceType,
		WorkspaceID: work.WorkspaceID, ExecutorID: work.ExecutorID,
		OperationID: work.OperationID, LeaseEpoch: work.LeaseEpoch,
		SourceCredentialRevision: work.CredentialRevision, RevocationEpoch: work.RevocationEpoch,
	}
	if err := insertTaskEvent(ctx, tx, meta, taskSequence+1, TaskEventChanged, "info", map[string]any{"status": "waiting_executor"}); err != nil {
		return ControlTaskWork{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_task_request_registry
		SET materialized_status='waiting_executor',materialized_at=COALESCE(materialized_at,now())
		WHERE task_id=$1
	`, work.TaskID); err != nil {
		return ControlTaskWork{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_runtime_worker (
		  executor_id,runtime_binding_id,runtime_binding_revision,owner_instance_id,
		  codex_version,queue_enabled,status,heartbeat_at
		) VALUES ($1,$2,$3,$4,$5,false,'online',now())
		ON CONFLICT (executor_id) DO UPDATE SET
		  runtime_binding_id=EXCLUDED.runtime_binding_id,
		  runtime_binding_revision=EXCLUDED.runtime_binding_revision,
		  owner_instance_id=EXCLUDED.owner_instance_id,codex_version=EXCLUDED.codex_version,
		  queue_enabled=false,status='online',revision=ky_ai_executor_runtime_worker.revision+1,
		  heartbeat_at=now(),updated_at=now()
	`, work.ExecutorID, work.RuntimeBindingID, work.RuntimeBindingRevision,
		ownerInstanceID, codexVersion); err != nil {
		return ControlTaskWork{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return ControlTaskWork{}, false, classifyControlWrite(err)
	}
	return work, true, nil
}

// ClaimExpiredControlTaskRecovery uses the database clock for the complete
// expiry decision and atomically transfers every persistent fence.  It never
// returns a credential candidate until lease, task and binding all carry the
// new epoch.  Invalid or non-resumable states are terminalized in the same
// transaction before callers may quarantine filesystem paths.
func (s *ControlStore) ClaimExpiredControlTaskRecovery(ctx context.Context, ownerInstanceID, codexVersion string) (resultItem ControlTaskRecoveryItem, found bool, err error) {
	defer func() { err = classifyControlWrite(err) }()
	if ownerInstanceID == "" || codexVersion == "" {
		return ControlTaskRecoveryItem{}, false, ErrConflict
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	defer tx.Rollback()

	var item ControlTaskRecoveryItem
	work := &item.Work
	var taskStatus, previousOwner string
	var taskRevision, taskSequence int64
	err = tx.QueryRowContext(ctx, `
		SELECT task.id,task.workspace_type,task.workspace_id,
		       COALESCE(NULLIF(task.effective_executor_id,''),task.executor_id),
		       task.task_type,task.operation_id,
		       COALESCE(task.executor_config_revision,0),
		       COALESCE(task.credential_binding_revision,0),
		       COALESCE(task.model_catalog_revision,0),task.runtime_binding_id,
		       COALESCE(task.runtime_binding_revision,0),task.revocation_epoch,
		       task.status,task.current_sequence,task.revision,
		       lease.owner_instance_id,lease.lease_epoch
		FROM ky_ai_executor_task task
		JOIN ky_ai_executor_operation_lease lease
		  ON lease.executor_id=COALESCE(NULLIF(task.effective_executor_id,''),task.executor_id)
		 AND lease.operation_id=task.operation_id
		 AND lease.lease_epoch=task.lease_epoch
		 AND lease.source_credential_revision=task.source_credential_revision
		 AND lease.revocation_epoch=task.revocation_epoch
		WHERE task.task_type IN ('credential_verify','model_catalog_refresh','readiness_check')
		  AND task.status IN ('waiting_executor','running')
		  AND lease.status='active' AND lease.lease_expires_at <= now()
		ORDER BY task.updated_at,task.id
		FOR UPDATE OF task,lease SKIP LOCKED LIMIT 1
	`).Scan(
		&work.TaskID, &work.WorkspaceType, &work.WorkspaceID, &work.ExecutorID,
		&work.TaskType, &work.OperationID, &work.ExecutorConfigRevision,
		&work.CredentialRevision, &work.CatalogRevision, &work.RuntimeBindingID,
		&work.RuntimeBindingRevision, &work.RevocationEpoch, &taskStatus,
		&taskSequence, &taskRevision, &previousOwner, &work.LeaseEpoch,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ControlTaskRecoveryItem{}, false, nil
	}
	if err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	work.OwnerInstanceID = previousOwner

	var runtimeType, executorStatus, credentialStatus, runtimeBindingID, defaultModel string
	var configRevision, currentCredential, catalogRevision, runtimeBindingRevision, revocationEpoch int64
	var timeoutSeconds int
	err = tx.QueryRowContext(ctx, `
		SELECT runtime_type,status,config_revision,credential_status,
		       COALESCE(current_credential_revision,0),catalog_revision,
		       runtime_binding_id,runtime_binding_revision,revocation_epoch,
		       COALESCE(default_model_key,''),task_timeout_seconds
		FROM ky_ai_executor_config WHERE id=$1 FOR UPDATE
	`, work.ExecutorID).Scan(
		&runtimeType, &executorStatus, &configRevision, &credentialStatus,
		&currentCredential, &catalogRevision, &runtimeBindingID,
		&runtimeBindingRevision, &revocationEpoch, &defaultModel, &timeoutSeconds,
	)
	if err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	work.DefaultModelKey = defaultModel
	work.TaskTimeoutSeconds = timeoutSeconds

	var sourceStatus string
	err = tx.QueryRowContext(ctx, `
		SELECT status,account_fingerprint,plan_type,auth_mode,binding_digest
		FROM ky_ai_executor_credential_binding
		WHERE executor_id=$1 AND revision=$2 AND revocation_epoch=$3 FOR UPDATE
	`, work.ExecutorID, work.CredentialRevision, work.RevocationEpoch).Scan(
		&sourceStatus, &work.AccountFingerprint, &work.PlanType, &work.AuthMode, &work.BindingDigest,
	)
	if errors.Is(err, sql.ErrNoRows) {
		sourceStatus = ""
	} else if err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}

	rows, err := tx.QueryContext(ctx, `
		SELECT revision,status,binding_digest,account_fingerprint,plan_type,auth_mode,
		       runtime_binding_id,runtime_binding_revision
		FROM ky_ai_executor_credential_binding
		WHERE executor_id=$1 AND operation_id=$2 AND lease_epoch=$3
		  AND source_credential_revision=$4 AND revocation_epoch=$5
		  AND authorization_session_id IS NULL
		  AND status IN ('prepared','committing')
		ORDER BY revision FOR UPDATE
	`, work.ExecutorID, work.OperationID, work.LeaseEpoch,
		work.CredentialRevision, work.RevocationEpoch)
	if err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	candidates := []controlTaskCandidate{}
	for rows.Next() {
		var candidate controlTaskCandidate
		if err := rows.Scan(&candidate.revision, &candidate.status, &candidate.digest,
			&candidate.accountFingerprint, &candidate.planType, &candidate.authMode,
			&candidate.runtimeBindingID, &candidate.runtimeBindingRevision); err != nil {
			_ = rows.Close()
			return ControlTaskRecoveryItem{}, false, err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Close(); err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}

	validCredentialStatus := credentialStatus == "authorized" ||
		(work.TaskType == "credential_verify" && credentialStatus == "expired")
	validBase := taskStatus == "running" && runtimeType == "server" &&
		executorStatus == "enabled" && validCredentialStatus && sourceStatus == "active" &&
		configRevision == work.ExecutorConfigRevision && currentCredential == work.CredentialRevision &&
		catalogRevision == work.CatalogRevision && runtimeBindingID == work.RuntimeBindingID &&
		runtimeBindingRevision == work.RuntimeBindingRevision && revocationEpoch == work.RevocationEpoch &&
		work.AccountFingerprint != "" && work.BindingDigest != ""
	validCandidate := false
	if validBase && len(candidates) == 1 {
		candidate := candidates[0]
		validCandidate = candidate.accountFingerprint == work.AccountFingerprint &&
			candidate.planType == work.PlanType && candidate.authMode == work.AuthMode &&
			candidate.runtimeBindingID == work.RuntimeBindingID &&
			candidate.runtimeBindingRevision == work.RuntimeBindingRevision &&
			candidate.digest != ""
	}
	if !validCandidate {
		for _, candidate := range candidates {
			item.CleanupRevisions = append(item.CleanupRevisions, candidate.revision)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_credential_binding SET status='quarantined'
			WHERE executor_id=$1 AND operation_id=$2 AND lease_epoch=$3
			  AND source_credential_revision=$4 AND revocation_epoch=$5
			  AND authorization_session_id IS NULL
			  AND status IN ('prepared','committing')
		`, work.ExecutorID, work.OperationID, work.LeaseEpoch,
			work.CredentialRevision, work.RevocationEpoch); err != nil {
			return ControlTaskRecoveryItem{}, false, err
		}
		failureCode := "executor_app_server_unavailable"
		if len(candidates) > 0 {
			failureCode = "credential_commit_failed"
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_config SET readiness_status='degraded',
			  readiness_reason_code='runtime_error',readiness_revision=readiness_revision+1,
			  updated_at=now()
			WHERE id=$1 AND current_credential_revision=$2 AND revocation_epoch=$3
		`, work.ExecutorID, work.CredentialRevision, work.RevocationEpoch); err != nil {
			return ControlTaskRecoveryItem{}, false, err
		}
		meta := taskEventMeta{
			TaskID: work.TaskID, Status: "failed", WorkspaceType: work.WorkspaceType,
			WorkspaceID: work.WorkspaceID, ExecutorID: work.ExecutorID,
			OperationID: work.OperationID, LeaseEpoch: work.LeaseEpoch,
			SourceCredentialRevision: work.CredentialRevision, RevocationEpoch: work.RevocationEpoch,
		}
		if err := terminalizeControlTask(ctx, tx, meta, taskRevision, taskSequence,
			"failed", failureCode, nil); err != nil {
			return ControlTaskRecoveryItem{}, false, err
		}
		result, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_operation_lease SET status='expired',updated_at=now()
			WHERE executor_id=$1 AND operation_id=$2 AND owner_instance_id=$3
			  AND lease_epoch=$4 AND status='active' AND lease_expires_at <= now()
		`, work.ExecutorID, work.OperationID, previousOwner, work.LeaseEpoch)
		if err != nil {
			return ControlTaskRecoveryItem{}, false, err
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return ControlTaskRecoveryItem{}, false, ErrExecutorFenced
		}
		if err := tx.Commit(); err != nil {
			return ControlTaskRecoveryItem{}, false, classifyControlWrite(err)
		}
		item.Terminalized = true
		return item, true, nil
	}

	candidate := candidates[0]
	newLeaseEpoch := work.LeaseEpoch + 1
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease
		SET owner_instance_id=$1,lease_epoch=$2,lease_expires_at=now()+interval '30 seconds',
		    status='active',updated_at=now()
		WHERE executor_id=$3 AND operation_id=$4 AND owner_instance_id=$5
		  AND lease_epoch=$6 AND source_credential_revision=$7 AND revocation_epoch=$8
		  AND status='active' AND lease_expires_at <= now()
	`, ownerInstanceID, newLeaseEpoch, work.ExecutorID, work.OperationID, previousOwner,
		work.LeaseEpoch, work.CredentialRevision, work.RevocationEpoch)
	if err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ControlTaskRecoveryItem{}, false, ErrExecutorFenced
	}
	result, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_binding SET lease_epoch=$1
		WHERE executor_id=$2 AND revision=$3 AND status=$4 AND operation_id=$5
		  AND lease_epoch=$6 AND source_credential_revision=$7 AND revocation_epoch=$8
	`, newLeaseEpoch, work.ExecutorID, candidate.revision, candidate.status,
		work.OperationID, work.LeaseEpoch, work.CredentialRevision, work.RevocationEpoch)
	if err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ControlTaskRecoveryItem{}, false, ErrExecutorFenced
	}
	result, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_task
		SET lease_epoch=$1,revision=revision+1,current_sequence=current_sequence+1,updated_at=now()
		WHERE id=$2 AND revision=$3 AND status='running' AND lease_epoch=$4
		  AND operation_id=$5 AND source_credential_revision=$6 AND revocation_epoch=$7
	`, newLeaseEpoch, work.TaskID, taskRevision, work.LeaseEpoch, work.OperationID,
		work.CredentialRevision, work.RevocationEpoch)
	if err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ControlTaskRecoveryItem{}, false, ErrExecutorFenced
	}
	work.LeaseEpoch = newLeaseEpoch
	work.OwnerInstanceID = ownerInstanceID
	meta := taskEventMeta{
		TaskID: work.TaskID, Status: "running", WorkspaceType: work.WorkspaceType,
		WorkspaceID: work.WorkspaceID, ExecutorID: work.ExecutorID,
		OperationID: work.OperationID, LeaseEpoch: work.LeaseEpoch,
		SourceCredentialRevision: work.CredentialRevision, RevocationEpoch: work.RevocationEpoch,
	}
	if err := insertTaskEvent(ctx, tx, meta, taskSequence+1, TaskEventChanged, "warning",
		map[string]any{"status": "running", "recovery": "lease_takeover"}); err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_runtime_worker (
		  executor_id,runtime_binding_id,runtime_binding_revision,owner_instance_id,
		  codex_version,queue_enabled,status,heartbeat_at
		) VALUES ($1,$2,$3,$4,$5,false,'online',now())
		ON CONFLICT (executor_id) DO UPDATE SET
		  runtime_binding_id=EXCLUDED.runtime_binding_id,
		  runtime_binding_revision=EXCLUDED.runtime_binding_revision,
		  owner_instance_id=EXCLUDED.owner_instance_id,codex_version=EXCLUDED.codex_version,
		  queue_enabled=false,status='online',revision=ky_ai_executor_runtime_worker.revision+1,
		  heartbeat_at=now(),updated_at=now()
	`, work.ExecutorID, work.RuntimeBindingID, work.RuntimeBindingRevision,
		ownerInstanceID, codexVersion); err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return ControlTaskRecoveryItem{}, false, classifyControlWrite(err)
	}
	item.CandidateRevision = &candidate.revision
	item.BindingStatus = candidate.status
	item.BindingDigest = candidate.digest
	item.CleanupRevisions = []int64{candidate.revision}
	return item, true, nil
}

// ListControlTaskCredentialCleanup first fences candidates belonging to an
// already-terminal task, then returns idempotent filesystem cleanup work.  The
// query intentionally continues to return old terminal rows: a crash between
// the DB fence and filesystem quarantine is repaired on the next startup.
func (s *ControlStore) ListControlTaskCredentialCleanup(ctx context.Context) ([]ControlTaskRecoveryItem, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_binding binding
		SET status='quarantined'
		FROM ky_ai_executor_task task
		WHERE task.task_type IN ('credential_verify','model_catalog_refresh','readiness_check')
		  AND task.status IN ('completed','failed','cancelled','timeout')
		  AND task.operation_id=binding.operation_id
		  AND COALESCE(NULLIF(task.effective_executor_id,''),task.executor_id)=binding.executor_id
		  AND binding.authorization_session_id IS NULL
		  AND binding.status IN ('prepared','committing')
	`); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, classifyControlWrite(err)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT task.id,COALESCE(NULLIF(task.effective_executor_id,''),task.executor_id),
		       task.operation_id,binding.revision
		FROM ky_ai_executor_task task
		LEFT JOIN ky_ai_executor_credential_binding binding
		  ON binding.executor_id=COALESCE(NULLIF(task.effective_executor_id,''),task.executor_id)
		 AND binding.operation_id=task.operation_id
		 AND binding.authorization_session_id IS NULL
		 AND binding.status='quarantined'
		WHERE task.task_type IN ('credential_verify','model_catalog_refresh','readiness_check')
		  AND task.status IN ('completed','failed','cancelled','timeout')
		  AND task.operation_id<>''
		ORDER BY task.id,binding.revision
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	itemsByTask := map[string]*ControlTaskRecoveryItem{}
	order := []string{}
	for rows.Next() {
		var taskID, executorID, operationID string
		var revision sql.NullInt64
		if err := rows.Scan(&taskID, &executorID, &operationID, &revision); err != nil {
			return nil, err
		}
		item := itemsByTask[taskID]
		if item == nil {
			item = &ControlTaskRecoveryItem{Work: ControlTaskWork{
				TaskID: taskID, ExecutorID: executorID, OperationID: operationID,
			}, Terminalized: true}
			itemsByTask[taskID] = item
			order = append(order, taskID)
		}
		if revision.Valid {
			item.CleanupRevisions = append(item.CleanupRevisions, revision.Int64)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	items := make([]ControlTaskRecoveryItem, 0, len(order))
	for _, taskID := range order {
		items = append(items, *itemsByTask[taskID])
	}
	return items, nil
}

// ReconcileTerminalControlTaskCredential is the bounded runtime-cancel
// cleanup path.  It authorizes filesystem cleanup only after locking the exact
// task and proving that the same fenced operation is already terminal.  A
// running task owned by a newer epoch is never modified.
func (s *ControlStore) ReconcileTerminalControlTaskCredential(ctx context.Context, work ControlTaskWork) (ControlTaskRecoveryItem, bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	defer tx.Rollback()
	var status, executorID, operationID string
	var leaseEpoch, sourceRevision, revocationEpoch int64
	err = tx.QueryRowContext(ctx, `
		SELECT status,COALESCE(NULLIF(effective_executor_id,''),executor_id),operation_id,
		       lease_epoch,source_credential_revision,revocation_epoch
		FROM ky_ai_executor_task WHERE id=$1 FOR UPDATE
	`, work.TaskID).Scan(&status, &executorID, &operationID, &leaseEpoch, &sourceRevision, &revocationEpoch)
	if errors.Is(err, sql.ErrNoRows) {
		return ControlTaskRecoveryItem{}, false, ErrExecutorFenced
	}
	if err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	if !terminalTaskStatus(status) || executorID != work.ExecutorID ||
		operationID != work.OperationID || leaseEpoch != work.LeaseEpoch ||
		sourceRevision != work.CredentialRevision || revocationEpoch != work.RevocationEpoch {
		return ControlTaskRecoveryItem{}, false, ErrExecutorFenced
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT revision FROM ky_ai_executor_credential_binding
		WHERE executor_id=$1 AND operation_id=$2 AND lease_epoch=$3
		  AND source_credential_revision=$4 AND revocation_epoch=$5
		  AND authorization_session_id IS NULL
		  AND status IN ('prepared','committing')
		ORDER BY revision FOR UPDATE
	`, work.ExecutorID, work.OperationID, work.LeaseEpoch,
		work.CredentialRevision, work.RevocationEpoch)
	if err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	revisions := []int64{}
	for rows.Next() {
		var revision int64
		if err := rows.Scan(&revision); err != nil {
			_ = rows.Close()
			return ControlTaskRecoveryItem{}, false, err
		}
		revisions = append(revisions, revision)
	}
	if err := rows.Close(); err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_binding SET status='quarantined'
		WHERE executor_id=$1 AND operation_id=$2 AND lease_epoch=$3
		  AND source_credential_revision=$4 AND revocation_epoch=$5
		  AND authorization_session_id IS NULL
		  AND status IN ('prepared','committing')
	`, work.ExecutorID, work.OperationID, work.LeaseEpoch,
		work.CredentialRevision, work.RevocationEpoch); err != nil {
		return ControlTaskRecoveryItem{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return ControlTaskRecoveryItem{}, false, classifyControlWrite(err)
	}
	return ControlTaskRecoveryItem{
		Work: work, CleanupRevisions: revisions, Terminalized: true,
	}, true, nil
}

func (s *ControlStore) StartControlTask(ctx context.Context, work ControlTaskWork) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var revision, sequence int64
	err = tx.QueryRowContext(ctx, `
		SELECT revision,current_sequence FROM ky_ai_executor_task
		WHERE id=$1 AND status='waiting_executor' AND operation_id=$2 AND lease_epoch=$3
		  AND source_credential_revision=$4 AND revocation_epoch=$5 FOR UPDATE
	`, work.TaskID, work.OperationID, work.LeaseEpoch, work.CredentialRevision,
		work.RevocationEpoch).Scan(&revision, &sequence)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrExecutorFenced
	}
	if err != nil {
		return err
	}
	if err := verifyControlTaskLease(ctx, tx, work); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_task
		SET status='running',revision=revision+1,current_sequence=current_sequence+1,
		    started_at=COALESCE(started_at,now()),updated_at=now()
		WHERE id=$1 AND revision=$2 AND status='waiting_executor'
	`, work.TaskID, revision)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrExecutorFenced
	}
	meta := taskEventMeta{
		TaskID: work.TaskID, Status: "running", WorkspaceType: work.WorkspaceType,
		WorkspaceID: work.WorkspaceID, ExecutorID: work.ExecutorID,
		OperationID: work.OperationID, LeaseEpoch: work.LeaseEpoch,
		SourceCredentialRevision: work.CredentialRevision, RevocationEpoch: work.RevocationEpoch,
	}
	if err := insertTaskEvent(ctx, tx, meta, sequence+1, TaskEventChanged, "info", map[string]any{"status": "running"}); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_task_request_registry SET materialized_status='running' WHERE task_id=$1
	`, work.TaskID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *ControlStore) RenewControlTaskLease(ctx context.Context, work ControlTaskWork) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease lease
		SET lease_expires_at=now()+interval '30 seconds',updated_at=now()
		FROM ky_ai_executor_task task
		WHERE lease.executor_id=$1 AND lease.operation_id=$2
		  AND lease.owner_instance_id=$3 AND lease.lease_epoch=$4
		  AND lease.source_credential_revision=$5 AND lease.revocation_epoch=$6
		  AND lease.status='active' AND lease.lease_expires_at>now() AND task.id=$7
		  AND task.status IN ('waiting_executor','running')
		  AND task.operation_id=lease.operation_id AND task.lease_epoch=lease.lease_epoch
	`, work.ExecutorID, work.OperationID, work.OwnerInstanceID, work.LeaseEpoch,
		work.CredentialRevision, work.RevocationEpoch, work.TaskID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrExecutorFenced
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_runtime_worker
		SET heartbeat_at=now(),queue_enabled=false,status='online',updated_at=now()
		WHERE executor_id=$1 AND owner_instance_id=$2
	`, work.ExecutorID, work.OwnerInstanceID)
	return err
}

func (s *ControlStore) PrepareControlTaskCredentialRotation(ctx context.Context, work ControlTaskWork, bindingDigest string) (int64, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if err := lockRunningControlTask(ctx, tx, work); err != nil {
		return 0, err
	}
	if err := verifyControlTaskLease(ctx, tx, work); err != nil {
		return 0, err
	}
	var currentRevision, revocationEpoch, nextRevision int64
	err = tx.QueryRowContext(ctx, `
		UPDATE ky_ai_executor_config
		SET credential_revision_counter=GREATEST(credential_revision_counter,current_credential_revision)+1,
		    updated_at=now()
		WHERE id=$1 AND current_credential_revision=$2 AND revocation_epoch=$3
		RETURNING current_credential_revision,revocation_epoch,credential_revision_counter
	`, work.ExecutorID, work.CredentialRevision, work.RevocationEpoch).Scan(
		&currentRevision, &revocationEpoch, &nextRevision,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrExecutorFenced
	}
	if err != nil {
		return 0, err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_binding (
		  executor_id,revision,status,runtime_type,runtime_binding_id,
		  runtime_binding_revision,account_fingerprint,auth_mode,plan_type,
		  binding_digest,revocation_epoch,operation_id,lease_epoch,
		  source_credential_revision,digest_algorithm
		) VALUES ($1,$2,'prepared','server',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
		  'aicrm-credential-tree-rfc8785-nfc-v1')
	`, work.ExecutorID, nextRevision, work.RuntimeBindingID, work.RuntimeBindingRevision,
		work.AccountFingerprint, work.AuthMode, work.PlanType, bindingDigest,
		work.RevocationEpoch, work.OperationID, work.LeaseEpoch, work.CredentialRevision)
	if err != nil {
		return 0, classifyControlWrite(err)
	}
	if err := tx.Commit(); err != nil {
		return 0, classifyControlWrite(err)
	}
	return nextRevision, nil
}

func (s *ControlStore) MarkControlTaskCredentialCommitting(ctx context.Context, work ControlTaskWork, revision int64, bindingDigest string) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_binding binding
		SET status='committing'
		FROM ky_ai_executor_task task,ky_ai_executor_operation_lease lease
		WHERE binding.executor_id=$1 AND binding.revision=$2 AND binding.status='prepared'
		  AND binding.binding_digest=$3 AND binding.operation_id=$4 AND binding.lease_epoch=$5
		  AND binding.source_credential_revision=$6 AND binding.revocation_epoch=$7
		  AND task.id=$8 AND task.status='running' AND task.operation_id=$4
		  AND task.lease_epoch=$5 AND task.source_credential_revision=$6
		  AND task.revocation_epoch=$7 AND lease.executor_id=$1
		  AND lease.operation_id=$4 AND lease.owner_instance_id=$9
		  AND lease.lease_epoch=$5 AND lease.status='active' AND lease.lease_expires_at>now()
	`, work.ExecutorID, revision, bindingDigest, work.OperationID, work.LeaseEpoch,
		work.CredentialRevision, work.RevocationEpoch, work.TaskID, work.OwnerInstanceID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrExecutorFenced
	}
	return nil
}

func (s *ControlStore) CompleteControlTask(ctx context.Context, input CompleteControlTaskInput) error {
	work := input.Work
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var revision, sequence int64
	err = tx.QueryRowContext(ctx, `
		SELECT revision,current_sequence FROM ky_ai_executor_task
		WHERE id=$1 AND status='running' AND operation_id=$2 AND lease_epoch=$3
		  AND source_credential_revision=$4 AND revocation_epoch=$5 FOR UPDATE
	`, work.TaskID, work.OperationID, work.LeaseEpoch, work.CredentialRevision,
		work.RevocationEpoch).Scan(&revision, &sequence)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrExecutorFenced
	}
	if err != nil {
		return err
	}
	if err := verifyControlTaskLease(ctx, tx, work); err != nil {
		return err
	}
	var currentCredential, catalogRevision, revocationEpoch, configRevision int64
	var defaultModel sql.NullString
	err = tx.QueryRowContext(ctx, `
		SELECT COALESCE(current_credential_revision,0),catalog_revision,revocation_epoch,
		       config_revision,default_model_key
		FROM ky_ai_executor_config WHERE id=$1 FOR UPDATE
	`, work.ExecutorID).Scan(&currentCredential, &catalogRevision, &revocationEpoch, &configRevision, &defaultModel)
	if err != nil || currentCredential != work.CredentialRevision ||
		revocationEpoch != work.RevocationEpoch || configRevision != work.ExecutorConfigRevision {
		return ErrExecutorFenced
	}
	activeCredentialRevision := work.CredentialRevision
	if input.PromotedCredentialRevision != nil {
		activeCredentialRevision = *input.PromotedCredentialRevision
		var bindingStatus, digest string
		err = tx.QueryRowContext(ctx, `
			SELECT status,binding_digest FROM ky_ai_executor_credential_binding
			WHERE executor_id=$1 AND revision=$2 AND operation_id=$3 AND lease_epoch=$4
			  AND source_credential_revision=$5 AND revocation_epoch=$6 FOR UPDATE
		`, work.ExecutorID, activeCredentialRevision, work.OperationID, work.LeaseEpoch,
			work.CredentialRevision, work.RevocationEpoch).Scan(&bindingStatus, &digest)
		if err != nil || bindingStatus != "committing" || digest != input.PromotedBindingDigest {
			return ErrExecutorFenced
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_credential_binding SET status='revoked',revoked_at=now()
			WHERE executor_id=$1 AND revision=$2 AND status='active'
		`, work.ExecutorID, work.CredentialRevision); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_credential_binding SET status='active',verified_at=now(),activated_at=now()
			WHERE executor_id=$1 AND revision=$2 AND status='committing'
		`, work.ExecutorID, activeCredentialRevision)
		if err != nil {
			return err
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return ErrExecutorFenced
		}
		result, err = tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_config SET current_credential_revision=$1,updated_at=now()
			WHERE id=$2 AND current_credential_revision=$3 AND revocation_epoch=$4
		`, activeCredentialRevision, work.ExecutorID, work.CredentialRevision, work.RevocationEpoch)
		if err != nil {
			return err
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return ErrExecutorFenced
		}
	}

	resultSafe := map[string]any{}
	switch work.TaskType {
	case "credential_verify":
		if input.CredentialAuthorized == nil {
			return ErrConflict
		}
		if *input.CredentialAuthorized {
			if _, err := tx.ExecContext(ctx, `
				UPDATE ky_ai_executor_credential_binding SET verified_at=now()
				WHERE executor_id=$1 AND revision=$2 AND status='active'
			`, work.ExecutorID, activeCredentialRevision); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
				UPDATE ky_ai_executor_config SET credential_status='authorized',updated_at=now()
				WHERE id=$1 AND current_credential_revision=$2 AND revocation_epoch=$3
			`, work.ExecutorID, activeCredentialRevision, work.RevocationEpoch); err != nil {
				return err
			}
		} else {
			if _, err := tx.ExecContext(ctx, `
				UPDATE ky_ai_executor_config
				SET credential_status='expired',readiness_status='degraded',
				    readiness_reason_code='credential_expired',readiness_revision=readiness_revision+1,
				    updated_at=now()
				WHERE id=$1 AND current_credential_revision=$2 AND revocation_epoch=$3
			`, work.ExecutorID, activeCredentialRevision, work.RevocationEpoch); err != nil {
				return err
			}
		}
		resultSafe = map[string]any{"authorized": *input.CredentialAuthorized, "credentialRevision": activeCredentialRevision}
	case "model_catalog_refresh":
		newCatalogRevision := catalogRevision + 1
		for _, model := range input.Models {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO ky_ai_executor_model_catalog (
				  executor_id,catalog_revision,model_key,display_name,metadata_json,
				  account_fingerprint,last_seen_at,status,catalog_item_id,
				  input_modalities_json,supported_reasoning_json,hidden,
				  upgrade_model_key,codex_version
				) VALUES ($1,$2,$3,$4,'{}'::jsonb,$5,now(),'available',$6,$7::jsonb,$8::jsonb,$9,$10,$11)
			`, work.ExecutorID, newCatalogRevision, model.ModelKey, model.DisplayName,
				work.AccountFingerprint, model.CatalogItemID, string(model.InputModalitiesJSON),
				string(model.SupportedReasoningJSON), model.Hidden, model.UpgradeModelKey,
				input.CodexVersion); err != nil {
				return classifyControlWrite(err)
			}
		}
		readinessStatus, readinessReason, err := modelReadiness(tx, work.ExecutorID, newCatalogRevision, defaultModel)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_config
			SET catalog_revision=$1,readiness_status=$2,readiness_reason_code=$3,
			    readiness_revision=readiness_revision+1,updated_at=now()
			WHERE id=$4 AND current_credential_revision=$5 AND revocation_epoch=$6
		`, newCatalogRevision, readinessStatus, readinessReason, work.ExecutorID,
			activeCredentialRevision, work.RevocationEpoch); err != nil {
			return err
		}
		resultSafe = map[string]any{"catalogRevision": newCatalogRevision, "modelCount": len(input.Models)}
	case "readiness_check":
		if input.ReadinessStatus != "ready" && input.ReadinessStatus != "degraded" && input.ReadinessStatus != "unavailable" {
			return ErrConflict
		}
		reason := safeStoredCode(input.ReadinessReasonCode)
		if input.ReadinessStatus == "ready" {
			reason = ""
		} else if reason == "" {
			reason = "runtime_error"
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_config
			SET readiness_status=$1,readiness_reason_code=$2,
			    readiness_revision=readiness_revision+1,updated_at=now()
			WHERE id=$3 AND current_credential_revision=$4 AND revocation_epoch=$5
		`, input.ReadinessStatus, reason, work.ExecutorID, activeCredentialRevision,
			work.RevocationEpoch); err != nil {
			return err
		}
		resultSafe = map[string]any{"readinessStatus": input.ReadinessStatus, "readinessReasonCode": reason}
	default:
		return ErrConflict
	}
	encodedResult, _ := json.Marshal(resultSafe)
	meta := taskEventMeta{
		TaskID: work.TaskID, Status: "completed", WorkspaceType: work.WorkspaceType,
		WorkspaceID: work.WorkspaceID, ExecutorID: work.ExecutorID,
		OperationID: work.OperationID, LeaseEpoch: work.LeaseEpoch,
		SourceCredentialRevision: work.CredentialRevision, RevocationEpoch: work.RevocationEpoch,
	}
	if err := terminalizeControlTask(ctx, tx, meta, revision, sequence, "completed", "", encodedResult); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease SET status='released',updated_at=now()
		WHERE executor_id=$1 AND operation_id=$2 AND owner_instance_id=$3
		  AND lease_epoch=$4 AND status='active'
	`, work.ExecutorID, work.OperationID, work.OwnerInstanceID, work.LeaseEpoch)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrExecutorFenced
	}
	if err := tx.Commit(); err != nil {
		return classifyControlWrite(err)
	}
	return nil
}

func (s *ControlStore) FailControlTask(ctx context.Context, work ControlTaskWork, terminalStatus, failureCode string, credentialExpired bool) error {
	if terminalStatus != "failed" && terminalStatus != "timeout" {
		return ErrConflict
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var revision, sequence int64
	err = tx.QueryRowContext(ctx, `
		SELECT revision,current_sequence FROM ky_ai_executor_task
		WHERE id=$1 AND status IN ('waiting_executor','running')
		  AND operation_id=$2 AND lease_epoch=$3 AND source_credential_revision=$4
		  AND revocation_epoch=$5 FOR UPDATE
	`, work.TaskID, work.OperationID, work.LeaseEpoch, work.CredentialRevision,
		work.RevocationEpoch).Scan(&revision, &sequence)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrExecutorFenced
	}
	if err != nil {
		return err
	}
	if err := verifyControlTaskLease(ctx, tx, work); err != nil {
		return err
	}
	var configUpdate sql.Result
	if credentialExpired {
		configUpdate, err = tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_config SET credential_status='expired',
			  readiness_status='degraded',readiness_reason_code='credential_expired',
			  readiness_revision=readiness_revision+1,updated_at=now()
			WHERE id=$1 AND current_credential_revision=$2 AND revocation_epoch=$3
		`, work.ExecutorID, work.CredentialRevision, work.RevocationEpoch)
	} else {
		configUpdate, err = tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_config SET readiness_status='degraded',
			  readiness_reason_code='runtime_error',readiness_revision=readiness_revision+1,
			  updated_at=now()
			WHERE id=$1 AND current_credential_revision=$2 AND revocation_epoch=$3
		`, work.ExecutorID, work.CredentialRevision, work.RevocationEpoch)
	}
	if err != nil {
		return err
	}
	if affected, _ := configUpdate.RowsAffected(); affected != 1 {
		return ErrExecutorFenced
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_binding SET status='quarantined'
		WHERE executor_id=$1 AND operation_id=$2 AND lease_epoch=$3
		  AND source_credential_revision=$4 AND revocation_epoch=$5
		  AND status IN ('prepared','committing')
	`, work.ExecutorID, work.OperationID, work.LeaseEpoch, work.CredentialRevision,
		work.RevocationEpoch); err != nil {
		return err
	}
	meta := taskEventMeta{
		TaskID: work.TaskID, Status: terminalStatus, WorkspaceType: work.WorkspaceType,
		WorkspaceID: work.WorkspaceID, ExecutorID: work.ExecutorID,
		OperationID: work.OperationID, LeaseEpoch: work.LeaseEpoch,
		SourceCredentialRevision: work.CredentialRevision, RevocationEpoch: work.RevocationEpoch,
	}
	if err := terminalizeControlTask(ctx, tx, meta, revision, sequence, terminalStatus,
		safeStoredCode(failureCode), nil); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease SET status='released',updated_at=now()
		WHERE executor_id=$1 AND operation_id=$2 AND owner_instance_id=$3
		  AND lease_epoch=$4 AND status='active'
	`, work.ExecutorID, work.OperationID, work.OwnerInstanceID, work.LeaseEpoch); err != nil {
		return err
	}
	return tx.Commit()
}

func lockRunningControlTask(ctx context.Context, tx *sql.Tx, work ControlTaskWork) error {
	var exists bool
	err := tx.QueryRowContext(ctx, `
		SELECT true FROM ky_ai_executor_task
		WHERE id=$1 AND status='running' AND operation_id=$2 AND lease_epoch=$3
		  AND source_credential_revision=$4 AND revocation_epoch=$5 FOR UPDATE
	`, work.TaskID, work.OperationID, work.LeaseEpoch, work.CredentialRevision,
		work.RevocationEpoch).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrExecutorFenced
	}
	return err
}

func verifyControlTaskLease(ctx context.Context, tx *sql.Tx, work ControlTaskWork) error {
	var exists bool
	err := tx.QueryRowContext(ctx, `
		SELECT true FROM ky_ai_executor_operation_lease
		WHERE executor_id=$1 AND operation_id=$2 AND owner_instance_id=$3
		  AND lease_epoch=$4 AND source_credential_revision=$5
		  AND revocation_epoch=$6 AND status='active' AND lease_expires_at>now()
		FOR UPDATE
	`, work.ExecutorID, work.OperationID, work.OwnerInstanceID, work.LeaseEpoch,
		work.CredentialRevision, work.RevocationEpoch).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrExecutorFenced
	}
	return err
}

func terminalizeControlTask(ctx context.Context, tx *sql.Tx, meta taskEventMeta, revision, sequence int64, status, failureCode string, resultJSON []byte) error {
	if len(resultJSON) == 0 {
		resultJSON = []byte(`{}`)
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_task
		SET status=$1,revision=revision+1,current_sequence=current_sequence+3,
		    failure_code=$2,result_safe_json=$3::jsonb,completed_at=now(),updated_at=now()
		WHERE id=$4 AND revision=$5 AND status IN ('pending','waiting_executor','running')
	`, status, failureCode, string(resultJSON), meta.TaskID, revision)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrExecutorFenced
	}
	level := "success"
	if status != "completed" {
		level = "error"
	}
	changed := map[string]any{"status": status}
	if failureCode != "" {
		changed["failureCode"] = failureCode
	}
	if err := insertTaskEvent(ctx, tx, meta, sequence+1, TaskEventChanged, level, changed); err != nil {
		return err
	}
	if err := insertTaskEvent(ctx, tx, meta, sequence+2, TaskEventTerminal, level, changed); err != nil {
		return err
	}
	if err := insertTaskEvent(ctx, tx, meta, sequence+3, TaskEventClosed, "info", map[string]any{"reason": "terminal"}); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_task_request_registry
		SET materialized_status=$1,materialized_at=COALESCE(materialized_at,now()),finalized_at=now()
		WHERE task_id=$2
	`, status, meta.TaskID); err != nil {
		return err
	}
	line := "Task completed"
	if status != "completed" {
		line = "Task failed"
	}
	return insertTerminalClosure(ctx, tx, meta.TaskID, status, line)
}

func modelReadiness(tx *sql.Tx, executorID string, catalogRevision int64, defaultModel sql.NullString) (string, string, error) {
	if !defaultModel.Valid {
		return "degraded", "default_model_missing", nil
	}
	var available bool
	err := tx.QueryRow(`
		SELECT EXISTS (
		  SELECT 1 FROM ky_ai_executor_model_catalog
		  WHERE executor_id=$1 AND catalog_revision=$2 AND model_key=$3
		    AND status='available' AND NOT hidden
		    AND input_modalities_json @> '["text","image"]'::jsonb
		)
	`, executorID, catalogRevision, defaultModel.String).Scan(&available)
	if err != nil {
		return "", "", err
	}
	if !available {
		return "degraded", "model_unavailable", nil
	}
	return "ready", "", nil
}
