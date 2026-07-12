# KyaiCRM 权限矩阵文档

> 文档状态：已锁定 / Phase 1 基线  
> 项目名称：KyaiCRM  
> 当前阶段：第一阶段 / 多租户用户中心与多后台身份底座  
> 编写日期：2026-06-15  
> 参照项目：`/data/Kysion/zhipinai_v2/docs/V2_PERMISSION_MATRIX.md`  
> 关联文档：
> - `docs/kyai_crm_multi_tenant_identity_requirements.md`
> - `docs/kyai_crm_architecture.md`
> - `docs/kyai_crm_data_model.md`
> - `docs/kyai_crm_v9_execution_architecture.md`（Post-Phase1 v9.1 覆盖扩展）

> 覆盖说明：第 1–13 节是 Phase 1 权限基线。Matrix Account、Agent Executor、可信 Desktop 与 AI 脚本维护的新增权限、grant 和设备证明规则由第 14 节补充；发生交叉范围冲突时以对应 v9.1 详细合同为准。

---

## 1. 文档目的

本文档用于定义 KyaiCRM 第一阶段权限矩阵。

权限矩阵覆盖：

- 后台身份。
- 菜单可见性。
- 页面访问。
- 操作按钮。
- 数据范围。
- 工作区切换后的权限变化。
- 无权限处理。

KyaiCRM 权限模式严格复用 zhipinai_v2 的工作区权限思想：

- 权限在当前 workspace 内计算。
- 同一用户在不同 workspace 中可以拥有不同角色。
- 切换 workspace 后菜单、页面、操作、数据范围都必须重新计算。
- 前端隐藏不是安全边界，后端必须再次校验。

---

## 2. 权限核心原则

1. 权限绑定当前工作区，不使用全局最强角色。
2. 平台角色不自动拥有机构或企业身份。
3. 机构角色不自动拥有平台身份。
4. 企业角色不自动拥有机构身份。
5. 部门负责人、团队负责人属于机构或企业 workspace 内的管理范围，不是独立 workspace。
6. 没有菜单权限，不展示菜单。
7. 没有页面权限，直接访问 URL 应进入 `/403`。
8. 没有操作权限，不展示按钮，后端拒绝请求。
9. 没有数据范围，不返回数据或返回权限拒绝，不用空列表掩盖权限问题。
10. workspace 切换后必须清理或隔离前端缓存，避免权限串用。

---

## 3. 第一阶段工作区

```text
platform
agency
enterprise
```

### 3.1 platform

平台工作区固定：

```text
workspace_type = platform
workspace_id = platform_root
```

平台工作区只允许拥有平台成员身份的用户进入。

### 3.2 agency

机构工作区：

```text
workspace_type = agency
workspace_id = agency_id
```

机构工作区只允许当前机构成员进入。

### 3.3 enterprise

企业工作区：

```text
workspace_type = enterprise
workspace_id = enterprise_id
```

企业工作区只允许当前企业成员进入。

---

## 4. 第一阶段角色

### 4.1 平台角色

```text
platform_owner       平台超级管理员
platform_admin       平台管理员
platform_operator    平台运营
```

### 4.2 机构角色

```text
agency_owner         机构所有者
agency_admin         机构管理员
agency_operator      机构运营
agency_readonly      机构只读
agency_member        机构普通成员
```

### 4.3 企业角色

```text
enterprise_owner     企业所有者
enterprise_admin     企业管理员
enterprise_operator  企业运营
enterprise_readonly  企业只读
enterprise_member    企业普通成员
```

### 4.4 范围型角色

范围型角色不产生独立 workspace，只限制在当前机构或企业 workspace 内。

```text
department_leader    部门负责人
team_leader          团队负责人
```

---

## 5. 菜单权限矩阵

### 5.1 平台后台菜单

| 菜单 | platform_owner | platform_admin | platform_operator |
|---|---:|---:|---:|
| 平台工作台 | yes | yes | yes |
| 用户中心 | yes | yes | yes |
| 机构中心 | yes | yes | yes |
| 企业中心 | yes | yes | yes |
| 权限中心 | yes | yes | limited |
| AI 配置 | yes | yes | limited |
| 通知中心 | yes | yes | yes |
| 审计中心 | yes | yes | read |
| 系统设置 | yes | yes | no |

说明：

- `read` 表示只读菜单可见，只能查看。
- `limited` 表示可执行部分非破坏性操作。
- `no` 表示菜单不可见。
- 菜单矩阵中的 `read` / `limited` 只表达菜单可见性和默认能力等级；具体页面能否进入以“页面访问矩阵”为准，具体写操作以“操作权限矩阵”和 action permission 为准。

---

### 5.2 机构后台菜单

| 菜单 | agency_owner | agency_admin | agency_operator | agency_readonly | agency_member | department_leader | team_leader |
|---|---:|---:|---:|---:|---:|---:|---:|
| 机构工作台 | yes | yes | yes | yes | yes | yes | yes |
| 机构中心 | yes | yes | read | read | limited | limited | limited |
| 成员中心 | yes | yes | limited | read | no | scoped | scoped |
| 组织结构 | yes | yes | limited | read | no | scoped | scoped |
| 企业管理 | yes | yes | limited | read | no | no | no |
| 权限中心 | yes | yes | no | read | no | no | no |
| 通知中心 | yes | yes | yes | yes | yes | yes | yes |
| 审计中心 | yes | yes | read | read | no | scoped | scoped |
| 机构设置 | yes | yes | no | read | no | no | no |

说明：

- `scoped` 表示只在部门或团队范围内可见和可操作。
- 普通成员默认只保留工作台、个人信息、通知等基础能力。

---

### 5.3 企业后台菜单

| 菜单 | enterprise_owner | enterprise_admin | enterprise_operator | enterprise_readonly | enterprise_member | department_leader | team_leader |
|---|---:|---:|---:|---:|---:|---:|---:|
| 企业工作台 | yes | yes | yes | yes | yes | yes | yes |
| 企业中心 | yes | yes | read | read | limited | limited | limited |
| 成员中心 | yes | yes | limited | read | no | scoped | scoped |
| 组织结构 | yes | yes | limited | read | no | scoped | scoped |
| 权限中心 | yes | yes | no | read | no | no | no |
| 通知中心 | yes | yes | yes | yes | yes | yes | yes |
| 审计中心 | yes | yes | read | read | no | scoped | scoped |
| 企业设置 | yes | yes | no | read | no | no | no |

---

## 6. 页面访问矩阵

### 6.1 平台页面

| 页面 | owner | admin | operator | readonly |
|---|---:|---:|---:|---:|
| 平台工作台 | yes | yes | yes | yes |
| 全局用户列表 | yes | yes | yes | yes |
| 用户详情 | yes | yes | yes | yes |
| 平台成员 | yes | yes | no | no |
| 平台邀请 | yes | yes | no | no |
| 机构列表 | yes | yes | yes | yes |
| 机构详情 | yes | yes | yes | yes |
| 企业列表 | yes | yes | yes | yes |
| 企业详情 | yes | yes | yes | yes |
| 平台角色 | yes | yes | yes | yes |
| 平台权限 | yes | yes | yes | yes |
| 平台成员授权 | yes | yes | no | no |
| 平台数据范围 | yes | yes | yes | yes |
| AI 供应商 | yes | yes | yes | yes |
| AI 模型 | yes | yes | yes | yes |
| 默认模型配置 | yes | yes | yes | yes |
| 平台通知 | yes | yes | yes | yes |
| 系统公告 | yes | yes | yes | yes |
| 全局审计日志 | yes | yes | yes | yes |
| 登录日志 | yes | yes | yes | yes |
| 系统设置 | yes | yes | no | yes |
| 字典配置 | yes | yes | no | yes |

---

### 6.2 机构页面

| 页面 | owner | admin | operator | readonly | member | department_leader | team_leader |
|---|---:|---:|---:|---:|---:|---:|---:|
| 机构工作台 | yes | yes | yes | yes | yes | yes | yes |
| 机构信息 | yes | yes | yes | yes | yes | yes | yes |
| 机构成员列表 | yes | yes | limited | yes | no | scoped | scoped |
| 成员详情 | yes | yes | limited | yes | no | scoped | scoped |
| 成员邀请 | yes | yes | limited | no | no | no | no |
| 部门管理 | yes | yes | limited | yes | no | scoped | no |
| 团队管理 | yes | yes | limited | yes | no | scoped | scoped |
| 服务企业列表 | yes | yes | limited | yes | no | no | no |
| 机构角色 | yes | yes | no | yes | no | no | no |
| 成员授权 | yes | yes | no | no | no | no | no |
| 数据范围 | yes | yes | no | yes | no | no | no |
| 机构通知 | yes | yes | yes | yes | yes | yes | yes |
| 系统公告 | yes | yes | yes | yes | yes | yes | yes |
| 机构审计日志 | yes | yes | yes | yes | no | scoped | scoped |
| 机构设置 | yes | yes | no | yes | no | no | no |

---

### 6.3 企业页面

| 页面 | owner | admin | operator | readonly | member | department_leader | team_leader |
|---|---:|---:|---:|---:|---:|---:|---:|
| 企业工作台 | yes | yes | yes | yes | yes | yes | yes |
| 企业信息 | yes | yes | yes | yes | yes | yes | yes |
| 企业成员列表 | yes | yes | limited | yes | no | scoped | scoped |
| 成员详情 | yes | yes | limited | yes | no | scoped | scoped |
| 成员邀请 | yes | yes | limited | no | no | no | no |
| 部门管理 | yes | yes | limited | yes | no | scoped | no |
| 团队管理 | yes | yes | limited | yes | no | scoped | scoped |
| 企业角色 | yes | yes | no | yes | no | no | no |
| 成员授权 | yes | yes | no | no | no | no | no |
| 数据范围 | yes | yes | no | yes | no | no | no |
| 企业通知 | yes | yes | yes | yes | yes | yes | yes |
| 系统公告 | yes | yes | yes | yes | yes | yes | yes |
| 企业审计日志 | yes | yes | yes | yes | no | scoped | scoped |
| 企业设置 | yes | yes | no | yes | no | no | no |

---

## 7. 操作权限矩阵

### 7.1 平台操作权限

| 操作 | owner | admin | operator | readonly |
|---|---:|---:|---:|---:|
| 创建机构 | yes | yes | yes | no |
| 编辑机构 | yes | yes | yes | no |
| 停用 / 冻结机构 | yes | yes | no | no |
| 创建企业 | yes | yes | yes | no |
| 编辑企业 | yes | yes | yes | no |
| 调整企业归属机构 | yes | yes | no | no |
| 停用企业 | yes | yes | no | no |
| 禁用用户 | yes | yes | no | no |
| 邀请平台成员 | yes | yes | no | no |
| 创建平台角色 | yes | yes | no | no |
| 修改平台权限 | yes | yes | no | no |
| 发布系统公告 | yes | yes | yes | no |
| 修改系统设置 | yes | yes | no | no |
| 新增 AI 供应商 | yes | yes | no | no |
| 修改 AI 供应商 | yes | yes | limited | no |
| 新增 AI 模型 | yes | yes | limited | no |
| 修改默认模型 | yes | yes | no | no |

---

### 7.2 机构操作权限

| 操作 | owner | admin | operator | readonly | member | department_leader | team_leader |
|---|---:|---:|---:|---:|---:|---:|---:|
| 编辑机构信息 | yes | yes | limited | no | no | no | no |
| 邀请机构成员 | yes | yes | limited | no | no | no | no |
| 禁用机构成员 | yes | yes | no | no | no | no | no |
| 移除机构成员 | yes | yes | no | no | no | no | no |
| 创建部门 | yes | yes | limited | no | no | scoped | no |
| 编辑部门 | yes | yes | limited | no | no | scoped | no |
| 删除部门 | yes | yes | no | no | no | no | no |
| 创建团队 | yes | yes | limited | no | no | scoped | scoped |
| 编辑团队 | yes | yes | limited | no | no | scoped | scoped |
| 管理团队成员 | yes | yes | limited | no | no | scoped | scoped |
| 创建角色 | yes | yes | no | no | no | no | no |
| 分配角色 | yes | yes | no | no | no | no | no |
| 查看审计日志 | yes | yes | yes | yes | no | scoped | scoped |
| 修改机构设置 | yes | yes | no | no | no | no | no |

---

### 7.3 企业操作权限

| 操作 | owner | admin | operator | readonly | member | department_leader | team_leader |
|---|---:|---:|---:|---:|---:|---:|---:|
| 编辑企业信息 | yes | yes | limited | no | no | no | no |
| 邀请企业成员 | yes | yes | limited | no | no | no | no |
| 禁用企业成员 | yes | yes | no | no | no | no | no |
| 移除企业成员 | yes | yes | no | no | no | no | no |
| 创建部门 | yes | yes | limited | no | no | scoped | no |
| 编辑部门 | yes | yes | limited | no | no | scoped | no |
| 删除部门 | yes | yes | no | no | no | no | no |
| 创建团队 | yes | yes | limited | no | no | scoped | scoped |
| 编辑团队 | yes | yes | limited | no | no | scoped | scoped |
| 管理团队成员 | yes | yes | limited | no | no | scoped | scoped |
| 创建角色 | yes | yes | no | no | no | no | no |
| 分配角色 | yes | yes | no | no | no | no | no |
| 查看审计日志 | yes | yes | yes | yes | no | scoped | scoped |
| 修改企业设置 | yes | yes | no | no | no | no | no |

---

## 8. 数据范围矩阵

### 8.1 平台工作区

| 角色 | 数据范围 |
|---|---|
| platform_owner | 全部平台数据、全部机构、全部企业 |
| platform_admin | 全部平台数据、全部机构、全部企业，危险操作受限于操作权限 |
| platform_operator | 授权范围内机构和企业，默认不含系统设置和权限变更 |

---

### 8.2 机构工作区

| 角色 | 数据范围 |
|---|---|
| agency_owner | 当前机构、机构部门、机构团队、机构成员、机构名下或授权服务企业 |
| agency_admin | 当前机构范围，危险操作受限 |
| agency_operator | 授权机构操作范围，通常不含角色权限和系统设置 |
| agency_readonly | 当前机构只读范围 |
| agency_member | 个人基础信息、个人通知 |
| department_leader | 当前机构内指定部门及下级部门 |
| team_leader | 当前机构内指定团队 |

---

### 8.3 企业工作区

| 角色 | 数据范围 |
|---|---|
| enterprise_owner | 当前企业全部数据 |
| enterprise_admin | 当前企业全部数据，危险操作受限 |
| enterprise_operator | 授权企业操作范围，通常不含角色权限和系统设置 |
| enterprise_readonly | 当前企业只读范围 |
| enterprise_member | 个人基础信息、个人通知 |
| department_leader | 当前企业内指定部门及下级部门 |
| team_leader | 当前企业内指定团队 |

---

## 9. 第一阶段权限字典

本节是 Phase 1 seed、前端菜单、页面路由和后端接口鉴权的权限编码真相源。新增页面或接口时必须先补充本节。

### 9.1 菜单权限

```text
menu.platform.workbench
menu.platform.users
menu.platform.members
menu.platform.agencies
menu.platform.enterprises
menu.platform.access
menu.platform.ai_configuration
menu.platform.notifications
menu.platform.audit
menu.platform.settings

menu.agency.workbench
menu.agency.profile
menu.agency.members
menu.agency.structure
menu.agency.enterprises
menu.agency.access
menu.agency.notifications
menu.agency.audit
menu.agency.settings

menu.enterprise.workbench
menu.enterprise.profile
menu.enterprise.members
menu.enterprise.structure
menu.enterprise.access
menu.enterprise.notifications
menu.enterprise.audit
menu.enterprise.settings
```

### 9.2 页面权限

```text
platform.workbench.view
platform.users.view
platform.members.view
platform.invitations.view
platform.agencies.view
platform.enterprises.view
platform.roles.view
platform.permissions.view
platform.data_scopes.view
platform.notifications.view
platform.announcements.view
platform.audit.view
platform.login_logs.view
platform.settings.view
platform.dictionaries.view
platform.ai_providers.view
platform.ai_models.view
platform.ai_model_settings.view

agency.workbench.view
agency.profile.view
agency.members.view
agency.invitations.view
agency.departments.view
agency.teams.view
agency.enterprises.view
agency.roles.view
agency.permissions.view
agency.data_scopes.view
agency.notifications.view
agency.announcements.view
agency.audit.view
agency.settings.view

enterprise.workbench.view
enterprise.profile.view
enterprise.members.view
enterprise.invitations.view
enterprise.departments.view
enterprise.teams.view
enterprise.roles.view
enterprise.permissions.view
enterprise.data_scopes.view
enterprise.notifications.view
enterprise.announcements.view
enterprise.audit.view
enterprise.settings.view
```

说明：第一阶段字典配置仅平台后台可见，使用 `platform.dictionaries.view`；机构和企业后台不定义 `agency.dictionaries.view`、`enterprise.dictionaries.view`。AI 配置第一阶段也仅平台后台可见，统一使用 `menu.platform.ai_configuration`，机构和企业不定义 AI 配置菜单 key。

### 9.3 操作权限

```text
platform.users.enable
platform.users.disable
platform.members.create
platform.members.update
platform.members.reset_password
platform.members.invite
platform.members.disable
platform.members.remove
platform.agencies.create
platform.agencies.update
platform.agencies.disable
platform.agencies.freeze
platform.enterprises.create
platform.enterprises.update
platform.enterprises.disable
platform.enterprises.assign_agency
platform.roles.create
platform.roles.update
platform.roles.disable
platform.roles.assign
platform.roles.update_permissions
platform.announcements.create
platform.announcements.publish
platform.settings.update
platform.ai_providers.create
platform.ai_providers.update
platform.ai_providers.update_status
platform.ai_models.create
platform.ai_models.update
platform.ai_models.update_status
platform.ai_model_settings.update

agency.profile.update
agency.members.create
agency.members.update
agency.members.reset_password
agency.members.invite
agency.members.disable
agency.members.remove
agency.members.assign_department
agency.members.assign_team
agency.departments.create
agency.departments.update
agency.departments.delete
agency.teams.create
agency.teams.update
agency.teams.manage_members
agency.enterprises.create
agency.enterprises.update
agency.enterprises.invite_admin
agency.roles.create
agency.roles.update
agency.roles.assign
agency.roles.update_permissions
agency.settings.update

enterprise.profile.update
enterprise.members.create
enterprise.members.update
enterprise.members.reset_password
enterprise.members.invite
enterprise.members.disable
enterprise.members.remove
enterprise.members.assign_department
enterprise.members.assign_team
enterprise.departments.create
enterprise.departments.update
enterprise.departments.delete
enterprise.teams.create
enterprise.teams.update
enterprise.teams.manage_members
enterprise.roles.create
enterprise.roles.update
enterprise.roles.assign
enterprise.roles.update_permissions
enterprise.settings.update
```

---

## 10. 无权限处理规则

### 10.1 页面无权限

当用户访问无权限页面：

- 跳转或渲染 `/403`。
- 明确展示当前 workspace。
- 提示当前身份无权访问。
- 提供返回工作台或切换身份操作。

### 10.2 操作无权限

当用户执行无权限操作：

- 前端不展示按钮。
- 后端返回权限错误。
- 不应静默成功。
- 不应仅返回空结果掩盖权限拒绝。

### 10.3 数据无权限

当用户请求超出数据范围的数据：

- 后端拒绝或过滤。
- 对明确对象详情访问，建议返回 403。
- 对列表查询，可按数据范围过滤，但必须确保不会泄漏越权数据。

---

## 11. 工作区切换规则

用户切换工作区后，必须重新计算：

```text
workspaceType
workspaceId
membershipId
roles
permissions
actionPermissions
menuKeys
dataScope
departmentScope
teamScope
notificationScope
```

前端必须：

- 清理或隔离 React Query 缓存。
- 重新生成菜单。
- 重新挂载路由权限状态。
- 跳转目标工作区工作台。

后端必须：

- 不信任前端缓存。
- 每个接口重新校验 workspace header。
- 每个接口重新校验 membership 与 permission。

---

## 12. 验收场景

第一阶段权限验收至少包含：

1. 同一用户拥有平台管理员和企业普通成员身份。
2. 切换到平台后台后能看到平台菜单。
3. 切换到企业后台普通成员后平台菜单消失。
4. 企业普通成员直接访问平台 URL 进入 `/403`。
5. 机构管理员只能看到当前机构及授权企业。
6. 企业管理员只能看到当前企业。
7. 部门负责人只能看到本部门及下级部门成员。
8. 团队负责人只能看到本团队成员。
9. 无操作权限时按钮不显示。
10. 直接调用无权限 API 被后端拒绝。
11. 切换 workspace 后旧列表缓存不会展示越权数据。
12. AI 配置仅平台授权角色可修改。

---

## 13. 后续细化

本文档为第一阶段权限矩阵初稿。后续在页面清单和 API 设计阶段，需要继续细化：

- 每个页面的 permission code。
- 每个按钮的 action permission code。
- 每个接口的 required permission。
- 每个查询的数据范围规则。
- seed 中内置角色与权限的绑定关系。

---

## 14. Post-Phase1 v9.1 Matrix 与 Executor 权限扩展

### 14.1 三个正交授权条件

v9.1 所有接口先校验 actor RBAC、当前 workspace 和数据范围；只有操作涉及对应资源或本地受信能力时，才叠加 grant 与 device proof：

```text
actor RBAC permission
+ workspace executor grant / resource publication（脚本选择、生成或执行）
+ Desktop device proof（本地受信操作）
```

- Platform executor 管理和纯安全查询不因本公式无条件要求 workspace grant 或 Desktop proof。多项条件适用时必须全部满足，任一项不能替代另一项。
- 普通 Bearer body 不能模拟 Desktop proof，设备签名也不能绕过 actor RBAC；需要 workspace grant 的脚本操作也不能绕过 grant。
- Matrix 查询/写入还必须在 store/query 层应用当前 workspace 数据范围；列表 `items` 与 `total` 使用同一 predicate。
- Executor 公共管理 API 只属于 platform workspace；agency/enterprise 不能直接读取 executor 私有资源。

### 14.2 Matrix Account 权限

菜单唯一使用：

```text
menu.platform.matrix_accounts
menu.agency.matrix_accounts
menu.enterprise.matrix_accounts
```

页面与账号操作：

```text
<workspace>.matrix_accounts.view
<workspace>.matrix_accounts.create
<workspace>.matrix_accounts.update
<workspace>.matrix_accounts.update_status
<workspace>.matrix_accounts.delete
<workspace>.matrix_accounts.login
<workspace>.matrix_accounts.open
<workspace>.matrix_accounts.check
<workspace>.matrix_accounts.clear_session
```

脚本、WebSpace 与敏感调试：

```text
<workspace>.matrix_account_scripts.view
<workspace>.matrix_account_scripts.manage
<workspace>.matrix_account_web_spaces.debug
<workspace>.matrix_account_sensitive_debug.view
<workspace>.matrix_account_sensitive_debug.export
<workspace>.matrix_account_login_scripts.view
<workspace>.matrix_account_login_scripts.update
<workspace>.matrix_account_login_scripts.regenerate
<workspace>.matrix_account_login_scripts.activate_version
<workspace>.matrix_account_login_scripts.assign_executor
<workspace>.matrix_account_login_scripts.assign_model
```

组合权限固定使用 AND：generation/contract test 需要 `view + regenerate`；修改 executor 需要 `update + assign_executor`；修改 model 需要 `update + assign_model`；同时修改需要三个权限全部成立，并再次校验 workspace grant 与 catalog。

### 14.3 Agent Executor 权限

```text
platform.ai_executors.view
platform.ai_executors.create
platform.ai_executors.update
platform.ai_executors.authorize
platform.ai_executors.change_account
platform.ai_executors.bind_device
platform.ai_executors.rebind_device
platform.ai_executors.force_revoke
platform.ai_executor_tasks.view
platform.ai_executor_tasks.create
platform.ai_executor_tasks.cancel
```

AI 配置菜单的唯一真相仍为 `menu.platform.ai_configuration`。`platform.ai_executors.view` 是页面权限，不能作为 `menuKey`，也不能保留 `ai.executors.view` 等第二套菜单 key。

默认角色 seed 与 API 逐项授权以 `docs/kyai_crm_ai_executor_authorization_requirements.md` §20.7 为准：`platform_owner` 拥有全部 executor 权限；`platform_admin` 不含 `force_revoke/rebind_device`；`platform_operator` 默认只读。Platform/agency/enterprise owner/admin 默认拥有对应脚本的 `assign_executor/assign_model`，operator/readonly/member 默认没有；rebind 和 force revoke 只属于 `platform_owner`。

### 14.4 安全投影与下级工作区

Agency/enterprise 只能经 Matrix API 读取已经发布给当前 workspace 的安全摘要：executor ID、名称、runtime、readiness 与脚本维护能力。不得读取账号标签、设备详情、公钥、凭据/credential revision、路径、授权会话、challenge、user code、原始任务输出或敏感诊断。

详情、Session、WebSpace、Generation Run 和 Executor Task 越权查询统一按对应领域合同返回 404 或 403；凡可能形成资源 ID 探测的 Matrix 资源统一返回 404。
