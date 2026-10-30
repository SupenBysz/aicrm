-- Additive component-center page grant and existing-system-settings menu leaf.
-- Preserve operator-owned menu metadata and custom role grants on re-run.
INSERT INTO ky_permission(id,code,name,category,resource,action,workspace_types,description,status)
VALUES('perm_platform_component_center_view','platform.component_center.view','组件中心查看','page','component_center','view','["platform"]'::jsonb,'查看无业务副作用的组件标准、模拟示例和复用代码','normal')
ON CONFLICT(code) DO NOTHING;
INSERT INTO ky_role_permission(id,role_id,permission_id)
SELECT 'rp_'||r.id||'_'||p.id,r.id,p.id FROM ky_role r CROSS JOIN ky_permission p
WHERE r.id='role_platform_owner' AND r.code='platform_owner' AND r.workspace_type='platform' AND r.workspace_id='platform_root' AND r.is_system=true AND r.deleted_at IS NULL AND r.status='normal' AND p.code='platform.component_center.view'
ON CONFLICT(role_id,permission_id) DO NOTHING;
INSERT INTO ky_menu_directory(directory_type,menu_key,node_type,parent_key,name,icon,permission_code,workspace_types,route_key,route_path,page_type,status,sort_order,permission_bindings,source_version)
VALUES('management','ky-component-center.catalog','leaf','group.ky-system-settings','组件中心','AppstoreOutlined','','["platform"]'::jsonb,'ky-component-center.catalog','/system/components','internal','active',2,'{"platform":["platform.component_center.view"]}'::jsonb,1)
ON CONFLICT(directory_type,menu_key) DO NOTHING;
