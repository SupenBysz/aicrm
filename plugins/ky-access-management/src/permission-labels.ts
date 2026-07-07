// Single source of truth for the Chinese display labels of the permission catalog
// (category / resource / action / workspace) plus the domain grouping used to build
// the 3-level authorization tree (领域 → 资源 → 具体权限). Shared by the role
// authorization drawer and the permission catalog page.

export const CATEGORY_LABELS: Record<string, string> = {
  menu: "菜单",
  page: "页面",
  action: "操作"
};

export const WORKSPACE_LABELS: Record<string, string> = {
  platform: "平台",
  agency: "机构",
  enterprise: "企业"
};

export const RESOURCE_LABELS: Record<string, string> = {
  access: "访问控制",
  agencies: "机构",
  ai_configuration: "AI 配置",
  ai_model_settings: "AI 默认模型",
  ai_models: "AI 模型",
  ai_providers: "AI 供应商",
  announcements: "公告",
  app_version: "App 版本",
  audit: "审计日志",
  basic_info: "基础信息",
  departments: "部门",
  dictionaries: "数据字典",
  email: "邮件服务",
  enterprises: "企业",
  invitations: "邀请",
  login_logs: "登录日志",
  members: "成员",
  notification_templates: "通知模板",
  notifications: "通知",
  permissions: "权限",
  profile: "组织资料",
  qualification: "资质提交",
  qualifications: "资质审核",
  roles: "角色",
  settings: "设置",
  sms: "短信服务",
  storage: "对象存储",
  structure: "组织架构",
  teams: "团队",
  users: "用户",
  workbench: "仪表盘"
};

export const ACTION_LABELS: Record<string, string> = {
  assign: "分配",
  assign_agency: "分配机构",
  assign_department: "分配部门",
  assign_team: "分配团队",
  create: "新建",
  delete: "删除",
  disable: "停用",
  enable: "启用",
  freeze: "冻结",
  invite: "邀请",
  invite_admin: "邀请管理员",
  manage_members: "管理成员",
  publish: "发布",
  remove: "移除",
  reset_password: "重置密码",
  review: "审核",
  rotate_key: "轮换密钥",
  submit: "提交",
  test: "测试",
  update: "编辑",
  update_permissions: "配置权限",
  update_status: "启停",
  view: "查看"
};

/** Top-level grouping of the authorization tree (一级节点). Ordered for display. */
export const DOMAIN_ORDER = ["org", "iam", "ai", "content", "platform"] as const;
export type DomainKey = (typeof DOMAIN_ORDER)[number];

export const DOMAIN_LABELS: Record<DomainKey, string> = {
  org: "组织管理",
  iam: "身份与访问",
  ai: "AI 配置",
  content: "内容与通知",
  platform: "平台治理"
};

/** Maps a permission resource to its top-level domain. Unknown resources fall back to 平台治理. */
export const RESOURCE_DOMAIN: Record<string, DomainKey> = {
  agencies: "org",
  enterprises: "org",
  departments: "org",
  teams: "org",
  structure: "org",
  profile: "org",
  qualification: "org",
  qualifications: "org",
  members: "iam",
  users: "iam",
  invitations: "iam",
  roles: "iam",
  permissions: "iam",
  access: "iam",
  ai_configuration: "ai",
  ai_providers: "ai",
  ai_models: "ai",
  ai_model_settings: "ai",
  storage: "platform",
  sms: "content",
  email: "content",
  notifications: "content",
  notification_templates: "content",
  announcements: "content",
  audit: "platform",
  login_logs: "platform",
  settings: "platform",
  basic_info: "platform",
  app_version: "platform",
  dictionaries: "platform",
  workbench: "platform"
};

export function label(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}

export function resourceDomain(resource: string): DomainKey {
  return RESOURCE_DOMAIN[resource] ?? "platform";
}

const HIDDEN_PERMISSION_RESOURCES = new Set(["data_scopes"]);

export function isPermissionResourceVisible(resource: string): boolean {
  return !HIDDEN_PERMISSION_RESOURCES.has(resource);
}
