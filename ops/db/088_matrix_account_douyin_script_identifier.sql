-- 抖店脚本标识符：用于脚本配置的稳定业务标识，不执行脚本。
ALTER TABLE ky_matrix_account_douyin_script
  ADD COLUMN IF NOT EXISTS identifier text;

-- 旧记录没有标识符时使用不可变脚本 ID 生成稳定回填值，不覆盖已有配置。
UPDATE ky_matrix_account_douyin_script
SET identifier = 'script_' || regexp_replace(id, '[^A-Za-z0-9_-]', '', 'g')
WHERE identifier IS NULL OR btrim(identifier) = '';

ALTER TABLE ky_matrix_account_douyin_script
  ALTER COLUMN identifier SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_douyin_script'::regclass
      AND conname = 'ky_matrix_account_douyin_script_identifier_ck'
  ) THEN
    ALTER TABLE ky_matrix_account_douyin_script
      ADD CONSTRAINT ky_matrix_account_douyin_script_identifier_ck
      CHECK (identifier ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_douyin_script_identifier_uidx
  ON ky_matrix_account_douyin_script(workspace_type, workspace_id, lower(identifier))
  WHERE deleted_at IS NULL;
