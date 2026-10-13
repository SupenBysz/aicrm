-- 为独立样式资产保存自己的运行时配置；NULL 保留旧数据回退到脚本级配置。
ALTER TABLE ky_matrix_account_douyin_script_asset_version
  ADD COLUMN IF NOT EXISTS run_at text,
  ADD COLUMN IF NOT EXISTS priority integer,
  ADD COLUMN IF NOT EXISTS enabled boolean;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ky_matrix_account_douyin_asset_run_at_ck') THEN
    ALTER TABLE ky_matrix_account_douyin_script_asset_version
      ADD CONSTRAINT ky_matrix_account_douyin_asset_run_at_ck
      CHECK (run_at IS NULL OR run_at IN ('document_start','dom_content_loaded','document_idle','spa_route_change'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ky_matrix_account_douyin_asset_priority_ck') THEN
    ALTER TABLE ky_matrix_account_douyin_script_asset_version
      ADD CONSTRAINT ky_matrix_account_douyin_asset_priority_ck
      CHECK (priority IS NULL OR priority BETWEEN -10000 AND 10000);
  END IF;
END $$;

-- 新样式版本由写入服务填充 document_start/0/启用；旧样式保持 NULL，运行时按脚本配置兼容回退。
