-- 插件管理只读权限；仅 platform_root owner/admin，幂等执行。
BEGIN;
INSERT INTO ky_permission (id,code,name,category,resource,action,workspace_types,description,status) VALUES
 ('perm_menu_platform_plugin_management','menu.platform.plugin_management','平台插件管理菜单','menu','plugin_management','view','["platform"]'::jsonb,'平台插件清单菜单','normal'),
 ('perm_platform_plugin_management_view','platform.plugin_management.view','平台插件管理查看','page','plugin_management','view','["platform"]'::jsonb,'平台插件只读清单','normal')
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN IF (SELECT count(*) FROM ky_role WHERE id IN ('role_platform_owner','role_platform_admin') AND code IN ('platform_owner','platform_admin') AND workspace_type='platform' AND workspace_id='platform_root' AND is_system=true AND deleted_at IS NULL AND status='normal') <> 2 THEN RAISE EXCEPTION 'plugin management roles missing'; END IF; END $$;
INSERT INTO ky_role_permission (id,role_id,permission_id)
SELECT 'rp_'||r.code||'_plugin_management_'||replace(p.code,'.','_'),r.id,p.id
FROM ky_role r CROSS JOIN ky_permission p
WHERE r.id IN ('role_platform_owner','role_platform_admin') AND r.code IN ('platform_owner','platform_admin') AND r.workspace_type='platform' AND r.workspace_id='platform_root' AND r.is_system=true AND r.deleted_at IS NULL AND r.status='normal'
  AND p.code IN ('menu.platform.plugin_management','platform.plugin_management.view')
ON CONFLICT (role_id,permission_id) DO NOTHING;
COMMIT;
