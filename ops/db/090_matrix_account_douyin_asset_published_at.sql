-- 为独立脚本/样式资产记录真实发布时间；历史已发布资产用既有更新时间回填。
ALTER TABLE ky_matrix_account_douyin_script_asset_version
  ADD COLUMN IF NOT EXISTS published_at timestamptz;

UPDATE ky_matrix_account_douyin_script_asset_version
SET published_at = updated_at
WHERE status IN ('released', 'active') AND published_at IS NULL;
