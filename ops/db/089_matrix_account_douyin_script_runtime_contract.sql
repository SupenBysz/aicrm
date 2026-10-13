-- 阶段1运行时契约字段：仅保存配置，不启用脚本注入或执行。
-- 旧记录统一回填为安全默认值；本迁移可重复执行。
ALTER TABLE ky_matrix_account_douyin_script
  ADD COLUMN IF NOT EXISTS run_at text,
  ADD COLUMN IF NOT EXISTS priority integer;

UPDATE ky_matrix_account_douyin_script
SET run_at = 'document_idle'
WHERE run_at IS NULL OR btrim(run_at) = '';

UPDATE ky_matrix_account_douyin_script
SET priority = 1000
WHERE priority IS NULL;

ALTER TABLE ky_matrix_account_douyin_script
  ALTER COLUMN run_at SET DEFAULT 'document_idle',
  ALTER COLUMN run_at SET NOT NULL,
  ALTER COLUMN priority SET DEFAULT 1000,
  ALTER COLUMN priority SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_douyin_script'::regclass
      AND conname = 'ky_matrix_account_douyin_script_run_at_ck'
  ) THEN
    ALTER TABLE ky_matrix_account_douyin_script
      ADD CONSTRAINT ky_matrix_account_douyin_script_run_at_ck
      CHECK (run_at IN ('document_start','dom_content_loaded','document_idle','load','spa_route_change','user_action'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_douyin_script'::regclass
      AND conname = 'ky_matrix_account_douyin_script_priority_ck'
  ) THEN
    ALTER TABLE ky_matrix_account_douyin_script
      ADD CONSTRAINT ky_matrix_account_douyin_script_priority_ck
      CHECK (priority BETWEEN -10000 AND 10000);
  END IF;
END $$;

-- 回滚说明（需在维护窗口执行）：先删除上述两个约束，再删除 run_at/priority 列。
-- 删除列会丢弃本阶段新增值，回滚前应确认调用方已停止使用新字段。
