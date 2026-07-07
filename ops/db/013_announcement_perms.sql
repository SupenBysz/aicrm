-- Announcement edit/delete permissions (platform-only), bound to the built-in
-- platform roles like the rest of platform.% perms in 008_seed.sql. Idempotent.

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_announcements_update', 'platform.announcements.update', '编辑公告', 'action', 'announcements', 'update', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_announcements_delete', 'platform.announcements.delete', '删除公告', 'action', 'announcements', 'delete', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p
WHERE p.code IN ('platform.announcements.update', 'platform.announcements.delete')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p
WHERE p.code IN ('platform.announcements.update', 'platform.announcements.delete')
ON CONFLICT (id) DO NOTHING;
