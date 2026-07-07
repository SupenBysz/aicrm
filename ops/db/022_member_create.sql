-- 用户管理: create workspace member + login account permissions.

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_members_create', 'platform.members.create', '创建用户', 'action', 'members', 'create', '["platform"]'::jsonb, 'Create user and platform membership', 'normal'),
  ('perm_agency_members_create', 'agency.members.create', '创建用户', 'action', 'members', 'create', '["agency"]'::jsonb, 'Create user and agency membership', 'normal'),
  ('perm_enterprise_members_create', 'enterprise.members.create', '创建用户', 'action', 'members', 'create', '["enterprise"]'::jsonb, 'Create user and enterprise membership', 'normal')
ON CONFLICT (id) DO NOTHING;

-- platform -> owner/admin
INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p WHERE p.code = 'platform.members.create'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p WHERE p.code = 'platform.members.create'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- agency templates -> owner/admin
INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || rt.role_id || '_' || replace(p.code, '.', '_'), rt.role_id, p.id
FROM ky_permission p
CROSS JOIN (VALUES ('role_agency_owner_template'), ('role_agency_admin_template')) AS rt(role_id)
WHERE p.code = 'agency.members.create'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- enterprise templates -> owner/admin
INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || rt.role_id || '_' || replace(p.code, '.', '_'), rt.role_id, p.id
FROM ky_permission p
CROSS JOIN (VALUES ('role_enterprise_owner_template'), ('role_enterprise_admin_template')) AS rt(role_id)
WHERE p.code = 'enterprise.members.create'
ON CONFLICT (role_id, permission_id) DO NOTHING;
