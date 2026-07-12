package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

func (s *Store) ResolveLoginScript(ctx context.Context, workspaceType, workspaceID, memberID, webSpaceID string, in LoginScriptResolveInput) (LoginScriptResolveResult, error) {
	ws, err := s.GetWebSpace(ctx, workspaceType, workspaceID, memberID, webSpaceID)
	if err != nil {
		return LoginScriptResolveResult{}, err
	}
	purpose := strings.TrimSpace(in.Purpose)
	fingerprint := strings.TrimSpace(in.PageFingerprint)
	modelID := strings.TrimSpace(in.ModelID)
	threshold := 3

	script, err := s.findLoginScript(ctx, workspaceType, workspaceID, ws.Platform, purpose, fingerprint)
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, ErrNotFound) {
		return LoginScriptResolveResult{
			ShouldGenerate:   true,
			Reason:           missingLoginScriptReason(purpose),
			FailureThreshold: threshold,
			ModelID:          modelID,
		}, nil
	}
	if err != nil {
		return LoginScriptResolveResult{}, err
	}
	threshold = script.FailureThreshold
	if modelID == "" {
		modelID = script.ModelID
	}

	version, err := s.activeLoginScriptVersion(ctx, script.ID)
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, ErrNotFound) {
		return LoginScriptResolveResult{
			Script:           &script,
			ShouldGenerate:   true,
			Reason:           "no_active_version",
			FailureThreshold: threshold,
			ModelID:          modelID,
		}, nil
	}
	if err != nil {
		return LoginScriptResolveResult{}, err
	}
	shouldGenerate := script.ConsecutiveFailureCount >= int64(script.FailureThreshold)
	reason := "script_ready"
	if shouldGenerate {
		reason = "consecutive_failures"
	}
	return LoginScriptResolveResult{
		Script:           &script,
		Version:          &version,
		ShouldGenerate:   shouldGenerate,
		Reason:           reason,
		FailureThreshold: threshold,
		ModelID:          modelID,
	}, nil
}

func (s *Store) RecordLoginScriptRun(ctx context.Context, workspaceType, workspaceID, memberID, actorUserID, webSpaceID string, in LoginScriptRunResultInput) (LoginScriptResolveResult, error) {
	ws, err := s.GetWebSpace(ctx, workspaceType, workspaceID, memberID, webSpaceID)
	if err != nil {
		return LoginScriptResolveResult{}, err
	}
	status := strings.TrimSpace(in.Status)
	if status == "" {
		status = "failed"
	}
	scriptID := strings.TrimSpace(in.ScriptID)
	versionID := strings.TrimSpace(in.ScriptVersionID)
	purpose := strings.TrimSpace(in.Purpose)
	if purpose == "" {
		purpose = "qr_login_prepare"
	}
	summary, _ := json.Marshal(in.ResultSummary)
	if len(summary) == 0 {
		summary = []byte(`{}`)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return LoginScriptResolveResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	if scriptID != "" {
		if err := validateLoginScriptRunRecord(ctx, tx, workspaceType, workspaceID, scriptID, versionID, purpose); err != nil {
			return LoginScriptResolveResult{}, err
		}
	} else if versionID != "" {
		return LoginScriptResolveResult{}, ErrValidation
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_matrix_account_login_script_run (
		  id, script_id, script_version_id, web_space_id, workspace_type, workspace_id, platform, purpose,
		  status, error_code, error_message, duration_ms, result_summary, created_by)
		VALUES ($1,NULLIF($2,''),NULLIF($3,''),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
	`, newID("malsr"), scriptID, versionID, ws.ID, workspaceType, workspaceID, ws.Platform, purpose, status,
		strings.TrimSpace(in.ErrorCode), strings.TrimSpace(in.ErrorMessage), in.DurationMs, string(summary), actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return LoginScriptResolveResult{}, err
	}

	if scriptID != "" {
		if status == "success" {
			if _, err = tx.ExecContext(ctx, `
				UPDATE ky_matrix_account_login_script
				SET success_count=success_count+1, consecutive_failure_count=0, last_success_at=now(),
				    updated_by=$2, updated_at=now()
				WHERE workspace_type=$3 AND workspace_id=$4 AND id=$1 AND deleted_at IS NULL
			`, scriptID, actorUserID, workspaceType, workspaceID); err != nil {
				return LoginScriptResolveResult{}, classifyWriteErr(err)
			}
		} else {
			if _, err = tx.ExecContext(ctx, `
				UPDATE ky_matrix_account_login_script
				SET failure_count=failure_count+1, consecutive_failure_count=consecutive_failure_count+1,
				    last_failed_at=now(), last_failure_reason=$2,
				    status=CASE
				      WHEN NOT EXISTS (
				        SELECT 1 FROM ky_matrix_account_login_script_version v
				        WHERE v.script_id=ky_matrix_account_login_script.id AND v.status='active'
				      ) THEN 'failed'
				      ELSE status
				    END,
				    updated_by=$3, updated_at=now()
				WHERE workspace_type=$4 AND workspace_id=$5 AND id=$1 AND deleted_at IS NULL
			`, scriptID, firstNonEmpty(in.ErrorMessage, in.ErrorCode, status), actorUserID, workspaceType, workspaceID); err != nil {
				return LoginScriptResolveResult{}, classifyWriteErr(err)
			}
		}
	}

	if err := tx.Commit(); err != nil {
		return LoginScriptResolveResult{}, err
	}
	if scriptID != "" {
		script, err := s.getLoginScript(ctx, workspaceType, workspaceID, scriptID)
		if err != nil {
			return LoginScriptResolveResult{}, err
		}
		var version *LoginScriptVersion
		if active, err := s.activeLoginScriptVersion(ctx, script.ID); err == nil {
			version = &active
		}
		shouldGenerate := status != "success"
		reason := "script_ready"
		if shouldGenerate {
			reason = failedLoginScriptReason(purpose)
			if script.ConsecutiveFailureCount >= int64(script.FailureThreshold) {
				reason = "consecutive_failures"
			}
		}
		return LoginScriptResolveResult{
			Script:           &script,
			Version:          version,
			ShouldGenerate:   shouldGenerate,
			Reason:           reason,
			FailureThreshold: script.FailureThreshold,
			ModelID:          script.ModelID,
		}, nil
	}
	return s.ResolveLoginScript(ctx, workspaceType, workspaceID, memberID, webSpaceID, LoginScriptResolveInput{
		Purpose:         purpose,
		PageFingerprint: "",
		ModelID:         "",
	})
}

func (s *Store) CreateGeneratedLoginScriptCandidate(ctx context.Context, workspaceType, workspaceID, memberID, actorUserID, webSpaceID string, in LoginScriptGenerateInput, generated GeneratedLoginScript) (LoginScriptResolveResult, error) {
	ws, err := s.GetWebSpace(ctx, workspaceType, workspaceID, memberID, webSpaceID)
	if err != nil {
		return LoginScriptResolveResult{}, err
	}
	purpose := strings.TrimSpace(in.Purpose)
	if purpose == "" {
		purpose = "qr_login_prepare"
	}
	if err := validateExecutableLoginScriptDSL(generated.DSL, purpose); err != nil {
		return LoginScriptResolveResult{}, err
	}
	pageFingerprint := strings.TrimSpace(in.PageFingerprint)
	generationReason := firstNonEmpty(strings.TrimSpace(generated.GenerationReason), strings.TrimSpace(in.GenerationReason), missingLoginScriptReason(purpose))
	usageSource := firstNonEmpty(strings.TrimSpace(generated.UsageSource), "unknown")

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return LoginScriptResolveResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	scriptID := ""
	err = tx.QueryRowContext(ctx, `
		SELECT id
		FROM ky_matrix_account_login_script
		WHERE workspace_type=$1 AND workspace_id=$2 AND platform=$3 AND purpose=$4
		  AND page_fingerprint=$5 AND deleted_at IS NULL
		LIMIT 1
		FOR UPDATE
	`, workspaceType, workspaceID, ws.Platform, purpose, pageFingerprint).Scan(&scriptID)
	if errors.Is(err, sql.ErrNoRows) {
		scriptID = newID("mals")
		_, err = tx.ExecContext(ctx, `
				INSERT INTO ky_matrix_account_login_script (
				  id, workspace_type, workspace_id, platform, purpose, url_pattern, page_fingerprint,
				  model_id, status, failure_threshold, generation_count,
				  total_prompt_tokens, total_completion_tokens, total_tokens, created_by, updated_by)
				VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),'learning',3,1,$9,$10,$11,$12,$12)
			`, scriptID, workspaceType, workspaceID, ws.Platform, purpose, normalizeURLPattern(in.URL), pageFingerprint,
			generated.ModelID, generated.PromptTokens, generated.CompletionTokens, generated.TotalTokens, actorUserID)
		if err := classifyWriteErr(err); err != nil {
			return LoginScriptResolveResult{}, err
		}
	} else if err != nil {
		return LoginScriptResolveResult{}, err
	} else {
		_, err = tx.ExecContext(ctx, `
			UPDATE ky_matrix_account_login_script
			SET model_id=COALESCE(model_id, NULLIF($2,'')),
			    status=CASE WHEN COALESCE(active_version_id,'')='' THEN 'learning' ELSE 'enabled' END,
			    generation_count=generation_count+1,
			    total_prompt_tokens=total_prompt_tokens+$3,
			    total_completion_tokens=total_completion_tokens+$4,
			    total_tokens=total_tokens+$5,
			    updated_by=$6, updated_at=now()
			WHERE id=$1 AND workspace_type=$7 AND workspace_id=$8 AND deleted_at IS NULL
		`, scriptID, generated.ModelID, generated.PromptTokens, generated.CompletionTokens, generated.TotalTokens, actorUserID, workspaceType, workspaceID)
		if err := classifyWriteErr(err); err != nil {
			return LoginScriptResolveResult{}, err
		}
	}

	version := 1
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) + 1 FROM ky_matrix_account_login_script_version WHERE script_id=$1`, scriptID).Scan(&version)
	if err != nil {
		return LoginScriptResolveResult{}, err
	}
	versionID := newID("malsv")
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_matrix_account_login_script_version (
		  id, script_id, version, model_id, dsl_json, source, status,
		  prompt_tokens, completion_tokens, total_tokens, usage_source, generation_reason, created_by)
		VALUES ($1,$2,$3,NULLIF($4,''),$5::jsonb,'ai_generated','candidate',$6,$7,$8,$9,$10,$11)
	`, versionID, scriptID, version, generated.ModelID, string(generated.DSL), generated.PromptTokens, generated.CompletionTokens,
		generated.TotalTokens, usageSource, generationReason, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return LoginScriptResolveResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return LoginScriptResolveResult{}, err
	}

	script, err := s.getLoginScript(ctx, workspaceType, workspaceID, scriptID)
	if err != nil {
		return LoginScriptResolveResult{}, err
	}
	candidate, err := s.getLoginScriptVersion(ctx, scriptID, versionID)
	if err != nil {
		return LoginScriptResolveResult{}, err
	}
	return LoginScriptResolveResult{
		Script:           &script,
		Version:          &candidate,
		ShouldGenerate:   false,
		Reason:           "generated_candidate",
		FailureThreshold: script.FailureThreshold,
		ModelID:          generated.ModelID,
	}, nil
}

func (s *Store) ListWebSpaceLoginScriptRuns(ctx context.Context, workspaceType, workspaceID, memberID, webSpaceID string, limit int) ([]LoginScriptRunLog, error) {
	if _, err := s.GetWebSpace(ctx, workspaceType, workspaceID, memberID, webSpaceID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.purpose,
		       COALESCE(v.version, 0),
		       COALESCE(v.status, ''),
		       COALESCE(v.source, ''),
		       r.status,
		       COALESCE(r.error_code, ''),
		       COALESCE(v.generation_reason, ''),
		       COALESCE(r.duration_ms, 0),
		       COALESCE(r.result_summary, '{}'::jsonb),
		       to_char(r.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM ky_matrix_account_login_script_run r
		LEFT JOIN ky_matrix_account_login_script_version v ON v.id = r.script_version_id
		WHERE r.workspace_type=$1 AND r.workspace_id=$2 AND r.web_space_id=$3
		ORDER BY r.created_at DESC
		LIMIT $4
	`, workspaceType, workspaceID, webSpaceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []LoginScriptRunLog{}
	for rows.Next() {
		var item LoginScriptRunLog
		var rawSummary []byte
		if err := rows.Scan(
			&item.Purpose,
			&item.Version,
			&item.VersionStatus,
			&item.VersionSource,
			&item.Status,
			&item.ErrorCode,
			&item.ReasonCode,
			&item.DurationMs,
			&rawSummary,
			&item.CreatedAt,
		); err != nil {
			return nil, err
		}
		if len(rawSummary) > 0 {
			_ = json.Unmarshal(rawSummary, &item.ResultSummary)
		}
		if item.ResultSummary == nil {
			item.ResultSummary = map[string]any{}
		}
		if item.ReasonCode == "" {
			item.ReasonCode = item.ErrorCode
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListLoginScripts(ctx context.Context, params LoginScriptListParams) ([]LoginScript, Page, error) {
	where := []string{"workspace_type=$1", "workspace_id=$2", "deleted_at IS NULL"}
	args := []any{params.WorkspaceType, params.WorkspaceID}
	if params.Platform != "" {
		args = append(args, params.Platform)
		where = append(where, "platform=$"+itoa(len(args)))
	}
	if params.Purpose != "" {
		args = append(args, params.Purpose)
		where = append(where, "purpose=$"+itoa(len(args)))
	}
	if params.Status != "" {
		args = append(args, params.Status)
		where = append(where, "status=$"+itoa(len(args)))
	}

	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_matrix_account_login_script WHERE `+strings.Join(where, " AND "), args...).Scan(&total); err != nil {
		return nil, Page{}, err
	}

	offset := (params.Page - 1) * params.PageSize
	args = append(args, params.PageSize, offset)
	rows, err := s.db.QueryContext(ctx, loginScriptSelectSQL()+`
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY platform, purpose, updated_at DESC, created_at DESC
		LIMIT $`+itoa(len(args)-1)+` OFFSET $`+itoa(len(args)), args...)
	if err != nil {
		return nil, Page{}, err
	}
	defer rows.Close()
	items, err := scanLoginScripts(rows)
	if err != nil {
		return nil, Page{}, err
	}
	return items, Page{Page: params.Page, PageSize: params.PageSize, Total: total}, nil
}

func (s *Store) GetLoginScript(ctx context.Context, workspaceType, workspaceID, id string) (LoginScript, error) {
	return s.getLoginScript(ctx, workspaceType, workspaceID, id)
}

func (s *Store) ListLoginScriptVersions(ctx context.Context, workspaceType, workspaceID, scriptID string) ([]LoginScriptVersion, error) {
	if _, err := s.getLoginScript(ctx, workspaceType, workspaceID, scriptID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, loginScriptVersionSelectSQL()+`
		WHERE script_id=$1
		ORDER BY version DESC
	`, scriptID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanLoginScriptVersions(rows)
}

func (s *Store) UpdateLoginScriptStatus(ctx context.Context, workspaceType, workspaceID, scriptID, status, actorUserID string) (LoginScript, error) {
	if status == "enabled" {
		var purpose string
		var versionStatus string
		var dsl json.RawMessage
		err := s.db.QueryRowContext(ctx, `
			SELECT s.purpose, v.status, v.dsl_json
			FROM ky_matrix_account_login_script s
			JOIN ky_matrix_account_login_script_version v ON v.id=s.active_version_id AND v.script_id=s.id
			WHERE s.workspace_type=$1 AND s.workspace_id=$2 AND s.id=$3 AND s.deleted_at IS NULL
		`, workspaceType, workspaceID, scriptID).Scan(&purpose, &versionStatus, &dsl)
		if errors.Is(err, sql.ErrNoRows) {
			return LoginScript{}, ErrValidation
		}
		if err != nil {
			return LoginScript{}, err
		}
		if versionStatus != "active" {
			return LoginScript{}, ErrValidation
		}
		if err := validateExecutableLoginScriptDSL(dsl, purpose); err != nil {
			return LoginScript{}, err
		}
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_matrix_account_login_script
		SET status=$4, updated_by=$5, updated_at=now()
		WHERE workspace_type=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL
	`, workspaceType, workspaceID, scriptID, status, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return LoginScript{}, err
	}
	if err := affectedOrNotFound(res); err != nil {
		return LoginScript{}, err
	}
	return s.getLoginScript(ctx, workspaceType, workspaceID, scriptID)
}

func missingLoginScriptReason(purpose string) string {
	if purpose == "qr_login_refresh" {
		return "refresh_script_missing"
	}
	if purpose == "account_detect" {
		return "detect_script_missing"
	}
	return "no_active_script"
}

func failedLoginScriptReason(purpose string) string {
	if purpose == "qr_login_refresh" {
		return "refresh_script_failed"
	}
	if purpose == "account_detect" {
		return "detect_script_failed"
	}
	return "script_run_failed"
}

func (s *Store) findLoginScript(ctx context.Context, workspaceType, workspaceID, platform, purpose, pageFingerprint string) (LoginScript, error) {
	where := []string{
		"workspace_type=$1",
		"workspace_id=$2",
		"platform=$3",
		"purpose=$4",
		"status='enabled'",
		"deleted_at IS NULL",
	}
	args := []any{workspaceType, workspaceID, platform, purpose}
	if pageFingerprint != "" {
		args = append(args, pageFingerprint)
		where = append(where, "(page_fingerprint=$"+itoa(len(args))+" OR page_fingerprint='')")
	} else {
		where = append(where, "page_fingerprint=''")
	}
	rows, err := s.db.QueryContext(ctx, loginScriptSelectSQL()+`
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY CASE WHEN page_fingerprint<>'' THEN 0 ELSE 1 END, last_success_at DESC NULLS LAST, updated_at DESC
		LIMIT 1
	`, args...)
	if err != nil {
		return LoginScript{}, err
	}
	defer rows.Close()
	items, err := scanLoginScripts(rows)
	if err != nil {
		return LoginScript{}, err
	}
	if len(items) == 0 {
		return LoginScript{}, ErrNotFound
	}
	return items[0], nil
}

func (s *Store) getLoginScript(ctx context.Context, workspaceType, workspaceID, id string) (LoginScript, error) {
	rows, err := s.db.QueryContext(ctx, loginScriptSelectSQL()+`
		WHERE workspace_type=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL
	`, workspaceType, workspaceID, id)
	if err != nil {
		return LoginScript{}, err
	}
	defer rows.Close()
	items, err := scanLoginScripts(rows)
	if err != nil {
		return LoginScript{}, err
	}
	if len(items) == 0 {
		return LoginScript{}, ErrNotFound
	}
	return items[0], nil
}

func (s *Store) activeLoginScriptVersion(ctx context.Context, scriptID string) (LoginScriptVersion, error) {
	rows, err := s.db.QueryContext(ctx, loginScriptVersionSelectSQL()+`
		WHERE script_id=$1 AND status='active'
		ORDER BY version DESC
		LIMIT 1
	`, scriptID)
	if err != nil {
		return LoginScriptVersion{}, err
	}
	defer rows.Close()
	items, err := scanLoginScriptVersions(rows)
	if err != nil {
		return LoginScriptVersion{}, err
	}
	if len(items) == 0 {
		return LoginScriptVersion{}, ErrNotFound
	}
	return items[0], nil
}

func (s *Store) getLoginScriptVersion(ctx context.Context, scriptID, versionID string) (LoginScriptVersion, error) {
	rows, err := s.db.QueryContext(ctx, loginScriptVersionSelectSQL()+`
		WHERE script_id=$1 AND id=$2
	`, scriptID, versionID)
	if err != nil {
		return LoginScriptVersion{}, err
	}
	defer rows.Close()
	items, err := scanLoginScriptVersions(rows)
	if err != nil {
		return LoginScriptVersion{}, err
	}
	if len(items) == 0 {
		return LoginScriptVersion{}, ErrNotFound
	}
	return items[0], nil
}

func normalizeURLPattern(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if idx := strings.IndexAny(value, "?#"); idx >= 0 {
		value = value[:idx]
	}
	return value
}

func loginScriptSelectSQL() string {
	return `
		SELECT id, workspace_type, workspace_id, platform, purpose, url_pattern, page_fingerprint,
		       COALESCE(active_version_id, ''), COALESCE(model_id, ''), status, failure_threshold,
		       success_count, failure_count, consecutive_failure_count, generation_count,
		       total_prompt_tokens, total_completion_tokens, total_tokens,
		       to_char(last_success_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(last_failed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       last_failure_reason,
		       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM ky_matrix_account_login_script
	`
}

func loginScriptVersionSelectSQL() string {
	return `
		SELECT id, script_id, version, COALESCE(model_id, ''), dsl_json, source, status,
		       prompt_tokens, completion_tokens, total_tokens, usage_source, generation_reason,
		       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM ky_matrix_account_login_script_version
	`
}

func scanLoginScripts(rows *sql.Rows) ([]LoginScript, error) {
	items := []LoginScript{}
	for rows.Next() {
		var item LoginScript
		var lastSuccessAt, lastFailedAt sql.NullString
		if err := rows.Scan(
			&item.ID, &item.WorkspaceType, &item.WorkspaceID, &item.Platform, &item.Purpose, &item.URLPattern, &item.PageFingerprint,
			&item.ActiveVersionID, &item.ModelID, &item.Status, &item.FailureThreshold,
			&item.SuccessCount, &item.FailureCount, &item.ConsecutiveFailureCount, &item.GenerationCount,
			&item.TotalPromptTokens, &item.TotalCompletionTokens, &item.TotalTokens,
			&lastSuccessAt, &lastFailedAt, &item.LastFailureReason, &item.CreatedAt, &item.UpdatedAt,
		); err != nil {
			return nil, err
		}
		if lastSuccessAt.Valid {
			item.LastSuccessAt = &lastSuccessAt.String
		}
		if lastFailedAt.Valid {
			item.LastFailedAt = &lastFailedAt.String
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func scanLoginScriptVersions(rows *sql.Rows) ([]LoginScriptVersion, error) {
	items := []LoginScriptVersion{}
	for rows.Next() {
		var item LoginScriptVersion
		if err := rows.Scan(
			&item.ID, &item.ScriptID, &item.Version, &item.ModelID, &item.DSL, &item.Source, &item.Status,
			&item.PromptTokens, &item.CompletionTokens, &item.TotalTokens, &item.UsageSource, &item.GenerationReason,
			&item.CreatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
