# KyaiCRM 后台页面与菜单清单

> 文档状态：已锁定 / Phase 1 基线  
> 项目名称：KyaiCRM  
> 当前阶段：第一阶段 / 多租户用户中心与多后台身份底座  
> 编写日期：2026-06-15  
> 关联文档：
> - `docs/kyai_crm_multi_tenant_identity_requirements.md`
> - `docs/kyai_crm_architecture.md`
> - `docs/kyai_crm_permission_matrix.md`
> - `docs/kyai_crm_api_contracts.md`

---

## 1. 文档目的

本文档定义 KyaiCRM 第一阶段后台页面、菜单、路由、按钮、权限点和接口映射。

第一阶段后台只覆盖多租户用户中心与多后台身份底座，不包含 CRM 业务、移动端业务、IM 业务、AI 员工业务。

---

## 2. 路由约定

所有登录后后台页面统一挂载在工作区路由下：

```text
/w/:workspaceType/:workspaceId/...
```

第一阶段支持：

```text
/w/platform/platform_root/...
/w/agency/:agencyId/...
/w/enterprise/:enterpriseId/...
```

公共页面：

```text
/login
/register
/invite/:token
/workspace/select
/no-workspace
/403
```

---

## 3. 公共页面

| 页面 | 路由 | 说明 | 主要接口 |
|---|---|---|---|
| 登录 | `/login` | 用户登录 | `POST /api/v1/auth/login` |
| 注册 | `/register` | 用户注册 | `POST /api/v1/auth/register` |
| 接受邀请 | `/invite/:token` | 查看并接受邀请 | `GET /api/v1/public/invitations/:token`、`POST /api/v1/public/invitations/:token/accept` |
| 后台身份选择 | `/workspace/select` | 选择平台/机构/企业后台身份 | `GET /api/v1/auth/bootstrap` |
| 无身份页 | `/no-workspace` | 无可用后台身份提示 | `GET /api/v1/auth/bootstrap` |
| 无权限页 | `/403` | 无权限提示 | 无 |

---

## 3.1 菜单 Key 总表

本节是后台菜单注册、bootstrap `menuKeys` 返回、侧边栏展示和页面清单之间的对照表。第一阶段菜单 key 必须与 `docs/kyai_crm_permission_matrix.md` 的权限字典保持一致。

### 3.1.1 平台后台菜单 Key

| 菜单 Key | 默认路由 | 说明 |
|---|---|---|
| `menu.platform.workbench` | `/w/platform/platform_root/workbench` | 平台工作台 |
| `menu.platform.users` | `/w/platform/platform_root/identity/users` | 全局用户、用户状态、登录日志入口 |
| `menu.platform.members` | `/w/platform/platform_root/members` | 平台成员、平台邀请 |
| `menu.platform.agencies` | `/w/platform/platform_root/agencies` | 机构列表与机构详情 |
| `menu.platform.enterprises` | `/w/platform/platform_root/enterprises` | 企业列表与企业详情 |
| `menu.platform.access` | `/w/platform/platform_root/access/roles` | 平台角色、权限、成员授权、数据范围 |
| `menu.platform.ai_configuration` | `/w/platform/platform_root/ai/providers` | AI 供应商、模型、默认模型配置；第一阶段仅平台后台可见 |
| `menu.platform.notifications` | `/w/platform/platform_root/notifications` | 平台通知、系统公告 |
| `menu.platform.audit` | `/w/platform/platform_root/audit/operation-logs` | 全局操作日志、登录日志 |
| `menu.platform.settings` | `/w/platform/platform_root/settings/general` | 平台基础设置、安全策略、字典配置 |

### 3.1.2 机构后台菜单 Key

| 菜单 Key | 默认路由 | 说明 |
|---|---|---|
| `menu.agency.workbench` | `/w/agency/:agencyId/workbench` | 机构工作台 |
| `menu.agency.profile` | `/w/agency/:agencyId/agency/profile` | 机构信息入口 |
| `menu.agency.members` | `/w/agency/:agencyId/members` | 机构成员、成员邀请、成员详情 |
| `menu.agency.structure` | `/w/agency/:agencyId/structure/departments` | 部门与团队 |
| `menu.agency.enterprises` | `/w/agency/:agencyId/enterprises` | 服务企业 |
| `menu.agency.access` | `/w/agency/:agencyId/access/roles` | 机构角色、权限、成员授权、数据范围 |
| `menu.agency.notifications` | `/w/agency/:agencyId/notifications` | 我的通知、机构通知、系统公告 |
| `menu.agency.audit` | `/w/agency/:agencyId/audit/operation-logs` | 机构操作日志 |
| `menu.agency.settings` | `/w/agency/:agencyId/settings/general` | 机构设置 |

### 3.1.3 企业后台菜单 Key

| 菜单 Key | 默认路由 | 说明 |
|---|---|---|
| `menu.enterprise.workbench` | `/w/enterprise/:enterpriseId/workbench` | 企业工作台 |
| `menu.enterprise.profile` | `/w/enterprise/:enterpriseId/enterprise/profile` | 企业信息入口 |
| `menu.enterprise.members` | `/w/enterprise/:enterpriseId/members` | 企业成员、成员邀请、成员详情 |
| `menu.enterprise.structure` | `/w/enterprise/:enterpriseId/structure/departments` | 部门与团队 |
| `menu.enterprise.access` | `/w/enterprise/:enterpriseId/access/roles` | 企业角色、权限、成员授权、数据范围 |
| `menu.enterprise.notifications` | `/w/enterprise/:enterpriseId/notifications` | 我的通知、企业通知、系统公告 |
| `menu.enterprise.audit` | `/w/enterprise/:enterpriseId/audit/operation-logs` | 企业操作日志 |
| `menu.enterprise.settings` | `/w/enterprise/:enterpriseId/settings/general` | 企业设置 |

说明：第一阶段不定义 `menu.agency.ai_configuration` 或 `menu.enterprise.ai_configuration`；AI 配置只由平台后台的 `menu.platform.ai_configuration` 承载。

---

## 4. 平台后台页面

### 4.1 平台工作台

| 项 | 内容 |
|---|---|
| 菜单 | 平台工作台 |
| 路由 | `/w/platform/platform_root/workbench` |
| 插件 | `ky-identity-management` 或 host base page |
| 页面权限 | `platform.workbench.view` |
| 菜单权限 | `menu.platform.workbench` |
| 主要接口 | `GET /api/v1/platform/workbench/summary` |

展示内容：

- 全局用户数。
- 机构数。
- 企业数。
- 今日登录数。
- 最近审计日志。
- 系统公告。
- AI 供应商状态。
- AI 模型数量。

---

### 4.2 全局用户列表

| 项 | 内容 |
|---|---|
| 菜单 | 用户中心 / 全局用户 |
| 路由 | `/w/platform/platform_root/identity/users` |
| 插件 | `ky-identity-management` |
| 页面权限 | `platform.users.view` |
| 菜单权限 | `menu.platform.users` |
| 主要接口 | `GET /api/v1/platform/users` |

查询条件：

- 用户名。
- 手机号。
- 邮箱。
- 状态。
- 创建时间。

列表字段：

- 用户 ID。
- 昵称。
- 手机号。
- 邮箱。
- 状态。
- 最近登录时间。
- 创建时间。

按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 查看详情 | `platform.users.view` | `GET /api/v1/platform/users/:id` |
| 禁用用户 | `platform.users.disable` | `PATCH /api/v1/platform/users/:id/status` |
| 启用用户 | `platform.users.enable` | `PATCH /api/v1/platform/users/:id/status` |

---

### 4.3 平台成员与邀请

| 页面 | 路由 | 插件 | 页面权限 | 菜单权限 | 主要接口 |
|---|---|---|---|---|---|
| 平台成员 | `/w/platform/platform_root/members` | `ky-organization-management` | `platform.members.view` | `menu.platform.members` | `GET /api/v1/workspace/members` |
| 平台邀请 | `/w/platform/platform_root/invitations` | `ky-organization-management` | `platform.invitations.view` | `menu.platform.members` | `GET /api/v1/invitations` |

按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 邀请平台成员 | `platform.members.invite` | `POST /api/v1/invitations` |
| 邀请机构/企业管理员 | `platform.members.invite` | `POST /api/v1/invitations`，指定 `targetWorkspaceType` / `targetWorkspaceId` / `invitationType` |
| 禁用平台成员 | `platform.members.disable` | `PATCH /api/v1/workspace/members/:id/status` |
| 移除平台成员 | `platform.members.remove` | `DELETE /api/v1/workspace/members/:id` |
| 分配平台角色 | `platform.roles.assign` | `POST /api/v1/memberships/:id/roles` |

---

### 4.3 机构列表

| 项 | 内容 |
|---|---|
| 菜单 | 机构中心 / 机构列表 |
| 路由 | `/w/platform/platform_root/agencies` |
| 插件 | `ky-organization-management` |
| 页面权限 | `platform.agencies.view` |
| 菜单权限 | `menu.platform.agencies` |
| 主要接口 | `GET /api/v1/platform/agencies` |

按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 创建机构 | `platform.agencies.create` | `POST /api/v1/platform/agencies` |
| 查看详情 | `platform.agencies.view` | `GET /api/v1/platform/agencies/:id` |
| 编辑机构 | `platform.agencies.update` | `PATCH /api/v1/platform/agencies/:id` |
| 停用机构 | `platform.agencies.disable` | `PATCH /api/v1/platform/agencies/:id/status` |
| 冻结机构 | `platform.agencies.freeze` | `PATCH /api/v1/platform/agencies/:id/status` |

---

### 4.4 机构详情

| 项 | 内容 |
|---|---|
| 菜单 | 机构中心 / 机构详情 |
| 路由 | `/w/platform/platform_root/agencies/:agencyId` |
| 插件 | `ky-organization-management` |
| 页面权限 | `platform.agencies.view` |
| 主要接口 | `GET /api/v1/platform/agencies/:agencyId` |

Tab：

- 基础信息。
- 机构成员概览。
- 服务企业。
- 审计日志。

---

### 4.5 企业列表

| 项 | 内容 |
|---|---|
| 菜单 | 企业中心 / 企业列表 |
| 路由 | `/w/platform/platform_root/enterprises` |
| 插件 | `ky-organization-management` |
| 页面权限 | `platform.enterprises.view` |
| 菜单权限 | `menu.platform.enterprises` |
| 主要接口 | `GET /api/v1/platform/enterprises` |

按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 创建企业 | `platform.enterprises.create` | `POST /api/v1/platform/enterprises` |
| 查看详情 | `platform.enterprises.view` | `GET /api/v1/platform/enterprises/:id` |
| 编辑企业 | `platform.enterprises.update` | `PATCH /api/v1/platform/enterprises/:id` |
| 调整归属机构 | `platform.enterprises.assign_agency` | `PATCH /api/v1/platform/enterprises/:id/agency` |
| 停用企业 | `platform.enterprises.disable` | `PATCH /api/v1/platform/enterprises/:id/status` |

---

### 4.6 平台权限中心

| 页面 | 路由 | 权限 | 主要接口 |
|---|---|---|---|
| 平台角色 | `/w/platform/platform_root/access/roles` | `platform.roles.view` | `GET /api/v1/roles` |
| 平台权限 | `/w/platform/platform_root/access/permissions` | `platform.permissions.view` | `GET /api/v1/permissions` |
| 平台成员授权 | `/w/platform/platform_root/access/member-roles` | `platform.roles.view` | `GET /api/v1/workspace/members`、`POST /api/v1/memberships/:id/roles` |
| 平台数据范围 | `/w/platform/platform_root/access/data-scopes` | `platform.data_scopes.view` | `GET /api/v1/data-scopes` |

常用按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 创建角色 | `platform.roles.create` | `POST /api/v1/roles` |
| 编辑角色 | `platform.roles.update` | `PATCH /api/v1/roles/:id` |
| 禁用角色 | `platform.roles.disable` | `PATCH /api/v1/roles/:id/status` |
| 分配权限 | `platform.roles.update_permissions` | `POST /api/v1/roles/:id/permissions` |
| 成员授权 | `platform.roles.assign` | `POST /api/v1/memberships/:id/roles` |

---

### 4.7 AI 配置

| 页面 | 路由 | 权限 | 主要接口 |
|---|---|---|---|
| 供应商管理 | `/w/platform/platform_root/ai/providers` | `platform.ai_providers.view` | `GET /api/v1/ai-models/providers` |
| 模型管理 | `/w/platform/platform_root/ai/models` | `platform.ai_models.view` | `GET /api/v1/ai-models` |
| 默认模型配置 | `/w/platform/platform_root/ai/settings` | `platform.ai_model_settings.view` | `GET /api/v1/ai-models/settings` |

按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 新增供应商 | `platform.ai_providers.create` | `POST /api/v1/ai-models/providers` |
| 编辑供应商 | `platform.ai_providers.update` | `PATCH /api/v1/ai-models/providers/:id` |
| 启停供应商 | `platform.ai_providers.update_status` | `PATCH /api/v1/ai-models/providers/:id/status` |
| 新增模型 | `platform.ai_models.create` | `POST /api/v1/ai-models` |
| 编辑模型 | `platform.ai_models.update` | `PATCH /api/v1/ai-models/:id` |
| 启停模型 | `platform.ai_models.update_status` | `PATCH /api/v1/ai-models/:id/status` |
| 修改默认模型 | `platform.ai_model_settings.update` | `PATCH /api/v1/ai-models/settings` |

---

### 4.8 平台通知、审计、系统设置

| 页面 | 路由 | 权限 | 主要接口 |
|---|---|---|---|
| 平台通知 | `/w/platform/platform_root/notifications` | `platform.notifications.view` | `GET /api/v1/notifications` |
| 系统公告 | `/w/platform/platform_root/announcements` | `platform.announcements.view` | `GET /api/v1/announcements` |
| 全局操作日志 | `/w/platform/platform_root/audit/operation-logs` | `platform.audit.view` | `GET /api/v1/audit-logs` |
| 登录日志 | `/w/platform/platform_root/audit/login-logs` | `platform.login_logs.view` | `GET /api/v1/login-logs` |
| 权限变更日志 | `/w/platform/platform_root/audit/permission-logs` | `platform.audit.view` | `GET /api/v1/audit-logs?action=permission_changed` |
| 基础设置 | `/w/platform/platform_root/settings/general` | `platform.settings.view` | `GET /api/v1/platform/system-settings` |
| 安全策略 | `/w/platform/platform_root/settings/security` | `platform.settings.view` | `GET /api/v1/platform/system-settings`，按 `section=security` 或 setting key 过滤 |
| 注册策略 | `/w/platform/platform_root/settings/registration` | `platform.settings.view` | `GET /api/v1/platform/system-settings`，按 `section=registration` 或 setting key 过滤 |
| 租户策略 | `/w/platform/platform_root/settings/tenant` | `platform.settings.view` | `GET /api/v1/platform/system-settings`，按 `section=tenant` 或 setting key 过滤 |
| 字典配置 | `/w/platform/platform_root/settings/dictionaries` | `platform.dictionaries.view` | `GET /api/v1/dictionaries` |

说明：`settings/general`、`settings/security`、`settings/registration`、`settings/tenant`、`settings/dictionaries` 是前端路由切片；后端第一阶段不拆 `/api/v1/platform/system-settings/security` 等子路由，统一使用 `GET/PATCH /api/v1/platform/system-settings` 按 `section` 或 setting key 读写。

---

## 5. 机构后台页面

### 5.1 机构工作台

| 项 | 内容 |
|---|---|
| 路由 | `/w/agency/:agencyId/workbench` |
| 权限 | `agency.workbench.view` |
| 菜单权限 | `menu.agency.workbench` |
| 接口 | `GET /api/v1/agency/workbench/summary` |

展示：

- 当前机构信息。
- 成员数量。
- 部门数量。
- 团队数量。
- 服务企业数量。
- 待接受邀请。
- 最近审计日志。
- 机构通知。

---

### 5.2 机构中心

| 页面 | 路由 | 权限 | 主要接口 |
|---|---|---|---|
| 机构信息 | `/w/agency/:agencyId/agency/profile` | `agency.profile.view` | `GET /api/v1/organizations/current` |
| 机构设置 | `/w/agency/:agencyId/settings/general` | `agency.settings.view` | `GET /api/v1/settings` |

按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 编辑机构信息 | `agency.profile.update` | `PATCH /api/v1/organizations/current` |
| 修改机构设置 | `agency.settings.update` | `PATCH /api/v1/settings` |

---

### 5.3 机构成员中心

| 页面 | 路由 | 权限 | 主要接口 |
|---|---|---|---|
| 机构成员 | `/w/agency/:agencyId/members` | `agency.members.view` | `GET /api/v1/workspace/members` |
| 成员邀请 | `/w/agency/:agencyId/invitations` | `agency.invitations.view` | `GET /api/v1/invitations` |
| 成员详情 | `/w/agency/:agencyId/members/:memberId` | `agency.members.view` | `GET /api/v1/workspace/members/:id` |

按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 邀请成员 | `agency.members.invite` | `POST /api/v1/invitations` |
| 禁用成员 | `agency.members.disable` | `PATCH /api/v1/workspace/members/:id/status` |
| 移除成员 | `agency.members.remove` | `DELETE /api/v1/workspace/members/:id` |
| 分配部门 | `agency.members.assign_department` | `POST /api/v1/workspace/members/:id/departments` |
| 分配团队 | `agency.members.assign_team` | `POST /api/v1/workspace/members/:id/teams` |

---

### 5.4 机构组织结构

| 页面 | 路由 | 权限 | 主要接口 |
|---|---|---|---|
| 部门管理 | `/w/agency/:agencyId/structure/departments` | `agency.departments.view` | `GET /api/v1/departments` |
| 团队管理 | `/w/agency/:agencyId/structure/teams` | `agency.teams.view` | `GET /api/v1/teams` |

按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 创建部门 | `agency.departments.create` | `POST /api/v1/departments` |
| 编辑部门 | `agency.departments.update` | `PATCH /api/v1/departments/:id` |
| 删除部门 | `agency.departments.delete` | `DELETE /api/v1/departments/:id` |
| 创建团队 | `agency.teams.create` | `POST /api/v1/teams` |
| 编辑团队 | `agency.teams.update` | `PATCH /api/v1/teams/:id` |
| 管理团队成员 | `agency.teams.manage_members` | `POST /api/v1/teams/:id/members` |

---

### 5.5 机构企业管理

| 页面 | 路由 | 权限 | 主要接口 |
|---|---|---|---|
| 服务企业 | `/w/agency/:agencyId/enterprises` | `agency.enterprises.view` | `GET /api/v1/agency/enterprises` |
| 企业详情 | `/w/agency/:agencyId/enterprises/:enterpriseId` | `agency.enterprises.view` | `GET /api/v1/agency/enterprises/:id` |

按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 开通企业 | `agency.enterprises.create` | `POST /api/v1/agency/enterprises` |
| 编辑企业基础信息 | `agency.enterprises.update` | `PATCH /api/v1/agency/enterprises/:id` |
| 邀请企业管理员 | `agency.enterprises.invite_admin` | `POST /api/v1/invitations` |

---

### 5.6 机构权限、通知、审计、设置

| 页面 | 路由 | 权限 | 主要接口 |
|---|---|---|---|
| 机构角色 | `/w/agency/:agencyId/access/roles` | `agency.roles.view` | `GET /api/v1/roles` |
| 机构权限 | `/w/agency/:agencyId/access/permissions` | `agency.permissions.view` | `GET /api/v1/permissions` |
| 成员授权 | `/w/agency/:agencyId/access/member-roles` | `agency.roles.view` | `GET /api/v1/workspace/members`、`POST /api/v1/memberships/:id/roles` |
| 数据范围 | `/w/agency/:agencyId/access/data-scopes` | `agency.data_scopes.view` | `GET /api/v1/data-scopes` |
| 我的通知 | `/w/agency/:agencyId/notifications` | `agency.notifications.view` | `GET /api/v1/notifications` |
| 系统公告 | `/w/agency/:agencyId/announcements` | `agency.announcements.view` | `GET /api/v1/announcements` |
| 机构操作日志 | `/w/agency/:agencyId/audit/operation-logs` | `agency.audit.view` | `GET /api/v1/audit-logs` |
| 成员变更日志 | `/w/agency/:agencyId/audit/member-logs` | `agency.audit.view` | `GET /api/v1/audit-logs?resourceType=membership` |
| 权限变更日志 | `/w/agency/:agencyId/audit/permission-logs` | `agency.audit.view` | `GET /api/v1/audit-logs?action=permission_changed` |
| 机构设置 | `/w/agency/:agencyId/settings/general` | `agency.settings.view` | `GET /api/v1/settings` |

说明：机构设置的前端子页可按 `general`、`security`、`invitation` 拆分；后端统一使用 `GET/PATCH /api/v1/settings` 按 setting key 或 section 读写。

---

## 6. 企业后台页面

### 6.1 企业工作台

| 项 | 内容 |
|---|---|
| 路由 | `/w/enterprise/:enterpriseId/workbench` |
| 权限 | `enterprise.workbench.view` |
| 菜单权限 | `menu.enterprise.workbench` |
| 接口 | `GET /api/v1/enterprise/workbench/summary` |

展示：

- 当前企业信息。
- 成员数量。
- 部门数量。
- 团队数量。
- 待接受邀请。
- 我的角色。
- 我的权限摘要。
- 最近企业日志。
- 我的通知。

---

### 6.2 企业中心

| 页面 | 路由 | 权限 | 主要接口 |
|---|---|---|---|
| 企业信息 | `/w/enterprise/:enterpriseId/enterprise/profile` | `enterprise.profile.view` | `GET /api/v1/organizations/current` |
| 企业设置 | `/w/enterprise/:enterpriseId/settings/general` | `enterprise.settings.view` | `GET /api/v1/settings` |

按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 编辑企业信息 | `enterprise.profile.update` | `PATCH /api/v1/organizations/current` |
| 修改企业设置 | `enterprise.settings.update` | `PATCH /api/v1/settings` |

---

### 6.3 企业成员中心

| 页面 | 路由 | 权限 | 主要接口 |
|---|---|---|---|
| 企业成员 | `/w/enterprise/:enterpriseId/members` | `enterprise.members.view` | `GET /api/v1/workspace/members` |
| 成员邀请 | `/w/enterprise/:enterpriseId/invitations` | `enterprise.invitations.view` | `GET /api/v1/invitations` |
| 成员详情 | `/w/enterprise/:enterpriseId/members/:memberId` | `enterprise.members.view` | `GET /api/v1/workspace/members/:id` |

按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 邀请成员 | `enterprise.members.invite` | `POST /api/v1/invitations` |
| 禁用成员 | `enterprise.members.disable` | `PATCH /api/v1/workspace/members/:id/status` |
| 移除成员 | `enterprise.members.remove` | `DELETE /api/v1/workspace/members/:id` |
| 分配部门 | `enterprise.members.assign_department` | `POST /api/v1/workspace/members/:id/departments` |
| 分配团队 | `enterprise.members.assign_team` | `POST /api/v1/workspace/members/:id/teams` |

---

### 6.4 企业组织结构

| 页面 | 路由 | 权限 | 主要接口 |
|---|---|---|---|
| 部门管理 | `/w/enterprise/:enterpriseId/structure/departments` | `enterprise.departments.view` | `GET /api/v1/departments` |
| 团队管理 | `/w/enterprise/:enterpriseId/structure/teams` | `enterprise.teams.view` | `GET /api/v1/teams` |

按钮：

| 按钮 | 权限 | 接口 |
|---|---|---|
| 创建部门 | `enterprise.departments.create` | `POST /api/v1/departments` |
| 编辑部门 | `enterprise.departments.update` | `PATCH /api/v1/departments/:id` |
| 删除部门 | `enterprise.departments.delete` | `DELETE /api/v1/departments/:id` |
| 创建团队 | `enterprise.teams.create` | `POST /api/v1/teams` |
| 编辑团队 | `enterprise.teams.update` | `PATCH /api/v1/teams/:id` |
| 管理团队成员 | `enterprise.teams.manage_members` | `POST /api/v1/teams/:id/members` |

---

### 6.5 企业权限、通知、审计、设置

| 页面 | 路由 | 权限 | 主要接口 |
|---|---|---|---|
| 企业角色 | `/w/enterprise/:enterpriseId/access/roles` | `enterprise.roles.view` | `GET /api/v1/roles` |
| 企业权限 | `/w/enterprise/:enterpriseId/access/permissions` | `enterprise.permissions.view` | `GET /api/v1/permissions` |
| 成员授权 | `/w/enterprise/:enterpriseId/access/member-roles` | `enterprise.roles.view` | `GET /api/v1/workspace/members`、`POST /api/v1/memberships/:id/roles` |
| 数据范围 | `/w/enterprise/:enterpriseId/access/data-scopes` | `enterprise.data_scopes.view` | `GET /api/v1/data-scopes` |
| 我的通知 | `/w/enterprise/:enterpriseId/notifications` | `enterprise.notifications.view` | `GET /api/v1/notifications` |
| 系统公告 | `/w/enterprise/:enterpriseId/announcements` | `enterprise.announcements.view` | `GET /api/v1/announcements` |
| 企业操作日志 | `/w/enterprise/:enterpriseId/audit/operation-logs` | `enterprise.audit.view` | `GET /api/v1/audit-logs` |
| 成员变更日志 | `/w/enterprise/:enterpriseId/audit/member-logs` | `enterprise.audit.view` | `GET /api/v1/audit-logs?resourceType=membership` |
| 权限变更日志 | `/w/enterprise/:enterpriseId/audit/permission-logs` | `enterprise.audit.view` | `GET /api/v1/audit-logs?action=permission_changed` |
| 企业设置 | `/w/enterprise/:enterpriseId/settings/general` | `enterprise.settings.view` | `GET /api/v1/settings` |

说明：企业设置的前端子页可按 `general`、`security`、`invitation` 拆分；后端统一使用 `GET/PATCH /api/v1/settings` 按 setting key 或 section 读写。

---

## 7. 全局 Header Action

| 功能 | 位置 | 插件 | 权限 | 接口 |
|---|---|---|---|---|
| 通知未读数 | 顶部栏 | `ky-notification` | 当前工作区通知查看权限 | `GET /api/v1/notifications/unread-count` |
| 通知入口 | 顶部栏 | `ky-notification` | 当前工作区通知查看权限 | `/w/:workspaceType/:workspaceId/notifications` |
| 工作区切换 | 顶部栏 | Host | 已登录且拥有多个后台身份 | `GET /api/v1/auth/bootstrap` |

---

## 8. 插件归属建议

| 插件 | 页面范围 |
|---|---|
| `ky-identity-management` | 登录后个人资料、全局用户、登录日志 |
| `ky-organization-management` | 平台机构/企业、机构/企业资料、部门、团队、成员基础页面 |
| `ky-access-management` | 角色、权限、成员授权、数据范围 |
| `ky-audit-management` | 操作日志、权限变更日志、登录日志查询 |
| `ky-notification` | 我的通知、系统公告、未读数 header action |
| `ky-system-settings` | 平台/机构/企业设置、字典配置、安全策略 |
| `ky-ai-configuration` | AI 供应商、AI 模型、默认模型配置 |

说明：本表中的插件名为目录短名；实际 npm 包名必须使用 `@ky/plugin-*`，例如目录 `plugins/ky-notification` 对应包名 `@ky/plugin-notification`。

---

## 9. 第一阶段页面验收标准

1. 平台后台、机构后台、企业后台菜单不同。
2. 同一用户切换不同后台身份后页面权限变化。
3. 无菜单权限时菜单不展示。
4. 无页面权限时 URL 直接访问进入 `/403`。
5. 无操作权限时按钮不展示。
6. 后端接口仍需校验操作权限。
7. 部门负责人、团队负责人只能看到 scope 范围内页面和数据。
8. AI 配置只在平台授权角色下可管理。
9. 页面路由全部位于 `/w/:workspaceType/:workspaceId` 下。
10. 插件页面通过 `ky-admin-core` 注册，不写死到 Host。
