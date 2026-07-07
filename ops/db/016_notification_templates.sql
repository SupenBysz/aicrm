-- P2 通知模板: system notification templates (managed in org-service, consumed by membership-service).

CREATE TABLE IF NOT EXISTS ky_notification_template (
  template_key text PRIMARY KEY,
  template_name text NOT NULL,
  notification_type text NOT NULL DEFAULT 'system',
  title text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Built-in default templates (idempotent). Variables use {{name}} style placeholders.
INSERT INTO ky_notification_template (template_key, template_name, notification_type, title, content, description) VALUES
  ('invitation', '成员邀请', 'system', '您收到一个加入邀请', '{{inviter}} 邀请您加入 {{workspace}}，请点击链接完成加入。', '向被邀请人发送的邀请通知'),
  ('qualification_result', '资质审核结果', 'system', '资质审核结果通知', '您提交的资质「{{qualificationType}}」审核结果为：{{result}}。{{remark}}', '资质审核通过/驳回时通知提交方'),
  ('announcement', '平台公告', 'system', '{{title}}', '{{content}}', '公告发布后桥接为成员通知时套用'),
  ('member_status', '成员状态变更', 'system', '账号状态变更通知', '您在 {{workspace}} 的成员状态已变更为：{{status}}。', '成员被停用/启用时通知本人')
ON CONFLICT (template_key) DO NOTHING;

-- Permissions
INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_notification_templates_view', 'platform.notification_templates.view', '通知模板查看', 'page', 'notification_templates', 'view', '["platform"]'::jsonb, 'System settings - notification templates', 'normal'),
  ('perm_platform_notification_templates_update', 'platform.notification_templates.update', '编辑通知模板', 'action', 'notification_templates', 'update', '["platform"]'::jsonb, 'System settings - notification templates', 'normal'),
  ('perm_menu_platform_notification_templates', 'menu.platform.notification_templates', '通知模板菜单', 'menu', 'notification_templates', 'view', '["platform"]'::jsonb, 'System settings - notification templates menu', 'normal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p WHERE p.code IN ('platform.notification_templates.view', 'platform.notification_templates.update', 'menu.platform.notification_templates')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p WHERE p.code IN ('platform.notification_templates.view', 'platform.notification_templates.update', 'menu.platform.notification_templates')
ON CONFLICT (id) DO NOTHING;
