-- Add whole-type broadcast target scopes to announcements:
--   agency_all     -> 全部机构（所有机构工作区）
--   enterprise_all -> 全部企业（所有企业工作区）
--   user_all       -> 全部用户（等同平台广播，所有人可见）
-- Existing scopes (all / agency / enterprise / user) are preserved.

ALTER TABLE ky_system_announcement DROP CONSTRAINT IF EXISTS ky_system_announcement_target_scope_check;
ALTER TABLE ky_system_announcement ADD CONSTRAINT ky_system_announcement_target_scope_check
  CHECK (target_scope IN ('all', 'agency', 'enterprise', 'user', 'agency_all', 'enterprise_all', 'user_all'));
