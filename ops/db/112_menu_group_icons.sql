-- Correct only legacy generated group icons; preserve customer icon overrides.
UPDATE ky_menu_directory AS menu
SET icon=fix.icon, revision=menu.revision+1, updated_at=now()
FROM (VALUES
 ('group.ky-organization-management','BankOutlined','ApartmentOutlined'),
 ('group.ky-ai-configuration','ApiOutlined','RobotOutlined'),
 ('group.ky-system-settings','ApiOutlined','SettingOutlined')
) AS fix(menu_key,old_icon,icon)
WHERE menu.directory_type='management' AND menu.node_type='group'
 AND menu.menu_key=fix.menu_key AND menu.icon=fix.old_icon;
