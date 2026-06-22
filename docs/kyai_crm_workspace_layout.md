# KyaiCRM 工作区布局与命名规范

> 文档状态：已锁定 / Phase 1 基线  
> 项目名称：KyaiCRM  
> 当前阶段：第一阶段 / 多租户用户中心与多后台身份底座  
> 编写日期：2026-06-15  
> 参照项目：`/data/Kysion/zhipinai_v2/docs/V2_WORKSPACE_LAYOUT.md`  
> 关联文档：
> - `docs/kyai_crm_multi_tenant_identity_requirements.md`
> - `docs/kyai_crm_technical_selection.md`
> - `docs/kyai_crm_architecture.md`
> - `docs/kyai_crm_phase1_implementation_plan.md`

---

## 1. 文档目的

本文档定义 KyaiCRM 第一阶段项目工作区布局、目录职责、命名规范、包边界、插件边界、服务边界、环境变量规范和请求上下文规范。

KyaiCRM 应严格复用 `/data/Kysion/zhipinai_v2` 的 monorepo 组织方式：

```text
apps/*
packages/*
plugins/*
services/*
ops/*
scripts/*
docs/*
```

并将 `zp` / `ZP` / `zp_` 命名体系统一替换为 KyaiCRM 的 `ky` / `KY` / `ky_` 命名体系。

---

## 2. 根目录布局

推荐项目根目录：

```text
KyaiCRM/
├── apps/
│   └── ky-admin-host/
├── packages/
│   └── ky-admin-core/
├── plugins/
│   ├── ky-identity-management/
│   ├── ky-organization-management/
│   ├── ky-access-management/
│   ├── ky-audit-management/
│   ├── ky-notification/
│   ├── ky-system-settings/
│   └── ky-ai-configuration/
├── services/
│   ├── ky-auth-service/
│   ├── ky-org-service/
│   ├── ky-membership-service/
│   └── ky-ai-model-service/
├── ops/
│   ├── db/
│   ├── native/
│   └── seed/
├── scripts/
├── docs/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── go.work
└── README.md
```

---

## 3. 顶层目录职责

| 目录 | 职责 |
|---|---|
| `apps/` | 前端应用宿主。第一阶段只放后台管理宿主 `ky-admin-host`。 |
| `packages/` | 跨前端包共享能力。第一阶段只放后台核心协议包 `ky-admin-core`。 |
| `plugins/` | 后台业务插件。页面、菜单、路由、工作台卡片均由插件贡献。 |
| `services/` | Go 后端服务，按领域事实拆分。 |
| `ops/db/` | 数据库 schema、migration、seed SQL。 |
| `ops/native/` | Nginx、systemd、env example、NATS 等原生部署配置。 |
| `ops/seed/` | 初始种子数据或生成后的 seed 文件。 |
| `scripts/` | 构建、部署、验收、初始化、数据脚本。 |
| `docs/` | 需求、架构、技术选型、API、部署、实施计划等文档。 |

---

## 4. 前端工作区布局

### 4.1 pnpm workspace

`pnpm-workspace.yaml`：

```yaml
packages:
  - apps/*
  - packages/*
  - plugins/*
```

### 4.2 Turborepo

`turbo.json`：

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "lint": {
      "dependsOn": ["^lint"]
    },
    "typecheck": {
      "dependsOn": ["^typecheck"]
    }
  }
}
```

### 4.3 根 package.json

根 package 建议：

```json
{
  "name": "kyai-crm",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@10.8.1",
  "scripts": {
    "dev": "pnpm --filter @ky/admin-host dev",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck"
  }
}
```

---

## 5. apps 目录

### 5.1 apps/ky-admin-host

后台宿主应用。

职责：

- 登录。
- 注册。
- 邀请接受。
- 后台身份选择。
- 工作区选择与切换。
- 主布局。
- 顶部栏。
- 侧边栏。
- 菜单汇总。
- 插件注册。
- 路由挂载。
- 权限守卫。
- request client。
- session store。
- QueryClient 管理。

推荐结构：

```text
apps/ky-admin-host/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
└── src/
    ├── app.tsx
    ├── app-store.ts
    ├── remote-api.ts
    ├── plugin-request-client.ts
    ├── local-plugin-manifest.ts
    ├── main.tsx
    ├── layouts/
    ├── pages/
    │   ├── login.tsx
    │   ├── register.tsx
    │   ├── invite.tsx
    │   ├── workspace-select.tsx
    │   ├── no-workspace.tsx
    │   └── forbidden.tsx
    ├── routes/
    └── styles/
```

Host 规则：

- Host 不写具体业务管理页面。
- Host 不硬编码插件业务菜单。
- Host 只负责通用 shell 能力。
- Host 负责 token 和 workspace request context。
- Host 提供 controlled request client 给插件使用。

---

## 6. packages 目录

### 6.1 packages/ky-admin-core

后台插件协议和共享运行契约包。

推荐结构：

```text
packages/ky-admin-core/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── types.ts
    ├── plugin-registry.ts
    ├── permissions.tsx
    ├── workspace.ts
    ├── menu.ts
    ├── route.ts
    ├── request.ts
    └── workbench.ts
```

职责：

- `AdminPlugin` 类型。
- `PluginRoute` 类型。
- `PluginMenuItem` 类型。
- `PluginMenuGroup` 类型。
- `WorkspaceType` 类型。
- `WorkspacePermissionState` 类型。
- `PermissionBoundary`。
- `RouteGuard`。
- plugin registry。
- request client interface。
- workbench contribution interface。
- header action interface。
- breadcrumb contribution interface。
- query namespace interface。

包名：

```text
@ky/admin-core
```

---

## 7. plugins 目录

插件命名规则：

```text
目录名：plugins/ky-<domain-name>
包名：@ky/plugin-<domain-name>
插件短名：ky-<domain-name>
```

强约束：目录名、包名、插件短名可以同时存在，但语义不能混用。例如 `plugins/ky-notification` 的 package name 必须是 `@ky/plugin-notification`，文档表格中可用短名 `ky-notification` 表示插件归属。

插件统一结构：

```text
plugins/ky-example-plugin/
├── package.json
├── tsconfig.json
└── src/
    ├── index.tsx
    ├── api.ts
    ├── permissions.ts
    ├── routes.tsx
    ├── pages/
    ├── components/
    └── hooks/
```

插件规则：

- 插件必须导出 `AdminPlugin`。
- 插件必须通过 `@ky/admin-core` 声明菜单、路由和权限。
- 插件不得直接读取 token。
- 插件不得自行维护 session。
- 插件不得替换 Host 根路由。
- 插件不得破坏 `/w/:workspaceType/:workspaceId` URL 契约。
- 插件 API 调用必须经过 Host 提供的 request client。

---

## 8. 第一阶段插件职责

### 8.1 ky-identity-management

包名：

```text
@ky/plugin-identity-management
```

职责：

- 全局用户列表。
- 用户详情。
- 用户状态管理。
- 个人资料，可选。
- 登录日志入口，可与 audit 插件联动。

---

### 8.2 ky-organization-management

包名：

```text
@ky/plugin-organization-management
```

职责：

- 平台机构管理。
- 平台企业管理。
- 机构信息。
- 企业信息。
- 部门管理。
- 团队管理。
- 成员基础页面，可与 membership/access 插件联动。

---

### 8.3 ky-access-management

包名：

```text
@ky/plugin-access-management
```

职责：

- 角色列表。
- 权限列表。
- 角色权限分配。
- 成员授权。
- 数据范围配置。

---

### 8.4 ky-audit-management

包名：

```text
@ky/plugin-audit-management
```

职责：

- 操作日志。
- 登录日志。
- 权限变更日志。
- 成员变更日志。

---

### 8.5 ky-notification

包名：

```text
@ky/plugin-notification
```

职责：

- 我的通知。
- 未读数。
- Header 通知入口。
- 系统公告。
- 工作台通知卡片。

---

### 8.6 ky-system-settings

包名：

```text
@ky/plugin-system-settings
```

职责：

- 平台设置。
- 机构设置。
- 企业设置。
- 安全策略。
- 字典配置。

---

### 8.7 ky-ai-configuration

包名：

```text
@ky/plugin-ai-configuration
```

职责仅限：

- AI 供应商管理。
- AI 模型管理。
- 默认模型配置。

不得包含：

- AI 员工。
- AI 执行器。
- AI 工作流。
- AI 协作。
- AI 对话业务。

---

## 9. services 目录

Go 服务命名规则：

```text
services/ky-<domain>-service
```

Go module 命名建议：

```text
github.com/Kysion/KyaiCRM/services/ky-auth-service
```

如实际仓库路径不同，以真实仓库路径为准。

统一结构：

```text
services/ky-*-service/
├── go.mod
├── cmd/
│   └── server/
│       └── main.go
└── internal/
    ├── config/
    │   └── config.go
    ├── server/
    │   └── server.go
    ├── store/
    └── domain/
```

服务规则：

- 每个服务独立启动。
- 每个服务独立 readyz。
- 配置统一支持 `KY_RUNTIME_ENV_FILE`。
- HTTP 地址支持服务专属环境变量覆盖。
- 数据访问使用 PostgreSQL + pgx/v5。
- 服务不跨域直接读取其他服务私有表，除非当前阶段为了复用和快速落地有明确说明。

---

## 10. 第一阶段服务职责

### 10.1 ky-auth-service

职责：

- 注册。
- 登录。
- 登出。
- Token。
- 当前用户。
- Bootstrap。
- 后台身份列表聚合。
- 全局用户管理。
- 登录日志。

---

### 10.2 ky-org-service

职责：

- 机构。
- 企业。
- 机构与企业关系。
- 当前组织信息。
- 部门。
- 团队。
- 系统设置。
- 字典。

---

### 10.3 ky-membership-service

职责：

- 成员。
- 邀请。
- 角色。
- 权限。
- 成员授权。
- 数据范围。
- 审计。
- 通知，第一阶段可暂归口在此。

---

### 10.4 ky-ai-model-service

职责：

- AI 供应商。
- AI 模型。
- 默认模型配置。
- AI 配置审计事件。

不包含 AI 业务执行能力。

---

## 11. ops 目录

推荐结构：

```text
ops/
├── db/
│   ├── 001_identity_schema.sql
│   ├── 002_organization_schema.sql
│   ├── 003_membership_schema.sql
│   ├── 004_access_schema.sql
│   ├── 005_audit_notification_schema.sql
│   ├── 006_system_setting_schema.sql
│   ├── 007_ai_model_schema.sql
│   └── 008_seed.sql
├── native/
│   ├── external-dependencies.env.example
│   ├── ky-admin-host.nginx.conf
│   ├── ky-auth-service.service
│   ├── ky-org-service.service
│   ├── ky-membership-service.service
│   └── ky-ai-model-service.service
└── seed/
```

---

## 12. scripts 目录

推荐脚本：

```text
scripts/deploy_database.sh
scripts/deploy_services.sh
scripts/deploy_frontend.sh
scripts/verify_deployment.sh
scripts/seed_dev_data.sh
scripts/build_services.sh
scripts/build_frontend.sh
```

脚本规则：

- 脚本必须使用 `KY_` 环境变量。
- 部署脚本不得写入敏感凭据到仓库。
- 验证脚本必须输出关键接口状态。
- 脚本命名使用 snake_case。

---

## 13. docs 目录

当前文档集：

```text
kyai_crm_multi_tenant_identity_requirements.md
kyai_crm_technical_selection.md
kyai_crm_architecture.md
kyai_crm_data_model.md
kyai_crm_permission_matrix.md
kyai_crm_phase1_implementation_plan.md
kyai_crm_admin_pages.md
kyai_crm_api_contracts.md
kyai_crm_workspace_layout.md
kyai_crm_deployment.md
```

---

## 14. 命名规范

### 14.1 文件与目录

使用 kebab-case：

```text
ky-admin-host
ky-admin-core
ky-organization-management
ky-auth-service
```

### 14.2 NPM 包

使用：

```text
@ky/admin-host
@ky/admin-core
@ky/plugin-organization-management
```

### 14.3 Go 服务

使用：

```text
ky-auth-service
ky-org-service
ky-membership-service
ky-ai-model-service
```

### 14.4 数据库表

使用 snake_case 和 `ky_` 前缀。第一阶段权威表名以 `kyai_crm_data_model.md` 为准，核心表包括：

```text
ky_user
ky_agency
ky_enterprise
ky_agency_enterprise_relation
ky_department
ky_team
ky_membership
ky_membership_department
ky_membership_team
ky_role
ky_permission
ky_role_permission
ky_membership_role
ky_role_data_scope
ky_audit_log
ky_notification
ky_notification_read
ky_system_announcement
ky_system_setting
ky_dictionary
ky_dictionary_item
ky_ai_provider
ky_ai_model
ky_ai_model_setting
```

第一阶段不建立 `ky_platform`、`ky_organization`、`ky_organization_setting`、`ky_team_member` 表。

### 14.5 环境变量

使用 `KY_` 前缀：

```text
KY_RUNTIME_ENV_FILE
KY_TENANT_DATABASE_URL
KY_AUTH_TOKEN_SECRET
KY_REDIS_URL
KY_NATS_URL
```

### 14.6 请求头

使用：

```text
X-KY-Workspace-Id
X-KY-Workspace-Type
X-KY-Request-Id
```

### 14.7 前端 session key

使用：

```text
ky.admin.session.v1
```

---

## 15. 与 zhipinai_v2 命名映射

| zhipinai_v2 | KyaiCRM |
|---|---|
| `zp-admin-host` | `ky-admin-host` |
| `zp-admin-core` | `ky-admin-core` |
| `@zp/admin-host` | `@ky/admin-host` |
| `@zp/admin-core` | `@ky/admin-core` |
| `plugins/zp-org-management` | `plugins/ky-organization-management` |
| `plugins/zp-notification` | `plugins/ky-notification` |
| `plugins/zp-ai-operations` | `plugins/ky-ai-configuration` |
| `zp-auth-service` | `ky-auth-service` |
| `zp-org-service` | `ky-org-service` |
| `zp-membership-service` | `ky-membership-service` |
| `zp-ai-model-service` | `ky-ai-model-service` |
| `ZP_*` | `KY_*` |
| `X-ZP-Workspace-Id` | `X-KY-Workspace-Id` |
| `X-ZP-Workspace-Type` | `X-KY-Workspace-Type` |
| `zp.admin.session.v1` | `ky.admin.session.v1` |

说明：前端浏览器 session key 固定为 `ky.admin.session.v1`；`ky_user_session` 只表示数据库会话表，不得作为浏览器存储 key。

---

## 16. 禁止事项

第一阶段禁止：

- 将业务页面写入 `ky-admin-host`。
- 插件直接读取 token。
- 插件绕过 Host request client。
- 新增不受控远程插件加载。
- 引入 AI 员工、执行器、IM、CRM 业务目录。
- 使用 `zp_`、`ZP_`、`@zp` 命名。
- 无 workspace header 调用工作区接口。
- 把平台权限带入机构或企业工作区。
- 把机构权限带入企业工作区。

---

## 17. 验收标准

工作区布局验收标准：

1. 根目录包含 apps、packages、plugins、services、ops、scripts、docs。
2. pnpm workspace 覆盖 apps/packages/plugins。
3. turbo 能统一运行 build/lint/typecheck。
4. Go work 能聚合第一阶段服务。
5. 所有前端包使用 `@ky/*`。
6. 所有服务使用 `ky-*-service`。
7. 所有表使用 `ky_` 前缀。
8. 所有环境变量使用 `KY_` 前缀。
9. 所有工作区请求头使用 `X-KY-*`。
10. Host + Plugin 边界清晰，业务页面不进入 Host。
