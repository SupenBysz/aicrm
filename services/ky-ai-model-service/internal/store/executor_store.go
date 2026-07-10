package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const executorConfigColumns = `
	id, name, scope_type, scope_id, executor_type, runtime_type, status, is_default, priority,
	auto_repair_enabled, trigger_failure_count, max_attempts, task_timeout_seconds, max_concurrency,
	allow_page_actions, allow_storage_read, allow_cdp_runtime, allow_script_save, allow_auto_activate,
	app_server_listen, auth_status, auth_method, auth_account_label, bound_device_id, codex_version,
	capabilities, last_heartbeat_at, last_auth_checked_at, remark, created_by, created_at, updated_at`

const executorTaskColumns = `
	id, workspace_type, workspace_id, executor_id, executor_type, task_type, purpose, trigger_reason,
	target_type, target_id, web_space_id, script_id, script_version_id, status,
	codex_thread_id, result_summary, error_message, created_by, started_at,
	completed_at, created_at, updated_at`

const ExecutorStreamNotifyChannel = "ky_ai_executor_stream_changed"

func scanExecutorConfig(row interface{ Scan(...any) error }) (ExecutorConfig, error) {
	var item ExecutorConfig
	var capabilities []byte
	var createdBy sql.NullString
	err := row.Scan(
		&item.ID,
		&item.Name,
		&item.ScopeType,
		&item.ScopeID,
		&item.ExecutorType,
		&item.RuntimeType,
		&item.Status,
		&item.IsDefault,
		&item.Priority,
		&item.AutoRepairEnabled,
		&item.TriggerFailureCount,
		&item.MaxAttempts,
		&item.TaskTimeoutSeconds,
		&item.MaxConcurrency,
		&item.AllowPageActions,
		&item.AllowStorageRead,
		&item.AllowCDPRuntime,
		&item.AllowScriptSave,
		&item.AllowAutoActivate,
		&item.AppServerListen,
		&item.AuthStatus,
		&item.AuthMethod,
		&item.AuthAccountLabel,
		&item.BoundDeviceID,
		&item.CodexVersion,
		&capabilities,
		&item.LastHeartbeatAt,
		&item.LastAuthCheckedAt,
		&item.Remark,
		&createdBy,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	if err != nil {
		return ExecutorConfig{}, err
	}
	if len(capabilities) == 0 {
		capabilities = []byte("{}")
	}
	item.Capabilities = capabilities
	if createdBy.Valid {
		item.CreatedBy = createdBy.String
	}
	return item, nil
}

func scanExecutorTask(row interface{ Scan(...any) error }) (ExecutorTask, error) {
	var item ExecutorTask
	var summary []byte
	err := row.Scan(
		&item.ID,
		&item.WorkspaceType,
		&item.WorkspaceID,
		&item.ExecutorID,
		&item.ExecutorType,
		&item.TaskType,
		&item.Purpose,
		&item.TriggerReason,
		&item.TargetType,
		&item.TargetID,
		&item.WebSpaceID,
		&item.ScriptID,
		&item.ScriptVersionID,
		&item.Status,
		&item.CodexThreadID,
		&summary,
		&item.ErrorMessage,
		&item.CreatedBy,
		&item.StartedAt,
		&item.CompletedAt,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	if err != nil {
		return ExecutorTask{}, err
	}
	if len(summary) == 0 {
		summary = []byte("{}")
	}
	item.ResultSummary = summary
	return item, nil
}

func (s *Store) ListExecutorConfigs(ctx context.Context, status, runtimeType, executorType string, page, pageSize int) ([]ExecutorConfig, int64, error) {
	where := []string{"scope_type=$1", "scope_id=$2"}
	args := []any{platformScopeType, platformScopeID}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }
	if status != "" {
		where = append(where, "status="+add(status))
	}
	if runtimeType != "" {
		where = append(where, "runtime_type="+add(runtimeType))
	}
	if executorType != "" {
		where = append(where, "executor_type="+add(executorType))
	}
	clause := strings.Join(where, " AND ")
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_ai_executor_config WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+executorConfigColumns+`
		FROM ky_ai_executor_config
		WHERE `+clause+`
		ORDER BY is_default DESC, priority ASC, created_at DESC
		LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []ExecutorConfig{}
	for rows.Next() {
		item, err := scanExecutorConfig(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}

func (s *Store) GetExecutorConfig(ctx context.Context, executorType string) (ExecutorConfig, error) {
	executorType = strings.TrimSpace(executorType)
	if executorType == "" {
		executorType = "codex"
	}
	item, err := scanExecutorConfig(s.db.QueryRowContext(ctx, `
		SELECT `+executorConfigColumns+`
		FROM ky_ai_executor_config
		WHERE scope_type=$1 AND scope_id=$2 AND executor_type=$3
		ORDER BY is_default DESC, priority ASC, created_at ASC
		LIMIT 1
	`, platformScopeType, platformScopeID, executorType))
	if errors.Is(err, sql.ErrNoRows) && executorType == "codex" {
		return s.CreateExecutorConfig(ctx, ExecutorConfigInput{
			Name:                "平台默认 Codex",
			ExecutorType:        "codex",
			RuntimeType:         "server",
			Status:              "enabled",
			IsDefault:           boolPtr(true),
			Priority:            100,
			AutoRepairEnabled:   boolPtr(true),
			TriggerFailureCount: 1,
			MaxAttempts:         2,
			TaskTimeoutSeconds:  180,
			MaxConcurrency:      1,
			AllowPageActions:    boolPtr(true),
			AllowStorageRead:    boolPtr(true),
			AllowCDPRuntime:     boolPtr(true),
			AllowScriptSave:     boolPtr(true),
			AllowAutoActivate:   boolPtr(false),
			AppServerListen:     "stdio://",
		}, "user_platform_owner")
	}
	if errors.Is(err, sql.ErrNoRows) {
		return ExecutorConfig{}, ErrNotFound
	}
	return item, err
}

func (s *Store) GetExecutorConfigByID(ctx context.Context, id string) (ExecutorConfig, error) {
	item, err := scanExecutorConfig(s.db.QueryRowContext(ctx, `
		SELECT `+executorConfigColumns+`
		FROM ky_ai_executor_config
		WHERE id=$1
	`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return ExecutorConfig{}, ErrNotFound
	}
	return item, err
}

func (s *Store) CreateExecutorConfig(ctx context.Context, in ExecutorConfigInput, createdBy string) (ExecutorConfig, error) {
	normalizeExecutorInputDefaults(&in)
	id := "aiexec_" + randomSuffix() + randomSuffix()
	if in.ExecutorType == "codex" && in.Name == "平台默认 Codex" {
		id = "aiexec_platform_codex"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ExecutorConfig{}, err
	}
	defer tx.Rollback()
	if boolDefault(in.IsDefault, false) {
		if _, err = tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_config
			SET is_default=false, updated_at=now()
			WHERE scope_type=$1 AND scope_id=$2 AND executor_type=$3
		`, platformScopeType, platformScopeID, in.ExecutorType); err != nil {
			return ExecutorConfig{}, err
		}
	}
	autoRepair := boolDefault(in.AutoRepairEnabled, true)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_config (
			id, name, scope_type, scope_id, executor_type, runtime_type, status, is_default, priority,
			auto_repair_enabled, trigger_failure_count, max_attempts, task_timeout_seconds, max_concurrency,
			allow_page_actions, allow_storage_read, allow_cdp_runtime, allow_script_save, allow_auto_activate,
			app_server_listen, remark, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
		ON CONFLICT (id) DO UPDATE SET
			name=EXCLUDED.name,
			runtime_type=EXCLUDED.runtime_type,
			status=EXCLUDED.status,
			is_default=EXCLUDED.is_default,
			priority=EXCLUDED.priority,
			auto_repair_enabled=EXCLUDED.auto_repair_enabled,
			trigger_failure_count=EXCLUDED.trigger_failure_count,
			max_attempts=EXCLUDED.max_attempts,
			task_timeout_seconds=EXCLUDED.task_timeout_seconds,
			max_concurrency=EXCLUDED.max_concurrency,
			allow_page_actions=EXCLUDED.allow_page_actions,
			allow_storage_read=EXCLUDED.allow_storage_read,
			allow_cdp_runtime=EXCLUDED.allow_cdp_runtime,
			allow_script_save=EXCLUDED.allow_script_save,
			allow_auto_activate=EXCLUDED.allow_auto_activate,
			app_server_listen=EXCLUDED.app_server_listen,
			remark=EXCLUDED.remark,
			updated_by=EXCLUDED.updated_by,
			updated_at=now()
	`, id, in.Name, platformScopeType, platformScopeID, in.ExecutorType, in.RuntimeType, in.Status, boolDefault(in.IsDefault, false), in.Priority,
		autoRepair, in.TriggerFailureCount, in.MaxAttempts, in.TaskTimeoutSeconds, in.MaxConcurrency,
		boolDefault(in.AllowPageActions, true), boolDefault(in.AllowStorageRead, true), boolDefault(in.AllowCDPRuntime, true),
		boolDefault(in.AllowScriptSave, true), boolDefault(in.AllowAutoActivate, false), in.AppServerListen, in.Remark, createdBy, createdBy)
	if err := classifyWriteErr(err); err != nil {
		return ExecutorConfig{}, err
	}
	if err = tx.Commit(); err != nil {
		return ExecutorConfig{}, err
	}
	return s.GetExecutorConfigByID(ctx, id)
}

func (s *Store) UpdateExecutorConfig(ctx context.Context, id string, in ExecutorConfigInput, updatedBy string) (ExecutorConfig, error) {
	normalizeExecutorInputDefaults(&in)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ExecutorConfig{}, err
	}
	defer tx.Rollback()
	if boolDefault(in.IsDefault, false) {
		if _, err = tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_config
			SET is_default=false, updated_at=now()
			WHERE scope_type=$1 AND scope_id=$2 AND executor_type=$3 AND id<>$4
		`, platformScopeType, platformScopeID, in.ExecutorType, id); err != nil {
			return ExecutorConfig{}, err
		}
	}
	res, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_config
		SET name=$2, executor_type=$3, runtime_type=$4, status=$5, is_default=$6, priority=$7,
			auto_repair_enabled=$8, trigger_failure_count=$9, max_attempts=$10, task_timeout_seconds=$11,
			max_concurrency=$12, allow_page_actions=$13, allow_storage_read=$14, allow_cdp_runtime=$15,
			allow_script_save=$16, allow_auto_activate=$17, app_server_listen=$18, remark=$19,
			updated_by=$20, updated_at=now()
		WHERE id=$1
	`, id, in.Name, in.ExecutorType, in.RuntimeType, in.Status, boolDefault(in.IsDefault, false), in.Priority,
		boolDefault(in.AutoRepairEnabled, true), in.TriggerFailureCount, in.MaxAttempts, in.TaskTimeoutSeconds,
		in.MaxConcurrency, boolDefault(in.AllowPageActions, true), boolDefault(in.AllowStorageRead, true),
		boolDefault(in.AllowCDPRuntime, true), boolDefault(in.AllowScriptSave, true), boolDefault(in.AllowAutoActivate, false),
		in.AppServerListen, in.Remark, updatedBy)
	if err != nil {
		return ExecutorConfig{}, classifyWriteErr(err)
	}
	if err := affectedOrNotFound(res); err != nil {
		return ExecutorConfig{}, err
	}
	if err = tx.Commit(); err != nil {
		return ExecutorConfig{}, err
	}
	return s.GetExecutorConfigByID(ctx, id)
}

func (s *Store) StartExecutorAuthorization(ctx context.Context, id, authMethod string) (ExecutorConfig, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_config
		SET auth_status='authorizing', auth_method=$2, last_auth_checked_at=now(), updated_at=now()
		WHERE id=$1
	`, id, authMethod)
	if err != nil {
		return ExecutorConfig{}, err
	}
	if err := affectedOrNotFound(res); err != nil {
		return ExecutorConfig{}, err
	}
	return s.GetExecutorConfigByID(ctx, id)
}

func (s *Store) UpdateExecutorAuthStatus(
	ctx context.Context,
	id string,
	authStatus string,
	authMethod string,
	authAccountLabel string,
	boundDeviceID string,
	codexVersion string,
	capabilities json.RawMessage,
) (ExecutorConfig, error) {
	if len(capabilities) == 0 {
		capabilities = []byte("{}")
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_config
		SET auth_status=$2,
			auth_method=$3,
			auth_account_label=$4,
			bound_device_id=$5,
			codex_version=$6,
			capabilities=$7::jsonb,
			last_auth_checked_at=now(),
			updated_at=now()
		WHERE id=$1
	`, strings.TrimSpace(id), authStatus, authMethod, authAccountLabel, boundDeviceID, codexVersion, string(capabilities))
	if err != nil {
		return ExecutorConfig{}, err
	}
	if err := affectedOrNotFound(res); err != nil {
		return ExecutorConfig{}, err
	}
	return s.GetExecutorConfigByID(ctx, id)
}

func normalizeExecutorInputDefaults(in *ExecutorConfigInput) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		in.Name = "Codex 执行器"
	}
	in.ExecutorType = strings.TrimSpace(in.ExecutorType)
	if in.ExecutorType == "" {
		in.ExecutorType = "codex"
	}
	in.RuntimeType = strings.TrimSpace(in.RuntimeType)
	if in.RuntimeType == "" {
		in.RuntimeType = "desktop"
	}
	in.Status = strings.TrimSpace(in.Status)
	if in.Status == "" {
		in.Status = "enabled"
	}
	if in.Priority <= 0 {
		in.Priority = 100
	}
	if in.TriggerFailureCount < 1 {
		in.TriggerFailureCount = 1
	}
	if in.MaxAttempts < 1 {
		in.MaxAttempts = 2
	}
	if in.TaskTimeoutSeconds < 30 {
		in.TaskTimeoutSeconds = 180
	}
	if in.MaxConcurrency < 1 {
		in.MaxConcurrency = 1
	}
	in.AppServerListen = strings.TrimSpace(in.AppServerListen)
	if in.AppServerListen == "" {
		in.AppServerListen = "stdio://"
	}
	in.Remark = strings.TrimSpace(in.Remark)
}

func (s *Store) ListExecutorTasks(ctx context.Context, workspaceType, workspaceID, status, executorType string, page, pageSize int) ([]ExecutorTask, int64, error) {
	where := []string{"workspace_type=$1", "workspace_id=$2"}
	args := []any{workspaceType, workspaceID}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }
	if status != "" {
		where = append(where, "status="+add(status))
	}
	if executorType != "" {
		where = append(where, "executor_type="+add(executorType))
	}
	clause := strings.Join(where, " AND ")
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_ai_executor_task WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+executorTaskColumns+`
		FROM ky_ai_executor_task
		WHERE `+clause+`
		ORDER BY created_at DESC
		LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []ExecutorTask{}
	for rows.Next() {
		item, err := scanExecutorTask(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		return nil, 0, err
	}
	if err = s.hydrateExecutorTaskTokenUsage(ctx, items); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

func (s *Store) GetExecutorTask(ctx context.Context, workspaceType, workspaceID, id string) (ExecutorTask, error) {
	item, err := scanExecutorTask(s.db.QueryRowContext(ctx, `
		SELECT `+executorTaskColumns+`
		FROM ky_ai_executor_task
		WHERE workspace_type=$1 AND workspace_id=$2 AND id=$3
	`, workspaceType, workspaceID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return ExecutorTask{}, ErrNotFound
	}
	if err != nil {
		return ExecutorTask{}, err
	}
	items := []ExecutorTask{item}
	if err = s.hydrateExecutorTaskTokenUsage(ctx, items); err != nil {
		return ExecutorTask{}, err
	}
	return items[0], nil
}

func (s *Store) hydrateExecutorTaskTokenUsage(ctx context.Context, items []ExecutorTask) error {
	if len(items) == 0 {
		return nil
	}
	args := make([]any, 0, len(items))
	placeholders := make([]string, 0, len(items))
	indexByID := map[string]int{}
	for index, item := range items {
		if item.ID == "" {
			continue
		}
		if _, exists := indexByID[item.ID]; exists {
			continue
		}
		args = append(args, item.ID)
		placeholders = append(placeholders, "$"+itoa(len(args)))
		indexByID[item.ID] = index
	}
	if len(args) == 0 {
		return nil
	}

	tokenValue := func(key string) string {
		return `CASE WHEN payload_json->'usage'->>'` + key + `' ~ '^-?[0-9]+$' THEN (payload_json->'usage'->>'` + key + `')::bigint ELSE 0 END`
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT task_id,
			COALESCE(SUM(`+tokenValue("cached_input_tokens")+`), 0),
			COALESCE(SUM(`+tokenValue("input_tokens")+`), 0),
			COALESCE(SUM(`+tokenValue("output_tokens")+`), 0),
			COALESCE(SUM(`+tokenValue("reasoning_output_tokens")+`), 0),
			COALESCE(SUM(`+tokenValue("total_tokens")+`), 0)
		FROM ky_ai_executor_task_event
		WHERE event_type='codex.usage' AND task_id IN (`+strings.Join(placeholders, ",")+`)
		GROUP BY task_id
	`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var taskID string
		var usage ExecutorTokenUsage
		if err := rows.Scan(
			&taskID,
			&usage.CachedInputTokens,
			&usage.InputTokens,
			&usage.OutputTokens,
			&usage.ReasoningOutputTokens,
			&usage.TotalTokens,
		); err != nil {
			return err
		}
		if usage.TotalTokens == 0 {
			usage.TotalTokens = usage.InputTokens + usage.OutputTokens
		}
		if index, ok := indexByID[taskID]; ok {
			items[index].TokenUsage = usage
		}
	}
	return rows.Err()
}

func (s *Store) CreateExecutorTask(ctx context.Context, workspaceType, workspaceID, actorUserID string, in ExecutorTaskInput) (ExecutorTask, error) {
	summary, _ := json.Marshal(in.ResultSummary)
	if len(summary) == 0 {
		summary = []byte("{}")
	}
	executor, err := s.ResolveExecutorForTask(ctx, in.ExecutorID, in.ExecutorType)
	if err != nil {
		return ExecutorTask{}, err
	}
	initialStatus := "pending"
	if executor.RuntimeType != "server" {
		initialStatus = "waiting_executor"
	}
	taskID := "aext_" + randomSuffix() + randomSuffix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ExecutorTask{}, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task (
			id, workspace_type, workspace_id, executor_id, executor_type, task_type, purpose, trigger_reason,
			target_type, target_id, web_space_id, script_id, script_version_id, status, result_summary, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)
	`, taskID, workspaceType, workspaceID, executor.ID, executor.ExecutorType, in.TaskType, in.Purpose, in.TriggerReason,
		in.TargetType, in.TargetID, in.WebSpaceID, in.ScriptID, in.ScriptVersionID, initialStatus, string(summary), actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return ExecutorTask{}, err
	}
	if err = insertExecutorEventTx(ctx, tx, taskID, "task.created", "info", "Codex 修复任务已创建", map[string]any{
		"purpose":       in.Purpose,
		"triggerReason": in.TriggerReason,
		"targetType":    in.TargetType,
		"targetId":      in.TargetID,
		"executorId":    executor.ID,
		"runtimeType":   executor.RuntimeType,
	}); err != nil {
		return ExecutorTask{}, err
	}
	if err = insertExecutorRawLogTx(ctx, tx, taskID, "executor", "internal", "Codex repair task created", map[string]any{
		"purpose":       in.Purpose,
		"triggerReason": in.TriggerReason,
		"executorId":    executor.ID,
		"runtimeType":   executor.RuntimeType,
	}, "Codex 修复任务已创建"); err != nil {
		return ExecutorTask{}, err
	}
	if err = tx.Commit(); err != nil {
		return ExecutorTask{}, err
	}
	s.notifyExecutorStream(taskID, "all")
	return s.GetExecutorTask(ctx, workspaceType, workspaceID, taskID)
}

func (s *Store) ResolveExecutorForTask(ctx context.Context, executorID, executorType string) (ExecutorConfig, error) {
	executorID = strings.TrimSpace(executorID)
	if executorID != "" {
		item, err := s.GetExecutorConfigByID(ctx, executorID)
		if err != nil {
			return ExecutorConfig{}, err
		}
		if item.Status != "enabled" || !item.AutoRepairEnabled {
			return ExecutorConfig{}, ErrConflict
		}
		return item, nil
	}
	executorType = strings.TrimSpace(executorType)
	if executorType == "" {
		executorType = "codex"
	}
	item, err := scanExecutorConfig(s.db.QueryRowContext(ctx, `
		SELECT `+executorConfigColumns+`
		FROM ky_ai_executor_config
		WHERE scope_type=$1 AND scope_id=$2 AND executor_type=$3 AND status='enabled' AND auto_repair_enabled=true
		ORDER BY is_default DESC, priority ASC, runtime_type='desktop' DESC, created_at ASC
		LIMIT 1
	`, platformScopeType, platformScopeID, executorType))
	if errors.Is(err, sql.ErrNoRows) {
		return ExecutorConfig{}, ErrNotFound
	}
	return item, err
}

func (s *Store) CancelExecutorTask(ctx context.Context, workspaceType, workspaceID, id, actorUserID string) (ExecutorTask, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_task
		SET status='cancelled', error_message='用户取消任务', completed_at=now(), updated_at=now()
		WHERE workspace_type=$1 AND workspace_id=$2 AND id=$3 AND status IN ('pending','waiting_executor','running','waiting_user_scan')
	`, workspaceType, workspaceID, id)
	if err != nil {
		return ExecutorTask{}, err
	}
	if err := affectedOrNotFound(res); err != nil {
		return ExecutorTask{}, err
	}
	_ = s.AppendExecutorEvent(ctx, id, "task.cancelled", "warning", "任务已取消", map[string]any{"actorUserId": actorUserID})
	_ = s.AppendExecutorRawLog(ctx, id, "executor", "internal", "cancelled", map[string]any{"actorUserId": actorUserID}, "任务已取消")
	return s.GetExecutorTask(ctx, workspaceType, workspaceID, id)
}

func (s *Store) ClaimNextExecutorTask(ctx context.Context) (ExecutorTask, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ExecutorTask{}, false, err
	}
	defer tx.Rollback()

	var id string
	err = tx.QueryRowContext(ctx, `
		SELECT t.id
		FROM ky_ai_executor_task t
		JOIN ky_ai_executor_config e ON e.id=t.executor_id
		WHERE t.executor_type='codex' AND t.status='pending' AND e.runtime_type='server' AND e.status='enabled'
		ORDER BY e.priority ASC, t.created_at ASC
		LIMIT 1
		FOR UPDATE SKIP LOCKED
	`).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return ExecutorTask{}, false, nil
	}
	if err != nil {
		return ExecutorTask{}, false, err
	}

	item, err := scanExecutorTask(tx.QueryRowContext(ctx, `
		UPDATE ky_ai_executor_task
		SET status='running', started_at=COALESCE(started_at, now()), updated_at=now()
		WHERE id=$1
		RETURNING `+executorTaskColumns, id))
	if err != nil {
		return ExecutorTask{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return ExecutorTask{}, false, err
	}
	return item, true, nil
}

func (s *Store) CompleteExecutorTask(ctx context.Context, taskID, status, errorMessage string) error {
	if status == "" {
		status = "completed"
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_task
		SET status=$2, error_message=$3, completed_at=now(), updated_at=now()
		WHERE id=$1
	`, taskID, status, errorMessage)
	return err
}

func (s *Store) UpdateExecutorTaskThread(ctx context.Context, taskID, threadID string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_task
		SET codex_thread_id=$2, updated_at=now()
		WHERE id=$1
	`, taskID, threadID)
	return err
}

func (s *Store) ListExecutorTaskEvents(ctx context.Context, taskID string, after int64, limit int) ([]ExecutorTaskEvent, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, task_id, sequence, event_type, level, message, payload_json, created_at
		FROM ky_ai_executor_task_event
		WHERE task_id=$1 AND sequence>$2
		ORDER BY sequence ASC
		LIMIT $3
	`, taskID, after, clampLimit(limit))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ExecutorTaskEvent{}
	for rows.Next() {
		var item ExecutorTaskEvent
		var payload []byte
		if err := rows.Scan(&item.ID, &item.TaskID, &item.Sequence, &item.EventType, &item.Level, &item.Message, &payload, &item.CreatedAt); err != nil {
			return nil, err
		}
		if len(payload) == 0 {
			payload = []byte("{}")
		}
		item.Payload = payload
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListExecutorTaskRawLogs(ctx context.Context, taskID string, after int64, limit int) ([]ExecutorTaskRawLog, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, task_id, sequence, source, direction, raw_text, raw_json, terminal_line, created_at
		FROM ky_ai_executor_task_raw_log
		WHERE task_id=$1 AND sequence>$2
		ORDER BY sequence ASC
		LIMIT $3
	`, taskID, after, clampLimit(limit))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ExecutorTaskRawLog{}
	for rows.Next() {
		var item ExecutorTaskRawLog
		var rawJSON []byte
		if err := rows.Scan(&item.ID, &item.TaskID, &item.Sequence, &item.Source, &item.Direction, &item.RawText, &rawJSON, &item.TerminalLine, &item.CreatedAt); err != nil {
			return nil, err
		}
		if len(rawJSON) == 0 {
			rawJSON = []byte("{}")
		}
		item.RawJSON = rawJSON
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) AppendExecutorEvent(ctx context.Context, taskID, eventType, level, message string, payload map[string]any) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = insertExecutorEventTx(ctx, tx, taskID, eventType, level, message, payload); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.notifyExecutorStream(taskID, "event")
	return nil
}

func (s *Store) AppendExecutorRawLog(ctx context.Context, taskID, source, direction, rawText string, rawJSON map[string]any, terminalLine string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = insertExecutorRawLogTx(ctx, tx, taskID, source, direction, rawText, rawJSON, terminalLine); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.notifyExecutorStream(taskID, "terminal")
	return nil
}

func (s *Store) AppendExecutorTerminalFrame(ctx context.Context, taskID, payload string, rawJSON map[string]any) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = insertExecutorRawLogTx(ctx, tx, taskID, "codex", "out", payload, rawJSON, ""); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.notifyExecutorStream(taskID, "terminal")
	return nil
}

func (s *Store) notifyExecutorStream(taskID, kind string) {
	taskID = strings.TrimSpace(taskID)
	kind = strings.TrimSpace(kind)
	if s == nil || s.db == nil || taskID == "" {
		return
	}
	if kind == "" {
		kind = "all"
	}
	body, _ := json.Marshal(map[string]string{
		"taskId": taskID,
		"kind":   kind,
	})
	if len(body) == 0 {
		body = []byte(taskID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = s.db.ExecContext(ctx, `SELECT pg_notify($1, $2)`, ExecutorStreamNotifyChannel, string(body))
}

func insertExecutorEventTx(ctx context.Context, tx *sql.Tx, taskID, eventType, level, message string, payload map[string]any) error {
	seq, err := nextExecutorSequence(ctx, tx, "ky_ai_executor_task_event", taskID)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(payload)
	if len(body) == 0 {
		body = []byte("{}")
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task_event (id, task_id, sequence, event_type, level, message, payload_json)
		VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
	`, "aexte_"+randomSuffix()+randomSuffix(), taskID, seq, eventType, level, message, string(body))
	return err
}

func insertExecutorRawLogTx(ctx context.Context, tx *sql.Tx, taskID, source, direction, rawText string, rawJSON map[string]any, terminalLine string) error {
	seq, err := nextExecutorSequence(ctx, tx, "ky_ai_executor_task_raw_log", taskID)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(rawJSON)
	if len(body) == 0 {
		body = []byte("{}")
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task_raw_log (id, task_id, sequence, source, direction, raw_text, raw_json, terminal_line)
		VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
	`, "aextrl_"+randomSuffix()+randomSuffix(), taskID, seq, source, direction, rawText, string(body), terminalLine)
	return err
}

func nextExecutorSequence(ctx context.Context, tx *sql.Tx, table, taskID string) (int64, error) {
	var locked string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM ky_ai_executor_task WHERE id=$1 FOR UPDATE`, taskID).Scan(&locked); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	var seq int64
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence), 0) + 1 FROM `+table+` WHERE task_id=$1`, taskID).Scan(&seq)
	return seq, err
}

func boolDefault(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func boolPtr(value bool) *bool {
	return &value
}

func clampLimit(limit int) int {
	if limit < 1 {
		return 200
	}
	if limit > 1000 {
		return 1000
	}
	return limit
}
