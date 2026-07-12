package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

var (
	ErrConflict         = errors.New("conflict")
	ErrRevisionConflict = errors.New("revision conflict")
	ErrDefaultRequired  = errors.New("default executor required")
	ErrModelUnavailable = errors.New("model unavailable")
	ErrIdempotencyReuse = errors.New("idempotency key reused")
)

type ControlStore struct {
	db *sql.DB
}

func OpenControl(ctx context.Context, databaseURL string) (*ControlStore, error) {
	if strings.TrimSpace(databaseURL) == "" {
		return nil, errors.New("KY_AGENT_EXECUTOR_WRITER_DATABASE_URL is required")
	}
	pgxConfig, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse agent executor writer database URL: %w", err)
	}
	if pgxConfig.RuntimeParams == nil {
		pgxConfig.RuntimeParams = map[string]string{}
	}
	pgxConfig.RuntimeParams["default_transaction_read_only"] = "off"
	pgxConfig.RuntimeParams["application_name"] = "ky-agent-executor-control"
	db := stdlib.OpenDB(*pgxConfig)
	db.SetMaxOpenConns(12)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(5 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping agent executor writer database: %w", err)
	}
	var readOnly string
	var writerMember bool
	var unprivileged bool
	if err := db.QueryRowContext(ctx, `
		SELECT current_setting('transaction_read_only'),
		       pg_has_role(current_user, 'ky_agent_executor_writer', 'member'),
		       NOT role.rolsuper AND NOT role.rolbypassrls
		FROM pg_roles role WHERE role.rolname=current_user
	`).Scan(&readOnly, &writerMember, &unprivileged); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("verify agent executor writer role: %w", err)
	}
	if readOnly != "off" || !writerMember || !unprivileged {
		_ = db.Close()
		return nil, errors.New("agent executor writer session is not authorized")
	}
	return &ControlStore{db: db}, nil
}

func (s *ControlStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *ControlStore) Ping(ctx context.Context) error {
	if s == nil || s.db == nil {
		return errors.New("database unavailable")
	}
	return s.db.PingContext(ctx)
}

type ExecutorControlProjection struct {
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
	CatalogRevision           int64   `json:"catalogRevision"`
	ReadinessStatus           string  `json:"readinessStatus"`
	ReadinessReasonCode       string  `json:"readinessReasonCode"`
	ReadinessRevision         int64   `json:"readinessRevision"`
	AllowScriptSave           bool    `json:"allowScriptSave"`
	AutoRepairEnabled         bool    `json:"autoRepairEnabled"`
	TriggerFailureCount       int     `json:"triggerFailureCount"`
	MaxAttempts               int     `json:"maxAttempts"`
	TaskTimeoutSeconds        int     `json:"taskTimeoutSeconds"`
	RevocationEpoch           int64   `json:"revocationEpoch"`
	ScriptMaintenanceReady    bool    `json:"scriptMaintenanceReady"`
	ReadinessObservedAt       *string `json:"readinessObservedAt"`
	CreatedAt                 string  `json:"createdAt"`
	UpdatedAt                 string  `json:"updatedAt"`
}

func (s *ControlStore) ListExecutors(ctx context.Context, workspaceType, workspaceID string) ([]ExecutorControlProjection, error) {
	rows, err := s.db.QueryContext(ctx, executorControlSelect+`
		ORDER BY config.is_default DESC, config.priority, config.created_at, config.id
	`, workspaceType, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ExecutorControlProjection{}
	for rows.Next() {
		item, err := scanExecutorControl(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *ControlStore) GetExecutor(ctx context.Context, id, workspaceType, workspaceID string) (ExecutorControlProjection, error) {
	row := s.db.QueryRowContext(ctx, executorControlSelect+` AND config.id=$3`, workspaceType, workspaceID, id)
	item, err := scanExecutorControl(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ExecutorControlProjection{}, ErrNotFound
	}
	return item, err
}

const executorControlSelect = `
	SELECT config.id, config.name, config.executor_type, config.runtime_type,
	       config.status, config.is_default, config.default_model_key,
	       config.config_revision, config.credential_status,
	       config.current_credential_revision, config.catalog_revision,
	       config.readiness_status, config.readiness_reason_code,
	       config.readiness_revision, config.allow_script_save,
	       config.auto_repair_enabled, config.trigger_failure_count,
	       config.max_attempts, config.task_timeout_seconds,
	       config.revocation_epoch,
	       (
	         config.executor_type='codex'
	         AND config.runtime_type='server'
	         AND config.status='enabled'
	         AND grant_row.status='enabled'
	         AND config.credential_status='authorized'
	         AND config.current_credential_revision IS NOT NULL
	         AND binding.status='active'
	         AND binding.revision=config.current_credential_revision
	         AND binding.runtime_binding_id=config.runtime_binding_id
	         AND binding.runtime_binding_revision=config.runtime_binding_revision
	         AND binding.revocation_epoch=config.revocation_epoch
	         AND config.readiness_status='ready'
	         AND worker.status='online'
	         AND worker.queue_enabled
	         AND worker.heartbeat_at > now() - interval '30 seconds'
	         AND worker.runtime_binding_id=config.runtime_binding_id
	         AND worker.runtime_binding_revision=config.runtime_binding_revision
	         AND config.allow_script_save
	         AND config.default_model_key IS NOT NULL
	         AND model.status='available'
	         AND NOT model.hidden
	         AND model.input_modalities_json @> '["text","image"]'::jsonb
	       ) AS script_maintenance_ready,
	       worker.heartbeat_at, config.created_at, config.updated_at
	FROM ky_ai_executor_config config
	LEFT JOIN ky_ai_executor_workspace_grant grant_row
	  ON grant_row.executor_id=config.id
	 AND grant_row.workspace_type=$1 AND grant_row.workspace_id=$2
	LEFT JOIN ky_ai_executor_credential_binding binding
	  ON binding.executor_id=config.id AND binding.status='active'
	LEFT JOIN ky_ai_executor_runtime_worker worker
	  ON worker.executor_id=config.id
	LEFT JOIN ky_ai_executor_model_catalog model
	  ON model.executor_id=config.id
	 AND model.catalog_revision=config.catalog_revision
	 AND model.model_key=config.default_model_key
	WHERE config.scope_type='platform' AND config.scope_id='platform_root'
`

type rowScanner interface{ Scan(...any) error }

func scanExecutorControl(row rowScanner) (ExecutorControlProjection, error) {
	var item ExecutorControlProjection
	var defaultModel sql.NullString
	var credentialRevision sql.NullInt64
	var observedAt sql.NullTime
	var createdAt, updatedAt time.Time
	err := row.Scan(
		&item.ID, &item.Name, &item.ExecutorType, &item.RuntimeType,
		&item.Status, &item.IsDefault, &defaultModel, &item.ConfigRevision,
		&item.CredentialStatus, &credentialRevision, &item.CatalogRevision,
		&item.ReadinessStatus, &item.ReadinessReasonCode, &item.ReadinessRevision,
		&item.AllowScriptSave, &item.AutoRepairEnabled, &item.TriggerFailureCount,
		&item.MaxAttempts, &item.TaskTimeoutSeconds, &item.RevocationEpoch,
		&item.ScriptMaintenanceReady, &observedAt, &createdAt, &updatedAt,
	)
	if err != nil {
		return ExecutorControlProjection{}, err
	}
	item.DefaultModelKey = nullableString(defaultModel)
	item.CurrentCredentialRevision = nullableInt64(credentialRevision)
	item.ReadinessObservedAt = nullableTime(observedAt)
	item.ReadinessReasonCode = safeStoredCode(item.ReadinessReasonCode)
	item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	item.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	return item, nil
}

type CreateExecutorInput struct {
	ID                  string
	Name                string
	RuntimeType         string
	Status              string
	IsDefault           bool
	AllowScriptSave     bool
	AutoRepairEnabled   bool
	TriggerFailureCount int
	MaxAttempts         int
	TaskTimeoutSeconds  int
	ActorID             string
	IdempotencyKeyHash  string
	RequestHash         string
}

func (s *ControlStore) CreateExecutor(ctx context.Context, input CreateExecutorInput, workspaceType, workspaceID string) (ExecutorControlProjection, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return ExecutorControlProjection{}, err
	}
	defer tx.Rollback()
	var existingRequestHash, existingExecutorID string
	err = tx.QueryRowContext(ctx, `
		SELECT request_hash, resource_id
		FROM ky_ai_executor_api_idempotency
		WHERE actor_id=$1 AND action='create_executor' AND scope_id='platform_root'
		  AND idempotency_key_hash=$2
	`, input.ActorID, input.IdempotencyKeyHash).Scan(&existingRequestHash, &existingExecutorID)
	if err == nil {
		if existingRequestHash != input.RequestHash {
			return ExecutorControlProjection{}, ErrIdempotencyReuse
		}
		_ = tx.Rollback()
		return s.GetExecutor(ctx, existingExecutorID, workspaceType, workspaceID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ExecutorControlProjection{}, err
	}
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('aicrm:executor-default:codex', 0))`); err != nil {
		return ExecutorControlProjection{}, err
	}
	if input.IsDefault {
		if _, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_config
			SET is_default=false, config_revision=config_revision+1, updated_at=now(), updated_by=$1
			WHERE scope_type='platform' AND scope_id='platform_root'
			  AND executor_type='codex' AND is_default
		`, input.ActorID); err != nil {
			return ExecutorControlProjection{}, err
		}
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_config (
		  id, name, scope_type, scope_id, executor_type, runtime_type, status,
		  is_default, allow_script_save, auto_repair_enabled,
		  trigger_failure_count, max_attempts, task_timeout_seconds,
		  max_concurrency, created_by, updated_by
		) VALUES ($1,$2,'platform','platform_root','codex',$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$11)
	`, input.ID, input.Name, input.RuntimeType, input.Status, input.IsDefault,
		input.AllowScriptSave, input.AutoRepairEnabled, input.TriggerFailureCount,
		input.MaxAttempts, input.TaskTimeoutSeconds, input.ActorID)
	if err != nil {
		return ExecutorControlProjection{}, classifyControlWrite(err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_workspace_grant (
		  id, executor_id, workspace_type, workspace_id, status, created_by, updated_by
		) VALUES ($1,$2,$3,$4,'enabled',$5,$5)
	`, "grant_"+input.ID+"_platform_root", input.ID, workspaceType, workspaceID, input.ActorID); err != nil {
		return ExecutorControlProjection{}, classifyControlWrite(err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_api_idempotency (
		  actor_id, action, scope_id, idempotency_key_hash, request_hash,
		  resource_type, resource_id, response_status
		) VALUES ($1,'create_executor','platform_root',$2,$3,'executor',$4,201)
	`, input.ActorID, input.IdempotencyKeyHash, input.RequestHash, input.ID); err != nil {
		return ExecutorControlProjection{}, classifyControlWrite(err)
	}
	if err := tx.Commit(); err != nil {
		return ExecutorControlProjection{}, classifyControlWrite(err)
	}
	return s.GetExecutor(ctx, input.ID, workspaceType, workspaceID)
}

type ExecutorPatch struct {
	ExpectedRevision       int64
	ActorID                string
	NameSet                bool
	Name                   string
	StatusSet              bool
	Status                 string
	IsDefaultSet           bool
	IsDefault              bool
	DefaultModelKeySet     bool
	DefaultModelKey        *string
	AllowScriptSaveSet     bool
	AllowScriptSave        bool
	AutoRepairEnabledSet   bool
	AutoRepairEnabled      bool
	TriggerFailureCountSet bool
	TriggerFailureCount    int
	MaxAttemptsSet         bool
	MaxAttempts            int
	TaskTimeoutSecondsSet  bool
	TaskTimeoutSeconds     int
}

func (s *ControlStore) PatchExecutor(ctx context.Context, id string, patch ExecutorPatch, workspaceType, workspaceID string) (ExecutorControlProjection, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return ExecutorControlProjection{}, err
	}
	defer tx.Rollback()
	var revision int64
	var currentDefault bool
	var currentStatus string
	err = tx.QueryRowContext(ctx, `
		SELECT config_revision, is_default, status
		FROM ky_ai_executor_config WHERE id=$1 FOR UPDATE
	`, id).Scan(&revision, &currentDefault, &currentStatus)
	if errors.Is(err, sql.ErrNoRows) {
		return ExecutorControlProjection{}, ErrNotFound
	}
	if err != nil {
		return ExecutorControlProjection{}, err
	}
	if revision != patch.ExpectedRevision {
		return ExecutorControlProjection{}, ErrRevisionConflict
	}
	if patch.IsDefaultSet || currentDefault {
		if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('aicrm:executor-default:codex', 0))`); err != nil {
			return ExecutorControlProjection{}, err
		}
	}
	if currentDefault && patch.IsDefaultSet && !patch.IsDefault {
		return ExecutorControlProjection{}, ErrDefaultRequired
	}
	if currentDefault && patch.StatusSet && patch.Status == "disabled" && !(patch.IsDefaultSet && !patch.IsDefault) {
		return ExecutorControlProjection{}, ErrDefaultRequired
	}
	if patch.IsDefaultSet && patch.IsDefault {
		targetStatus := currentStatus
		if patch.StatusSet {
			targetStatus = patch.Status
		}
		if targetStatus != "enabled" {
			return ExecutorControlProjection{}, ErrDefaultRequired
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_config
			SET is_default=false, config_revision=config_revision+1, updated_at=now(), updated_by=$1
			WHERE scope_type='platform' AND scope_id='platform_root'
			  AND executor_type='codex' AND is_default AND id<>$2
		`, patch.ActorID, id); err != nil {
			return ExecutorControlProjection{}, err
		}
	}
	if patch.DefaultModelKeySet && patch.DefaultModelKey != nil {
		var available bool
		err := tx.QueryRowContext(ctx, `
			SELECT EXISTS (
			  SELECT 1 FROM ky_ai_executor_config config
			  JOIN ky_ai_executor_model_catalog model
			    ON model.executor_id=config.id AND model.catalog_revision=config.catalog_revision
			  WHERE config.id=$1 AND model.model_key=$2 AND model.status='available'
			    AND NOT model.hidden AND model.input_modalities_json @> '["text","image"]'::jsonb
			)
		`, id, *patch.DefaultModelKey).Scan(&available)
		if err != nil {
			return ExecutorControlProjection{}, err
		}
		if !available {
			return ExecutorControlProjection{}, ErrModelUnavailable
		}
	}
	sets := []string{"config_revision=config_revision+1", "updated_at=now()", "updated_by=$1"}
	args := []any{patch.ActorID}
	add := func(expression string, value any) {
		args = append(args, value)
		sets = append(sets, fmt.Sprintf(expression, len(args)))
	}
	if patch.NameSet {
		add("name=$%d", patch.Name)
	}
	if patch.StatusSet {
		add("status=$%d", patch.Status)
	}
	if patch.IsDefaultSet {
		add("is_default=$%d", patch.IsDefault)
	}
	if patch.DefaultModelKeySet {
		add("default_model_key=$%d", patch.DefaultModelKey)
	}
	if patch.AllowScriptSaveSet {
		add("allow_script_save=$%d", patch.AllowScriptSave)
	}
	if patch.AutoRepairEnabledSet {
		add("auto_repair_enabled=$%d", patch.AutoRepairEnabled)
	}
	if patch.TriggerFailureCountSet {
		add("trigger_failure_count=$%d", patch.TriggerFailureCount)
	}
	if patch.MaxAttemptsSet {
		add("max_attempts=$%d", patch.MaxAttempts)
	}
	if patch.TaskTimeoutSecondsSet {
		add("task_timeout_seconds=$%d", patch.TaskTimeoutSeconds)
	}
	args = append(args, id, patch.ExpectedRevision)
	query := fmt.Sprintf(`UPDATE ky_ai_executor_config SET %s WHERE id=$%d AND config_revision=$%d`,
		strings.Join(sets, ","), len(args)-1, len(args))
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return ExecutorControlProjection{}, classifyControlWrite(err)
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		return ExecutorControlProjection{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return ExecutorControlProjection{}, classifyControlWrite(err)
	}
	return s.GetExecutor(ctx, id, workspaceType, workspaceID)
}

type ModelProjection struct {
	CatalogItemID      string          `json:"catalogItemId"`
	ModelKey           string          `json:"modelKey"`
	DisplayName        string          `json:"displayName"`
	InputModalities    json.RawMessage `json:"inputModalities"`
	SupportedReasoning json.RawMessage `json:"supportedReasoningEfforts"`
	Hidden             bool            `json:"hidden"`
	UpgradeModelKey    string          `json:"upgradeModelKey,omitempty"`
	Status             string          `json:"status"`
	CatalogRevision    int64           `json:"catalogRevision"`
	CodexVersion       string          `json:"codexVersion"`
	LastSeenAt         string          `json:"lastSeenAt"`
}

func (s *ControlStore) ListModels(ctx context.Context, executorID string, includeHidden bool) ([]ModelProjection, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT model.catalog_item_id, model.model_key, model.display_name,
		       model.input_modalities_json, model.supported_reasoning_json,
		       model.hidden, model.upgrade_model_key, model.status,
		       model.catalog_revision, model.codex_version, model.last_seen_at
		FROM ky_ai_executor_config config
		JOIN ky_ai_executor_model_catalog model
		  ON model.executor_id=config.id AND model.catalog_revision=config.catalog_revision
		WHERE config.id=$1 AND ($2 OR NOT model.hidden)
		ORDER BY model.hidden, model.display_name, model.model_key
	`, executorID, includeHidden)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ModelProjection{}
	for rows.Next() {
		var item ModelProjection
		var modalities, reasoning []byte
		var seenAt time.Time
		if err := rows.Scan(&item.CatalogItemID, &item.ModelKey, &item.DisplayName,
			&modalities, &reasoning, &item.Hidden, &item.UpgradeModelKey,
			&item.Status, &item.CatalogRevision, &item.CodexVersion, &seenAt); err != nil {
			return nil, err
		}
		item.InputModalities = append(json.RawMessage(nil), modalities...)
		item.SupportedReasoning = append(json.RawMessage(nil), reasoning...)
		item.LastSeenAt = seenAt.UTC().Format(time.RFC3339Nano)
		items = append(items, item)
	}
	return items, rows.Err()
}

type WorkspaceGrantProjection struct {
	ID            string `json:"id"`
	ExecutorID    string `json:"executorId"`
	WorkspaceType string `json:"workspaceType"`
	WorkspaceID   string `json:"workspaceId"`
	Status        string `json:"status"`
	Revision      int64  `json:"revision"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
}

func (s *ControlStore) ListWorkspaceGrants(ctx context.Context, executorID string) ([]WorkspaceGrantProjection, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, executor_id, workspace_type, workspace_id, status, revision, created_at, updated_at
		FROM ky_ai_executor_workspace_grant WHERE executor_id=$1
		ORDER BY workspace_type, workspace_id
	`, executorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []WorkspaceGrantProjection{}
	for rows.Next() {
		var item WorkspaceGrantProjection
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&item.ID, &item.ExecutorID, &item.WorkspaceType, &item.WorkspaceID,
			&item.Status, &item.Revision, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		item.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *ControlStore) PutWorkspaceGrant(ctx context.Context, id, executorID, workspaceType, workspaceID, actorID string, expectedRevision int64) (WorkspaceGrantProjection, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return WorkspaceGrantProjection{}, err
	}
	defer tx.Rollback()
	var current int64
	err = tx.QueryRowContext(ctx, `
		SELECT revision FROM ky_ai_executor_workspace_grant
		WHERE executor_id=$1 AND workspace_type=$2 AND workspace_id=$3 FOR UPDATE
	`, executorID, workspaceType, workspaceID).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		if expectedRevision != 0 {
			return WorkspaceGrantProjection{}, ErrRevisionConflict
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_workspace_grant
			(id,executor_id,workspace_type,workspace_id,status,revision,created_by,updated_by)
			VALUES ($1,$2,$3,$4,'enabled',1,$5,$5)
		`, id, executorID, workspaceType, workspaceID, actorID)
	} else if err == nil {
		if current != expectedRevision {
			return WorkspaceGrantProjection{}, ErrRevisionConflict
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_workspace_grant
			SET status='enabled', revision=revision+1, updated_by=$1, updated_at=now()
			WHERE executor_id=$2 AND workspace_type=$3 AND workspace_id=$4 AND revision=$5
		`, actorID, executorID, workspaceType, workspaceID, expectedRevision)
	}
	if err != nil {
		return WorkspaceGrantProjection{}, classifyControlWrite(err)
	}
	if err := tx.Commit(); err != nil {
		return WorkspaceGrantProjection{}, classifyControlWrite(err)
	}
	return s.getWorkspaceGrant(ctx, executorID, workspaceType, workspaceID)
}

func (s *ControlStore) DeleteWorkspaceGrant(ctx context.Context, executorID, workspaceType, workspaceID, actorID string, expectedRevision int64) (WorkspaceGrantProjection, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_workspace_grant
		SET status='disabled', revision=revision+1, updated_by=$1, updated_at=now()
		WHERE executor_id=$2 AND workspace_type=$3 AND workspace_id=$4
		  AND revision=$5 AND status<>'disabled'
	`, actorID, executorID, workspaceType, workspaceID, expectedRevision)
	if err != nil {
		return WorkspaceGrantProjection{}, classifyControlWrite(err)
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		current, getErr := s.getWorkspaceGrant(ctx, executorID, workspaceType, workspaceID)
		if errors.Is(getErr, ErrNotFound) {
			return WorkspaceGrantProjection{}, ErrNotFound
		}
		if getErr != nil {
			return WorkspaceGrantProjection{}, getErr
		}
		if current.Status == "disabled" {
			return current, nil
		}
		return WorkspaceGrantProjection{}, ErrRevisionConflict
	}
	return s.getWorkspaceGrant(ctx, executorID, workspaceType, workspaceID)
}

func (s *ControlStore) getWorkspaceGrant(ctx context.Context, executorID, workspaceType, workspaceID string) (WorkspaceGrantProjection, error) {
	var item WorkspaceGrantProjection
	var createdAt, updatedAt time.Time
	err := s.db.QueryRowContext(ctx, `
		SELECT id, executor_id, workspace_type, workspace_id, status, revision, created_at, updated_at
		FROM ky_ai_executor_workspace_grant
		WHERE executor_id=$1 AND workspace_type=$2 AND workspace_id=$3
	`, executorID, workspaceType, workspaceID).Scan(&item.ID, &item.ExecutorID, &item.WorkspaceType,
		&item.WorkspaceID, &item.Status, &item.Revision, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceGrantProjection{}, ErrNotFound
	}
	if err != nil {
		return WorkspaceGrantProjection{}, err
	}
	item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	item.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	return item, nil
}

func classifyControlWrite(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	if strings.Contains(message, "23505") || strings.Contains(message, "duplicate key") ||
		strings.Contains(message, "40001") || strings.Contains(message, "could not serialize") {
		return ErrConflict
	}
	return err
}

func safeStoredCode(value string) string {
	if value == "" {
		return ""
	}
	for i, char := range value {
		if (char >= 'a' && char <= 'z') || (i > 0 && char >= '0' && char <= '9') || (i > 0 && char == '_') {
			continue
		}
		return "unsafe_code_redacted"
	}
	if len(value) > 128 {
		return "unsafe_code_redacted"
	}
	return value
}
