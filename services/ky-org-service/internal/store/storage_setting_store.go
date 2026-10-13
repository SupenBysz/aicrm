package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"time"
)

// StorageSetting is one provider's persisted configuration. SecretEncrypted is
// internal-only and is never serialized in API responses.
type StorageSetting struct {
	ProviderKey       string `json:"providerKey"`
	LocalDirectory    string `json:"localDirectory,omitempty"`
	Endpoint          string `json:"endpoint"`
	Region            string `json:"region"`
	Bucket            string `json:"bucket"`
	BucketPrivate     bool   `json:"bucketPrivate"`
	ForcePathStyle    bool   `json:"forcePathStyle"`
	Prefix            string `json:"prefix"`
	PublicDomain      string `json:"publicDomain"`
	AccessKeyID       string `json:"accessKeyId"`
	HasSecret         bool   `json:"hasSecret"`
	LastTestAt        string `json:"lastTestAt,omitempty"`
	LastTestStatus    string `json:"lastTestStatus"`
	LastTestMessage   string `json:"lastTestMessage,omitempty"`
	ConfigFingerprint string `json:"-"`
	TestFingerprint   string `json:"-"`
	UpdatedAt         string `json:"updatedAt,omitempty"`
	SecretEncrypted   string `json:"-"`
}

type StorageSettings struct {
	ActiveStorageProvider string                    `json:"activeStorageProvider"`
	Providers             map[string]StorageSetting `json:"providers"`
}

const defaultStorageProvider = "local"

func (s *Store) scanStorageSetting(row *sql.Row) (StorageSetting, error) {
	var st StorageSetting
	var lastTestAt, updatedAt sql.NullTime
	err := row.Scan(&st.ProviderKey, &st.LocalDirectory, &st.Endpoint, &st.Region, &st.Bucket, &st.BucketPrivate,
		&st.ForcePathStyle, &st.Prefix, &st.PublicDomain, &st.AccessKeyID, &st.SecretEncrypted,
		&st.LastTestStatus, &st.LastTestMessage, &st.ConfigFingerprint, &st.TestFingerprint, &lastTestAt, &updatedAt)
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

func (s *Store) GetStorageSettings(ctx context.Context) (StorageSettings, error) {
	providers := map[string]StorageSetting{}
	for _, key := range []string{"local", "minio", "oss"} {
		st, err := s.scanStorageSetting(s.db.QueryRowContext(ctx, `
			SELECT provider_key, local_directory, endpoint, region, bucket, bucket_private, force_path_style,
			       prefix, public_domain, access_key_id, secret_access_key_encrypted,
			       last_test_status, last_test_message, config_fingerprint, last_test_fingerprint, last_test_at, updated_at
			FROM ky_storage_setting WHERE id=$1`, key))
		if err == sql.ErrNoRows {
			st = StorageSetting{ProviderKey: key, BucketPrivate: true}
		} else if err != nil {
			return StorageSettings{}, err
		}
		st.ProviderKey = key
		providers[key] = st
	}
	var active string
	err := s.db.QueryRowContext(ctx, `SELECT active_storage_provider FROM ky_storage_setting WHERE id='default'`).Scan(&active)
	if err == sql.ErrNoRows || active == "" {
		active = defaultStorageProvider
	} else if err != nil {
		return StorageSettings{}, err
	}
	return StorageSettings{ActiveStorageProvider: active, Providers: providers}, nil
}

func (s *Store) GetStorageSetting(ctx context.Context, provider string) (StorageSetting, error) {
	all, err := s.GetStorageSettings(ctx)
	if err != nil {
		return StorageSetting{}, err
	}
	st, ok := all.Providers[provider]
	if !ok {
		return StorageSetting{}, sql.ErrNoRows
	}
	return st, nil
}

func (s *Store) UpsertStorageSetting(ctx context.Context, st StorageSetting, secretEncrypted, updatedBy string) error {
	if secretEncrypted == "" {
		_ = s.db.QueryRowContext(ctx, `SELECT secret_access_key_encrypted FROM ky_storage_setting WHERE id=$1`, st.ProviderKey).Scan(&secretEncrypted)
	}
	fingerprint := storageConfigFingerprint(st, secretEncrypted)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_storage_setting (id, provider_key, local_directory, endpoint, region, bucket, bucket_private, force_path_style,
			prefix, public_domain, access_key_id, secret_access_key_encrypted, config_fingerprint, updated_by, updated_at)
		VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE(NULLIF($11,''),''),$13,$12,now())
		ON CONFLICT (id) DO UPDATE SET
			provider_key=$1, local_directory=$2, endpoint=$3, region=$4, bucket=$5, bucket_private=$6,
			force_path_style=$7, prefix=$8, public_domain=$9, access_key_id=$10,
			secret_access_key_encrypted=COALESCE(NULLIF($11,''), ky_storage_setting.secret_access_key_encrypted),
			config_fingerprint=$13, last_test_fingerprint='', last_test_status='', last_test_message='', last_test_at=NULL,
			updated_by=$12, updated_at=now()
	`, st.ProviderKey, st.LocalDirectory, st.Endpoint, st.Region, st.Bucket, st.BucketPrivate, st.ForcePathStyle,
		st.Prefix, st.PublicDomain, st.AccessKeyID, secretEncrypted, nullStr(updatedBy), fingerprint)
	return err
}

func (s *Store) SetActiveStorageProvider(ctx context.Context, provider, updatedBy string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE ky_storage_setting SET active_storage_provider=$1, updated_by=$2, updated_at=now() WHERE id='default'`, provider, nullStr(updatedBy))
	return err
}

func (s *Store) RotateStorageSecret(ctx context.Context, provider, secretEncrypted, updatedBy string) error {
	st, err := s.GetStorageSetting(ctx, provider)
	if err != nil {
		return err
	}
	fingerprint := storageConfigFingerprint(st, secretEncrypted)
	_, err = s.db.ExecContext(ctx,
		`UPDATE ky_storage_setting SET secret_access_key_encrypted=$1, config_fingerprint=$2, last_test_fingerprint='', last_test_status='', last_test_message='', last_test_at=NULL, updated_by=$3, updated_at=now() WHERE id=$4`,
		secretEncrypted, fingerprint, nullStr(updatedBy), provider)
	return err
}

func (s *Store) RecordStorageTest(ctx context.Context, provider, status, message string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE ky_storage_setting SET last_test_at=now(), last_test_status=$1, last_test_message=$2, last_test_fingerprint=CASE WHEN $1='success' THEN config_fingerprint ELSE '' END WHERE id=$3`,
		status, message, provider)
	return err
}

func storageConfigFingerprint(st StorageSetting, secretEncrypted string) string {
	payload := fmt.Sprintf("%s\x00%s\x00%s\x00%s\x00%s\x00%t\x00%t\x00%s\x00%s\x00%s\x00%s",
		st.ProviderKey, st.LocalDirectory, st.Endpoint, st.Region, st.Bucket, st.BucketPrivate,
		st.ForcePathStyle, st.Prefix, st.PublicDomain, st.AccessKeyID, secretEncrypted)
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}
