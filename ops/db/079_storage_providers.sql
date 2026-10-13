-- 对象存储多提供商配置：保留旧单例并复制到兼容 MinIO 配置。
ALTER TABLE ky_storage_setting
  ADD COLUMN IF NOT EXISTS local_directory text NOT NULL DEFAULT './storage',
  ADD COLUMN IF NOT EXISTS active_storage_provider text NOT NULL DEFAULT 'minio';

INSERT INTO ky_storage_setting (id, provider_key, endpoint, region, bucket, bucket_private, force_path_style, prefix,
  public_domain, access_key_id, secret_access_key_encrypted, updated_by)
SELECT 'minio', CASE WHEN provider_key = 's3' THEN 'minio' ELSE provider_key END, endpoint, region, bucket,
  bucket_private, force_path_style, prefix, public_domain, access_key_id, secret_access_key_encrypted, updated_by
FROM ky_storage_setting WHERE id='default'
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_storage_setting (id, provider_key, local_directory, bucket_private)
VALUES ('local', 'local', './storage', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_storage_setting (id, provider_key, bucket_private)
VALUES ('oss', 'oss', true)
ON CONFLICT (id) DO NOTHING;

UPDATE ky_storage_setting SET active_storage_provider = CASE
  WHEN active_storage_provider IN ('local', 'minio', 'oss') THEN active_storage_provider
  ELSE 'minio' END
WHERE id='default';
