package store

import (
	"context"
	"database/sql"
	"time"
)

// StorageSetting is the S3-compatible object storage config (singleton). The
// secret access key is stored encrypted; SecretEncrypted is internal-only.
type StorageSetting struct {
	ProviderKey     string `json:"providerKey"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	BucketPrivate   bool   `json:"bucketPrivate"`
	ForcePathStyle  bool   `json:"forcePathStyle"`
	Prefix          string `json:"prefix"`
	PublicDomain    string `json:"publicDomain"`
	AccessKeyID     string `json:"accessKeyId"`
	HasSecret       bool   `json:"hasSecret"`
	LastTestAt      string `json:"lastTestAt,omitempty"`
	LastTestStatus  string `json:"lastTestStatus"`
	LastTestMessage string `json:"lastTestMessage,omitempty"`
	UpdatedAt       string `json:"updatedAt,omitempty"`

	SecretEncrypted string `json:"-"`
}

func (s *Store) GetStorageSetting(ctx context.Context) (StorageSetting, error) {
	var st StorageSetting
	var lastTestAt, updatedAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `
		SELECT provider_key, endpoint, region, bucket, bucket_private, force_path_style, prefix, public_domain,
		       access_key_id, secret_access_key_encrypted, last_test_status, last_test_message, last_test_at, updated_at
		FROM ky_storage_setting WHERE id='default'`).Scan(
		&st.ProviderKey, &st.Endpoint, &st.Region, &st.Bucket, &st.BucketPrivate, &st.ForcePathStyle,
		&st.Prefix, &st.PublicDomain, &st.AccessKeyID, &st.SecretEncrypted, &st.LastTestStatus, &st.LastTestMessage,
		&lastTestAt, &updatedAt)
	if err == sql.ErrNoRows {
		return StorageSetting{}, nil
	}
	if err != nil {
		return StorageSetting{}, err
	}
	st.HasSecret = st.SecretEncrypted != ""
	if lastTestAt.Valid {
		st.LastTestAt = lastTestAt.Time.Format(time.RFC3339)
	}
	if updatedAt.Valid {
		st.UpdatedAt = updatedAt.Time.Format(time.RFC3339)
	}
	return st, nil
}

// UpsertStorageSetting updates config. If secretEncrypted is empty the existing
// secret is preserved (PATCH-keep semantics).
func (s *Store) UpsertStorageSetting(ctx context.Context, st StorageSetting, secretEncrypted, updatedBy string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_storage_setting (id, provider_key, endpoint, region, bucket, bucket_private, force_path_style,
			prefix, public_domain, access_key_id, secret_access_key_encrypted, updated_by, updated_at)
		VALUES ('default', $1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE(NULLIF($10,''), (SELECT secret_access_key_encrypted FROM ky_storage_setting WHERE id='default')), $11, now())
		ON CONFLICT (id) DO UPDATE SET
			provider_key=$1, endpoint=$2, region=$3, bucket=$4, bucket_private=$5, force_path_style=$6,
			prefix=$7, public_domain=$8, access_key_id=$9,
			secret_access_key_encrypted=COALESCE(NULLIF($10,''), ky_storage_setting.secret_access_key_encrypted),
			updated_by=$11, updated_at=now()
	`, st.ProviderKey, st.Endpoint, st.Region, st.Bucket, st.BucketPrivate, st.ForcePathStyle,
		st.Prefix, st.PublicDomain, st.AccessKeyID, secretEncrypted, nullStr(updatedBy))
	return err
}

func (s *Store) RotateStorageSecret(ctx context.Context, secretEncrypted, updatedBy string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE ky_storage_setting SET secret_access_key_encrypted=$1, updated_by=$2, updated_at=now() WHERE id='default'`,
		secretEncrypted, nullStr(updatedBy))
	return err
}

func (s *Store) RecordStorageTest(ctx context.Context, status, message string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE ky_storage_setting SET last_test_at=now(), last_test_status=$1, last_test_message=$2 WHERE id='default'`,
		status, message)
	return err
}
