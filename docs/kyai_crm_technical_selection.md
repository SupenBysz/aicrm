# KyaiCRM 技术选型方案

> 文档状态：已锁定 / Phase 1 基线  
> 项目名称：KyaiCRM  
> 当前阶段：第一阶段 / 多租户用户中心与多后台身份底座  
> 编写日期：2026-06-15  
> 参照项目：`/data/Kysion/zhipinai_v2`  
> 关键词：React、TypeScript、Vite、Ant Design、Go、PostgreSQL、Redis、NATS、S3/MinIO、Nginx、systemd、pnpm、Turborepo、Host + Plugin

---

## 1. 文档目的

本文档用于明确 KyaiCRM 第一阶段的技术选型方案。

KyaiCRM 第一阶段定位为“以用户为中心的多租户、多组织、多后台身份管理底座”，其技术方案应严格参考并复用 `/data/Kysion/zhipinai_v2` 已验证的工程架构、技术栈、服务拆分方式、后台插件化模式、权限上下文模式、部署方式和基础设施选型。

本文档重点回答：

- 前端采用什么技术栈。
- 后端采用什么技术栈。
- 工程如何组织。
- 服务如何拆分。
- 数据与基础设施如何选型。
- 部署方式如何选型。
- 哪些内容严格复用参照项目。
- 哪些内容当前阶段明确不引入。

---

## 2. 总体技术策略

KyaiCRM 不重新发明一套技术体系，而是在 zhipinai_v2 的基础上做收敛和复用。

总体策略：

```text
前端：React + TypeScript + Vite + Ant Design + Host/Plugin
后端：Go 多服务 + HTTP JSON API
数据：PostgreSQL 为主，Redis 辅助
异步：NATS
文件：S3/MinIO 兼容对象存储
工程：pnpm workspace + Turborepo + Go workspace
部署：Nginx + systemd + 原生 VM
```

选型原则：

1. **严格复用参照项目成熟架构**  
   参照项目已经形成后台 Host + Plugin、workspace、permissions、menuKeys、actionPermissions、bootstrap、多服务、Nginx 反代、systemd 部署等基础模式，KyaiCRM 应直接沿用。

2. **第一阶段不引入复杂新技术**  
   不引入 Kubernetes、复杂微前端框架、GraphQL、重型网关、服务网格等。

3. **后台优先，业务延后**  
   当前只建设多租户用户中心和后台底座，不建设 CRM 业务。

4. **AI 能力只保留配置层**  
   只保留 AI 供应商、模型、默认模型等配置能力，不引入 AI 员工、执行器、AI 协作等业务链路。

5. **工程结构可直接映射 zhipinai_v2**  
   `zp_` 前缀统一替换为 `ky_`，服务、插件、包和环境变量使用 KyaiCRM 命名规范。

---

## 3. 参照项目技术基线

从 `/data/Kysion/zhipinai_v2` 可确认参照项目的核心技术基线如下。

### 3.1 前端技术基线

参照项目后台前端使用：

```text
React 19
TypeScript 5
Vite 7
Ant Design 6
React Router 7
TanStack Query 5
Zustand
Day.js
Node.js 22 LTS，最低 Node.js 20.19.0
pnpm workspace
Turborepo
```

对应依据包括：

- 根 `package.json` 使用 `pnpm@10.8.1`、`turbo`、`typescript`、`vite`。
- `apps/zp-admin-host/package.json` 使用 React、Ant Design、React Router、TanStack Query、Zustand。
- `packages/zp-admin-core` 作为后台核心协议包。
- `plugins/zp-*` 作为后台插件包。

### 3.2 后端技术基线

参照项目后端使用：

```text
Go 多模块工作区
HTTP JSON 服务
按领域拆分服务
PostgreSQL 访问使用 pgx/v5
```

服务目录采用：

```text
services/zp-*-service
```

每个 Go 服务基本结构：

```text
cmd/server/main.go
internal/config/config.go
internal/server/server.go
```

### 3.3 基础设施技术基线

参照项目基础设施使用：

```text
PostgreSQL
Redis
NATS
S3 / MinIO 兼容对象存储
Nginx
systemd
Cloudflare Tunnel，可选
```

部署方式明确为：

```text
原生 VM 部署，不以 Docker 作为前提
```

### 3.4 工程组织基线

参照项目采用：

```text
apps/*
packages/*
plugins/*
services/*
ops/*
scripts/*
docs/*
```

JS/TS 侧由 `pnpm-workspace.yaml` 管理：

```text
apps/*
packages/*
plugins/*
```

Go 侧由 `go.work` 聚合多个服务。

---

## 4. KyaiCRM 推荐技术栈总览

| 方向 | KyaiCRM 选型 | 复用来源 |
|---|---|---|
| 后台前端框架 | React 19 | 复用 zhipinai_v2 |
| 前端语言 | TypeScript 5 | 复用 zhipinai_v2 |
| 构建工具 | Vite 7 | 复用 zhipinai_v2 |
| UI 组件 | Ant Design 6 | 复用 zhipinai_v2 |
| 路由 | React Router 7 | 复用 zhipinai_v2 |
| 服务端状态 | TanStack Query 5 | 复用 zhipinai_v2 |
| 客户端状态 | Zustand | 复用 zhipinai_v2 |
| 时间处理 | Day.js | 复用 zhipinai_v2 |
| 前端工作区 | pnpm workspace | 复用 zhipinai_v2 |
| 构建编排 | Turborepo | 复用 zhipinai_v2 |
| 后端语言 | Go | 复用 zhipinai_v2 |
| API 风格 | HTTP JSON / REST-like | 复用 zhipinai_v2 |
| 数据库 | PostgreSQL | 复用 zhipinai_v2 |
| 数据库驱动 | pgx/v5 | 复用 zhipinai_v2 |
| 缓存 / 短状态 | Redis | 复用 zhipinai_v2 |
| 事件 / 异步 | NATS | 复用 zhipinai_v2 |
| 对象存储 | S3 / MinIO compatible | 复用 zhipinai_v2 |
| Web 入口 | Nginx | 复用 zhipinai_v2 |
| 进程管理 | systemd | 复用 zhipinai_v2 |
| 部署形态 | 原生 VM | 复用 zhipinai_v2 |

---

## 5. 前端技术选型

### 5.1 后台应用框架

选择：

```text
React 19 + TypeScript 5 + Vite 7
```

原因：

- 与参照项目完全一致，便于复用后台 Host、插件、权限、菜单、请求上下文等代码模式。
- React 适合复杂后台页面与插件化页面组合。
- TypeScript 可保证插件协议、权限声明、菜单定义、路由定义的类型稳定。
- Vite 适合多包工作区下快速开发和构建。

### 5.2 UI 组件库

选择：

```text
Ant Design 6
```

原因：

- 参照项目已使用 Ant Design 6。
- 后台系统所需的表格、表单、弹窗、抽屉、菜单、布局、权限配置页面等均可直接覆盖。
- 第一阶段不建设自研设计系统，避免分散精力。

### 5.3 路由

选择：

```text
React Router 7
```

路由约定复用：

```text
/w/:workspaceType/:workspaceId/...
```

KyaiCRM 第一阶段 workspaceType：

```text
platform
agency
enterprise
```

原因：

- 与参照项目工作区路由模型一致。
- 支持平台、机构、企业独立后台上下文。
- 插件路由可统一注册到当前工作区前缀下。

### 5.4 服务端状态管理

选择：

```text
@tanstack/react-query 5
```

用途：

- 用户列表。
- 机构列表。
- 企业列表。
- 成员列表。
- 角色权限。
- 通知未读数。
- AI 供应商和模型配置。
- 审计日志查询。

原因：

- 与参照项目一致。
- 适合 HTTP JSON API 的查询、缓存、失效、刷新、mutation 管理。
- 支持按 workspace 切换清理或隔离缓存。

### 5.5 客户端状态管理

选择：

```text
Zustand
```

用途：

- 当前登录会话。
- 当前用户。
- 当前后台身份。
- 当前 workspace。
- 当前权限状态。
- 当前菜单状态。
- 工作区切换状态。

原因：

- 与参照项目一致。
- 足够承载后台 shell 运行时状态。
- 不引入 Redux 等更重方案。

### 5.6 时间处理

选择：

```text
Day.js
```

用途：

- 登录日志时间。
- 邀请过期时间。
- 审计日志时间。
- 通知时间。
- AI 模型更新时间。

原因：

- 与参照项目一致。
- 轻量、生态成熟。

---

## 6. 前端架构选型

### 6.1 后台 Host + Plugin

选择：

```text
Admin Host + Admin Core + Plugins
```

这是 KyaiCRM 必须严格复用的核心架构。

#### Admin Host 职责

```text
apps/ky-admin-host
```

负责：

- 登录。
- 注册。
- 邀请入职。
- 后台身份选择。
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

#### Admin Core 职责

```text
packages/ky-admin-core
```

负责：

- 插件协议。
- 路由声明类型。
- 菜单声明类型。
- 权限上下文。
- 工作区上下文。
- 请求客户端类型。
- Header action 协议。
- Workbench contribution 协议。
- Breadcrumb 协议。
- Query namespace 协议。

#### Plugins 职责

```text
plugins/ky-*
```

负责具体后台模块页面：

- 身份中心。
- 机构 / 企业 / 部门 / 团队管理。
- 权限中心。
- 审计中心。
- 通知中心。
- 系统设置。
- AI 配置。

### 6.2 插件加载方式

第一阶段选择：

```text
本地 workspace 插件 + manifest 启停
```

暂不选择：

```text
远程运行时插件加载
第三方任意插件执行
复杂微前端框架
```

原因：

- 参照项目当前也是先通过本地插件和 manifest 管理插件状态。
- 第一阶段重点是权限、工作区、后台身份和基础管理闭环。
- 远程插件热插拔涉及版本、完整性、CSP、依赖共享、隔离、回滚等复杂问题，应后置。

---

## 7. 前端工程组织

### 7.1 推荐目录

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
```

### 7.2 包管理

选择：

```text
pnpm workspace
```

工作区范围：

```yaml
packages:
  - apps/*
  - packages/*
  - plugins/*
```

### 7.3 构建编排

选择：

```text
Turborepo
```

任务：

```text
build
lint
typecheck
```

原因：

- 与参照项目一致。
- 多插件、多包下可统一构建与验证。
- 支持依赖包先构建。

### 7.4 前端命名

KyaiCRM 使用 `ky` 命名：

```text
@ky/admin-host
@ky/admin-core
@ky/plugin-identity-management
@ky/plugin-organization-management
@ky/plugin-access-management
@ky/plugin-notification
@ky/plugin-ai-configuration
```

文件目录使用 kebab-case：

```text
ky-admin-host
ky-admin-core
ky-identity-management
```

---

## 8. 后端技术选型

### 8.1 后端语言

选择：

```text
Go
```

建议版本：

```text
Go 1.25.x
```

说明：

- 第一阶段锁定 Go 1.25.x，与参照项目 `go.work` 的 Go 1.25.0 基线对齐。
- 各服务 `go.mod` 初始化时统一使用 Go 1.25。
- Go 1.26 可作为后续升级目标，不作为第一阶段实施前提。

### 8.2 服务风格

选择：

```text
service-per-domain
HTTP JSON API
REST-like 路由
```

原因：

- 与参照项目一致。
- 第一阶段服务边界清晰。
- 前端后台和插件可以快速稳定调用。
- 不引入 gRPC、GraphQL、复杂 API 网关。

### 8.3 HTTP 框架

选择：

```text
Go 标准 net/http + http.ServeMux
```

原因：

- 参照项目服务端以轻量 HTTP JSON 服务为主。
- 第一阶段接口复杂度可控。
- 避免过早引入大型 Web 框架。

如后续路由复杂度明显增加，可评估轻量 router，但第一阶段不建议改变参照项目风格。

### 8.4 数据库访问

选择：

```text
pgx/v5
```

原因：

- 参照项目 Go 服务已使用 `github.com/jackc/pgx/v5`。
- PostgreSQL 原生能力支持好。
- 不强制引入 ORM，便于精确控制多租户权限和数据范围查询。

### 8.5 后端服务基础结构

每个服务沿用：

```text
services/ky-*-service/
├── cmd/server/main.go
├── internal/config/config.go
└── internal/server/server.go
```

服务启动逻辑沿用参照项目：

- 读取配置。
- 初始化服务。
- 监听 HTTP 地址。
- 支持 SIGINT / SIGTERM 优雅退出。

---

## 9. 后端服务拆分方案

### 9.1 第一阶段推荐服务

KyaiCRM 第一阶段建议拆分为：

```text
ky-auth-service
ky-org-service
ky-membership-service
ky-ai-model-service
```

可选，后续阶段再启用：

```text
ky-notification-service
```

第一阶段不部署独立 `ky-notification-service`；通知、公告与未读数先归口 `ky-membership-service`，待通知复杂度提升后再拆。

### 9.2 服务职责

#### ky-auth-service

对应参照项目：

```text
zp-auth-service
```

职责：

- 登录。
- 注册。
- 登出。
- Token 签发与校验。
- Bootstrap。
- 当前用户信息。
- 全局用户管理。
- 平台后台入口校验。
- 后台身份列表返回。

#### ky-org-service

对应参照项目：

```text
zp-org-service
```

职责：

- 平台、机构、企业基础信息。
- 机构列表。
- 企业列表。
- 企业归属机构关系。
- 部门管理。
- 团队管理。
- 系统设置。
- 资产 / 文件设置，可选。

#### ky-membership-service

对应参照项目：

```text
zp-membership-service
```

职责：

- 成员关系。
- 邀请入职。
- 角色。
- 权限。
- 成员授权。
- 数据范围。
- 审计日志。
- 通知中心，第一阶段可先放入此服务。

#### ky-ai-model-service

对应参照项目：

```text
zp-ai-model-service
```

职责仅保留：

- AI 供应商配置。
- AI 模型配置。
- 默认模型配置。
- 模型启停。
- AI 配置审计事件输出。

明确不包含：

- AI 员工。
- AI 技能。
- AI 工作流。
- AI 执行器。
- AI 协作。
- 人才市场。

#### ky-notification-service，可选

如第一阶段希望通知独立，可拆为：

- 站内信。
- 未读数。
- 系统公告。
- 通知模板。

若追求严格复用和快速落地，第一阶段可以先放入 `ky-membership-service`，待通知复杂度提升后再拆。

### 9.3 不建议第一阶段拆分的服务

第一阶段不建议引入：

```text
ky-im-service
ky-ai-agent-service
ky-ai-collab-service
ky-agent-executor-service
ky-crm-service
ky-billing-service
ky-catalog-service
ky-fulfillment-service
```

原因：

- 当前需求不涉及 IM、移动端、AI 员工、AI 协作、执行器、CRM、账务、商品或履约。
- 过早拆分会增加部署和联调成本。

---

## 10. 数据库与存储选型

### 10.1 主数据库

选择：

```text
PostgreSQL
```

原因：

- 与参照项目一致。
- 适合关系清晰的用户、组织、成员、角色、权限、多租户数据模型。
- 支持事务、索引、JSONB、复杂查询。

### 10.2 数据库版本

推荐：

```text
PostgreSQL 16+；如基础环境允许，可对齐参照技术文档目标版本 PostgreSQL 18。
```

说明：

- 参照项目技术文档提到 PostgreSQL 18。
- 实际落地应以目标服务器可稳定安装和维护的版本为准。
- 第一阶段不依赖过高版本特性时，可选择更稳妥的 PostgreSQL 16/17。

### 10.3 数据库连接

选择：

```text
PostgreSQL URL + pgx/v5
```

环境变量命名使用 `KY_` 前缀：

```text
KY_TENANT_DATABASE_URL
KY_POSTGRES_HOST
KY_POSTGRES_PORT
KY_POSTGRES_DB
KY_POSTGRES_USER
KY_POSTGRES_PASSWORD
KY_POSTGRES_SSLMODE
```

### 10.4 缓存和短状态

选择：

```text
Redis
```

用途：

- 登录短状态。
- 会话辅助。
- 邀请 token 短期缓存，可选。
- 验证码，可选。
- 分布式锁，可选。
- 限流计数，可选。

### 10.5 对象存储

选择：

```text
S3-compatible object storage
MinIO 作为兼容实现
```

用途：

- 用户头像。
- 机构 Logo。
- 企业 Logo。
- 附件。
- 导入导出文件。

说明：

第一阶段可只保留配置能力和基础上传能力，不做复杂文件业务。

### 10.6 异步消息

选择：

```text
NATS
```

用途：

- 审计事件。
- 通知事件。
- 邀请事件。
- 成员变更事件。
- 权限变更事件。
- AI 配置变更事件。

第一阶段也可以先同步写库，但技术选型上保留 NATS 作为参照项目一致的事件基础设施。

---

## 11. API 与请求上下文选型

### 11.1 API 风格

选择：

```text
REST-like HTTP JSON
```

统一前缀：

```text
/api/v1
```

示例：

```text
/api/v1/auth/login
/api/v1/auth/bootstrap
/api/v1/platform/users
/api/v1/organizations
/api/v1/roles
/api/v1/permissions
/api/v1/audit-logs
/api/v1/notifications
/api/v1/ai-models
```

### 11.2 请求上下文 Header

复用参照项目模式，`ZP` 替换为 `KY`：

```text
Authorization: Bearer <token>
X-KY-Workspace-Id: <workspaceId>
X-KY-Workspace-Type: <workspaceType>
X-KY-Request-Id: <uuid>
```

### 11.3 Workspace URL Contract

前端路由继续使用：

```text
/w/:workspaceType/:workspaceId
```

第一阶段：

```text
/w/platform/platform_root
/w/agency/:agencyId
/w/enterprise/:enterpriseId
```

### 11.4 插件请求规则

插件必须通过 host 提供的受控 request client 调用接口。

插件不得：

- 直接读取 token。
- 自行存储 token。
- 自行拼接认证头。
- 绕过 host 注入的 workspace context。

---

## 12. 权限与安全选型

### 12.1 权限模型

复用参照项目三层权限：

```text
permissions          页面 / 资源权限
actionPermissions    操作权限
menuKeys             菜单权限
```

### 12.2 权限执行位置

必须前后端双层执行：

```text
前端：菜单隐藏、路由守卫、按钮隐藏
后端：token 校验、workspace 校验、permission 校验、data scope 校验
```

### 12.3 Session 存储

前端 session key 使用：

```text
ky.admin.session.v1
```

替代参照项目：

```text
zp.admin.session.v1
```

### 12.4 Token Secret

环境变量：

```text
KY_AUTH_TOKEN_SECRET
```

必须通过运行时配置提供，不能写入代码仓库。

---

## 13. 环境变量与配置选型

### 13.1 环境变量前缀

统一使用：

```text
KY_
```

替代参照项目的：

```text
ZP_
```

### 13.2 运行时配置文件

参照项目默认运行时 env file：

```text
/data/zhipinai_v2/config/external-dependencies.env
```

KyaiCRM 建议：

```text
/data/kyai_crm/config/external-dependencies.env
```

可通过环境变量覆盖：

```text
KY_RUNTIME_ENV_FILE
```

### 13.3 基础环境变量

建议第一阶段配置：

```text
KY_PUBLIC_SITE_URL=https://www.kyai-crm.example
KY_CONSOLE_URL=https://console.kyai-crm.example
KY_API_PUBLIC_URL=https://console.kyai-crm.example
KY_ASSET_PUBLIC_URL=https://asset.kyai-crm.example
KY_COOKIE_DOMAIN=.kyai-crm.example

KY_TENANT_DATABASE_URL=postgresql://...
KY_POSTGRES_HOST=...
KY_POSTGRES_PORT=5432
KY_POSTGRES_DB=kyai_crm_tenant
KY_POSTGRES_USER=...
KY_POSTGRES_PASSWORD=...
KY_POSTGRES_SSLMODE=disable

KY_AUTH_TOKEN_SECRET=...
KY_REDIS_URL=redis://127.0.0.1:6379/0
KY_NATS_URL=nats://127.0.0.1:4222
```

---

## 14. 部署技术选型

### 14.1 部署形态

选择：

```text
原生 VM + systemd + Nginx
```

不选择：

```text
Docker-first
Kubernetes-first
Serverless-first
```

原因：

- 与参照项目一致。
- 第一阶段服务数量可控。
- 部署、排查、日志、重启链路简单。
- 适合快速上线测试环境。

### 14.2 Nginx 职责

Nginx 负责：

- 托管后台前端静态文件。
- 提供 `/healthz`。
- SPA fallback 到 `index.html`。
- `/api/v1/*` 路由反代到不同 Go 服务。
- `/assets/*` 静态资源缓存策略。

### 14.3 systemd 职责

systemd 负责管理 Go 服务：

```text
ky-auth-service.service
ky-org-service.service
ky-membership-service.service
ky-ai-model-service.service
```

可选：

```text
ky-notification-service.service
```

### 14.4 端口建议

参照项目端口为 `8081` 起。KyaiCRM 可使用独立端口段，避免与参照项目冲突：

```text
ky-auth-service          18081
ky-org-service           18082
ky-membership-service    18083
ky-ai-model-service      18086
ky-notification-service  18087，后续可选；Phase 1 不部署
```

### 14.5 Nginx API 反代建议

```text
/api/v1/auth/             -> 127.0.0.1:18081
/api/v1/platform/users    -> 127.0.0.1:18081

/api/v1/organizations     -> 127.0.0.1:18082
/api/v1/platform/agencies -> 127.0.0.1:18082
/api/v1/platform/enterprises -> 127.0.0.1:18082
/api/v1/agency/enterprises -> 127.0.0.1:18082
/api/v1/departments       -> 127.0.0.1:18082
/api/v1/teams             -> 127.0.0.1:18082
/api/v1/platform/system-settings -> 127.0.0.1:18082
/api/v1/settings          -> 127.0.0.1:18082
/api/v1/dictionaries      -> 127.0.0.1:18082
/api/v1/platform/workbench/summary -> 127.0.0.1:18082
/api/v1/agency/workbench/summary -> 127.0.0.1:18082
/api/v1/enterprise/workbench/summary -> 127.0.0.1:18082

/api/v1/roles             -> 127.0.0.1:18083
/api/v1/permissions       -> 127.0.0.1:18083
/api/v1/audit-logs        -> 127.0.0.1:18083
/api/v1/notifications     -> 127.0.0.1:18083
/api/v1/invitations       -> 127.0.0.1:18083
/api/v1/public/invitations -> 127.0.0.1:18083
/api/v1/workspace/members -> 127.0.0.1:18083
/api/v1/memberships       -> 127.0.0.1:18083
/api/v1/data-scopes       -> 127.0.0.1:18083
/api/v1/announcements     -> 127.0.0.1:18083

/api/v1/ai-models         -> 127.0.0.1:18086
```

---

## 15. 脚本与运维选型

### 15.1 脚本目录

复用参照项目：

```text
scripts/
```

建议脚本：

```text
scripts/deploy_database.sh
scripts/deploy_services.sh
scripts/deploy_frontend.sh
scripts/verify_deployment.sh
scripts/seed_dev_data.sh
scripts/build_services.sh
scripts/build_frontend.sh
```

### 15.2 ops 目录

复用参照项目：

```text
ops/
├── db/
├── native/
└── seed/
```

建议：

```text
ops/native/external-dependencies.env.example
ops/native/ky-admin-host.nginx.conf
ops/native/ky-auth-service.service
ops/native/ky-org-service.service
ops/native/ky-membership-service.service
ops/native/ky-ai-model-service.service
```

### 15.3 健康检查

每个服务提供：

```text
/readyz
/healthz，可选
```

部署脚本完成后调用 readyz 验证。

---

## 16. 质量与验证选型

### 16.1 前端验证

必须支持：

```text
pnpm lint
pnpm typecheck
pnpm build
```

插件级验证：

```text
pnpm --filter @ky/admin-host build
pnpm --filter @ky/plugin-organization-management typecheck
pnpm --filter @ky/plugin-access-management typecheck
```

### 16.2 后端验证

每个服务支持：

```text
go test ./...
```

建议后续加入：

```text
golangci-lint
```

但第一阶段可以不作为硬性门槛。

### 16.3 集成验证

第一阶段必须有 smoke checks：

- 登录。
- Bootstrap。
- 后台身份列表。
- 工作区选择。
- 工作区切换。
- 平台后台菜单。
- 机构后台菜单。
- 企业后台菜单。
- 权限拒绝跳转 `/403`。
- 成员邀请。
- 通知未读数。
- AI 供应商列表。
- AI 模型列表。

---

## 17. 第一阶段推荐工程结构

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

## 18. 与参照项目命名映射

| zhipinai_v2 | KyaiCRM |
|---|---|
| `zp-admin-host` | `ky-admin-host` |
| `zp-admin-core` | `ky-admin-core` |
| `@zp/admin-host` | `@ky/admin-host` |
| `@zp/admin-core` | `@ky/admin-core` |
| `plugins/zp-org-management` | `plugins/ky-organization-management` |
| `plugins/zp-notification` | `plugins/ky-notification` |
| `plugins/zp-ai-operations` | `plugins/ky-ai-configuration`，仅保留供应商和模型配置 |
| `zp-auth-service` | `ky-auth-service` |
| `zp-org-service` | `ky-org-service` |
| `zp-membership-service` | `ky-membership-service` |
| `zp-ai-model-service` | `ky-ai-model-service` |
| `ZP_*` | `KY_*` |
| `X-ZP-Workspace-Id` | `X-KY-Workspace-Id` |
| `X-ZP-Workspace-Type` | `X-KY-Workspace-Type` |
| `zp.admin.session.v1` | `ky.admin.session.v1` |

---

## 19. 明确不选择的技术方案

第一阶段明确不选择：

```text
Kubernetes-first
Docker-first
复杂微前端框架
运行时远程插件加载
GraphQL
gRPC 对外 API
重型 API Gateway
多语言后端混用
自研 UI 组件库
Redux
复杂工作流引擎
服务网格
AI 执行器运行时
IM 实时通信服务
移动端 Flutter 应用
```

这些不是永远不做，而是不进入第一阶段技术基线。

---

## 20. 技术选型结论

KyaiCRM 第一阶段技术选型结论如下：

1. **前端严格复用 zhipinai_v2：**  
   React 19、TypeScript 5、Vite 7、Ant Design 6、React Router 7、TanStack Query 5、Zustand、pnpm workspace、Turborepo。

2. **后台架构严格复用 Host + Plugin：**  
   `ky-admin-host` 负责后台壳层，`ky-admin-core` 负责插件协议，`plugins/ky-*` 承载后台模块。

3. **后端严格复用 Go 多服务：**  
   使用 Go、HTTP JSON、PostgreSQL、pgx/v5，按认证、组织、成员权限、AI 模型配置拆分服务。

4. **数据和基础设施严格复用：**  
   PostgreSQL、Redis、NATS、S3/MinIO、Nginx、systemd。

5. **部署严格复用原生 VM 模式：**  
   Nginx 托管前端和 API 反代，systemd 管理 Go 服务，shell 脚本完成构建、部署、验证。

6. **命名统一改为 `ky_` / `KY_` / `ky-*`：**  
   数据表、环境变量、包名、服务名、请求头全部替换为 KyaiCRM 命名体系。

7. **AI 只保留配置层：**  
   只建设 AI 供应商和模型配置，不引入 AI 员工、AI 协作、AI 执行器和 AI 业务模块。

8. **第一阶段不做 CRM 业务：**  
   当前只建设用户中心、多租户、多后台身份、组织权限、通知审计和系统配置底座。
