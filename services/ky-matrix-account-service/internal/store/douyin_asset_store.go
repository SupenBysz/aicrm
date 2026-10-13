package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

type DouyinAssetVersion struct {
	ID            string `json:"id"`
	ScriptID      string `json:"scriptId"`
	AssetType     string `json:"assetType"`
	Version       string `json:"version"`
	SourceContent string `json:"sourceContent,omitempty"`
	SourceBytes   int    `json:"sourceBytes"`
	SourceChars   int    `json:"sourceChars"`
	SourceSHA256  string `json:"sourceSha256"`
	RunAt         string `json:"runAt"`
	Priority      int    `json:"priority"`
	Enabled       bool   `json:"enabled"`
	Status        string `json:"status"`
	Revision      int    `json:"revision"`
	CreatedBy     string `json:"createdBy,omitempty"`
	CreatedByName string `json:"createdByName,omitempty"`
	UpdatedBy     string `json:"updatedBy,omitempty"`
	UpdatedByName string `json:"updatedByName,omitempty"`
	PublishedAt   string `json:"publishedAt,omitempty"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
}

type DouyinAssetInput struct {
	AssetType     string `json:"assetType"`
	Version       string `json:"version"`
	SourceContent string `json:"sourceContent"`
	RunAt         string `json:"runAt,omitempty"`
	Priority      *int   `json:"priority,omitempty"`
	Enabled       *bool  `json:"enabled,omitempty"`
}

func nullableAssetRunAt(in DouyinAssetInput) any {
	if in.AssetType != "style" || in.RunAt == "" {
		return nil
	}
	return in.RunAt
}
func nullableAssetPriority(in DouyinAssetInput) any {
	if in.AssetType != "style" || in.Priority == nil {
		return nil
	}
	return *in.Priority
}
func nullableAssetEnabled(in DouyinAssetInput) any {
	if in.AssetType != "style" || in.Enabled == nil {
		return nil
	}
	return *in.Enabled
}

func normalizeDouyinAssetInput(in DouyinAssetInput) (DouyinAssetInput, error) {
	in.AssetType, in.Version = strings.TrimSpace(in.AssetType), strings.TrimSpace(in.Version)
	if in.AssetType != "script" && in.AssetType != "style" || in.Version == "" || len(in.SourceContent) > 2_000_000 {
		return in, ErrValidation
	}
	if in.AssetType == "style" {
		if in.RunAt == "" {
			in.RunAt = "document_start"
		}
		if in.Priority == nil {
			priority := 0
			in.Priority = &priority
		}
		if in.Enabled == nil {
			enabled := true
			in.Enabled = &enabled
		}
		if in.RunAt != "document_start" && in.RunAt != "dom_content_loaded" && in.RunAt != "document_idle" && in.RunAt != "spa_route_change" {
			return in, ErrValidation
		}
		if *in.Priority < -10000 || *in.Priority > 10000 {
			return in, ErrValidation
		}
	}
	parts := strings.Split(in.Version, ".")
	if len(parts) != 3 {
		return in, ErrValidation
	}
	for _, part := range parts {
		if part == "" {
			return in, ErrValidation
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return in, ErrValidation
			}
		}
	}
	return in, nil
}

// normalizeDouyinStyleMetadata 校验已发布样式允许修改的运行时元数据。
func normalizeDouyinStyleMetadata(in DouyinAssetInput) error {
	if in.AssetType != "style" || in.RunAt == "" || in.Priority == nil || in.Enabled == nil {
		return ErrValidation
	}
	if in.RunAt != "document_start" && in.RunAt != "dom_content_loaded" && in.RunAt != "document_idle" && in.RunAt != "spa_route_change" {
		return ErrValidation
	}
	if *in.Priority < -10000 || *in.Priority > 10000 {
		return ErrValidation
	}
	return nil
}

func assetHash(content string) string {
	h := sha256.Sum256([]byte(content))
	return hex.EncodeToString(h[:])
}

func (s *Store) ListDouyinAssets(ctx context.Context, wsType, wsID, scriptID, assetType string) ([]DouyinAssetVersion, error) {
	if assetType != "script" && assetType != "style" {
		return nil, ErrValidation
	}
	rows, err := s.db.QueryContext(ctx, `SELECT v.id,v.script_id,v.asset_type,v.version,v.source_bytes,char_length(v.source_content),v.source_sha256,COALESCE(v.run_at,s.run_at),COALESCE(v.priority,s.priority),COALESCE(v.enabled,true),v.status,v.revision,COALESCE(v.created_by,''),COALESCE(cu.display_name,''),COALESCE(v.updated_by,''),COALESCE(uu.display_name,''),COALESCE(to_char(v.published_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),''),to_char(v.created_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),to_char(v.updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF')
FROM ky_matrix_account_douyin_script_asset_version v JOIN ky_matrix_account_douyin_script s ON s.id=v.script_id
LEFT JOIN public.ky_user cu ON cu.id=v.created_by LEFT JOIN public.ky_user uu ON uu.id=v.updated_by
WHERE s.workspace_type=$1 AND s.workspace_id=$2 AND s.id=$3 AND v.asset_type=$4 AND v.status<>'archived' ORDER BY v.created_at DESC,v.id DESC`, wsType, wsID, scriptID, assetType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DouyinAssetVersion{}
	for rows.Next() {
		var item DouyinAssetVersion
		if err := rows.Scan(&item.ID, &item.ScriptID, &item.AssetType, &item.Version, &item.SourceBytes, &item.SourceChars, &item.SourceSHA256, &item.RunAt, &item.Priority, &item.Enabled, &item.Status, &item.Revision, &item.CreatedBy, &item.CreatedByName, &item.UpdatedBy, &item.UpdatedByName, &item.PublishedAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) GetDouyinAsset(ctx context.Context, wsType, wsID, scriptID, assetID string, content bool) (DouyinAssetVersion, error) {
	var item DouyinAssetVersion
	contentColumn := "''"
	if content {
		contentColumn = "v.source_content"
	}
	err := s.db.QueryRowContext(ctx, `SELECT v.id,v.script_id,v.asset_type,v.version,`+contentColumn+`,v.source_bytes,char_length(v.source_content),v.source_sha256,COALESCE(v.run_at,s.run_at),COALESCE(v.priority,s.priority),COALESCE(v.enabled,true),v.status,v.revision,COALESCE(v.created_by,''),COALESCE(cu.display_name,''),COALESCE(v.updated_by,''),COALESCE(uu.display_name,''),COALESCE(to_char(v.published_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),''),to_char(v.created_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),to_char(v.updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF')
FROM ky_matrix_account_douyin_script_asset_version v JOIN ky_matrix_account_douyin_script s ON s.id=v.script_id
LEFT JOIN public.ky_user cu ON cu.id=v.created_by LEFT JOIN public.ky_user uu ON uu.id=v.updated_by
WHERE s.workspace_type=$1 AND s.workspace_id=$2 AND v.script_id=$3 AND v.id=$4`, wsType, wsID, scriptID, assetID).
		Scan(&item.ID, &item.ScriptID, &item.AssetType, &item.Version, &item.SourceContent, &item.SourceBytes, &item.SourceChars, &item.SourceSHA256, &item.RunAt, &item.Priority, &item.Enabled, &item.Status, &item.Revision, &item.CreatedBy, &item.CreatedByName, &item.UpdatedBy, &item.UpdatedByName, &item.PublishedAt, &item.CreatedAt, &item.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return DouyinAssetVersion{}, ErrNotFound
	}
	return item, err
}

func (s *Store) CreateDouyinAsset(ctx context.Context, wsType, wsID, scriptID, user, key string, in DouyinAssetInput) (DouyinAssetVersion, error) {
	in, err := normalizeDouyinAssetInput(in)
	if err != nil {
		return DouyinAssetVersion{}, err
	}
	if _, err := s.GetDouyinScript(ctx, wsType, wsID, scriptID); err != nil {
		return DouyinAssetVersion{}, err
	}
	hash := assetHash(in.SourceContent)
	var existingID, existingHash string
	err = s.db.QueryRowContext(ctx, `SELECT id,last_command_hash FROM ky_matrix_account_douyin_script_asset_version WHERE script_id=$1 AND asset_type=$2 AND last_command_key=$3`, scriptID, in.AssetType, key).Scan(&existingID, &existingHash)
	if err == nil {
		if existingHash != idemHash(in) {
			return DouyinAssetVersion{}, ErrConflict
		}
		return s.GetDouyinAsset(ctx, wsType, wsID, scriptID, existingID, true)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return DouyinAssetVersion{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DouyinAssetVersion{}, err
	}
	defer tx.Rollback()
	id := newID("mdsa")
	if _, err = tx.ExecContext(ctx, `INSERT INTO ky_matrix_account_douyin_script_asset_version(id,script_id,asset_type,version,source_content,source_bytes,source_sha256,run_at,priority,enabled,created_by,updated_by,last_command_key,last_command_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13)`, id, scriptID, in.AssetType, in.Version, in.SourceContent, len(in.SourceContent), hash, nullableAssetRunAt(in), nullableAssetPriority(in), nullableAssetEnabled(in), user, key, idemHash(in)); err != nil {
		return DouyinAssetVersion{}, classifyWriteErr(err)
	}
	column := "latest_script_asset_version_id"
	if in.AssetType == "style" {
		column = "latest_style_asset_version_id"
	}
	if _, err = tx.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script SET `+column+`=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$3 AND workspace_type=$4 AND workspace_id=$5 AND deleted_at IS NULL`, id, user, scriptID, wsType, wsID); err != nil {
		return DouyinAssetVersion{}, err
	}
	if err = tx.Commit(); err != nil {
		return DouyinAssetVersion{}, err
	}
	return s.GetDouyinAsset(ctx, wsType, wsID, scriptID, id, true)
}

func (s *Store) CopyDouyinAsset(ctx context.Context, wsType, wsID, scriptID, assetID, user, key string) (DouyinAssetVersion, error) {
	source, err := s.GetDouyinAsset(ctx, wsType, wsID, scriptID, assetID, true)
	if err != nil {
		return DouyinAssetVersion{}, err
	}
	if source.Status == "draft" {
		return DouyinAssetVersion{}, ErrConflict
	}
	parts := strings.Split(source.Version, ".")
	version := source.Version
	if len(parts) == 3 {
		patch, _ := strconv.Atoi(parts[2])
		version = fmt.Sprintf("%s.%s.%d", parts[0], parts[1], patch+1)
	}
	in := DouyinAssetInput{AssetType: source.AssetType, Version: version, SourceContent: source.SourceContent}
	if source.AssetType == "style" {
		priority := source.Priority
		enabled := source.Enabled
		in.RunAt, in.Priority, in.Enabled = source.RunAt, &priority, &enabled
	}
	return s.CreateDouyinAsset(ctx, wsType, wsID, scriptID, user, key, in)
}

func (s *Store) UpdateDouyinAsset(ctx context.Context, wsType, wsID, scriptID, assetID, user, key string, expected int, in DouyinAssetInput) (DouyinAssetVersion, error) {
	current, err := s.GetDouyinAsset(ctx, wsType, wsID, scriptID, assetID, true)
	if err != nil {
		return DouyinAssetVersion{}, err
	}
	if current.Status == "released" || current.Status == "active" {
		if current.AssetType != "style" {
			return DouyinAssetVersion{}, ErrConflict
		}
		if err := normalizeDouyinStyleMetadata(in); err != nil {
			return DouyinAssetVersion{}, err
		}
		if (in.Version != "" && in.Version != current.Version) || (in.SourceContent != "" && in.SourceContent != current.SourceContent) {
			return DouyinAssetVersion{}, ErrConflict
		}
		res, err := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script_asset_version v SET run_at=$1,priority=$2,enabled=$3,revision=v.revision+1,updated_by=$4,updated_at=now(),last_command_key=$5,last_command_hash=$6 FROM ky_matrix_account_douyin_script s WHERE v.id=$7 AND v.script_id=$8 AND v.asset_type='style' AND s.id=v.script_id AND s.workspace_type=$9 AND s.workspace_id=$10 AND v.revision=$11 AND v.status IN ('released','active')`, in.RunAt, *in.Priority, *in.Enabled, user, key, idemHash(in), assetID, scriptID, wsType, wsID, expected)
		if err != nil {
			return DouyinAssetVersion{}, classifyWriteErr(err)
		}
		if err = affectedOrNotFound(res); err != nil {
			return DouyinAssetVersion{}, ErrConflict
		}
		return s.GetDouyinAsset(ctx, wsType, wsID, scriptID, assetID, true)
	}
	if current.Status != "draft" {
		return DouyinAssetVersion{}, ErrConflict
	}
	in, err = normalizeDouyinAssetInput(in)
	if err != nil {
		return DouyinAssetVersion{}, err
	}
	hash := assetHash(in.SourceContent)
	res, err := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script_asset_version v SET version=$1,source_content=$2,source_bytes=$3,source_sha256=$4,run_at=COALESCE($5, v.run_at),priority=COALESCE($6, v.priority),enabled=COALESCE($7, v.enabled),revision=v.revision+1,updated_by=$8,updated_at=now(),last_command_key=$9,last_command_hash=$10 FROM ky_matrix_account_douyin_script s WHERE v.id=$11 AND v.script_id=$12 AND v.asset_type=$13 AND s.id=v.script_id AND s.workspace_type=$14 AND s.workspace_id=$15 AND v.revision=$16 AND v.status='draft'`, in.Version, in.SourceContent, len(in.SourceContent), hash, nullableAssetRunAt(in), nullableAssetPriority(in), nullableAssetEnabled(in), user, key, idemHash(in), assetID, scriptID, in.AssetType, wsType, wsID, expected)
	if err != nil {
		return DouyinAssetVersion{}, classifyWriteErr(err)
	}
	if err = affectedOrNotFound(res); err != nil {
		return DouyinAssetVersion{}, ErrConflict
	}
	return s.GetDouyinAsset(ctx, wsType, wsID, scriptID, assetID, true)
}

func (s *Store) ChangeDouyinAssetState(ctx context.Context, wsType, wsID, scriptID, assetID, user, key string, expected int, action string) (DouyinAssetVersion, error) {
	if action != "release" && action != "activate" && action != "archive" {
		return DouyinAssetVersion{}, ErrValidation
	}
	var status string
	if action == "release" {
		status = "released"
	} else if action == "activate" {
		status = "active"
	} else {
		status = "archived"
	}
	whereStatus := "v.status='draft'"
	effectiveGuard := ""
	if action == "activate" {
		whereStatus = "v.status='released'"
	} else if action == "archive" {
		whereStatus = "v.status IN ('draft','released','active')"
		effectiveGuard = " AND NOT ((v.asset_type='script' AND s.effective_script_asset_version_id=v.id) OR (v.asset_type='style' AND s.effective_style_asset_version_id=v.id))"
	}
	publishedSQL := ""
	if action == "release" {
		publishedSQL = ",published_at=COALESCE(v.published_at,now())"
	}
	res, err := s.db.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script_asset_version v SET status=$1`+publishedSQL+`,revision=v.revision+1,updated_by=$2,updated_at=now(),last_command_key=$3,last_command_hash=$4 FROM ky_matrix_account_douyin_script s WHERE v.id=$5 AND v.script_id=$6 AND s.id=v.script_id AND s.workspace_type=$7 AND s.workspace_id=$8 AND v.revision=$9 AND v.status<>'archived'`+effectiveGuard+` AND `+whereStatus, status, user, key, idemHash(action), assetID, scriptID, wsType, wsID, expected)
	if err != nil {
		return DouyinAssetVersion{}, classifyWriteErr(err)
	}
	if err = affectedOrNotFound(res); err != nil {
		return DouyinAssetVersion{}, ErrConflict
	}
	if action == "activate" {
		column := "effective_script_asset_version_id"
		var assetType string
		if err = s.db.QueryRowContext(ctx, `SELECT asset_type FROM ky_matrix_account_douyin_script_asset_version WHERE id=$1`, assetID).Scan(&assetType); err != nil {
			return DouyinAssetVersion{}, err
		}
		if assetType == "style" {
			column = "effective_style_asset_version_id"
		}
		if _, err = s.db.ExecContext(ctx, `UPDATE ky_matrix_account_douyin_script SET `+column+`=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$3 AND workspace_type=$4 AND workspace_id=$5`, assetID, user, scriptID, wsType, wsID); err != nil {
			return DouyinAssetVersion{}, err
		}
	}
	return s.GetDouyinAsset(ctx, wsType, wsID, scriptID, assetID, false)
}
