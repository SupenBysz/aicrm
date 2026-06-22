# KyaiCRM Phase 1.5 组织主体管理实现锁定记录

> 文档状态：已锁定 / Phase 1.5 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

本次锁定范围为 KyaiCRM Phase 1.5 组织主体管理实现基线。

覆盖内容：

```text
services/ky-org-service
```

依赖前置基线：Phase 1 文档基线、工程骨架、数据库 schema/seed、Phase 1.4 Auth/Bootstrap 实现。

---

## 2. 已实现接口

```text
GET    /api/v1/platform/agencies
POST   /api/v1/platform/agencies
GET    /api/v1/platform/agencies/:id
PATCH  /api/v1/platform/agencies/:id
PATCH  /api/v1/platform/agencies/:id/status

GET    /api/v1/platform/enterprises
POST   /api/v1/platform/enterprises
GET    /api/v1/platform/enterprises/:id
PATCH  /api/v1/platform/enterprises/:id
PATCH  /api/v1/platform/enterprises/:id/agency
PATCH  /api/v1/platform/enterprises/:id/status

GET    /api/v1/organizations/current
PATCH  /api/v1/organizations/current

GET    /api/v1/agency/enterprises
GET    /api/v1/agency/enterprises/:id
POST   /api/v1/agency/enterprises
PATCH  /api/v1/agency/enterprises/:id

GET    /api/v1/departments
POST   /api/v1/departments
PATCH  /api/v1/departments/:id
DELETE /api/v1/departments/:id

GET    /api/v1/teams
POST   /api/v1/teams
PATCH  /api/v1/teams/:id
POST   /api/v1/teams/:id/members
```

并保留：

```text
GET /readyz
GET /healthz
```

---

## 3. 实现要点

### 3.1 服务结构

```text
internal/config/config.go     env 加载 + AuthTokenSecret
internal/auth/token.go        与 ky-auth-service 一致的 HMAC token 校验
internal/store/db.go          pgx 连接 + active membership 查询
internal/store/agency_store.go
internal/store/enterprise_store.go
internal/store/department_store.go
internal/store/team_store.go
internal/store/org_store.go
internal/store/helpers.go     唯一/外键冲突分类
internal/server/*.go          中间件 + 各域 handler
```

### 3.2 鉴权与工作区

每个登录后接口经过 `ws()` 中间件：

1. 校验 `Authorization: Bearer <token>`（HMAC + exp）。
2. 校验工作区 Header `X-KY-Workspace-Type` / `X-KY-Workspace-Id`。
3. 校验工作区类型与接口匹配（platform / agency / enterprise）。
4. 校验用户在该工作区有 active membership。

返回约定：

```text
缺 token        -> 401 unauthorized
缺工作区 Header -> 400 workspace_required
类型不匹配      -> 403 workspace_forbidden
无 membership   -> 403 workspace_forbidden
```

### 3.3 数据隔离

- 平台接口仅 `platform` 工作区可用。
- 机构服务企业接口按当前机构 `agency_id` 过滤，越权返回 not_found。
- 当前组织接口按 `workspace_type/workspace_id` 解析机构或企业。
- 部门 / 团队按当前工作区 `workspace_type/workspace_id` 隔离。
- 团队成员仅允许当前工作区内 membership。

### 3.4 写一致性

- 机构 / 企业 / 部门 / 团队 `code` 唯一冲突返回 409 conflict。
- 外键非法（如 agencyId / parentId / departmentId 不存在）归类为 409 conflict。
- 企业创建 / 调整归属机构在事务内维护 `ky_agency_enterprise_relation`（owner 关系）。
- 部门删除为软删除，存在子部门返回 409 conflict。
- 团队成员维护为覆盖式设置。

---

## 4. 验证结果

```text
go build ./services/ky-org-service/...      通过
go vet  ./services/ky-org-service/...        通过
go test ./services/ky-org-service/...        通过（auth/server 单测）
go test 全部服务                              通过
```

单元测试覆盖：

```text
token 跨服务互验（与 auth 签名一致）
token 过期 / 错签 / 缺 secret
工作区类型 gating
status 校验 / status 归一化
```

复审结论：

```text
NO BLOCKERS
```

---

## 5. 部署一致性

`ops/native/ky-admin-host.nginx.conf` 已将以下路由反代到 `127.0.0.1:18082`（ky-org-service）：

```text
/api/v1/platform/agencies
/api/v1/platform/enterprises
/api/v1/agency/enterprises
/api/v1/organizations
/api/v1/departments
/api/v1/teams
```

---

## 6. 外部环境待验收项

与 Phase 1.4 一致，真实端到端验收需要：

```text
KY_TENANT_DATABASE_URL
psql / 已执行 schema 与 seed
有效登录 token（来自 ky-auth-service）
```

本阶段代码、构建、单测层面无阻塞，真实数据库联调属运行验收待办。

---

## 7. 后续阶段

```text
Phase 1.6 成员与邀请（ky-membership-service）
Phase 1.7 权限中心与数据范围（接入 page/action 级权限校验）
Phase 1.8 通知与审计（补写操作审计 hook）
```
