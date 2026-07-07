package store

import (
	"context"
	"database/sql"
	"time"
)

type AppVersionRule struct {
	ID                      string `json:"id"`
	Platform                string `json:"platform"`
	Channel                 string `json:"channel"`
	LatestVersionCode       int    `json:"latestVersionCode"`
	LatestVersionName       string `json:"latestVersionName"`
	MinSupportedVersionCode int    `json:"minSupportedVersionCode"`
	ForceUpdate             bool   `json:"forceUpdate"`
	UpdateTitle             string `json:"updateTitle"`
	UpdateNotes             string `json:"updateNotes"`
	UpdateURL               string `json:"updateUrl"`
	Enabled                 bool   `json:"enabled"`
	InternalRemark          string `json:"internalRemark"`
	UpdatedAt               string `json:"updatedAt,omitempty"`
}

const avrColumns = `id, platform, channel, latest_version_code, latest_version_name, min_supported_version_code,
	force_update, update_title, update_notes, update_url, enabled, internal_remark, updated_at`

func scanAppVersionRule(row interface{ Scan(...any) error }) (AppVersionRule, error) {
	var a AppVersionRule
	var updatedAt sql.NullTime
	err := row.Scan(&a.ID, &a.Platform, &a.Channel, &a.LatestVersionCode, &a.LatestVersionName,
		&a.MinSupportedVersionCode, &a.ForceUpdate, &a.UpdateTitle, &a.UpdateNotes, &a.UpdateURL,
		&a.Enabled, &a.InternalRemark, &updatedAt)
	if updatedAt.Valid {
		a.UpdatedAt = updatedAt.Time.Format(time.RFC3339)
	}
	return a, err
}

func (s *Store) ListAppVersionRules(ctx context.Context) ([]AppVersionRule, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+avrColumns+` FROM ky_app_version_rule ORDER BY platform, channel`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AppVersionRule{}
	for rows.Next() {
		a, err := scanAppVersionRule(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	return items, rows.Err()
}

func (s *Store) GetAppVersionRule(ctx context.Context, id string) (AppVersionRule, error) {
	a, err := scanAppVersionRule(s.db.QueryRowContext(ctx, `SELECT `+avrColumns+` FROM ky_app_version_rule WHERE id=$1`, id))
	if err == sql.ErrNoRows {
		return AppVersionRule{}, ErrNotFound
	}
	return a, err
}

func (s *Store) CreateAppVersionRule(ctx context.Context, a AppVersionRule, createdBy string) (string, error) {
	id := "avr_" + randomSuffix()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_app_version_rule (id, platform, channel, latest_version_code, latest_version_name,
			min_supported_version_code, force_update, update_title, update_notes, update_url, enabled, internal_remark, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
	`, id, a.Platform, a.Channel, a.LatestVersionCode, a.LatestVersionName, a.MinSupportedVersionCode,
		a.ForceUpdate, a.UpdateTitle, a.UpdateNotes, a.UpdateURL, a.Enabled, a.InternalRemark, nullStr(createdBy))
	if err != nil {
		return "", classifyWriteErr(err)
	}
	return id, nil
}

func (s *Store) UpdateAppVersionRule(ctx context.Context, a AppVersionRule, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_app_version_rule SET channel=$2, latest_version_code=$3, latest_version_name=$4,
			min_supported_version_code=$5, force_update=$6, update_title=$7, update_notes=$8, update_url=$9,
			enabled=$10, internal_remark=$11, updated_by=$12, updated_at=now()
		WHERE id=$1
	`, a.ID, a.Channel, a.LatestVersionCode, a.LatestVersionName, a.MinSupportedVersionCode,
		a.ForceUpdate, a.UpdateTitle, a.UpdateNotes, a.UpdateURL, a.Enabled, a.InternalRemark, nullStr(updatedBy))
	if err != nil {
		return classifyWriteErr(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteAppVersionRule(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM ky_app_version_rule WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetEnabledAppVersionRule returns the enabled rule for a platform/channel (for public check).
func (s *Store) GetEnabledAppVersionRule(ctx context.Context, platform, channel string) (AppVersionRule, error) {
	if channel == "" {
		channel = "default"
	}
	a, err := scanAppVersionRule(s.db.QueryRowContext(ctx,
		`SELECT `+avrColumns+` FROM ky_app_version_rule WHERE platform=$1 AND channel=$2 AND enabled=true`, platform, channel))
	if err == sql.ErrNoRows {
		return AppVersionRule{}, ErrNotFound
	}
	return a, err
}
