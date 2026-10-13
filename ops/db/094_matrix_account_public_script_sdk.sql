-- 公共脚本 SDK 依赖与平台字段增量迁移；不删除历史源码。
ALTER TABLE ky_matrix_account_public_script
  ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'douyin',
  ADD COLUMN IF NOT EXISTS dependencies jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE ky_matrix_account_public_script
  DROP CONSTRAINT IF EXISTS ky_matrix_account_public_script_platform_check;
ALTER TABLE ky_matrix_account_public_script
  ADD CONSTRAINT ky_matrix_account_public_script_platform_check
  CHECK (platform ~ '^[a-z][a-z0-9_-]{0,31}$');

DROP INDEX IF EXISTS ky_matrix_account_public_script_identifier_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_public_script_identifier_uidx
  ON ky_matrix_account_public_script(workspace_type, workspace_id, platform, lower(identifier))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ky_matrix_account_public_script_runtime_idx
  ON ky_matrix_account_public_script(workspace_type, workspace_id, platform, enabled, updated_at DESC)
  WHERE deleted_at IS NULL;

-- 回滚：删除新增索引与约束后，再删除 platform/dependencies 列；删除列前必须确认运行时已回退到旧版本。
