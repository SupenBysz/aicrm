# KyaiCRM Phase 1.4 Auth / Bootstrap 实现锁定记录

> 文档状态：已锁定 / Phase 1.4 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

本次锁定范围为 KyaiCRM Phase 1.4 Auth / Bootstrap 实现基线。

覆盖内容：

```text
services/ky-auth-service
apps/ky-admin-host
packages/ky-admin-core
scripts/seed_dev_data.sh
ops/seed/README.md
```

---

## 2. 后端实现范围

`ky-auth-service` 已实现：

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
GET  /api/v1/auth/bootstrap
GET  /readyz
GET  /healthz
```

后端能力包括：

- bcrypt 密码哈希与校验。
- HMAC token 签发与校验。
- token payload 包含 `userId`、`sessionId`、`exp`。
- session 创建、active 校验、logout revoke。
- 登录日志写入。
- bootstrap 聚合 memberships、roles、permissions、actionPermissions、menuKeys、dataScopes。
- workspace name 按 platform / agency / enterprise 解析。
- `/readyz` 返回数据库连接状态和 token secret 配置状态。

---

## 3. 前端实现范围

`ky-admin-host` 已实现：

```text
/login
/register
/workspace/select
/no-workspace
/403
/w/:workspaceType/:workspaceId/workbench
```

前端能力包括：

- session 存储：`ky.admin.session.v1`
- bootstrap 存储：`ky.admin.bootstrap.v1`
- 当前 workspace 存储：`ky.admin.currentWorkspace.v1`
- 登录后 bootstrap。
- 注册后 bootstrap。
- 无身份跳转 `/no-workspace`。
- 单身份进入工作台。
- 多身份进入 `/workspace/select`。
- workspace workbench 占位展示。
- logout 调用后端并清理本地状态。
- request client 解析 `{ data, error, requestId }` envelope。
- request client 注入：
  - `Authorization`
  - `X-KY-Workspace-Id`
  - `X-KY-Workspace-Type`
  - `X-KY-Request-Id`

---

## 4. 已完成验证

已完成 Go 编译测试：

```text
go test ./services/ky-auth-service/... ./services/ky-org-service/... ./services/ky-membership-service/... ./services/ky-ai-model-service/...
```

结果：通过。

已完成前端类型检查：

```text
pnpm --filter @ky/admin-host typecheck
```

结果：通过。

已完成前端构建：

```text
pnpm --filter @ky/admin-host build
```

结果：通过。

构建产物：

```text
apps/ky-admin-host/dist/index.html
apps/ky-admin-host/dist/assets/*.js
```

构建提示：

```text
部分 chunk 超过 500 kB，属于优化建议，不阻塞 Phase 1.4 锁定。
```

---

## 5. 外部环境待验收项

以下不是代码阻塞，但属于运行验收前置条件：

1. 真实 PostgreSQL 连接：

```text
KY_TENANT_DATABASE_URL
```

2. 开发凭据后处理工具：

```text
psql
htpasswd
```

3. 执行开发 seed：

```text
scripts/seed_dev_data.sh
```

说明：`ops/db/008_seed.sql` 按设计保留 `CHANGE_ME_HASH`，本地/测试环境需要运行 `scripts/seed_dev_data.sh` 将 `platform_owner / admin123456` 写入 bcrypt hash。

---

## 6. 锁定结论

代码、文档、类型检查、前端构建和 Go 编译测试层面：

```text
NO BLOCKERS
```

Phase 1.4 Auth / Bootstrap 实现基线可锁定。

后续进入真实运行验收或 Phase 1.5 组织主体管理前，应先准备数据库环境并完成 seed 后处理。
