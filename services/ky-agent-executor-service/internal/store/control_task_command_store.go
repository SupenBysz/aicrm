package store

import (
	"context"
	"database/sql"
	"errors"
)

var (
	ErrExecutorRuntimeUnsupported = errors.New("executor runtime unsupported")
	ErrExecutorDisabled           = errors.New("executor disabled")
	ErrCredentialUnavailable      = errors.New("executor credential unavailable")
)

type CreateControlTaskInput struct {
	ID                         string
	ExecutorID                 string
	TaskType                   string
	ActorID                    string
	WorkspaceType              string
	WorkspaceID                string
	ExpectedExecutorRevision   int64
	ExpectedCredentialRevision *int64
	ExpectedCatalogRevision    *int64
	IdempotencyKeyHash         string
	RequestHash                string
}

type CreateControlTaskResult struct {
	Task    PublicTaskProjection
	Created bool
}

type controlTaskBinding struct {
	ExecutorID             string
	RuntimeType            string
	ExecutorStatus         string
	ConfigRevision         int64
	CredentialStatus       string
	CredentialRevision     int64
	CatalogRevision        int64
	RuntimeBindingID       string
	RuntimeBindingRevision int64
	RevocationEpoch        int64
	DefaultModelKey        string
	BindingStatus          string
	BindingFingerprint     string
	BindingDigest          string
}

func (s *ControlStore) CreateControlTask(ctx context.Context, input CreateControlTaskInput) (CreateControlTaskResult, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return CreateControlTaskResult{}, err
	}
	defer tx.Rollback()
	action := controlTaskAction(input.TaskType)
	if action == "" {
		return CreateControlTaskResult{}, ErrConflict
	}
	var existingHash, existingTaskID string
	err = tx.QueryRowContext(ctx, `
		SELECT request_hash,resource_id FROM ky_ai_executor_api_idempotency
		WHERE actor_id=$1 AND action=$2 AND scope_id=$3 AND idempotency_key_hash=$4
	`, input.ActorID, action, input.ExecutorID, input.IdempotencyKeyHash).Scan(&existingHash, &existingTaskID)
	if err == nil {
		if existingHash != input.RequestHash {
			return CreateControlTaskResult{}, ErrIdempotencyReuse
		}
		item, err := scanPublicTask(tx.QueryRowContext(ctx, publicTaskSelect+`
			WHERE task.id=$1 AND task.workspace_type=$2 AND task.workspace_id=$3
		`, existingTaskID, input.WorkspaceType, input.WorkspaceID))
		return CreateControlTaskResult{Task: item}, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return CreateControlTaskResult{}, err
	}

	binding, err := loadControlTaskBinding(ctx, tx, input.ExecutorID)
	if err != nil {
		return CreateControlTaskResult{}, err
	}
	if binding.RuntimeType != "server" {
		return CreateControlTaskResult{}, ErrExecutorRuntimeUnsupported
	}
	if binding.ExecutorStatus != "enabled" {
		return CreateControlTaskResult{}, ErrExecutorDisabled
	}
	if binding.ConfigRevision != input.ExpectedExecutorRevision {
		return CreateControlTaskResult{}, ErrRevisionConflict
	}
	if input.ExpectedCredentialRevision != nil && binding.CredentialRevision != *input.ExpectedCredentialRevision {
		return CreateControlTaskResult{}, ErrRevisionConflict
	}
	if input.ExpectedCatalogRevision != nil && binding.CatalogRevision != *input.ExpectedCatalogRevision {
		return CreateControlTaskResult{}, ErrRevisionConflict
	}
	credentialAllowed := binding.CredentialStatus == "authorized"
	if input.TaskType == "credential_verify" {
		credentialAllowed = binding.CredentialStatus == "authorized" || binding.CredentialStatus == "expired"
	}
	if !credentialAllowed || binding.CredentialRevision < 1 || binding.BindingStatus != "active" ||
		binding.RuntimeBindingID == "" || binding.RuntimeBindingRevision < 1 ||
		binding.BindingFingerprint == "" || binding.BindingDigest == "" {
		return CreateControlTaskResult{}, ErrCredentialUnavailable
	}

	var activeTaskID string
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM ky_ai_executor_task
		WHERE task_type=$1 AND status IN ('pending','waiting_executor','running')
		  AND COALESCE(NULLIF(effective_executor_id,''),executor_id)=$2
		  AND executor_config_revision=$3 AND credential_binding_revision=$4
		  AND COALESCE(model_catalog_revision,0)=$5 AND revocation_epoch=$6
		ORDER BY created_at,id LIMIT 1 FOR UPDATE
	`, input.TaskType, input.ExecutorID, binding.ConfigRevision, binding.CredentialRevision,
		binding.CatalogRevision, binding.RevocationEpoch).Scan(&activeTaskID)
	if err == nil {
		if err := insertTaskAPIIdempotency(ctx, tx, input, action, activeTaskID); err != nil {
			return CreateControlTaskResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return CreateControlTaskResult{}, classifyControlWrite(err)
		}
		item, err := s.GetPublicTask(ctx, activeTaskID, input.WorkspaceType, input.WorkspaceID)
		return CreateControlTaskResult{Task: item}, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return CreateControlTaskResult{}, err
	}

	var catalogRevision any
	if binding.CatalogRevision > 0 {
		catalogRevision = binding.CatalogRevision
	}
	operationID := "control_" + input.ID
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task (
		  id,workspace_type,workspace_id,executor_id,executor_type,task_type,
		  status,effective_executor_id,effective_model_key,
		  executor_config_revision,credential_binding_revision,
		  runtime_binding_id,runtime_binding_revision,model_catalog_revision,
		  generation_engine,operation_id,source_credential_revision,
		  revocation_epoch,revision,current_sequence,request_hash,created_by
		) VALUES ($1,$2,$3,$4,'codex',$5,'pending',$4,$6,$7,$8,$9,$10,$11,
		  '',$12,$8,$13,1,1,$14,$15)
	`, input.ID, input.WorkspaceType, input.WorkspaceID, input.ExecutorID,
		input.TaskType, binding.DefaultModelKey, binding.ConfigRevision,
		binding.CredentialRevision, binding.RuntimeBindingID, binding.RuntimeBindingRevision,
		catalogRevision, operationID, binding.RevocationEpoch, input.RequestHash, input.ActorID)
	if err != nil {
		return CreateControlTaskResult{}, classifyControlWrite(err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task_request_registry
		(task_id,request_hash,materialized_status,materialized_at)
		VALUES ($1,$2,'pending',now())
	`, input.ID, input.RequestHash); err != nil {
		return CreateControlTaskResult{}, classifyControlWrite(err)
	}
	meta := taskEventMeta{
		TaskID: input.ID, Status: "pending", WorkspaceType: input.WorkspaceType,
		WorkspaceID: input.WorkspaceID, ExecutorID: input.ExecutorID,
		OperationID: operationID, SourceCredentialRevision: binding.CredentialRevision,
		RevocationEpoch: binding.RevocationEpoch,
	}
	if err := insertTaskEvent(ctx, tx, meta, 1, TaskEventChanged, "info", map[string]any{
		"status": "pending", "taskType": input.TaskType,
	}); err != nil {
		return CreateControlTaskResult{}, err
	}
	if err := insertTaskAPIIdempotency(ctx, tx, input, action, input.ID); err != nil {
		return CreateControlTaskResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return CreateControlTaskResult{}, classifyControlWrite(err)
	}
	item, err := s.GetPublicTask(ctx, input.ID, input.WorkspaceType, input.WorkspaceID)
	return CreateControlTaskResult{Task: item, Created: true}, err
}

func loadControlTaskBinding(ctx context.Context, tx *sql.Tx, executorID string) (controlTaskBinding, error) {
	var item controlTaskBinding
	var credentialRevision sql.NullInt64
	var defaultModel sql.NullString
	err := tx.QueryRowContext(ctx, `
		SELECT config.id,config.runtime_type,config.status,config.config_revision,
		       config.credential_status,config.current_credential_revision,
		       config.catalog_revision,config.runtime_binding_id,
		       config.runtime_binding_revision,config.revocation_epoch,
		       config.default_model_key,COALESCE(binding.status,''),
		       COALESCE(binding.account_fingerprint,''),COALESCE(binding.binding_digest,'')
		FROM ky_ai_executor_config config
		LEFT JOIN ky_ai_executor_credential_binding binding
		  ON binding.executor_id=config.id
		 AND binding.revision=config.current_credential_revision
		 AND binding.revocation_epoch=config.revocation_epoch
		WHERE config.id=$1 FOR UPDATE OF config
	`, executorID).Scan(
		&item.ExecutorID, &item.RuntimeType, &item.ExecutorStatus, &item.ConfigRevision,
		&item.CredentialStatus, &credentialRevision, &item.CatalogRevision,
		&item.RuntimeBindingID, &item.RuntimeBindingRevision, &item.RevocationEpoch,
		&defaultModel, &item.BindingStatus, &item.BindingFingerprint, &item.BindingDigest,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return controlTaskBinding{}, ErrNotFound
	}
	if err != nil {
		return controlTaskBinding{}, err
	}
	if credentialRevision.Valid {
		item.CredentialRevision = credentialRevision.Int64
	}
	if defaultModel.Valid {
		item.DefaultModelKey = defaultModel.String
	}
	return item, nil
}

func insertTaskAPIIdempotency(ctx context.Context, tx *sql.Tx, input CreateControlTaskInput, action, taskID string) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_api_idempotency (
		  actor_id,action,scope_id,idempotency_key_hash,request_hash,
		  resource_type,resource_id,response_status
		) VALUES ($1,$2,$3,$4,$5,'executor_task',$6,202)
	`, input.ActorID, action, input.ExecutorID, input.IdempotencyKeyHash, input.RequestHash, taskID)
	return classifyControlWrite(err)
}

func controlTaskAction(taskType string) string {
	switch taskType {
	case "model_catalog_refresh":
		return "refresh_model_catalog"
	case "readiness_check":
		return "check_readiness"
	case "credential_verify":
		return "verify_credential"
	default:
		return ""
	}
}
