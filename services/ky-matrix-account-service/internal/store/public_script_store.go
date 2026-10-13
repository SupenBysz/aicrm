package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

const maxPublicScriptSourceBytes = 2_000_000

type PublicScript struct {
	ID            string                   `json:"id"`
	WorkspaceType string                   `json:"workspaceType"`
	WorkspaceID   string                   `json:"workspaceId"`
	Platform      string                   `json:"platform"`
	Name          string                   `json:"name"`
	Identifier    string                   `json:"identifier"`
	Description   string                   `json:"description"`
	SourceContent string                   `json:"sourceContent"`
	SourceChars   int                      `json:"sourceChars"`
	SourceBytes   int                      `json:"sourceBytes"`
	SourceSHA256  string                   `json:"sourceSha256"`
	Enabled       bool                     `json:"enabled"`
	Status        string                   `json:"status"`
	Revision      int                      `json:"revision"`
	CreatedAt     string                   `json:"createdAt"`
	UpdatedAt     string                   `json:"updatedAt"`
	CreatedBy     string                   `json:"createdBy"`
	UpdatedBy     string                   `json:"updatedBy"`
	Dependencies  []PublicScriptDependency `json:"dependencies"`
	DeletedAt     string                   `json:"deletedAt,omitempty"`
}

type PublicScriptDependency struct {
	Identifier string `json:"identifier"`
	Version    string `json:"version,omitempty"`
}

type PublicScriptInput struct {
	Name          string                   `json:"name"`
	Identifier    string                   `json:"identifier"`
	Platform      string                   `json:"platform"`
	Description   string                   `json:"description"`
	SourceContent string                   `json:"sourceContent"`
	Enabled       *bool                    `json:"enabled"`
	Dependencies  []PublicScriptDependency `json:"dependencies"`
}

type PublicScriptInputError struct {
	Field   string
	Message string
}

func (e *PublicScriptInputError) Error() string { return e.Message }
func (e *PublicScriptInputError) Unwrap() error { return ErrValidation }

func normalizePublicScriptInput(in PublicScriptInput, requireEnabled bool) (PublicScriptInput, error) {
	in.Name = strings.TrimSpace(in.Name)
	in.Identifier = strings.TrimSpace(in.Identifier)
	in.Description = strings.TrimSpace(in.Description)
	if in.Name == "" {
		return in, &PublicScriptInputError{Field: "name", Message: "名称不能为空"}
	}
	if utf8.RuneCountInString(in.Name) > 120 {
		return in, &PublicScriptInputError{Field: "name", Message: "名称不能超过120个字符"}
	}
	if in.Identifier == "" {
		return in, &PublicScriptInputError{Field: "identifier", Message: "标识符不能为空"}
	}
	if len(in.Identifier) > 64 {
		return in, &PublicScriptInputError{Field: "identifier", Message: "标识符不能超过64个字符"}
	}
	for i, r := range in.Identifier {
		valid := (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || (i > 0 && r == '_')
		if !valid {
			return in, &PublicScriptInputError{Field: "identifier", Message: "公共脚本标识符仅允许大写字母、数字和下划线，且必须以大写字母开头"}
		}
	}
	for _, reserved := range []string{"HOST", "PUBLIC", "LIFECYCLE", "VERSION", "CAPABILITIES", "REGISTER"} {
		if in.Identifier == reserved {
			return in, &PublicScriptInputError{Field: "identifier", Message: "公共脚本标识符保留不可使用"}
		}
	}
	in.Platform = strings.ToLower(strings.TrimSpace(in.Platform))
	if in.Platform == "" {
		in.Platform = "douyin"
	}
	if !ValidScriptRuntimePlatform(in.Platform) {
		return in, &PublicScriptInputError{Field: "platform", Message: "平台标识无效"}
	}
	seen := make(map[string]struct{}, len(in.Dependencies))
	for _, dep := range in.Dependencies {
		if dep.Identifier == in.Identifier || !validPublicScriptIdentifier(dep.Identifier) {
			return in, &PublicScriptInputError{Field: "dependencies", Message: "公共脚本依赖标识符无效或不能依赖自身"}
		}
		if _, ok := seen[dep.Identifier]; ok {
			return in, &PublicScriptInputError{Field: "dependencies", Message: "公共脚本依赖不能重复"}
		}
		seen[dep.Identifier] = struct{}{}
		if dep.Version != "" && dep.Version != "latest" {
			parts := strings.Split(dep.Version, ".")
			if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
				return in, &PublicScriptInputError{Field: "dependencies", Message: "公共脚本依赖版本必须是 latest 或 SemVer"}
			}
		}
	}
	if !utf8.ValidString(in.SourceContent) {
		return in, &PublicScriptInputError{Field: "sourceContent", Message: "源码必须是有效的 UTF-8 文本"}
	}
	if len(in.SourceContent) > maxPublicScriptSourceBytes {
		return in, &PublicScriptInputError{Field: "sourceContent", Message: "源码不能超过2MB"}
	}
	if requireEnabled && in.Enabled == nil {
		return in, &PublicScriptInputError{Field: "enabled", Message: "编辑公共脚本时必须提供启用状态"}
	}
	if in.Enabled == nil {
		enabled := true
		in.Enabled = &enabled
	}
	return in, nil
}

func validPublicScriptIdentifier(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for i, r := range value {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9' && i > 0) || (r == '_' && i > 0) {
			continue
		}
		return false
	}
	return value[0] >= 'A' && value[0] <= 'Z'
}

// ValidPublicScriptIdentifier 用于运行时入口在读取数据库前校验公共脚本选择器。
func ValidPublicScriptIdentifier(value string) bool { return validPublicScriptIdentifier(value) }

func publicScriptHash(source string) string {
	sum := sha256.Sum256([]byte(source))
	return hex.EncodeToString(sum[:])
}

func publicScriptIdemHash(in PublicScriptInput) string {
	deps, _ := json.Marshal(in.Dependencies)
	return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%s\x00%s\x00%s\x00%t", in.Name, in.Identifier, in.Description, in.SourceContent, deps, *in.Enabled))))
}

func publicScriptDependenciesJSON(dependencies []PublicScriptDependency) []byte {
	if dependencies == nil {
		return []byte("[]")
	}
	b, _ := json.Marshal(dependencies)
	return b
}

func decodePublicScriptDependencies(raw []byte) []PublicScriptDependency {
	var out []PublicScriptDependency
	if len(raw) == 0 || json.Unmarshal(raw, &out) != nil {
		return []PublicScriptDependency{}
	}
	return out
}

type PublicScriptListParams struct {
	WorkspaceType string
	WorkspaceID   string
	Keyword       string
	Status        string
	Page          int
	PageSize      int
}

func (s *Store) ListPublicScripts(ctx context.Context, p PublicScriptListParams) ([]PublicScript, Page, error) {
	if p.Page < 1 {
		p.Page = 1
	}
	if p.PageSize < 1 || p.PageSize > 100 {
		p.PageSize = 20
	}
	args := []any{p.WorkspaceType, p.WorkspaceID}
	where := []string{"workspace_type=$1", "workspace_id=$2", "deleted_at IS NULL"}
	if p.Keyword != "" {
		args = append(args, "%"+p.Keyword+"%")
		where = append(where, fmt.Sprintf("(name ILIKE $%d OR identifier ILIKE $%d OR description ILIKE $%d)", len(args), len(args), len(args)))
	}
	if p.Status != "" {
		if p.Status != "enabled" && p.Status != "disabled" {
			return nil, Page{}, &PublicScriptInputError{Field: "status", Message: "状态必须是 enabled 或 disabled"}
		}
		args = append(args, p.Status == "enabled")
		where = append(where, fmt.Sprintf("enabled=$%d", len(args)))
	}
	whereSQL := strings.Join(where, " AND ")
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM ky_matrix_account_public_script WHERE "+whereSQL, args...).Scan(&total); err != nil {
		return nil, Page{}, err
	}
	offset := (p.Page - 1) * p.PageSize
	args = append(args, p.PageSize, offset)
	rows, err := s.db.QueryContext(ctx, `SELECT id,workspace_type,workspace_id,platform,name,identifier,description,source_content,source_chars,source_bytes,source_sha256,enabled,revision,to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),COALESCE(created_by,''),COALESCE(updated_by,''),COALESCE(dependencies,'[]'::jsonb) FROM ky_matrix_account_public_script WHERE `+whereSQL+` ORDER BY updated_at DESC,id DESC LIMIT $`+fmt.Sprint(len(args)-1)+` OFFSET $`+fmt.Sprint(len(args)), args...)
	if err != nil {
		return nil, Page{}, err
	}
	defer rows.Close()
	items := make([]PublicScript, 0)
	for rows.Next() {
		var item PublicScript
		var rawDependencies []byte
		if err := rows.Scan(&item.ID, &item.WorkspaceType, &item.WorkspaceID, &item.Platform, &item.Name, &item.Identifier, &item.Description, &item.SourceContent, &item.SourceChars, &item.SourceBytes, &item.SourceSHA256, &item.Enabled, &item.Revision, &item.CreatedAt, &item.UpdatedAt, &item.CreatedBy, &item.UpdatedBy, &rawDependencies); err != nil {
			return nil, Page{}, err
		}
		item.Dependencies = decodePublicScriptDependencies(rawDependencies)
		item.Status = publicScriptStatus(item.Enabled)
		items = append(items, item)
	}
	return items, Page{Page: p.Page, PageSize: p.PageSize, Total: total}, rows.Err()
}

func publicScriptStatus(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "disabled"
}

func (s *Store) GetPublicScript(ctx context.Context, wsType, wsID, id string) (PublicScript, error) {
	var item PublicScript
	var rawDependencies []byte
	err := s.db.QueryRowContext(ctx, `SELECT id,workspace_type,workspace_id,platform,name,identifier,description,source_content,source_chars,source_bytes,source_sha256,enabled,revision,to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),COALESCE(created_by,''),COALESCE(updated_by,''),COALESCE(dependencies,'[]'::jsonb) FROM ky_matrix_account_public_script WHERE workspace_type=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL`, wsType, wsID, id).Scan(&item.ID, &item.WorkspaceType, &item.WorkspaceID, &item.Platform, &item.Name, &item.Identifier, &item.Description, &item.SourceContent, &item.SourceChars, &item.SourceBytes, &item.SourceSHA256, &item.Enabled, &item.Revision, &item.CreatedAt, &item.UpdatedAt, &item.CreatedBy, &item.UpdatedBy, &rawDependencies)
	if errors.Is(err, sql.ErrNoRows) {
		return PublicScript{}, ErrNotFound
	}
	if err != nil {
		return PublicScript{}, err
	}
	item.Dependencies = decodePublicScriptDependencies(rawDependencies)
	item.Status = publicScriptStatus(item.Enabled)
	return item, nil
}

func (s *Store) CreatePublicScript(ctx context.Context, wsType, wsID, user, key string, in PublicScriptInput) (PublicScript, error) {
	in, err := normalizePublicScriptInput(in, false)
	if err != nil {
		return PublicScript{}, err
	}
	hash := publicScriptIdemHash(in)
	var existingID, existingHash string
	err = s.db.QueryRowContext(ctx, `SELECT id,last_command_hash FROM ky_matrix_account_public_script WHERE workspace_type=$1 AND workspace_id=$2 AND last_command_key=$3 AND deleted_at IS NULL`, wsType, wsID, key).Scan(&existingID, &existingHash)
	if err == nil {
		if existingHash != hash {
			return PublicScript{}, ErrConflict
		}
		return s.GetPublicScript(ctx, wsType, wsID, existingID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return PublicScript{}, err
	}
	id := newID("mps")
	_, err = s.db.ExecContext(ctx, `INSERT INTO ky_matrix_account_public_script(id,workspace_type,workspace_id,platform,name,identifier,description,source_content,source_chars,source_bytes,source_sha256,enabled,dependencies,created_by,updated_by,last_command_key,last_command_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16)`, id, wsType, wsID, in.Platform, in.Name, in.Identifier, in.Description, in.SourceContent, utf8.RuneCountInString(in.SourceContent), len([]byte(in.SourceContent)), publicScriptHash(in.SourceContent), *in.Enabled, publicScriptDependenciesJSON(in.Dependencies), user, key, hash)
	if err != nil {
		return PublicScript{}, classifyWriteErr(err)
	}
	return s.GetPublicScript(ctx, wsType, wsID, id)
}

func (s *Store) UpdatePublicScript(ctx context.Context, wsType, wsID, id, user, key string, expected int, in PublicScriptInput) (PublicScript, error) {
	in, err := normalizePublicScriptInput(in, true)
	if err != nil {
		return PublicScript{}, err
	}
	hash := publicScriptIdemHash(in)
	var existingHash string
	err = s.db.QueryRowContext(ctx, `SELECT last_command_hash FROM ky_matrix_account_public_script WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND last_command_key=$4 AND deleted_at IS NULL`, id, wsType, wsID, key).Scan(&existingHash)
	if err == nil {
		if existingHash != hash {
			return PublicScript{}, ErrConflict
		}
		return s.GetPublicScript(ctx, wsType, wsID, id)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return PublicScript{}, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_public_script SET platform=$1,name=$2,identifier=$3,description=$4,source_content=$5,source_chars=$6,source_bytes=$7,source_sha256=$8,enabled=$9,dependencies=$10,revision=revision+1,updated_by=$11,updated_at=now(),last_command_key=$12,last_command_hash=$13 WHERE id=$14 AND workspace_type=$15 AND workspace_id=$16 AND deleted_at IS NULL AND revision=$17`, in.Platform, in.Name, in.Identifier, in.Description, in.SourceContent, utf8.RuneCountInString(in.SourceContent), len([]byte(in.SourceContent)), publicScriptHash(in.SourceContent), *in.Enabled, publicScriptDependenciesJSON(in.Dependencies), user, key, hash, id, wsType, wsID, expected)
	if err != nil {
		return PublicScript{}, classifyWriteErr(err)
	}
	if err := affectedOrNotFound(res); err != nil {
		return PublicScript{}, ErrConflict
	}
	return s.GetPublicScript(ctx, wsType, wsID, id)
}

func (s *Store) UpdatePublicScriptStatus(ctx context.Context, wsType, wsID, id, user, key string, expected int, status string) (PublicScript, error) {
	if status != "enabled" && status != "disabled" {
		return PublicScript{}, &PublicScriptInputError{Field: "status", Message: "状态必须是 enabled 或 disabled"}
	}
	enabled := status == "enabled"
	res, err := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_public_script SET enabled=$1,revision=revision+1,updated_by=$2,updated_at=now(),last_command_key=$3,last_command_hash=$4 WHERE id=$5 AND workspace_type=$6 AND workspace_id=$7 AND deleted_at IS NULL AND revision=$8`, enabled, user, key, idemHash(status), id, wsType, wsID, expected)
	if err != nil {
		return PublicScript{}, classifyWriteErr(err)
	}
	if err := affectedOrNotFound(res); err != nil {
		return PublicScript{}, ErrConflict
	}
	return s.GetPublicScript(ctx, wsType, wsID, id)
}

func (s *Store) DeletePublicScript(ctx context.Context, wsType, wsID, id, user, key string, expected int) error {
	var existingHash string
	err := s.db.QueryRowContext(ctx, `SELECT last_command_hash FROM ky_matrix_account_public_script WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND last_command_key=$4`, id, wsType, wsID, key).Scan(&existingHash)
	if err == nil {
		if existingHash != idemHash("delete") {
			return ErrConflict
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_public_script SET deleted_at=now(),revision=revision+1,updated_by=$1,updated_at=now(),last_command_key=$2,last_command_hash=$3 WHERE id=$4 AND workspace_type=$5 AND workspace_id=$6 AND deleted_at IS NULL AND revision=$7`, user, key, idemHash("delete"), id, wsType, wsID, expected)
	if err != nil {
		return classifyWriteErr(err)
	}
	if err := affectedOrNotFound(res); err != nil {
		return ErrConflict
	}
	return nil
}
