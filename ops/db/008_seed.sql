-- KyaiCRM Phase 1 seed data.
-- This file is idempotent and uses stable text IDs for the Phase 1 baseline.
-- Real deployments must replace CHANGE_ME_HASH before enabling the default platform owner account.

INSERT INTO ky_user (id, username, display_name, email, status) VALUES
  ('user_platform_owner', 'Super.Admin', '平台超级管理员', 'platform-owner@kyai-crm.local', 'normal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_user_credential (id, user_id, credential_type, identifier, password_hash, status, verified_at) VALUES
  ('cred_platform_owner_password', 'user_platform_owner', 'password', 'Super.Admin', 'CHANGE_ME_HASH', 'normal', now())
ON CONFLICT (credential_type, identifier) DO NOTHING;

INSERT INTO ky_membership (id, user_id, workspace_type, workspace_id, display_name, status, joined_at) VALUES
  ('mem_platform_owner', 'user_platform_owner', 'platform', 'platform_root', '平台超级管理员', 'active', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role (id, workspace_type, workspace_id, name, code, description, is_system, status) VALUES
  ('role_platform_owner', 'platform', 'platform_root', '平台超级管理员', 'platform_owner', 'Phase 1 built-in platform owner role', true, 'normal'),
  ('role_platform_admin', 'platform', 'platform_root', '平台管理员', 'platform_admin', 'Phase 1 built-in platform admin role', true, 'normal'),
  ('role_platform_operator', 'platform', 'platform_root', '平台运营', 'platform_operator', 'Phase 1 built-in platform operator role', true, 'normal'),
  ('role_agency_owner_template', 'agency', NULL, '机构所有者', 'agency_owner', 'Phase 1 agency owner role template', true, 'normal'),
  ('role_agency_admin_template', 'agency', NULL, '机构管理员', 'agency_admin', 'Phase 1 agency admin role template', true, 'normal'),
  ('role_agency_operator_template', 'agency', NULL, '机构运营', 'agency_operator', 'Phase 1 agency operator role template', true, 'normal'),
  ('role_agency_readonly_template', 'agency', NULL, '机构只读', 'agency_readonly', 'Phase 1 agency readonly role template', true, 'normal'),
  ('role_agency_member_template', 'agency', NULL, '机构普通成员', 'agency_member', 'Phase 1 agency member role template', true, 'normal'),
  ('role_enterprise_owner_template', 'enterprise', NULL, '企业所有者', 'enterprise_owner', 'Phase 1 enterprise owner role template', true, 'normal'),
  ('role_enterprise_admin_template', 'enterprise', NULL, '企业管理员', 'enterprise_admin', 'Phase 1 enterprise admin role template', true, 'normal'),
  ('role_enterprise_operator_template', 'enterprise', NULL, '企业运营', 'enterprise_operator', 'Phase 1 enterprise operator role template', true, 'normal'),
  ('role_enterprise_readonly_template', 'enterprise', NULL, '企业只读', 'enterprise_readonly', 'Phase 1 enterprise readonly role template', true, 'normal'),
  ('role_enterprise_member_template', 'enterprise', NULL, '企业普通成员', 'enterprise_member', 'Phase 1 enterprise member role template', true, 'normal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_menu_platform_workbench', 'menu.platform.workbench', '平台工作台菜单', 'menu', 'workbench', 'view', '["platform"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_platform_users', 'menu.platform.users', '平台用户中心菜单', 'menu', 'users', 'view', '["platform"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_platform_members', 'menu.platform.members', '平台成员菜单', 'menu', 'members', 'view', '["platform"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_platform_agencies', 'menu.platform.agencies', '平台机构中心菜单', 'menu', 'agencies', 'view', '["platform"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_platform_enterprises', 'menu.platform.enterprises', '平台企业中心菜单', 'menu', 'enterprises', 'view', '["platform"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_platform_access', 'menu.platform.access', '平台权限中心菜单', 'menu', 'access', 'view', '["platform"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_platform_ai_configuration', 'menu.platform.ai_configuration', '平台 AI 配置菜单', 'menu', 'ai_configuration', 'view', '["platform"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_platform_notifications', 'menu.platform.notifications', '平台通知菜单', 'menu', 'notifications', 'view', '["platform"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_platform_audit', 'menu.platform.audit', '平台审计菜单', 'menu', 'audit', 'view', '["platform"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_platform_settings', 'menu.platform.settings', '平台设置菜单', 'menu', 'settings', 'view', '["platform"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_agency_workbench', 'menu.agency.workbench', '机构工作台菜单', 'menu', 'workbench', 'view', '["agency"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_agency_profile', 'menu.agency.profile', '机构信息菜单', 'menu', 'profile', 'view', '["agency"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_agency_members', 'menu.agency.members', '机构成员菜单', 'menu', 'members', 'view', '["agency"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_agency_structure', 'menu.agency.structure', '机构组织结构菜单', 'menu', 'structure', 'view', '["agency"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_agency_enterprises', 'menu.agency.enterprises', '机构企业管理菜单', 'menu', 'enterprises', 'view', '["agency"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_agency_access', 'menu.agency.access', '机构权限中心菜单', 'menu', 'access', 'view', '["agency"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_agency_notifications', 'menu.agency.notifications', '机构通知菜单', 'menu', 'notifications', 'view', '["agency"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_agency_audit', 'menu.agency.audit', '机构审计菜单', 'menu', 'audit', 'view', '["agency"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_agency_settings', 'menu.agency.settings', '机构设置菜单', 'menu', 'settings', 'view', '["agency"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_enterprise_workbench', 'menu.enterprise.workbench', '企业工作台菜单', 'menu', 'workbench', 'view', '["enterprise"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_enterprise_profile', 'menu.enterprise.profile', '企业信息菜单', 'menu', 'profile', 'view', '["enterprise"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_enterprise_members', 'menu.enterprise.members', '企业成员菜单', 'menu', 'members', 'view', '["enterprise"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_enterprise_structure', 'menu.enterprise.structure', '企业组织结构菜单', 'menu', 'structure', 'view', '["enterprise"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_enterprise_access', 'menu.enterprise.access', '企业权限中心菜单', 'menu', 'access', 'view', '["enterprise"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_enterprise_notifications', 'menu.enterprise.notifications', '企业通知菜单', 'menu', 'notifications', 'view', '["enterprise"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_enterprise_audit', 'menu.enterprise.audit', '企业审计菜单', 'menu', 'audit', 'view', '["enterprise"]'::jsonb, 'Phase 1 menu permission', 'normal'),
  ('perm_menu_enterprise_settings', 'menu.enterprise.settings', '企业设置菜单', 'menu', 'settings', 'view', '["enterprise"]'::jsonb, 'Phase 1 menu permission', 'normal'),

  ('perm_platform_workbench_view', 'platform.workbench.view', '平台工作台查看', 'page', 'workbench', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_users_view', 'platform.users.view', '全局用户查看', 'page', 'users', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_members_view', 'platform.members.view', '平台成员查看', 'page', 'members', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_invitations_view', 'platform.invitations.view', '平台邀请查看', 'page', 'invitations', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_agencies_view', 'platform.agencies.view', '机构查看', 'page', 'agencies', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_enterprises_view', 'platform.enterprises.view', '企业查看', 'page', 'enterprises', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_roles_view', 'platform.roles.view', '平台角色查看', 'page', 'roles', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_permissions_view', 'platform.permissions.view', '平台权限查看', 'page', 'permissions', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_data_scopes_view', 'platform.data_scopes.view', '平台数据范围查看', 'page', 'data_scopes', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_notifications_view', 'platform.notifications.view', '平台通知查看', 'page', 'notifications', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_announcements_view', 'platform.announcements.view', '平台公告查看', 'page', 'announcements', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_audit_view', 'platform.audit.view', '平台审计查看', 'page', 'audit', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_login_logs_view', 'platform.login_logs.view', '登录日志查看', 'page', 'login_logs', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_settings_view', 'platform.settings.view', '平台设置查看', 'page', 'settings', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_dictionaries_view', 'platform.dictionaries.view', '平台字典查看', 'page', 'dictionaries', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_ai_providers_view', 'platform.ai_providers.view', 'AI 供应商查看', 'page', 'ai_providers', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_ai_models_view', 'platform.ai_models.view', 'AI 模型查看', 'page', 'ai_models', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_platform_ai_model_settings_view', 'platform.ai_model_settings.view', '默认模型配置查看', 'page', 'ai_model_settings', 'view', '["platform"]'::jsonb, 'Phase 1 page permission', 'normal'),

  ('perm_agency_workbench_view', 'agency.workbench.view', '机构工作台查看', 'page', 'workbench', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_profile_view', 'agency.profile.view', '机构信息查看', 'page', 'profile', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_members_view', 'agency.members.view', '机构成员查看', 'page', 'members', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_invitations_view', 'agency.invitations.view', '机构邀请查看', 'page', 'invitations', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_departments_view', 'agency.departments.view', '机构部门查看', 'page', 'departments', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_teams_view', 'agency.teams.view', '机构团队查看', 'page', 'teams', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_enterprises_view', 'agency.enterprises.view', '机构企业查看', 'page', 'enterprises', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_roles_view', 'agency.roles.view', '机构角色查看', 'page', 'roles', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_permissions_view', 'agency.permissions.view', '机构权限查看', 'page', 'permissions', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_data_scopes_view', 'agency.data_scopes.view', '机构数据范围查看', 'page', 'data_scopes', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_notifications_view', 'agency.notifications.view', '机构通知查看', 'page', 'notifications', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_announcements_view', 'agency.announcements.view', '机构公告查看', 'page', 'announcements', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_audit_view', 'agency.audit.view', '机构审计查看', 'page', 'audit', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_agency_settings_view', 'agency.settings.view', '机构设置查看', 'page', 'settings', 'view', '["agency"]'::jsonb, 'Phase 1 page permission', 'normal'),

  ('perm_enterprise_workbench_view', 'enterprise.workbench.view', '企业工作台查看', 'page', 'workbench', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_enterprise_profile_view', 'enterprise.profile.view', '企业信息查看', 'page', 'profile', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_enterprise_members_view', 'enterprise.members.view', '企业成员查看', 'page', 'members', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_enterprise_invitations_view', 'enterprise.invitations.view', '企业邀请查看', 'page', 'invitations', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_enterprise_departments_view', 'enterprise.departments.view', '企业部门查看', 'page', 'departments', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_enterprise_teams_view', 'enterprise.teams.view', '企业团队查看', 'page', 'teams', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_enterprise_roles_view', 'enterprise.roles.view', '企业角色查看', 'page', 'roles', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_enterprise_permissions_view', 'enterprise.permissions.view', '企业权限查看', 'page', 'permissions', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_enterprise_data_scopes_view', 'enterprise.data_scopes.view', '企业数据范围查看', 'page', 'data_scopes', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_enterprise_notifications_view', 'enterprise.notifications.view', '企业通知查看', 'page', 'notifications', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_enterprise_announcements_view', 'enterprise.announcements.view', '企业公告查看', 'page', 'announcements', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_enterprise_audit_view', 'enterprise.audit.view', '企业审计查看', 'page', 'audit', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),
  ('perm_enterprise_settings_view', 'enterprise.settings.view', '企业设置查看', 'page', 'settings', 'view', '["enterprise"]'::jsonb, 'Phase 1 page permission', 'normal'),

  ('perm_platform_users_enable', 'platform.users.enable', '启用用户', 'action', 'users', 'enable', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_users_disable', 'platform.users.disable', '禁用用户', 'action', 'users', 'disable', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_members_invite', 'platform.members.invite', '邀请平台成员', 'action', 'members', 'invite', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_members_disable', 'platform.members.disable', '禁用平台成员', 'action', 'members', 'disable', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_members_remove', 'platform.members.remove', '移除平台成员', 'action', 'members', 'remove', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_agencies_create', 'platform.agencies.create', '创建机构', 'action', 'agencies', 'create', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_qualifications_view', 'platform.qualifications.view', '资质审核查看', 'page', 'qualifications', 'view', '["platform"]'::jsonb, 'Qualification review', 'normal'),
  ('perm_platform_qualifications_review', 'platform.qualifications.review', '审核资质', 'action', 'qualifications', 'review', '["platform"]'::jsonb, 'Qualification review', 'normal'),
  ('perm_agency_qualification_view', 'agency.qualification.view', '机构资质查看', 'page', 'qualification', 'view', '["agency"]'::jsonb, 'Qualification submit', 'normal'),
  ('perm_agency_qualification_submit', 'agency.qualification.submit', '机构资质提交', 'action', 'qualification', 'submit', '["agency"]'::jsonb, 'Qualification submit', 'normal'),
  ('perm_enterprise_qualification_view', 'enterprise.qualification.view', '企业资质查看', 'page', 'qualification', 'view', '["enterprise"]'::jsonb, 'Qualification submit', 'normal'),
  ('perm_enterprise_qualification_submit', 'enterprise.qualification.submit', '企业资质提交', 'action', 'qualification', 'submit', '["enterprise"]'::jsonb, 'Qualification submit', 'normal'),
  ('perm_platform_agencies_update', 'platform.agencies.update', '编辑机构', 'action', 'agencies', 'update', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_agencies_disable', 'platform.agencies.disable', '停用机构', 'action', 'agencies', 'disable', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_agencies_freeze', 'platform.agencies.freeze', '冻结机构', 'action', 'agencies', 'freeze', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_enterprises_create', 'platform.enterprises.create', '创建企业', 'action', 'enterprises', 'create', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_enterprises_update', 'platform.enterprises.update', '编辑企业', 'action', 'enterprises', 'update', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_enterprises_disable', 'platform.enterprises.disable', '停用企业', 'action', 'enterprises', 'disable', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_enterprises_assign_agency', 'platform.enterprises.assign_agency', '调整企业归属机构', 'action', 'enterprises', 'assign_agency', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_roles_create', 'platform.roles.create', '创建平台角色', 'action', 'roles', 'create', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_roles_update', 'platform.roles.update', '编辑平台角色', 'action', 'roles', 'update', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_roles_disable', 'platform.roles.disable', '禁用平台角色', 'action', 'roles', 'disable', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_roles_assign', 'platform.roles.assign', '平台成员授权', 'action', 'roles', 'assign', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_roles_update_permissions', 'platform.roles.update_permissions', '修改平台角色权限', 'action', 'roles', 'update_permissions', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_announcements_create', 'platform.announcements.create', '创建系统公告', 'action', 'announcements', 'create', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_announcements_publish', 'platform.announcements.publish', '发布系统公告', 'action', 'announcements', 'publish', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_settings_update', 'platform.settings.update', '修改平台设置', 'action', 'settings', 'update', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_ai_providers_create', 'platform.ai_providers.create', '新增 AI 供应商', 'action', 'ai_providers', 'create', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_ai_providers_update', 'platform.ai_providers.update', '编辑 AI 供应商', 'action', 'ai_providers', 'update', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_ai_providers_update_status', 'platform.ai_providers.update_status', '启停 AI 供应商', 'action', 'ai_providers', 'update_status', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_ai_providers_rotate_key', 'platform.ai_providers.rotate_key', '轮换 AI 供应商密钥', 'action', 'ai_providers', 'rotate_key', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_ai_models_create', 'platform.ai_models.create', '新增 AI 模型', 'action', 'ai_models', 'create', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_ai_models_update', 'platform.ai_models.update', '编辑 AI 模型', 'action', 'ai_models', 'update', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_ai_models_update_status', 'platform.ai_models.update_status', '启停 AI 模型', 'action', 'ai_models', 'update_status', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_platform_ai_model_settings_update', 'platform.ai_model_settings.update', '修改默认模型', 'action', 'ai_model_settings', 'update', '["platform"]'::jsonb, 'Phase 1 action permission', 'normal'),

  ('perm_agency_profile_update', 'agency.profile.update', '编辑机构信息', 'action', 'profile', 'update', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_members_invite', 'agency.members.invite', '邀请机构成员', 'action', 'members', 'invite', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_members_disable', 'agency.members.disable', '禁用机构成员', 'action', 'members', 'disable', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_members_remove', 'agency.members.remove', '移除机构成员', 'action', 'members', 'remove', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_members_assign_department', 'agency.members.assign_department', '分配机构部门', 'action', 'members', 'assign_department', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_members_assign_team', 'agency.members.assign_team', '分配机构团队', 'action', 'members', 'assign_team', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_departments_create', 'agency.departments.create', '创建机构部门', 'action', 'departments', 'create', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_departments_update', 'agency.departments.update', '编辑机构部门', 'action', 'departments', 'update', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_departments_delete', 'agency.departments.delete', '删除机构部门', 'action', 'departments', 'delete', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_teams_create', 'agency.teams.create', '创建机构团队', 'action', 'teams', 'create', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_teams_update', 'agency.teams.update', '编辑机构团队', 'action', 'teams', 'update', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_teams_manage_members', 'agency.teams.manage_members', '管理机构团队成员', 'action', 'teams', 'manage_members', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_enterprises_create', 'agency.enterprises.create', '机构开通企业', 'action', 'enterprises', 'create', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_enterprises_update', 'agency.enterprises.update', '机构编辑企业', 'action', 'enterprises', 'update', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_enterprises_invite_admin', 'agency.enterprises.invite_admin', '邀请企业管理员', 'action', 'enterprises', 'invite_admin', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_roles_create', 'agency.roles.create', '创建机构角色', 'action', 'roles', 'create', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_roles_update', 'agency.roles.update', '编辑机构角色', 'action', 'roles', 'update', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_roles_assign', 'agency.roles.assign', '机构成员授权', 'action', 'roles', 'assign', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_roles_update_permissions', 'agency.roles.update_permissions', '修改机构角色权限', 'action', 'roles', 'update_permissions', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_agency_settings_update', 'agency.settings.update', '修改机构设置', 'action', 'settings', 'update', '["agency"]'::jsonb, 'Phase 1 action permission', 'normal'),

  ('perm_enterprise_profile_update', 'enterprise.profile.update', '编辑企业信息', 'action', 'profile', 'update', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_members_invite', 'enterprise.members.invite', '邀请企业成员', 'action', 'members', 'invite', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_members_disable', 'enterprise.members.disable', '禁用企业成员', 'action', 'members', 'disable', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_members_remove', 'enterprise.members.remove', '移除企业成员', 'action', 'members', 'remove', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_members_assign_department', 'enterprise.members.assign_department', '分配企业部门', 'action', 'members', 'assign_department', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_members_assign_team', 'enterprise.members.assign_team', '分配企业团队', 'action', 'members', 'assign_team', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_departments_create', 'enterprise.departments.create', '创建企业部门', 'action', 'departments', 'create', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_departments_update', 'enterprise.departments.update', '编辑企业部门', 'action', 'departments', 'update', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_departments_delete', 'enterprise.departments.delete', '删除企业部门', 'action', 'departments', 'delete', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_teams_create', 'enterprise.teams.create', '创建企业团队', 'action', 'teams', 'create', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_teams_update', 'enterprise.teams.update', '编辑企业团队', 'action', 'teams', 'update', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_teams_manage_members', 'enterprise.teams.manage_members', '管理企业团队成员', 'action', 'teams', 'manage_members', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_roles_create', 'enterprise.roles.create', '创建企业角色', 'action', 'roles', 'create', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_roles_update', 'enterprise.roles.update', '编辑企业角色', 'action', 'roles', 'update', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_roles_assign', 'enterprise.roles.assign', '企业成员授权', 'action', 'roles', 'assign', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_roles_update_permissions', 'enterprise.roles.update_permissions', '修改企业角色权限', 'action', 'roles', 'update_permissions', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal'),
  ('perm_enterprise_settings_update', 'enterprise.settings.update', '修改企业设置', 'action', 'settings', 'update', '["enterprise"]'::jsonb, 'Phase 1 action permission', 'normal')
ON CONFLICT (code) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p
WHERE p.code LIKE 'platform.%' OR p.code LIKE 'menu.platform.%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p
WHERE p.code LIKE 'platform.%' OR p.code LIKE 'menu.platform.%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_agency_owner_' || replace(p.code, '.', '_'), 'role_agency_owner_template', p.id
FROM ky_permission p
WHERE p.code LIKE 'agency.%' OR p.code LIKE 'menu.agency.%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_agency_admin_' || replace(p.code, '.', '_'), 'role_agency_admin_template', p.id
FROM ky_permission p
WHERE p.code LIKE 'agency.%' OR p.code LIKE 'menu.agency.%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_enterprise_owner_' || replace(p.code, '.', '_'), 'role_enterprise_owner_template', p.id
FROM ky_permission p
WHERE p.code LIKE 'enterprise.%' OR p.code LIKE 'menu.enterprise.%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_enterprise_admin_' || replace(p.code, '.', '_'), 'role_enterprise_admin_template', p.id
FROM ky_permission p
WHERE p.code LIKE 'enterprise.%' OR p.code LIKE 'menu.enterprise.%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_membership_role (id, membership_id, role_id, workspace_type, workspace_id) VALUES
  ('mr_platform_owner', 'mem_platform_owner', 'role_platform_owner', 'platform', 'platform_root')
ON CONFLICT (membership_id, role_id) DO NOTHING;

INSERT INTO ky_role_data_scope (id, role_id, scope_type) VALUES
  ('rds_platform_owner_all', 'role_platform_owner', 'all'),
  ('rds_platform_admin_all', 'role_platform_admin', 'all'),
  ('rds_platform_operator_all', 'role_platform_operator', 'all'),
  ('rds_agency_owner_current', 'role_agency_owner_template', 'current_agency'),
  ('rds_agency_admin_current', 'role_agency_admin_template', 'current_agency'),
  ('rds_agency_member_self', 'role_agency_member_template', 'self'),
  ('rds_enterprise_owner_current', 'role_enterprise_owner_template', 'current_enterprise'),
  ('rds_enterprise_admin_current', 'role_enterprise_admin_template', 'current_enterprise'),
  ('rds_enterprise_member_self', 'role_enterprise_member_template', 'self')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_system_setting (id, scope_type, scope_id, setting_key, setting_value, description) VALUES
  ('setting_platform_general', 'platform', 'platform_root', 'general', '{"systemName":"KyaiCRM","defaultLanguage":"zh-CN","defaultTimezone":"Asia/Shanghai"}'::jsonb, 'Phase 1 default general settings'),
  ('setting_platform_security', 'platform', 'platform_root', 'security', '{"sessionHours":24,"passwordMinLength":8}'::jsonb, 'Phase 1 default security settings'),
  ('setting_platform_registration', 'platform', 'platform_root', 'registration', '{"allowRegister":true,"requireEmailVerification":false,"requirePhoneVerification":false}'::jsonb, 'Phase 1 default registration settings'),
  ('setting_platform_tenant', 'platform', 'platform_root', 'tenant', '{"allowAgencyCreateEnterprise":true}'::jsonb, 'Phase 1 default tenant settings')
ON CONFLICT (scope_type, scope_id, setting_key) DO NOTHING;

INSERT INTO ky_dictionary (id, code, name, scope_type, scope_id, status) VALUES
  ('dict_user_status', 'user_status', '用户状态', 'platform', 'platform_root', 'normal'),
  ('dict_membership_status', 'membership_status', '成员状态', 'platform', 'platform_root', 'normal')
ON CONFLICT (scope_type, scope_id, code) DO NOTHING;

INSERT INTO ky_dictionary_item (id, dictionary_id, label, value, sort_order, status) VALUES
  ('dict_item_user_normal', 'dict_user_status', '正常', 'normal', 10, 'normal'),
  ('dict_item_user_unverified', 'dict_user_status', '未验证', 'unverified', 20, 'normal'),
  ('dict_item_user_disabled', 'dict_user_status', '禁用', 'disabled', 30, 'normal'),
  ('dict_item_user_closed', 'dict_user_status', '注销', 'closed', 40, 'normal'),
  ('dict_item_member_invited', 'dict_membership_status', '待加入', 'invited', 10, 'normal'),
  ('dict_item_member_active', 'dict_membership_status', '正常', 'active', 20, 'normal'),
  ('dict_item_member_disabled', 'dict_membership_status', '已禁用', 'disabled', 30, 'normal'),
  ('dict_item_member_left', 'dict_membership_status', '已离开', 'left', 40, 'normal')
ON CONFLICT (dictionary_id, value) DO NOTHING;

-- Additional scoped built-in role templates required by the Phase 1 permission matrix.
INSERT INTO ky_role (id, workspace_type, workspace_id, name, code, description, is_system, status) VALUES
  ('role_agency_department_leader_template', 'agency', NULL, '机构部门负责人', 'department_leader', 'Phase 1 agency department leader role template', true, 'normal'),
  ('role_agency_team_leader_template', 'agency', NULL, '机构团队负责人', 'team_leader', 'Phase 1 agency team leader role template', true, 'normal'),
  ('role_enterprise_department_leader_template', 'enterprise', NULL, '企业部门负责人', 'department_leader', 'Phase 1 enterprise department leader role template', true, 'normal'),
  ('role_enterprise_team_leader_template', 'enterprise', NULL, '企业团队负责人', 'team_leader', 'Phase 1 enterprise team leader role template', true, 'normal')
ON CONFLICT (id) DO NOTHING;

-- Baseline permission bindings for non-owner/admin built-in roles.
INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_operator_' || replace(p.code, '.', '_'), 'role_platform_operator', p.id
FROM ky_permission p
WHERE p.category IN ('menu', 'page') AND (p.code LIKE 'platform.%' OR p.code LIKE 'menu.platform.%')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_agency_operator_' || replace(p.code, '.', '_'), 'role_agency_operator_template', p.id
FROM ky_permission p
WHERE p.category IN ('menu', 'page') AND (p.code LIKE 'agency.%' OR p.code LIKE 'menu.agency.%')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_agency_readonly_' || replace(p.code, '.', '_'), 'role_agency_readonly_template', p.id
FROM ky_permission p
WHERE p.category IN ('menu', 'page') AND (p.code LIKE 'agency.%' OR p.code LIKE 'menu.agency.%')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_agency_member_' || replace(p.code, '.', '_'), 'role_agency_member_template', p.id
FROM ky_permission p
WHERE p.code IN (
  'menu.agency.workbench', 'menu.agency.profile', 'menu.agency.notifications',
  'agency.workbench.view', 'agency.profile.view', 'agency.notifications.view', 'agency.announcements.view'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_enterprise_operator_' || replace(p.code, '.', '_'), 'role_enterprise_operator_template', p.id
FROM ky_permission p
WHERE p.category IN ('menu', 'page') AND (p.code LIKE 'enterprise.%' OR p.code LIKE 'menu.enterprise.%')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_enterprise_readonly_' || replace(p.code, '.', '_'), 'role_enterprise_readonly_template', p.id
FROM ky_permission p
WHERE p.category IN ('menu', 'page') AND (p.code LIKE 'enterprise.%' OR p.code LIKE 'menu.enterprise.%')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_enterprise_member_' || replace(p.code, '.', '_'), 'role_enterprise_member_template', p.id
FROM ky_permission p
WHERE p.code IN (
  'menu.enterprise.workbench', 'menu.enterprise.profile', 'menu.enterprise.notifications',
  'enterprise.workbench.view', 'enterprise.profile.view', 'enterprise.notifications.view', 'enterprise.announcements.view'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_agency_department_leader_' || replace(p.code, '.', '_'), 'role_agency_department_leader_template', p.id
FROM ky_permission p
WHERE p.code IN (
  'menu.agency.workbench', 'menu.agency.profile', 'menu.agency.members', 'menu.agency.structure', 'menu.agency.notifications', 'menu.agency.audit',
  'agency.workbench.view', 'agency.profile.view', 'agency.members.view', 'agency.departments.view', 'agency.teams.view',
  'agency.notifications.view', 'agency.announcements.view', 'agency.audit.view',
  'agency.departments.create', 'agency.departments.update', 'agency.teams.create', 'agency.teams.update', 'agency.teams.manage_members'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_agency_team_leader_' || replace(p.code, '.', '_'), 'role_agency_team_leader_template', p.id
FROM ky_permission p
WHERE p.code IN (
  'menu.agency.workbench', 'menu.agency.profile', 'menu.agency.members', 'menu.agency.structure', 'menu.agency.notifications', 'menu.agency.audit',
  'agency.workbench.view', 'agency.profile.view', 'agency.members.view', 'agency.teams.view',
  'agency.notifications.view', 'agency.announcements.view', 'agency.audit.view',
  'agency.teams.update', 'agency.teams.manage_members'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_enterprise_department_leader_' || replace(p.code, '.', '_'), 'role_enterprise_department_leader_template', p.id
FROM ky_permission p
WHERE p.code IN (
  'menu.enterprise.workbench', 'menu.enterprise.profile', 'menu.enterprise.members', 'menu.enterprise.structure', 'menu.enterprise.notifications', 'menu.enterprise.audit',
  'enterprise.workbench.view', 'enterprise.profile.view', 'enterprise.members.view', 'enterprise.departments.view', 'enterprise.teams.view',
  'enterprise.notifications.view', 'enterprise.announcements.view', 'enterprise.audit.view',
  'enterprise.departments.create', 'enterprise.departments.update', 'enterprise.teams.create', 'enterprise.teams.update', 'enterprise.teams.manage_members'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_enterprise_team_leader_' || replace(p.code, '.', '_'), 'role_enterprise_team_leader_template', p.id
FROM ky_permission p
WHERE p.code IN (
  'menu.enterprise.workbench', 'menu.enterprise.profile', 'menu.enterprise.members', 'menu.enterprise.structure', 'menu.enterprise.notifications', 'menu.enterprise.audit',
  'enterprise.workbench.view', 'enterprise.profile.view', 'enterprise.members.view', 'enterprise.teams.view',
  'enterprise.notifications.view', 'enterprise.announcements.view', 'enterprise.audit.view',
  'enterprise.teams.update', 'enterprise.teams.manage_members'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Data scopes for every required built-in role template.
INSERT INTO ky_role_data_scope (id, role_id, scope_type) VALUES
  ('rds_agency_operator_current', 'role_agency_operator_template', 'current_agency'),
  ('rds_agency_readonly_current', 'role_agency_readonly_template', 'current_agency'),
  ('rds_enterprise_operator_current', 'role_enterprise_operator_template', 'current_enterprise'),
  ('rds_enterprise_readonly_current', 'role_enterprise_readonly_template', 'current_enterprise'),
  ('rds_agency_department_leader_tree', 'role_agency_department_leader_template', 'department_tree'),
  ('rds_agency_team_leader_team', 'role_agency_team_leader_template', 'team'),
  ('rds_enterprise_department_leader_tree', 'role_enterprise_department_leader_template', 'department_tree'),
  ('rds_enterprise_team_leader_team', 'role_enterprise_team_leader_template', 'team')
ON CONFLICT (id) DO NOTHING;

-- Optional default AI configuration is intentionally not seeded with real provider credentials.
