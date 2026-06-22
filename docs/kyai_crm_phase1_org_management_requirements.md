# KyaiCRM Phase 1.5 组织主体管理实现需求

> 文档状态：已锁定 / Phase 1.5 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.5 / 组织主体管理  
> 编写日期：2026-06-16  
> 前置基线：Phase 1 文档基线、工程骨架、数据库 schema/seed、Phase 1.4 Auth/Bootstrap 实现  

---

## 1. 阶段目标

实现 `ky-org-service` 的组织主体管理能力，使平台、机构、企业三类后台能够管理组织对象本身。

完成后系统应支持：

1. 平台管理机构（列表、详情、创建、更新、状态变更）。
2. 平台管理企业（列表、详情、创建、更新、调整归属机构、状态变更）。
3. 机构后台查看 / 维护当前机构信息。
4. 企业后台查看 / 维护当前企业信息。
5. 机构后台管理服务企业。
6. 机构 / 企业后台管理部门。
7. 机构 / 企业后台管理团队。

---

## 2. 范围

### 2.1 后端范围

服务：

```text
services/ky-org-service
```

实现 API：

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

读取 / 写入表：

```text
ky_agency
ky_enterprise
ky_agency_enterprise_relation
ky_department
ky_team
ky_membership_team
ky_membership
```

### 2.2 不做范围

```text
成员邀请（Phase 1.6）
角色权限授权（Phase 1.7）
通知与审计写入细节（Phase 1.8，可预留 hook）
AI 配置（Phase 1.9）
系统设置 / 字典聚合接口（保留给后续阶段）
工作台 summary 聚合（保留给后续阶段）
CRM / AI 员工 / IM / 移动端
```

---

## 3. 鉴权与工作区上下文

`ky-org-service` 不再签发 token，只校验。

每个登录后接口必须：

1. 校验 `Authorization: Bearer <token>`，使用与 `ky-auth-service` 相同的 `KY_AUTH_TOKEN_SECRET` 进行 HMAC 验签和过期校验。
2. 读取工作区 Header：
   - `X-KY-Workspace-Id`
   - `X-KY-Workspace-Type`
3. 校验当前 token 用户在该工作区拥有 active membership。
4. `X-KY-Request-Id` 用于响应 `requestId`，缺失时生成。

工作区类型与接口的约束：

| 接口前缀 | 允许工作区类型 |
|---|---|
| `/api/v1/platform/*` | `platform`（`platform_root`） |
| `/api/v1/agency/*` | `agency` |
| `/api/v1/organizations/current` | `agency` / `enterprise` |
| `/api/v1/departments`、`/api/v1/teams` | `agency` / `enterprise` |

工作区类型不匹配时返回 `workspace_forbidden`（403）。

> 第一阶段先做 membership 级工作区校验；细粒度操作权限（page/action permission）在 Phase 1.7 接入。本阶段在数据范围上以“当前工作区主体”为边界：机构后台只能操作当前机构及其名下企业，企业后台只能操作当前企业。

---

## 4. 通用响应

成功：

```json
{ "data": {}, "requestId": "req_xxx" }
```

列表：

```json
{ "data": { "items": [], "pagination": { "page": 1, "pageSize": 20, "total": 0 } }, "requestId": "req_xxx" }
```

错误：

```json
{ "error": { "code": "validation_error", "message": "...", "details": {} }, "requestId": "req_xxx" }
```

错误码沿用契约：`unauthorized` / `permission_denied` / `workspace_required` / `workspace_forbidden` / `not_found` / `validation_error` / `conflict` / `internal_error`。

---

## 5. 接口数据要点

### 5.1 平台机构

- 列表支持 `page`、`pageSize`、`keyword`（name/code 模糊）、`status`。
- 创建写入 `ky_agency`：`name`、`code`、`contactName`、`contactPhone`、`contactEmail`，`status` 默认 `normal`，记录 `created_by`。
- `code` 在未删除范围内唯一，冲突返回 `conflict`。
- 状态变更允许：`normal` / `disabled` / `frozen`。

### 5.2 平台企业

- 列表支持 `keyword`、`status`、`agencyId`。
- 创建写入 `ky_enterprise`，`agencyId` 可空（直属平台）；非空时同时写入 `ky_agency_enterprise_relation`（`relation_type=owner`，`status=normal`）。
- 调整归属机构更新 `ky_enterprise.agency_id`，并维护 `ky_agency_enterprise_relation`。
- 状态变更允许：`normal` / `disabled` / `frozen`。

### 5.3 当前组织

- 根据 `X-KY-Workspace-Type` 返回机构或企业当前主体信息。
- 更新仅允许维护基础资料（name/logo/description/contact*），不允许改 code 与归属。

### 5.4 机构服务企业

- 仅返回当前机构名下或授权范围内企业（基于 `ky_agency_enterprise_relation` 或 `ky_enterprise.agency_id = 当前机构`）。
- 机构开通企业：创建 `ky_enterprise`（`agency_id=当前机构`）+ 关系记录。
- 机构编辑企业仅限基础资料。

### 5.5 部门

- 按当前工作区（`workspace_type`/`workspace_id`）隔离。
- 支持 `parentId`、`status` 过滤。
- 创建 / 更新 / 删除限定在当前工作区主体内。
- 删除为软删除（`deleted_at`），存在子部门时返回 `conflict`。

### 5.6 团队

- 按当前工作区隔离。
- 支持 `departmentId`、`status` 过滤。
- 团队成员维护写入 `ky_membership_team`（覆盖式设置 membership 列表）。
- 仅允许当前工作区内的 membership 加入团队。

---

## 6. 验收标准

### 6.1 后端

```text
go build ./cmd/server   （ky-org-service 模块内）
go test ./services/ky-org-service/...
ky-org-service 可启动
GET /readyz 反映数据库与 token secret 状态
```

### 6.2 鉴权

```text
缺 token -> 401 unauthorized
缺工作区 Header -> 400 workspace_required
用户无当前工作区 membership -> 403 workspace_forbidden
平台接口用非平台工作区访问 -> 403 workspace_forbidden
```

### 6.3 业务

```text
平台可创建/查询/更新/停用机构
平台可创建/查询/更新/调整归属/停用企业
机构后台可查看并更新当前机构
机构后台可管理服务企业（当前机构范围内）
企业后台可查看并更新当前企业
机构/企业后台可管理部门与团队（当前工作区范围内）
跨工作区数据不可越权读取或写入
```

---

## 7. 风险与约束

1. 服务边界：本阶段 `ky-org-service` 直接读 `ky_membership` 做工作区校验；与 Phase 1.4 一致，后续可下沉到 membership 服务。
2. 操作权限：本阶段仅做工作区/membership 级校验，page/action 级权限在 Phase 1.7 接入，接口需预留权限校验插入点。
3. 审计：写操作预留审计 hook，本阶段不强制落 `ky_audit_log`。
4. Token 校验：复用与 auth 一致的自定义 HMAC token 格式，org 服务内置等价校验实现。
