# KyaiCRM 总体架构设计文档

> 文档状态：已锁定 / Phase 1 基线  
> 项目名称：KyaiCRM  
> 当前阶段：第一阶段 / 多租户用户中心与多后台身份底座  
> 编写日期：2026-06-15  
> 参照项目：`/data/Kysion/zhipinai_v2`  
> 关联文档：
> - `docs/kyai_crm_multi_tenant_identity_requirements.md`
> - `docs/kyai_crm_technical_selection.md`

---

## 1. 文档目的

本文档用于描述 KyaiCRM 第一阶段的总体架构设计。

KyaiCRM 第一阶段不建设 CRM 业务，而是建设一个以用户为中心的多租户、多组织、多后台身份管理底座。本文档将需求文档与技术选型文档连接起来，明确系统由哪些前端模块、后端服务、数据对象、基础设施和运行链路组成。

---

## 2. 架构目标

KyaiCRM 第一阶段架构需要支持：

1. 用户账号全局统一。
2. 用户可拥有多个后台身份。
3. 平台、机构、企业三类独立后台入口。
4. 部门、团队作为组织内部管理范围。
5. 工作区上下文驱动菜单、权限、数据和通知。
6. Host + Plugin 后台插件化架构。
7. Go 多服务后端架构。
8. PostgreSQL 作为主数据库。
9. Redis、NATS、S3/MinIO 作为基础设施能力。
10. Nginx + systemd + 原生 VM 部署。
11. 严格复用 zhipinai_v2 的架构、工程组织和权限模式。

---

## 3. 总体架构视图

```text
浏览器 / 管理后台
        │
        ▼
Nginx / Console 静态托管 + API 反代
        │
        ├── ky-admin-host 静态资源
        │
        ├── /api/v1/auth/*          ──► ky-auth-service
        ├── /api/v1/platform/users* ──► ky-auth-service
        ├── /api/v1/login-logs*     ──► ky-auth-service
        ├── /api/v1/platform/agencies* / platform/enterprises* / platform/system-settings* ──► ky-org-service
        ├── /api/v1/agency/enterprises* ──► ky-org-service
        ├── /api/v1/organizations*  ──► ky-org-service
        ├── /api/v1/departments*    ──► ky-org-service
        ├── /api/v1/teams*          ──► ky-org-service
        ├── /api/v1/settings*       ──► ky-org-service
        ├── /api/v1/dictionaries*   ──► ky-org-service
        ├── /api/v1/(platform|agency|enterprise)/workbench/summary ──► ky-org-service
        ├── /api/v1/workspace/members* ──► ky-membership-service
        ├── /api/v1/memberships*    ──► ky-membership-service
        ├── /api/v1/roles*          ──► ky-membership-service
        ├── /api/v1/permissions*    ──► ky-membership-service
        ├── /api/v1/data-scopes*    ──► ky-membership-service
        ├── /api/v1/invitations* / public/invitations* ──► ky-membership-service
        ├── /api/v1/audit-logs*     ──► ky-membership-service
        ├── /api/v1/notifications* / announcements* ──► ky-membership-service，后续可拆 ky-notification-service
        └── /api/v1/ai-models*      ──► ky-ai-model-service

后端服务
        │
        ├── PostgreSQL：用户、组织、成员、权限、审计、通知、AI 配置
        ├── Redis：短状态、会话辅助、限流、验证码、临时 token
        ├── NATS：审计事件、通知事件、成员变更事件、权限变更事件
        └── S3/MinIO：头像、Logo、附件、导入导出文件
```

说明：上图只展示主干链路，精确 API 与服务映射以 `docs/kyai_crm_api_contracts.md` 为准。

---

## 4. 前端总体架构

### 4.1 前端架构模式

KyaiCRM 前端采用：

```text
Admin Host + Admin Core + Plugins
```

该模式严格复用 zhipinai_v2。

```text
apps/ky-admin-host
packages/ky-admin-core
plugins/ky-*
```

---

### 4.2 Admin Host

目录：

```text
apps/ky-admin-host
```

职责：

- 登录页。
- 注册页。
- 邀请接受页。
- 后台身份选择页。
- 工作区切换。
- 主布局。
- 顶部栏。
- 侧边栏。
- 插件注册。
- 菜单汇总。
- 路由挂载。
- 权限守卫。
- QueryClient 管理。
- 请求上下文注入。
- session 存储。
- 插件错误边界。

Host 不承载具体业务页面。具体后台页面由插件提供。

---

### 4.3 Admin Core

目录：

```text
packages/ky-admin-core
```

职责：

- 插件协议类型。
- 菜单协议。
- 路由协议。
- 面包屑协议。
- 权限上下文。
- 工作区上下文。
- 受控请求客户端类型。
- Header action 协议。
- Workbench contribution 协议。
- Query namespace 协议。

Admin Core 是 Host 与 Plugins 之间的契约层。

---

### 4.4 Plugins

目录：

```text
plugins/ky-identity-management
plugins/ky-organization-management
plugins/ky-access-management
plugins/ky-audit-management
plugins/ky-notification
plugins/ky-system-settings
plugins/ky-ai-configuration
```

插件职责：

- 声明自己的菜单。
- 声明自己的路由。
- 声明自己的权限点。
- 提供页面组件。
- 提供工作台卡片，可选。
- 提供 Header action，可选。
- 提供 query namespace。

插件必须通过 Host 提供的 request client 访问后端，不能直接读取 token。

---

## 5. 前端运行时结构

```text
用户访问后台入口
        │
        ▼
ky-admin-host 启动
        │
        ▼
读取本地 session
        │
        ├── 无 session：进入登录页
        │
        └── 有 session：调用 bootstrap
                    │
                    ▼
            获取 user + workspace identities + permissions + menuKeys
                    │
                    ├── 无身份：进入无身份页
                    ├── 单身份：进入对应 workspace workbench
                    └── 多身份：进入后台身份选择页
```

---

## 6. 后端总体架构

### 6.1 服务拆分原则

后端按领域事实拆分服务，不按前端插件数量机械拆分。

第一阶段推荐服务：

```text
ky-auth-service
ky-org-service
ky-membership-service
ky-ai-model-service
```

可选服务，后续阶段再启用；第一阶段不部署：

```text
ky-notification-service
```

---

### 6.2 ky-auth-service

职责：

- 用户注册。
- 用户登录。
- 用户登出。
- Token 签发与校验。
- 当前用户信息。
- Bootstrap。
- 后台身份列表聚合。
- 全局用户基础管理。
- 登录日志。

核心接口：

```text
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/register
GET  /api/v1/auth/bootstrap
GET  /api/v1/auth/me
GET  /api/v1/platform/users
```

---

### 6.3 ky-org-service

职责：

- 平台组织主体基础配置。
- 机构管理。
- 企业管理。
- 机构与企业关系。
- 部门管理。
- 团队管理。
- 系统设置。
- 组织级设置。
- 资产配置，可选。

核心接口：

```text
GET    /api/v1/platform/agencies
POST   /api/v1/platform/agencies
GET    /api/v1/platform/enterprises
POST   /api/v1/platform/enterprises
GET    /api/v1/agency/enterprises
POST   /api/v1/agency/enterprises
GET    /api/v1/organizations/current
PATCH  /api/v1/organizations/current
GET    /api/v1/departments
POST   /api/v1/departments
GET    /api/v1/teams
POST   /api/v1/teams
GET    /api/v1/settings
PATCH  /api/v1/settings
GET    /api/v1/platform/system-settings
PATCH  /api/v1/platform/system-settings
GET    /api/v1/dictionaries
```

---

### 6.4 ky-membership-service

职责：

- 成员关系。
- 成员邀请。
- 邀请接受。
- 角色管理。
- 权限管理。
- 成员授权。
- 数据范围。
- 审计日志。
- 通知中心，第一阶段归口在此；不单独部署 `ky-notification-service`。

核心接口：

```text
GET    /api/v1/workspace/members
POST   /api/v1/invitations
GET    /api/v1/invitations
GET    /api/v1/public/invitations/:token
POST   /api/v1/public/invitations/:token/accept
GET    /api/v1/roles
POST   /api/v1/roles
GET    /api/v1/permissions
GET    /api/v1/data-scopes
POST   /api/v1/memberships/:id/roles
GET    /api/v1/audit-logs
GET    /api/v1/notifications
GET    /api/v1/announcements
```

---

### 6.5 ky-ai-model-service

职责只限 AI 配置层：

- AI 供应商管理。
- AI 模型管理。
- 默认模型配置。
- 模型启停。
- AI 配置变更审计。

核心接口：

```text
GET    /api/v1/ai-models/providers
POST   /api/v1/ai-models/providers
PATCH  /api/v1/ai-models/providers/:id
GET    /api/v1/ai-models
POST   /api/v1/ai-models
PATCH  /api/v1/ai-models/:id
GET    /api/v1/ai-models/settings
PATCH  /api/v1/ai-models/settings
```

明确不包含：AI 员工、AI 执行器、AI 工作流、AI 协作、AI 人才市场。

---

## 7. 工作区架构

### 7.1 工作区类型

KyaiCRM 第一阶段支持：

```text
platform
agency
enterprise
```

部门和团队不作为独立 workspace type，而是 workspace 内部的管理范围。

---

### 7.2 工作区 URL

统一使用：

```text
/w/:workspaceType/:workspaceId/...
```

示例：

```text
/w/platform/platform_root/workbench
/w/agency/agency_001/workbench
/w/enterprise/enterprise_001/workbench
```

---

### 7.3 工作区上下文

每次进入工作区后，前端和后端都需要明确：

```text
current_user
current_workspace_type
current_workspace_id
current_membership_id
current_roles
current_permissions
current_action_permissions
current_menu_keys
current_data_scope
current_department_scope
current_team_scope
```

---

### 7.4 请求上下文

所有工作区内请求携带：

```text
Authorization: Bearer <token>
X-KY-Workspace-Id: <workspaceId>
X-KY-Workspace-Type: <workspaceType>
X-KY-Request-Id: <uuid>
```

后端必须根据 token 和 workspace header 重新校验用户是否拥有当前后台身份。

---

## 8. Bootstrap 架构

### 8.1 Bootstrap 职责

`GET /api/v1/auth/bootstrap` 是前端后台启动的核心接口。

返回内容包括：

- 当前用户。
- 可进入后台身份列表。
- 每个身份的 workspace 信息。
- 每个身份的成员关系。
- 每个身份的角色，结构为 `{ id, code, name }` 对象数组。
- 每个身份的 permissions。
- 每个身份的 actionPermissions。
- 每个身份的 menuKeys。
- 每个身份的 dataScopes。
- 当前推荐进入身份，可选。

---

### 8.2 Bootstrap 返回结构示意

```json
{
  "user": {
    "id": "user_001",
    "displayName": "张三",
    "avatarUrl": ""
  },
  "workspaces": [
    {
      "id": "platform_root",
      "type": "platform",
      "name": "平台后台",
      "membershipId": "mem_platform_001",
      "roles": [
        {
          "id": "role_platform_admin",
          "code": "platform_admin",
          "name": "平台管理员"
        }
      ],
      "permissions": [],
      "actionPermissions": [],
      "menuKeys": [],
      "dataScopes": [
        {
          "scopeType": "all"
        }
      ]
    },
    {
      "id": "agency_001",
      "type": "agency",
      "name": "华东机构",
      "membershipId": "mem_agency_001",
      "roles": [
        {
          "id": "role_agency_admin",
          "code": "agency_admin",
          "name": "机构管理员"
        }
      ],
      "permissions": [],
      "actionPermissions": [],
      "menuKeys": [],
      "dataScopes": [
        {
          "scopeType": "current_agency"
        }
      ]
    },
    {
      "id": "enterprise_001",
      "type": "enterprise",
      "name": "A 企业",
      "membershipId": "mem_enterprise_001",
      "roles": [
        {
          "id": "role_enterprise_admin",
          "code": "enterprise_admin",
          "name": "企业管理员"
        }
      ],
      "permissions": [],
      "actionPermissions": [],
      "menuKeys": [],
      "dataScopes": [
        {
          "scopeType": "current_enterprise"
        }
      ]
    }
  ]
}
```

---

## 9. 权限架构

### 9.1 权限层次

KyaiCRM 复用 zhipinai_v2 的权限结构：

```text
menuKeys             菜单权限
actionPermissions    操作权限
permissions          页面 / 资源权限
```

---

### 9.2 权限判断链路

```text
用户请求页面或接口
        │
        ▼
解析 token
        │
        ▼
读取 workspace header
        │
        ▼
确认用户拥有当前 workspace 身份
        │
        ▼
计算角色权限
        │
        ▼
校验菜单 / 页面 / 操作权限
        │
        ▼
套用数据范围
        │
        ▼
允许或拒绝
```

---

### 9.3 前后端职责

前端负责：

- 菜单隐藏。
- 路由守卫。
- 按钮隐藏。
- `/403` 展示。
- 工作区切换后清理缓存。

后端负责：

- Token 校验。
- Workspace 校验。
- 成员身份校验。
- 权限校验。
- 数据范围过滤。
- 审计记录。

前端权限只用于体验优化，后端权限才是安全边界。

---

## 10. 数据架构

### 10.1 数据主体

第一阶段核心数据对象：

```text
用户
平台
机构
企业
部门
团队
成员
邀请
角色
权限
数据范围
审计日志
通知
系统设置
AI 供应商
AI 模型
```

说明：`/api/v1/organizations/current` 是当前工作区主体的通用接口；平台下机构/企业列表仍使用 `/api/v1/platform/agencies*` 与 `/api/v1/platform/enterprises*`。

### 10.2 表命名

统一使用：

```text
ky_ 前缀
```

例如：

```text
ky_user
ky_agency
ky_enterprise
ky_membership
ky_role
ky_permission
ky_audit_log
ky_ai_provider
ky_ai_model
```

### 10.3 数据隔离

所有与租户相关的数据必须带主体上下文：

```text
workspace_type
workspace_id
agency_id，可选
enterprise_id，可选
```

成员和权限必须按 workspace 隔离。

用户在 A 企业的角色不能影响 B 企业；机构身份不能自动拥有企业身份；企业身份不能自动拥有平台身份。

---

## 11. 通知与审计架构

### 11.1 审计事件

关键操作必须写入审计日志。

审计日志要记录：

- 操作人。
- 操作人的后台身份。
- workspaceType。
- workspaceId。
- 操作对象。
- 操作类型。
- 操作结果。
- 请求 ID。
- 时间。

### 11.2 通知事件

通知来源包括：

- 邀请。
- 成员变更。
- 权限变更。
- 机构状态变更。
- 企业状态变更。
- 系统公告。
- 安全提醒。

### 11.3 NATS 使用策略

第一阶段可以同步写库，保留 NATS 作为事件总线能力。

推荐事件：

```text
membership.invited
membership.accepted
membership.disabled
role.updated
permission.updated
organization.status_changed
ai.provider.updated
ai.model.updated
```

---

## 12. AI 配置架构

### 12.1 AI 配置边界

AI 只做配置，不做业务执行。

保留：

- 供应商配置。
- 模型配置。
- 默认模型配置。
- 模型状态。

不做：

- AI 员工。
- AI 执行器。
- AI 工作流。
- AI 协作。
- AI 对话业务页面。

### 12.2 服务归属

AI 配置由：

```text
ky-ai-model-service
```

负责。

前端由：

```text
plugins/ky-ai-configuration
```

负责。

---

## 13. 部署架构

### 13.1 部署方式

采用：

```text
原生 VM + Nginx + systemd
```

不采用 Kubernetes-first 或 Docker-first。

### 13.2 目录建议

```text
/data/kyai_crm/
├── bin/
├── config/
│   └── external-dependencies.env
├── www/
│   └── ky-admin-host/
├── logs/
└── releases/
```

### 13.3 systemd 服务

```text
ky-auth-service.service
ky-org-service.service
ky-membership-service.service
ky-ai-model-service.service
```

### 13.4 Nginx

Nginx 负责：

- 托管 `ky-admin-host` 静态文件。
- `/api/v1/*` 反代。
- SPA fallback。
- `/healthz`。
- 静态资源缓存。

---

## 14. 复用与裁剪

### 14.1 从 zhipinai_v2 复用

必须复用：

- Host + Plugin 架构。
- workspace 模型。
- platform / agency / enterprise。
- bootstrap。
- permission context。
- menuKeys / permissions / actionPermissions。
- plugin registry。
- query namespace。
- request client。
- Nginx + systemd 部署模式。
- Go 服务结构。
- PostgreSQL + pgx/v5。

### 14.2 从 zhipinai_v2 裁剪

不引入：

- 移动端。
- IM。
- AI 员工。
- AI 执行器。
- AI 协作。
- 人才市场。
- 招聘业务。
- CRM 业务。

---

## 15. 架构验收标准

第一阶段架构验收应满足：

1. 用户可登录并获取 bootstrap。
2. 一个用户可拥有平台、机构、企业多个后台身份。
3. 用户可在不同后台身份之间切换。
4. 切换身份后菜单、权限、通知、数据范围随之变化。
5. 平台后台、机构后台、企业后台入口可独立访问。
6. 部门和团队可作为管理范围存在。
7. 前端插件通过 Host + Core 注册菜单和路由。
8. 后端服务按 auth、org、membership、ai-model 拆分。
9. 所有工作区内请求携带 `X-KY-Workspace-*`。
10. 后端必须校验 token、workspace、membership、permission、data scope。
11. Nginx 可反代到各服务。
12. systemd 可管理所有 Go 服务。

---

## 16. 后续文档关系

本文档是总体架构文档，后续细化文档包括：

- `docs/kyai_crm_data_model.md`
- `docs/kyai_crm_permission_matrix.md`
- `docs/kyai_crm_admin_pages.md`
- `docs/kyai_crm_api_contracts.md`
- `docs/kyai_crm_workspace_layout.md`
- `docs/kyai_crm_phase1_implementation_plan.md`
- `docs/kyai_crm_deployment.md`
