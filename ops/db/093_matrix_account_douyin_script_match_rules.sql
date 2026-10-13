-- 抖店脚本多 URL 规则：保留旧字段并以 JSONB 规则数组作为权威配置。
-- 兼容旧记录；不修改公共脚本或旧登录脚本表。
ALTER TABLE ky_matrix_account_douyin_script
  ADD COLUMN IF NOT EXISTS match_rules jsonb;

UPDATE ky_matrix_account_douyin_script
SET match_rules = jsonb_build_array(jsonb_build_object(
  'id', 'legacy_' || id,
  'matchType', match_type,
  'pattern', match_url,
  'ignoreQuery', false,
  'enabled', true,
  'remark', '',
  'sortOrder', 0
))
WHERE match_rules IS NULL OR jsonb_typeof(match_rules) <> 'array' OR jsonb_array_length(match_rules) = 0;

ALTER TABLE ky_matrix_account_douyin_script
  ALTER COLUMN match_rules SET DEFAULT '[]'::jsonb,
  ALTER COLUMN match_rules SET NOT NULL;

ALTER TABLE ky_matrix_account_douyin_script
  DROP CONSTRAINT IF EXISTS ky_matrix_account_douyin_script_match_type_check,
  DROP CONSTRAINT IF EXISTS ky_matrix_account_douyin_script_match_type_ck;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_douyin_script'::regclass
      AND conname = 'ky_matrix_account_douyin_script_match_type_ck'
  ) THEN
    ALTER TABLE ky_matrix_account_douyin_script
      ADD CONSTRAINT ky_matrix_account_douyin_script_match_type_ck
      CHECK (match_type IN ('exact','prefix','wildcard'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_douyin_script'::regclass
      AND conname = 'ky_matrix_account_douyin_script_match_rules_array_ck'
  ) THEN
    ALTER TABLE ky_matrix_account_douyin_script
      ADD CONSTRAINT ky_matrix_account_douyin_script_match_rules_array_ck
      CHECK (jsonb_typeof(match_rules) = 'array' AND jsonb_array_length(match_rules) >= 1);
  END IF;
END $$;

-- 回滚说明：停止使用多规则版本后，可删除本列及本迁移新增约束；旧 match_type/match_url 保留。
