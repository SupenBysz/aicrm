-- 用户管理: edit user profile + reset login password permissions (platform/agency/enterprise).

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_members_update', 'platform.members.update', '编辑用户', 'action', 'members', 'update', '["platform"]'::jsonb, 'Edit user profile', 'normal'),
  ('perm_platform_members_reset_password', 'platform.members.reset_password', '重置登录密码', 'action', 'members', 'reset_password', '["platform"]'::jsonb, 'Reset user login password', 'normal'),
  ('perm_agency_members_update', 'agency.members.update', '编辑用户', 'action', 'members', 'update', '["agency"]'::jsonb, 'Edit user profile', 'normal'),
  ('perm_agency_members_reset_password', 'agency.members.reset_password', '重置登录密码', 'action', 'members', 'reset_password', '["agency"]'::jsonb, 'Reset user login password', 'normal'),
  ('perm_enterprise_members_update', 'enterprise.members.update', '编辑用户', 'action', 'members', 'update', '["enterprise"]'::jsonb, 'Edit user profile', 'normal'),
  ('perm_enterprise_members_reset_password', 'enterprise.members.reset_password', '重置登录密码', 'action', 'members', 'reset_password', '["enterprise"]'::jsonb, 'Reset user login password', 'normal')
ON CONFLICT (id) DO NOTHING;

-- platform → owner/admin
INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p WHERE p.code IN ('platform.members.update', 'platform.members.reset_password')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p WHERE p.code IN ('platform.members.update', 'platform.members.reset_password')
ON CONFLICT (id) DO NOTHING;

-- agency templates → owner/admin
INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || rt.role_id || '_' || replace(p.code, '.', '_'), rt.role_id, p.id
FROM ky_permission p
CROSS JOIN (VALUES ('role_agency_owner_template'), ('role_agency_admin_template')) AS rt(role_id)
WHERE p.code IN ('agency.members.update', 'agency.members.reset_password')
ON CONFLICT (id) DO NOTHING;

-- enterprise templates → owner/admin
INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || rt.role_id || '_' || replace(p.code, '.', '_'), rt.role_id, p.id
FROM ky_permission p
CROSS JOIN (VALUES ('role_enterprise_owner_template'), ('role_enterprise_admin_template')) AS rt(role_id)
WHERE p.code IN ('enterprise.members.update', 'enterprise.members.reset_password')
ON CONFLICT (id) DO NOTHING;
