-- 抖店脚本与样式独立源码版本；不修改旧版本表，旧数据通过回填保留可读历史。
ALTER TABLE ky_matrix_account_douyin_script
  ADD COLUMN IF NOT EXISTS latest_script_asset_version_id text,
  ADD COLUMN IF NOT EXISTS effective_script_asset_version_id text,
  ADD COLUMN IF NOT EXISTS latest_style_asset_version_id text,
  ADD COLUMN IF NOT EXISTS effective_style_asset_version_id text;

CREATE TABLE IF NOT EXISTS ky_matrix_account_douyin_script_asset_version (
  id text PRIMARY KEY,
  script_id text NOT NULL REFERENCES ky_matrix_account_douyin_script(id),
  asset_type text NOT NULL CHECK (asset_type IN ('script','style')),
  version text NOT NULL,
  source_content text NOT NULL DEFAULT '',
  source_bytes integer NOT NULL DEFAULT 0 CHECK (source_bytes >= 0),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','released','active','archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_command_key text NOT NULL DEFAULT '',
  last_command_hash text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(script_id, asset_type, version)
);
CREATE INDEX IF NOT EXISTS ky_matrix_account_douyin_script_asset_version_list_idx
  ON ky_matrix_account_douyin_script_asset_version(script_id, asset_type, created_at DESC);

-- 旧版本同时包含 JS/CSS；分别投影到两条不可变资产历史，原表继续作为兼容 API 的事实来源。
INSERT INTO ky_matrix_account_douyin_script_asset_version
  (id,script_id,asset_type,version,source_content,source_bytes,source_sha256,status,revision,created_by,updated_by,created_at,updated_at)
SELECT 'mdsa_script_'||v.id,v.script_id,'script',v.version,v.js_content,v.js_bytes,v.content_sha256,v.status,v.revision,v.created_by,v.updated_by,v.created_at,v.updated_at
FROM ky_matrix_account_douyin_script_version v
ON CONFLICT (script_id,asset_type,version) DO NOTHING;
INSERT INTO ky_matrix_account_douyin_script_asset_version
  (id,script_id,asset_type,version,source_content,source_bytes,source_sha256,status,revision,created_by,updated_by,created_at,updated_at)
SELECT 'mdsa_style_'||v.id,v.script_id,'style',v.version,v.css_content,v.css_bytes,v.content_sha256,v.status,v.revision,v.created_by,v.updated_by,v.created_at,v.updated_at
FROM ky_matrix_account_douyin_script_version v
ON CONFLICT (script_id,asset_type,version) DO NOTHING;
UPDATE ky_matrix_account_douyin_script s SET
 latest_script_asset_version_id=COALESCE(s.latest_script_asset_version_id,'mdsa_script_'||s.latest_version_id),
 effective_script_asset_version_id=COALESCE(s.effective_script_asset_version_id,'mdsa_script_'||s.effective_version_id),
 latest_style_asset_version_id=COALESCE(s.latest_style_asset_version_id,'mdsa_style_'||s.latest_version_id),
 effective_style_asset_version_id=COALESCE(s.effective_style_asset_version_id,'mdsa_style_'||s.effective_version_id)
WHERE s.latest_version_id IS NOT NULL OR s.effective_version_id IS NOT NULL;
