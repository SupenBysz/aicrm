package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

var ErrNotFound = errors.New("not found")

type Reader interface {
	Ping(context.Context) error
	Executor(context.Context, string) (ExecutorProjection, error)
	Task(context.Context, string) (TaskProjection, error)
	TaskResult(context.Context, string) (TaskResultProjection, error)
}

type Store struct {
	db *sql.DB
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	if databaseURL == "" {
		return nil, errors.New("KY_AGENT_EXECUTOR_DATABASE_URL is required")
	}
	pgxConfig, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse agent executor database URL: %w", err)
	}
	if pgxConfig.RuntimeParams == nil {
		pgxConfig.RuntimeParams = map[string]string{}
	}
	// Every pooled connection is server-enforced read-only.  The production
	// LOGIN must additionally be a member of ky_agent_executor_reader only.
	pgxConfig.RuntimeParams["default_transaction_read_only"] = "on"
	pgxConfig.RuntimeParams["application_name"] = "ky-agent-executor-shadow"

	db := stdlib.OpenDB(*pgxConfig)
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(5 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping agent executor reader database: %w", err)
	}
	var readOnly string
	if err := db.QueryRowContext(ctx, "SELECT current_setting('transaction_read_only')").Scan(&readOnly); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("verify read-only database session: %w", err)
	}
	if readOnly != "on" {
		_ = db.Close()
		return nil, errors.New("agent executor database session is not read-only")
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Ping(ctx context.Context) error {
	if s == nil || s.db == nil {
		return errors.New("database unavailable")
	}
	return s.db.PingContext(ctx)
}

type ExecutorProjection struct {
	ID                        string  `json:"id"`
	Name                      string  `json:"name"`
	ExecutorType              string  `json:"executorType"`
	RuntimeType               string  `json:"runtimeType"`
	Status                    string  `json:"status"`
	IsDefault                 bool    `json:"isDefault"`
	DefaultModelKey           *string `json:"defaultModelKey"`
	ConfigRevision            int64   `json:"configRevision"`
	CredentialStatus          string  `json:"credentialStatus"`
	CurrentCredentialRevision *int64  `json:"currentCredentialRevision"`
	ReadinessStatus           string  `json:"readinessStatus"`
	ReadinessReasonCode       string  `json:"readinessReasonCode"`
	RevocationEpoch           int64   `json:"revocationEpoch"`
	UpdatedAt                 string  `json:"updatedAt"`
	ScriptMaintenanceReady    bool    `json:"scriptMaintenanceReady"`
	WriteEnabled              bool    `json:"writeEnabled"`
}

func (s *Store) Executor(ctx context.Context, id string) (ExecutorProjection, error) {
	var projection ExecutorProjection
	var defaultModel sql.NullString
	var credentialRevision sql.NullInt64
	var updatedAt time.Time
	err := s.db.QueryRowContext(ctx, `
		SELECT id, name, executor_type, runtime_type, status, is_default,
		       default_model_key, config_revision, credential_status,
		       current_credential_revision, readiness_status,
		       readiness_reason_code, revocation_epoch, updated_at
		FROM ky_ai_executor_config
		WHERE id = $1
	`, id).Scan(
		&projection.ID,
		&projection.Name,
		&projection.ExecutorType,
		&projection.RuntimeType,
		&projection.Status,
		&projection.IsDefault,
		&defaultModel,
		&projection.ConfigRevision,
		&projection.CredentialStatus,
		&credentialRevision,
		&projection.ReadinessStatus,
		&projection.ReadinessReasonCode,
		&projection.RevocationEpoch,
		&updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ExecutorProjection{}, ErrNotFound
	}
	if err != nil {
		return ExecutorProjection{}, err
	}
	projection.DefaultModelKey = nullableString(defaultModel)
	projection.CurrentCredentialRevision = nullableInt64(credentialRevision)
	projection.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	// P1 is never eligible, regardless of legacy columns or observed values.
	projection.ScriptMaintenanceReady = false
	projection.WriteEnabled = false
	return projection, nil
}

type TaskProjection struct {
	ID                        string  `json:"id"`
	WorkspaceType             string  `json:"workspaceType"`
	WorkspaceID               string  `json:"workspaceId"`
	TaskType                  string  `json:"taskType"`
	ScriptPurpose             string  `json:"scriptPurpose"`
	Status                    string  `json:"status"`
	WebSpaceID                string  `json:"webSpaceId"`
	ScriptID                  string  `json:"scriptId"`
	ScriptVersionID           string  `json:"scriptVersionId"`
	ContractID                string  `json:"contractId"`
	ContractRevision          *int64  `json:"contractRevision"`
	EffectiveExecutorID       string  `json:"effectiveExecutorId"`
	EffectiveModelKey         string  `json:"effectiveModelKey"`
	ExecutorSource            string  `json:"executorSource"`
	ModelSource               string  `json:"modelSource"`
	ExecutorConfigRevision    *int64  `json:"executorConfigRevision"`
	CredentialBindingRevision *int64  `json:"credentialBindingRevision"`
	RuntimeBindingID          string  `json:"runtimeBindingId"`
	RuntimeBindingRevision    *int64  `json:"runtimeBindingRevision"`
	ModelCatalogRevision      *int64  `json:"modelCatalogRevision"`
	GenerationEngine          string  `json:"generationEngine"`
	OperationID               string  `json:"operationId"`
	LeaseEpoch                int64   `json:"leaseEpoch"`
	SourceCredentialRevision  int64   `json:"sourceCredentialRevision"`
	RevocationEpoch           int64   `json:"revocationEpoch"`
	Revision                  int64   `json:"revision"`
	CurrentSequence           int64   `json:"currentSequence"`
	FailureCode               string  `json:"failureCode"`
	StartedAt                 *string `json:"startedAt"`
	CompletedAt               *string `json:"completedAt"`
	CreatedAt                 string  `json:"createdAt"`
	UpdatedAt                 string  `json:"updatedAt"`
}

func (s *Store) Task(ctx context.Context, id string) (TaskProjection, error) {
	var projection TaskProjection
	var contractRevision, executorConfigRevision, credentialBindingRevision sql.NullInt64
	var runtimeBindingRevision, modelCatalogRevision sql.NullInt64
	var startedAt, completedAt sql.NullTime
	var createdAt, updatedAt time.Time
	err := s.db.QueryRowContext(ctx, `
		SELECT id, workspace_type, workspace_id, task_type, purpose, status,
		       web_space_id, script_id, script_version_id,
		       contract_id, contract_revision,
		       effective_executor_id, effective_model_key,
		       executor_source, model_source,
		       executor_config_revision, credential_binding_revision,
		       runtime_binding_id, runtime_binding_revision,
		       model_catalog_revision, generation_engine,
		       operation_id, lease_epoch, source_credential_revision,
		       revocation_epoch, revision, current_sequence, failure_code,
		       started_at, completed_at, created_at, updated_at
		FROM ky_ai_executor_task
		WHERE id = $1
	`, id).Scan(
		&projection.ID,
		&projection.WorkspaceType,
		&projection.WorkspaceID,
		&projection.TaskType,
		&projection.ScriptPurpose,
		&projection.Status,
		&projection.WebSpaceID,
		&projection.ScriptID,
		&projection.ScriptVersionID,
		&projection.ContractID,
		&contractRevision,
		&projection.EffectiveExecutorID,
		&projection.EffectiveModelKey,
		&projection.ExecutorSource,
		&projection.ModelSource,
		&executorConfigRevision,
		&credentialBindingRevision,
		&projection.RuntimeBindingID,
		&runtimeBindingRevision,
		&modelCatalogRevision,
		&projection.GenerationEngine,
		&projection.OperationID,
		&projection.LeaseEpoch,
		&projection.SourceCredentialRevision,
		&projection.RevocationEpoch,
		&projection.Revision,
		&projection.CurrentSequence,
		&projection.FailureCode,
		&startedAt,
		&completedAt,
		&createdAt,
		&updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskProjection{}, ErrNotFound
	}
	if err != nil {
		return TaskProjection{}, err
	}
	projection.ContractRevision = nullableInt64(contractRevision)
	projection.ExecutorConfigRevision = nullableInt64(executorConfigRevision)
	projection.CredentialBindingRevision = nullableInt64(credentialBindingRevision)
	projection.RuntimeBindingRevision = nullableInt64(runtimeBindingRevision)
	projection.ModelCatalogRevision = nullableInt64(modelCatalogRevision)
	projection.StartedAt = nullableTime(startedAt)
	projection.CompletedAt = nullableTime(completedAt)
	projection.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	projection.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	return projection, nil
}

type TaskResultProjection struct {
	TaskID                    string          `json:"taskId"`
	Status                    string          `json:"status"`
	Revision                  int64           `json:"revision"`
	FailureCode               string          `json:"failureCode"`
	SafeResult                json.RawMessage `json:"safeResult"`
	EffectiveExecutorID       string          `json:"effectiveExecutorId"`
	EffectiveModelKey         string          `json:"effectiveModelKey"`
	CredentialBindingRevision *int64          `json:"credentialBindingRevision"`
	RuntimeBindingRevision    *int64          `json:"runtimeBindingRevision"`
	ModelCatalogRevision      *int64          `json:"modelCatalogRevision"`
	GenerationEngine          string          `json:"generationEngine"`
}

func (s *Store) TaskResult(ctx context.Context, id string) (TaskResultProjection, error) {
	var projection TaskResultProjection
	var rawResult []byte
	var credentialBindingRevision, runtimeBindingRevision, modelCatalogRevision sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, status, revision, failure_code, result_safe_json,
		       effective_executor_id, effective_model_key,
		       credential_binding_revision, runtime_binding_revision,
		       model_catalog_revision, generation_engine
		FROM ky_ai_executor_task
		WHERE id = $1
	`, id).Scan(
		&projection.TaskID,
		&projection.Status,
		&projection.Revision,
		&projection.FailureCode,
		&rawResult,
		&projection.EffectiveExecutorID,
		&projection.EffectiveModelKey,
		&credentialBindingRevision,
		&runtimeBindingRevision,
		&modelCatalogRevision,
		&projection.GenerationEngine,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskResultProjection{}, ErrNotFound
	}
	if err != nil {
		return TaskResultProjection{}, err
	}
	projection.CredentialBindingRevision = nullableInt64(credentialBindingRevision)
	projection.RuntimeBindingRevision = nullableInt64(runtimeBindingRevision)
	projection.ModelCatalogRevision = nullableInt64(modelCatalogRevision)
	if len(rawResult) == 0 || !json.Valid(rawResult) {
		rawResult = []byte("{}")
	}
	projection.SafeResult = append(json.RawMessage(nil), rawResult...)
	return projection, nil
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func nullableInt64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func nullableTime(value sql.NullTime) *string {
	if !value.Valid {
		return nil
	}
	formatted := value.Time.UTC().Format(time.RFC3339Nano)
	return &formatted
}
