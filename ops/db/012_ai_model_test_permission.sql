-- Adds the AI model connectivity-test permission and binds it to the platform
-- built-in roles, matching the auto-binding rule used by 008_seed.sql
-- (platform.% -> platform_owner / platform_admin). Idempotent.

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_ai_models_test', 'platform.ai_models.test', '测试 AI 模型', 'action', 'ai_models', 'test', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p
WHERE p.code = 'platform.ai_models.test'
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p
WHERE p.code = 'platform.ai_models.test'
ON CONFLICT (id) DO NOTHING;
