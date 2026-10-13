package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/matcher"
)

const maxPublicStyleSourceBytes = 2_000_000

type PublicStyle struct {
	ID            string `json:"id"`
	WorkspaceType string `json:"workspaceType"`
	WorkspaceID   string `json:"workspaceId"`
	Platform      string `json:"platform"`
	Name          string `json:"name"`
	Identifier    string `json:"identifier"`
	Description   string `json:"description"`
	MatchType     string `json:"matchType"`
	MatchURL      string `json:"matchUrl"`
	SourceContent string `json:"sourceContent"`
	SourceChars   int    `json:"sourceChars"`
	SourceBytes   int    `json:"sourceBytes"`
	SourceSHA256  string `json:"sourceSha256"`
	RunAt         string `json:"runAt"`
	Priority      int    `json:"priority"`
	Enabled       bool   `json:"enabled"`
	Status        string `json:"status"`
	Revision      int    `json:"revision"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
	CreatedBy     string `json:"createdBy"`
	UpdatedBy     string `json:"updatedBy"`
}
type PublicStyleInput struct {
	Name          string `json:"name"`
	Identifier    string `json:"identifier"`
	Platform      string `json:"platform"`
	Description   string `json:"description"`
	MatchType     string `json:"matchType"`
	MatchURL      string `json:"matchUrl"`
	SourceContent string `json:"sourceContent"`
	RunAt         string `json:"runAt"`
	Priority      *int   `json:"priority"`
	Enabled       *bool  `json:"enabled"`
}
type PublicStyleInputError struct {
	Field   string
	Message string
}

func (e *PublicStyleInputError) Error() string { return e.Message }
func (e *PublicStyleInputError) Unwrap() error { return ErrValidation }
func normalizePublicStyleInput(in PublicStyleInput, requireEnabled bool) (PublicStyleInput, error) {
	in.Name = strings.TrimSpace(in.Name)
	in.Identifier = strings.TrimSpace(in.Identifier)
	in.Description = strings.TrimSpace(in.Description)
	in.Platform = strings.ToLower(strings.TrimSpace(in.Platform))
	in.MatchType = strings.TrimSpace(in.MatchType)
	in.MatchURL = strings.TrimSpace(in.MatchURL)
	in.RunAt = strings.TrimSpace(in.RunAt)
	if in.Name == "" {
		return in, &PublicStyleInputError{"name", "名称不能为空"}
	}
	if utf8.RuneCountInString(in.Name) > 120 {
		return in, &PublicStyleInputError{"name", "名称不能超过120个字符"}
	}
	if !validPublicScriptIdentifier(in.Identifier) {
		return in, &PublicStyleInputError{"identifier", "标识符格式无效"}
	}
	if in.Platform == "" {
		in.Platform = "douyin"
	}
	if !ValidScriptRuntimePlatform(in.Platform) {
		return in, &PublicStyleInputError{"platform", "平台标识无效"}
	}
	if in.MatchType == "" {
		in.MatchType = "wildcard"
	}
	if in.MatchType != "exact" && in.MatchType != "wildcard" {
		return in, &PublicStyleInputError{"matchType", "匹配方式无效"}
	}
	if _, err := matcher.Validate(in.MatchType, in.MatchURL); err != nil {
		return in, &PublicStyleInputError{"matchUrl", "匹配 URL 无效"}
	}
	if in.RunAt == "" {
		in.RunAt = "document_start"
	}
	if in.RunAt != "document_start" && in.RunAt != "dom_content_loaded" && in.RunAt != "document_idle" && in.RunAt != "spa_route_change" {
		return in, &PublicStyleInputError{"runAt", "样式注入时机无效"}
	}
	if in.Priority == nil {
		v := 0
		in.Priority = &v
	}
	if *in.Priority < -10000 || *in.Priority > 10000 {
		return in, &PublicStyleInputError{"priority", "优先级必须在 -10000 至 10000 之间"}
	}
	if !utf8.ValidString(in.SourceContent) {
		return in, &PublicStyleInputError{"sourceContent", "样式必须是有效的 UTF-8 文本"}
	}
	if len([]byte(in.SourceContent)) > maxPublicStyleSourceBytes {
		return in, &PublicStyleInputError{"sourceContent", "样式不能超过2MB"}
	}
	if requireEnabled && in.Enabled == nil {
		return in, &PublicStyleInputError{"enabled", "编辑公共样式时必须提供启用状态"}
	}
	if in.Enabled == nil {
		v := true
		in.Enabled = &v
	}
	return in, nil
}
func publicStyleHash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func publicStyleIdemHash(in PublicStyleInput) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%s\x00%s\x00%s\x00%s\x00%d\x00%t", in.Name, in.Identifier, in.Description, in.MatchType, in.MatchURL, in.SourceContent, *in.Priority, *in.Enabled))))
}
func publicStyleStringHash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func publicStyleStatus(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "disabled"
}

type PublicStyleListParams struct {
	WorkspaceType, WorkspaceID, Platform, Keyword, Status string
	Page, PageSize                                        int
}

const publicStyleSelect = `SELECT id,workspace_type,workspace_id,platform,name,identifier,description,match_type,match_url,source_content,source_chars,source_bytes,source_sha256,run_at,priority,enabled,status,revision,to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),COALESCE(created_by,''),COALESCE(updated_by,'') FROM ky_matrix_account_public_style `

func scanPublicStyle(row interface{ Scan(...any) error }) (PublicStyle, error) {
	var x PublicStyle
	err := row.Scan(&x.ID, &x.WorkspaceType, &x.WorkspaceID, &x.Platform, &x.Name, &x.Identifier, &x.Description, &x.MatchType, &x.MatchURL, &x.SourceContent, &x.SourceChars, &x.SourceBytes, &x.SourceSHA256, &x.RunAt, &x.Priority, &x.Enabled, &x.Status, &x.Revision, &x.CreatedAt, &x.UpdatedAt, &x.CreatedBy, &x.UpdatedBy)
	return x, err
}
func (s *Store) ListPublicStyles(ctx context.Context, p PublicStyleListParams) ([]PublicStyle, Page, error) {
	if p.Page < 1 {
		p.Page = 1
	}
	if p.PageSize < 1 || p.PageSize > 100 {
		p.PageSize = 20
	}
	args := []any{p.WorkspaceType, p.WorkspaceID, p.Platform}
	where := []string{"workspace_type=$1", "workspace_id=$2", "platform=$3", "deleted_at IS NULL"}
	if p.Keyword != "" {
		args = append(args, "%"+p.Keyword+"%")
		where = append(where, fmt.Sprintf("(name ILIKE $%d OR identifier ILIKE $%d OR description ILIKE $%d)", len(args), len(args), len(args)))
	}
	if p.Status != "" {
		if p.Status != "enabled" && p.Status != "disabled" {
			return nil, Page{}, &PublicStyleInputError{"status", "状态必须是 enabled 或 disabled"}
		}
		args = append(args, p.Status == "enabled")
		where = append(where, fmt.Sprintf("enabled=$%d", len(args)))
	}
	w := strings.Join(where, " AND ")
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM ky_matrix_account_public_style WHERE "+w, args...).Scan(&total); err != nil {
		return nil, Page{}, err
	}
	args = append(args, p.PageSize, (p.Page-1)*p.PageSize)
	rows, err := s.db.QueryContext(ctx, publicStyleSelect+"WHERE "+w+" ORDER BY updated_at DESC,id DESC LIMIT $"+fmt.Sprint(len(args)-1)+" OFFSET $"+fmt.Sprint(len(args)), args...)
	if err != nil {
		return nil, Page{}, err
	}
	defer rows.Close()
	out := []PublicStyle{}
	for rows.Next() {
		x, e := scanPublicStyle(rows)
		if e != nil {
			return nil, Page{}, e
		}
		out = append(out, x)
	}
	return out, Page{Page: p.Page, PageSize: p.PageSize, Total: total}, rows.Err()
}
func (s *Store) GetPublicStyle(ctx context.Context, wsType, wsID, id string) (PublicStyle, error) {
	x, e := scanPublicStyle(s.db.QueryRowContext(ctx, publicStyleSelect+"WHERE workspace_type=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL", wsType, wsID, id))
	if errors.Is(e, sql.ErrNoRows) {
		return PublicStyle{}, ErrNotFound
	}
	return x, e
}
func (s *Store) CreatePublicStyle(ctx context.Context, wsType, wsID, user, key string, in PublicStyleInput) (PublicStyle, error) {
	in, e := normalizePublicStyleInput(in, false)
	if e != nil {
		return PublicStyle{}, e
	}
	h := publicStyleIdemHash(in)
	var id, old string
	e = s.db.QueryRowContext(ctx, "SELECT id,last_command_hash FROM ky_matrix_account_public_style WHERE workspace_type=$1 AND workspace_id=$2 AND last_command_key=$3 AND deleted_at IS NULL", wsType, wsID, key).Scan(&id, &old)
	if e == nil {
		if old != h {
			return PublicStyle{}, ErrConflict
		}
		return s.GetPublicStyle(ctx, wsType, wsID, id)
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return PublicStyle{}, e
	}
	id = newID("mpss")
	_, e = s.db.ExecContext(ctx, `INSERT INTO ky_matrix_account_public_style(id,workspace_type,workspace_id,platform,name,identifier,description,match_type,match_url,source_content,source_chars,source_bytes,source_sha256,run_at,priority,enabled,status,created_by,updated_by,last_command_key,last_command_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'enabled',$18,$18,$19,$20)`, id, wsType, wsID, in.Platform, in.Name, in.Identifier, in.Description, in.MatchType, in.MatchURL, in.SourceContent, utf8.RuneCountInString(in.SourceContent), len([]byte(in.SourceContent)), publicStyleHash(in.SourceContent), in.RunAt, *in.Priority, *in.Enabled, user, key, h)
	if e != nil {
		return PublicStyle{}, classifyWriteErr(e)
	}
	return s.GetPublicStyle(ctx, wsType, wsID, id)
}
func (s *Store) UpdatePublicStyle(ctx context.Context, wsType, wsID, id, user, key string, expected int, in PublicStyleInput) (PublicStyle, error) {
	in, e := normalizePublicStyleInput(in, true)
	if e != nil {
		return PublicStyle{}, e
	}
	h := publicStyleIdemHash(in)
	var old string
	e = s.db.QueryRowContext(ctx, "SELECT last_command_hash FROM ky_matrix_account_public_style WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND last_command_key=$4 AND deleted_at IS NULL", id, wsType, wsID, key).Scan(&old)
	if e == nil {
		if old != h {
			return PublicStyle{}, ErrConflict
		}
		return s.GetPublicStyle(ctx, wsType, wsID, id)
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return PublicStyle{}, e
	}
	res, e := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_public_style SET name=$1,identifier=$2,description=$3,match_type=$4,match_url=$5,source_content=$6,source_chars=$7,source_bytes=$8,source_sha256=$9,run_at=$10,priority=$11,enabled=$12,status=CASE WHEN $12 THEN 'enabled' ELSE 'disabled' END,revision=revision+1,updated_by=$13,updated_at=now(),last_command_key=$14,last_command_hash=$15 WHERE id=$16 AND workspace_type=$17 AND workspace_id=$18 AND deleted_at IS NULL AND revision=$19`, in.Name, in.Identifier, in.Description, in.MatchType, in.MatchURL, in.SourceContent, utf8.RuneCountInString(in.SourceContent), len([]byte(in.SourceContent)), publicStyleHash(in.SourceContent), in.RunAt, *in.Priority, *in.Enabled, user, key, h, id, wsType, wsID, expected)
	if e != nil {
		return PublicStyle{}, classifyWriteErr(e)
	}
	if e = affectedOrNotFound(res); e != nil {
		return PublicStyle{}, ErrConflict
	}
	return s.GetPublicStyle(ctx, wsType, wsID, id)
}
func (s *Store) UpdatePublicStyleStatus(ctx context.Context, wsType, wsID, id, user, key string, expected int, status string) (PublicStyle, error) {
	if status != "enabled" && status != "disabled" {
		return PublicStyle{}, &PublicStyleInputError{"status", "状态必须是 enabled 或 disabled"}
	}
	en := status == "enabled"
	res, e := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_public_style SET enabled=$1,status=$2,revision=revision+1,updated_by=$3,updated_at=now(),last_command_key=$4,last_command_hash=$5 WHERE id=$6 AND workspace_type=$7 AND workspace_id=$8 AND deleted_at IS NULL AND revision=$9`, en, status, user, key, publicStyleStringHash(status), id, wsType, wsID, expected)
	if e != nil {
		return PublicStyle{}, classifyWriteErr(e)
	}
	if e = affectedOrNotFound(res); e != nil {
		return PublicStyle{}, ErrConflict
	}
	return s.GetPublicStyle(ctx, wsType, wsID, id)
}
func (s *Store) DeletePublicStyle(ctx context.Context, wsType, wsID, id, user, key string, expected int) error {
	res, e := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_public_style SET deleted_at=now(),revision=revision+1,updated_by=$1,updated_at=now(),last_command_key=$2,last_command_hash=$3 WHERE id=$4 AND workspace_type=$5 AND workspace_id=$6 AND deleted_at IS NULL AND revision=$7`, user, key, publicStyleStringHash("delete"), id, wsType, wsID, expected)
	if e != nil {
		return classifyWriteErr(e)
	}
	if e = affectedOrNotFound(res); e != nil {
		return ErrConflict
	}
	return nil
}
