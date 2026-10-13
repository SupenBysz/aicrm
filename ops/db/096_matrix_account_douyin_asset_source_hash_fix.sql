-- 修复 087 历史回填把 JS+CSS 联合 hash 写入独立资产的问题。
-- 每个资产的 source_sha256 必须只覆盖自身 source_content，供运行时完整性校验。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE ky_matrix_account_douyin_script_asset_version
SET source_sha256 = encode(sha256(convert_to(source_content, 'UTF8')), 'hex')
WHERE source_sha256 IS DISTINCT FROM encode(sha256(convert_to(source_content, 'UTF8')), 'hex');

-- 回滚说明：本修复仅重算派生 hash，不删除源码或版本；如需回滚应恢复
-- 迁移前的 source_sha256 备份，禁止重新写入联合 hash。
