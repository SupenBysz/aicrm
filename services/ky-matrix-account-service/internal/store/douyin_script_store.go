package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/matcher"
)

type DouyinScript struct {
	ID                 string            `json:"id"`
	WorkspaceType      string            `json:"workspaceType"`
	WorkspaceID        string            `json:"workspaceId"`
	Identifier         string            `json:"identifier"`
	Name               string            `json:"name"`
	Platform           string            `json:"platform"`
	MatchType          string            `json:"matchType"`
	MatchURL           string            `json:"matchUrl"`
	MatchRules         []DouyinMatchRule `json:"matchRules"`
	RunAt              string            `json:"runAt"`
	Priority           int               `json:"priority"`
	LatestVersionID    string            `json:"latestVersionId"`
	EffectiveVersionID string            `json:"effectiveVersionId"`
	Status             string            `json:"status"`
	Revision           int               `json:"revision"`
	LatestVersion      string            `json:"latestVersion"`
	EffectiveVersion   string            `json:"effectiveVersion"`
	LatestJSBytes      int               `json:"latestJsBytes"`
	LatestCSSBytes     int               `json:"latestCssBytes"`
	UpdatedAt          string            `json:"updatedAt"`
}
type DouyinScriptVersion struct {
	ID            string `json:"id"`
	ScriptID      string `json:"scriptId"`
	Version       string `json:"version"`
	JSContent     string `json:"jsContent,omitempty"`
	CSSContent    string `json:"cssContent,omitempty"`
	JSBytes       int    `json:"jsBytes"`
	CSSBytes      int    `json:"cssBytes"`
	ContentSHA256 string `json:"contentSha256"`
	Status        string `json:"status"`
	Revision      int    `json:"revision"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
}
type DouyinScriptInput struct {
	Identifier string            `json:"identifier"`
	Name       string            `json:"name"`
	MatchType  string            `json:"matchType"`
	MatchURL   string            `json:"matchUrl"`
	MatchRules []DouyinMatchRule `json:"matchRules"`
	RunAt      string            `json:"runAt"`
	Priority   *int              `json:"priority"`
}
type DouyinScriptVersionInput struct {
	Version    string `json:"version"`
	JSContent  string `json:"jsContent"`
	CSSContent string `json:"cssContent"`
}

// DouyinScriptInputError 向 HTTP 层传递安全的字段级校验信息，
// 不暴露原始输入或存储细节。
type DouyinScriptInputError struct {
	Field   string
	Message string
}

func (e *DouyinScriptInputError) Error() string { return e.Message }
func (e *DouyinScriptInputError) Unwrap() error { return ErrValidation }

func validDouyinScriptValue(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

type DouyinScriptListParams struct {
	WorkspaceType, WorkspaceID, Keyword, Status string
	Page, PageSize                              int
}

func normalizeDouyinScriptInput(in DouyinScriptInput) (DouyinScriptInput, error) {
	return normalizeDouyinScriptInputMode(in, true)
}

// normalizeDouyinScriptUpdateInput 保留旧客户端未发送的运行时字段。
func normalizeDouyinScriptUpdateInput(in DouyinScriptInput) (DouyinScriptInput, error) {
	return normalizeDouyinScriptInputMode(in, true)
}

func normalizeDouyinScriptInputMode(in DouyinScriptInput, applyRuntimeDefaults bool) (DouyinScriptInput, error) {
	in.Identifier, in.Name, in.MatchType, in.MatchURL = strings.TrimSpace(in.Identifier), strings.TrimSpace(in.Name), strings.TrimSpace(in.MatchType), strings.TrimSpace(in.MatchURL)
	if in.Identifier == "" {
		return in, &DouyinScriptInputError{Field: "identifier", Message: "标识符不能为空"}
	}
	if len(in.Identifier) > 64 {
		return in, &DouyinScriptInputError{Field: "identifier", Message: "标识符不能超过64个字符"}
	}
	for i, r := range in.Identifier {
		valid := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || (i > 0 && (r == '_' || r == '-' || r == '.'))
		if !valid {
			return in, &DouyinScriptInputError{Field: "identifier", Message: "标识符仅允许字母、数字、点、下划线和连字符，且必须以字母或数字开头"}
		}
	}
	if in.Name == "" {
		return in, &DouyinScriptInputError{Field: "name", Message: "名称不能为空"}
	}
	if in.MatchType != "" && !validDouyinScriptValue(in.MatchType, "exact", "prefix", "wildcard") {
		return in, &DouyinScriptInputError{Field: "matchType", Message: "匹配方式必须是精确、前缀或通配匹配"}
	}
	if len(in.Name) > 120 {
		return in, &DouyinScriptInputError{Field: "name", Message: "名称不能超过120个字符"}
	}
	in.RunAt = strings.TrimSpace(in.RunAt)
	if in.RunAt == "" && applyRuntimeDefaults {
		in.RunAt = DefaultDouyinScriptRunAt
	}
	if in.RunAt != "" && !validDouyinScriptRunAt(in.RunAt) {
		return in, &DouyinScriptInputError{Field: "runAt", Message: "运行时机无效，必须使用受支持的事件阶段"}
	}
	if in.Priority == nil && applyRuntimeDefaults {
		priority := DefaultDouyinScriptPriority
		in.Priority = &priority
	}
	if in.Priority != nil && (*in.Priority < MinDouyinScriptPriority || *in.Priority > MaxDouyinScriptPriority) {
		return in, &DouyinScriptInputError{Field: "priority", Message: "优先级必须在-10000至10000之间"}
	}
	in, err := normalizeDouyinRulesForInput(in)
	if err != nil {
		return in, err
	}
	normalizedURL, err := matcher.ValidateRule(in.MatchType, in.MatchURL)
	if err != nil {
		message := "匹配 URL 格式无效，请填写完整的 http 或 https URL"
		switch {
		case errors.Is(err, matcher.ErrEmptyURL):
			message = "匹配 URL 不能为空"
		case in.MatchType == "exact" && strings.ContainsRune(in.MatchURL, '*'):
			message = "精确匹配不能包含 *，请移除 * 或选择通配匹配"
		case in.MatchType == "wildcard" && strings.Count(in.MatchURL, "*") > matcher.MaxWildcardCount:
			message = "通配匹配最多允许32个 *"
		case in.MatchType == "wildcard" && strings.Count(in.MatchURL, "*") == 0:
			message = "通配匹配的完整 URL 可不含 *，将按字面量匹配；当前 URL 格式无效"
		case in.MatchType == "wildcard":
			message = "通配匹配语法无效，仅允许使用 *，且必须是完整的 http 或 https URL"
		}
		return in, &DouyinScriptInputError{Field: "matchUrl", Message: message}
	}
	in.MatchURL = normalizedURL
	return in, nil
}
func normalizeDouyinVersionInput(in DouyinScriptVersionInput) (DouyinScriptVersionInput, error) {
	in.Version, in.JSContent, in.CSSContent = strings.TrimSpace(in.Version), strings.TrimSpace(in.JSContent), strings.TrimSpace(in.CSSContent)
	if in.Version == "" || (in.JSContent == "" && in.CSSContent == "") || len(in.JSContent) > 2_000_000 || len(in.CSSContent) > 2_000_000 {
		return in, ErrValidation
	}
	parts := strings.Split(in.Version, ".")
	if len(parts) != 3 {
		return in, ErrValidation
	}
	for _, p := range parts {
		if p == "" {
			return in, ErrValidation
		}
		for _, r := range p {
			if r < '0' || r > '9' {
				return in, ErrValidation
			}
		}
	}
	return in, nil
}
func scriptHash(in DouyinScriptVersionInput) string {
	h := sha256.Sum256([]byte(in.JSContent + "\x00" + in.CSSContent))
	return hex.EncodeToString(h[:])
}
func idemHash(v any) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%#v", v)))) }

func (s *Store) ListDouyinScripts(ctx context.Context, p DouyinScriptListParams) ([]DouyinScript, Page, error) {
	if p.Page < 1 {
		p.Page = 1
	}
	if p.PageSize < 1 || p.PageSize > 100 {
		p.PageSize = 20
	}
	args := []any{p.WorkspaceType, p.WorkspaceID}
	where := []string{"s.workspace_type=$1", "s.workspace_id=$2", "s.deleted_at IS NULL"}
	if p.Keyword != "" {
		args = append(args, "%"+p.Keyword+"%")
		where = append(where, fmt.Sprintf("(s.name ILIKE $%d OR s.match_url ILIKE $%d)", len(args), len(args)))
	}
	if p.Status != "" {
		args = append(args, p.Status)
		where = append(where, fmt.Sprintf("s.status=$%d", len(args)))
	}
	whereSQL := strings.Join(where, " AND ")
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM ky_matrix_account_douyin_script s WHERE "+whereSQL, args...).Scan(&total); err != nil {
		return nil, Page{}, err
	}
	offset := (p.Page - 1) * p.PageSize
	args = append(args, p.PageSize, offset)
	rows, err := s.db.QueryContext(ctx, `SELECT s.id,s.workspace_type,s.workspace_id,s.identifier,s.name,s.platform,s.match_type,s.match_url,COALESCE(s.match_rules,'[]'::jsonb),s.run_at,s.priority,COALESCE(s.latest_version_id,''),COALESCE(s.effective_version_id,''),s.status,s.revision,COALESCE(ls.version,lt.version,l.version,''),COALESCE(es.version,et.version,e.version,''),COALESCE(ls.source_bytes,l.js_bytes,0),COALESCE(lt.source_bytes,l.css_bytes,0),to_char(s.updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF') FROM ky_matrix_account_douyin_script s LEFT JOIN ky_matrix_account_douyin_script_version l ON l.id=s.latest_version_id LEFT JOIN ky_matrix_account_douyin_script_version e ON e.id=s.effective_version_id LEFT JOIN ky_matrix_account_douyin_script_asset_version ls ON ls.id=s.latest_script_asset_version_id LEFT JOIN ky_matrix_account_douyin_script_asset_version es ON es.id=s.effective_script_asset_version_id LEFT JOIN ky_matrix_account_douyin_script_asset_version lt ON lt.id=s.latest_style_asset_version_id LEFT JOIN ky_matrix_account_douyin_script_asset_version et ON et.id=s.effective_style_asset_version_id WHERE `+whereSQL+` ORDER BY s.updated_at DESC,s.id DESC LIMIT $`+fmt.Sprint(len(args)-1)+` OFFSET $`+fmt.Sprint(len(args)), args...)
	if err != nil {
		return nil, Page{}, err
	}
	defer rows.Close()
	items := []DouyinScript{}
	for rows.Next() {
		var x DouyinScript
		var rawRules []byte
		if err := rows.Scan(&x.ID, &x.WorkspaceType, &x.WorkspaceID, &x.Identifier, &x.Name, &x.Platform, &x.MatchType, &x.MatchURL, &rawRules, &x.RunAt, &x.Priority, &x.LatestVersionID, &x.EffectiveVersionID, &x.Status, &x.Revision, &x.LatestVersion, &x.EffectiveVersion, &x.LatestJSBytes, &x.LatestCSSBytes, &x.UpdatedAt); err != nil {
			return nil, Page{}, err
		}
		x.MatchRules, err = decodeDouyinMatchRules(rawRules, x.MatchType, x.MatchURL)
		if err != nil {
			return nil, Page{}, err
		}
		items = append(items, x)
	}
	return items, Page{Page: p.Page, PageSize: p.PageSize, Total: total}, rows.Err()
}
func (s *Store) GetDouyinScript(ctx context.Context, wsType, wsID, id string) (DouyinScript, error) {
	var x DouyinScript
	var rawRules []byte
	err := s.db.QueryRowContext(ctx, `SELECT s.id,s.workspace_type,s.workspace_id,s.identifier,s.name,s.platform,s.match_type,s.match_url,COALESCE(s.match_rules,'[]'::jsonb),s.run_at,s.priority,COALESCE(s.latest_version_id,''),COALESCE(s.effective_version_id,''),s.status,s.revision,COALESCE(ls.version,lt.version,l.version,''),COALESCE(es.version,et.version,e.version,''),COALESCE(ls.source_bytes,l.js_bytes,0),COALESCE(lt.source_bytes,l.css_bytes,0),to_char(s.updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF') FROM ky_matrix_account_douyin_script s LEFT JOIN ky_matrix_account_douyin_script_version l ON l.id=s.latest_version_id LEFT JOIN ky_matrix_account_douyin_script_version e ON e.id=s.effective_version_id LEFT JOIN ky_matrix_account_douyin_script_asset_version ls ON ls.id=s.latest_script_asset_version_id LEFT JOIN ky_matrix_account_douyin_script_asset_version es ON es.id=s.effective_script_asset_version_id LEFT JOIN ky_matrix_account_douyin_script_asset_version lt ON lt.id=s.latest_style_asset_version_id LEFT JOIN ky_matrix_account_douyin_script_asset_version et ON et.id=s.effective_style_asset_version_id WHERE s.workspace_type=$1 AND s.workspace_id=$2 AND s.id=$3 AND s.deleted_at IS NULL`, wsType, wsID, id).Scan(&x.ID, &x.WorkspaceType, &x.WorkspaceID, &x.Identifier, &x.Name, &x.Platform, &x.MatchType, &x.MatchURL, &rawRules, &x.RunAt, &x.Priority, &x.LatestVersionID, &x.EffectiveVersionID, &x.Status, &x.Revision, &x.LatestVersion, &x.EffectiveVersion, &x.LatestJSBytes, &x.LatestCSSBytes, &x.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return x, ErrNotFound
	}
	if err != nil {
		return x, err
	}
	x.MatchRules, err = decodeDouyinMatchRules(rawRules, x.MatchType, x.MatchURL)
	return x, err
}
func (s *Store) CreateDouyinScript(ctx context.Context, wsType, wsID, user, key string, in DouyinScriptInput) (DouyinScript, error) {
	in, err := normalizeDouyinScriptInput(in)
	if err != nil {
		return DouyinScript{}, err
	}
	var existingID, existingHash string
	if err := s.db.QueryRowContext(ctx, `SELECT id,last_command_hash FROM ky_matrix_account_douyin_script WHERE workspace_type=$1 AND workspace_id=$2 AND last_command_key=$3 AND deleted_at IS NULL`, wsType, wsID, key).Scan(&existingID, &existingHash); err == nil {
		if existingHash != idemHash(in) {
			return DouyinScript{}, ErrConflict
		}
		return s.GetDouyinScript(ctx, wsType, wsID, existingID)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return DouyinScript{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DouyinScript{}, err
	}
	defer tx.Rollback()
	id := newID("mds")
	_, err = tx.ExecContext(ctx, `INSERT INTO ky_matrix_account_douyin_script(id,workspace_type,workspace_id,identifier,name,match_type,match_url,match_rules,run_at,priority,created_by,updated_by,last_command_key,last_command_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13)`, id, wsType, wsID, in.Identifier, in.Name, in.MatchType, in.MatchURL, mustEncodeDouyinRules(in.MatchRules), in.RunAt, *in.Priority, user, key, idemHash(in))
	if err != nil {
		return DouyinScript{}, classifyWriteErr(err)
	}
	if err = tx.Commit(); err != nil {
		return DouyinScript{}, err
	}
	return s.GetDouyinScript(ctx, wsType, wsID, id)
}
func (s *Store) UpdateDouyinScript(ctx context.Context, wsType, wsID, id, user, key string, expected int, in DouyinScriptInput) (DouyinScript, error) {
	originalRunAt, originalPriority := strings.TrimSpace(in.RunAt), in.Priority
	in, err := normalizeDouyinScriptUpdateInput(in)
	if err != nil {
		return DouyinScript{}, err
	}
	var existingHash string
	if err := s.db.QueryRowContext(ctx, `SELECT last_command_hash FROM ky_matrix_account_douyin_script WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND last_command_key=$4 AND deleted_at IS NULL`, id, wsType, wsID, key).Scan(&existingHash); err == nil {
		if existingHash != idemHash(in) {
			return DouyinScript{}, ErrConflict
		}
		return s.GetDouyinScript(ctx, wsType, wsID, id)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return DouyinScript{}, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script SET identifier=$1,name=$2,match_type=$3,match_url=$4,match_rules=$5,run_at=CASE WHEN $6<>'' THEN $6 ELSE 'document_start' END,priority=CASE WHEN $7::integer IS NOT NULL THEN $7::integer ELSE priority END,revision=revision+1,updated_by=$8,updated_at=now(),last_command_key=$9,last_command_hash=$10 WHERE id=$11 AND workspace_type=$12 AND workspace_id=$13 AND deleted_at IS NULL AND revision=$14 AND status<>'archived'`, in.Identifier, in.Name, in.MatchType, in.MatchURL, mustEncodeDouyinRules(in.MatchRules), originalRunAt, originalPriority, user, key, idemHash(in), id, wsType, wsID, expected)
	if err != nil {
		return DouyinScript{}, classifyWriteErr(err)
	}
	if err = affectedOrNotFound(res); err != nil {
		if errors.Is(err, ErrNotFound) {
			return DouyinScript{}, ErrConflict
		}
		return DouyinScript{}, err
	}
	return s.GetDouyinScript(ctx, wsType, wsID, id)
}
func (s *Store) UpdateDouyinScriptStatus(ctx context.Context, wsType, wsID, id, user, key string, expected int, status string) (DouyinScript, error) {
	if !validDouyinScriptValue(status, "enabled", "disabled", "archived") {
		return DouyinScript{}, ErrValidation
	}
	res, err := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script SET status=$1,revision=revision+1,updated_by=$2,updated_at=now(),last_command_key=$3,last_command_hash=$4 WHERE id=$5 AND workspace_type=$6 AND workspace_id=$7 AND revision=$8 AND deleted_at IS NULL`, status, user, key, idemHash(status), id, wsType, wsID, expected)
	if err != nil {
		return DouyinScript{}, classifyWriteErr(err)
	}
	if err = affectedOrNotFound(res); err != nil {
		return DouyinScript{}, ErrConflict
	}
	return s.GetDouyinScript(ctx, wsType, wsID, id)
}
func (s *Store) ListDouyinScriptVersions(ctx context.Context, wsType, wsID, scriptID string) ([]DouyinScriptVersion, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT v.id,v.script_id,v.version,v.js_bytes,v.css_bytes,v.content_sha256,v.status,v.revision,to_char(v.created_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),to_char(v.updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF') FROM ky_matrix_account_douyin_script_version v JOIN ky_matrix_account_douyin_script s ON s.id=v.script_id WHERE s.workspace_type=$1 AND s.workspace_id=$2 AND s.id=$3 ORDER BY v.created_at DESC`, wsType, wsID, scriptID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DouyinScriptVersion{}
	for rows.Next() {
		var x DouyinScriptVersion
		if err := rows.Scan(&x.ID, &x.ScriptID, &x.Version, &x.JSBytes, &x.CSSBytes, &x.ContentSHA256, &x.Status, &x.Revision, &x.CreatedAt, &x.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}
func (s *Store) GetDouyinScriptVersion(ctx context.Context, wsType, wsID, scriptID, versionID string, content bool) (DouyinScriptVersion, error) {
	var x DouyinScriptVersion
	q := `SELECT v.id,v.script_id,v.version,` + map[bool]string{true: "v.js_content,v.css_content", false: "'', ''"}[content] + `,v.js_bytes,v.css_bytes,v.content_sha256,v.status,v.revision,to_char(v.created_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),to_char(v.updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF') FROM ky_matrix_account_douyin_script_version v JOIN ky_matrix_account_douyin_script s ON s.id=v.script_id WHERE s.workspace_type=$1 AND s.workspace_id=$2 AND s.id=$3 AND v.id=$4`
	err := s.db.QueryRowContext(ctx, q, wsType, wsID, scriptID, versionID).Scan(&x.ID, &x.ScriptID, &x.Version, &x.JSContent, &x.CSSContent, &x.JSBytes, &x.CSSBytes, &x.ContentSHA256, &x.Status, &x.Revision, &x.CreatedAt, &x.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return x, ErrNotFound
	}
	return x, err
}
func (s *Store) CreateDouyinScriptVersion(ctx context.Context, wsType, wsID, scriptID, user, key string, in DouyinScriptVersionInput) (DouyinScriptVersion, error) {
	in, err := normalizeDouyinVersionInput(in)
	if err != nil {
		return DouyinScriptVersion{}, err
	}
	var existingID, existingHash string
	if err := s.db.QueryRowContext(ctx, `SELECT id,last_command_hash FROM ky_matrix_account_douyin_script_version WHERE script_id=$1 AND last_command_key=$2`, scriptID, key).Scan(&existingID, &existingHash); err == nil {
		if existingHash != idemHash(in) {
			return DouyinScriptVersion{}, ErrConflict
		}
		return s.GetDouyinScriptVersion(ctx, wsType, wsID, scriptID, existingID, false)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return DouyinScriptVersion{}, err
	}
	if _, err = s.GetDouyinScript(ctx, wsType, wsID, scriptID); err != nil {
		return DouyinScriptVersion{}, err
	}
	h := scriptHash(in)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DouyinScriptVersion{}, err
	}
	defer tx.Rollback()
	id := newID("mdsv")
	_, err = tx.ExecContext(ctx, `INSERT INTO ky_matrix_account_douyin_script_version(id,script_id,version,js_content,css_content,js_bytes,css_bytes,content_sha256,created_by,updated_by,last_command_key,last_command_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11)`, id, scriptID, in.Version, in.JSContent, in.CSSContent, len(in.JSContent), len(in.CSSContent), h, user, key, idemHash(in))
	if err != nil {
		return DouyinScriptVersion{}, classifyWriteErr(err)
	}
	_, err = tx.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script SET latest_version_id=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$3 AND workspace_type=$4 AND workspace_id=$5`, id, user, scriptID, wsType, wsID)
	if err != nil {
		return DouyinScriptVersion{}, classifyWriteErr(err)
	}
	if err = tx.Commit(); err != nil {
		return DouyinScriptVersion{}, err
	}
	return s.GetDouyinScriptVersion(ctx, wsType, wsID, scriptID, id, true)
}
func (s *Store) UpdateDouyinScriptVersion(ctx context.Context, wsType, wsID, scriptID, versionID, user, key string, expected int, in DouyinScriptVersionInput) (DouyinScriptVersion, error) {
	in, err := normalizeDouyinVersionInput(in)
	if err != nil {
		return DouyinScriptVersion{}, err
	}
	var existingHash string
	if err := s.db.QueryRowContext(ctx, `SELECT v.last_command_hash FROM ky_matrix_account_douyin_script_version v JOIN ky_matrix_account_douyin_script s ON s.id=v.script_id WHERE v.id=$1 AND v.script_id=$2 AND s.workspace_type=$3 AND s.workspace_id=$4 AND v.last_command_key=$5`, versionID, scriptID, wsType, wsID, key).Scan(&existingHash); err == nil {
		if existingHash != idemHash(in) {
			return DouyinScriptVersion{}, ErrConflict
		}
		return s.GetDouyinScriptVersion(ctx, wsType, wsID, scriptID, versionID, false)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return DouyinScriptVersion{}, err
	}
	h := scriptHash(in)
	res, err := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script_version v SET version=$1,js_content=$2,css_content=$3,js_bytes=$4,css_bytes=$5,content_sha256=$6,revision=revision+1,updated_by=$7,updated_at=now(),last_command_key=$8,last_command_hash=$9 FROM ky_matrix_account_douyin_script s WHERE v.id=$10 AND v.script_id=s.id AND s.workspace_type=$11 AND s.workspace_id=$12 AND v.revision=$13 AND v.status='draft'`, in.Version, in.JSContent, in.CSSContent, len(in.JSContent), len(in.CSSContent), h, user, key, idemHash(in), versionID, scriptID, wsType, wsID, expected)
	if err != nil {
		return DouyinScriptVersion{}, classifyWriteErr(err)
	}
	if err = affectedOrNotFound(res); err != nil {
		return DouyinScriptVersion{}, ErrConflict
	}
	return s.GetDouyinScriptVersion(ctx, wsType, wsID, scriptID, versionID, true)
}
func (s *Store) ReleaseDouyinScriptVersion(ctx context.Context, wsType, wsID, scriptID, versionID, user, key string, expected int) (DouyinScriptVersion, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script_version v SET status='released',revision=revision+1,updated_by=$1,updated_at=now(),last_command_key=$2,last_command_hash=$3 FROM ky_matrix_account_douyin_script s WHERE v.id=$4 AND v.script_id=s.id AND s.workspace_type=$5 AND s.workspace_id=$6 AND v.revision=$7 AND v.status='draft'`, user, key, idemHash("release"), versionID, scriptID, wsType, wsID, expected)
	if err != nil {
		return DouyinScriptVersion{}, classifyWriteErr(err)
	}
	if err = affectedOrNotFound(res); err != nil {
		return DouyinScriptVersion{}, ErrConflict
	}
	return s.GetDouyinScriptVersion(ctx, wsType, wsID, scriptID, versionID, false)
}
func (s *Store) ActivateDouyinScriptVersion(ctx context.Context, wsType, wsID, scriptID, versionID, user, key string, expected int) (DouyinScriptVersion, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DouyinScriptVersion{}, err
	}
	defer tx.Rollback()
	var status string
	if err = tx.QueryRowContext(ctx, `SELECT v.status FROM ky_matrix_account_douyin_script_version v JOIN ky_matrix_account_douyin_script s ON s.id=v.script_id WHERE v.id=$1 AND v.script_id=$2 AND s.workspace_type=$3 AND s.workspace_id=$4`, versionID, scriptID, wsType, wsID).Scan(&status); err != nil {
		return DouyinScriptVersion{}, classifyWriteErr(err)
	}
	if status != "released" {
		return DouyinScriptVersion{}, ErrConflict
	}
	res, err := tx.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script SET effective_version_id=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$3 AND workspace_type=$4 AND workspace_id=$5 AND revision=$6 AND deleted_at IS NULL`, versionID, user, scriptID, wsType, wsID, expected)
	if err != nil {
		return DouyinScriptVersion{}, err
	}
	if err = affectedOrNotFound(res); err != nil {
		return DouyinScriptVersion{}, ErrConflict
	}
	_, err = tx.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script_version SET status='active',revision=revision+1,updated_by=$1,updated_at=now() WHERE id=$2`, user, versionID)
	if err != nil {
		return DouyinScriptVersion{}, err
	}
	if err = tx.Commit(); err != nil {
		return DouyinScriptVersion{}, err
	}
	return s.GetDouyinScriptVersion(ctx, wsType, wsID, scriptID, versionID, false)
}
func (s *Store) ArchiveDouyinScriptVersion(ctx context.Context, wsType, wsID, scriptID, versionID, user, key string, expected int) (DouyinScriptVersion, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script_version v SET status='archived',revision=revision+1,updated_by=$1,updated_at=now() FROM ky_matrix_account_douyin_script s WHERE v.id=$2 AND v.script_id=s.id AND s.workspace_type=$3 AND s.workspace_id=$4 AND v.revision=$5 AND v.status<>'active'`, user, versionID, scriptID, wsType, wsID, expected)
	if err != nil {
		return DouyinScriptVersion{}, classifyWriteErr(err)
	}
	if err = affectedOrNotFound(res); err != nil {
		return DouyinScriptVersion{}, ErrConflict
	}
	return s.GetDouyinScriptVersion(ctx, wsType, wsID, scriptID, versionID, false)
}
