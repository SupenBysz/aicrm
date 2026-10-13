-- 为测试结果绑定配置版本；未经成功测试的云存储不得成为当前存储。
ALTER TABLE ky_storage_setting
  ADD COLUMN IF NOT EXISTS config_fingerprint text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_test_fingerprint text NOT NULL DEFAULT '';

UPDATE ky_storage_setting AS d
SET active_storage_provider = 'local', updated_at = now()
WHERE d.id = 'default'
  AND d.active_storage_provider <> 'local'
  AND NOT EXISTS (
    SELECT 1
    FROM ky_storage_setting AS p
    WHERE p.id = d.active_storage_provider
      AND p.last_test_status = 'success'
      AND p.config_fingerprint <> ''
      AND p.config_fingerprint = p.last_test_fingerprint
  );
