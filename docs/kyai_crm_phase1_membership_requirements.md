# KyaiCRM Phase 1.6 成员与邀请实现需求

> 文档状态：已锁定 / Phase 1.6 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.6 / 成员与邀请  
> 编写日期：2026-06-16  
> 前置基线：Phase 1 文档基线、工程骨架、数据库 schema/seed、Phase 1.4 Auth/Bootstrap、Phase 1.5 组织主体管理  

---

## 1. 阶段目标

实现 `ky-membership-service` 的成员与邀请能力，使三类后台能够管理工作区成员、发起与处理邀请，并支持被邀请人接受邀请加入工作区。

完成后系统应支持：

1. 查看当前工作区成员列表与详情。
2. 修改成员状态、移除成员。
3. 为成员分配部门与团队。
4. 创建、查看、取消邀请。
5. 公开查询邀请、接受邀请并生成成员身份。

---

## 2. 范围

### 2.1 后端范围

服务：

```text
services/ky-membership-service
```

实现 API：

```text
GET    /api/v1/workspace/members
GET    /api/v1/workspace/members/:id
PATCH  /api/v1/workspace/members/:id/status
DELETE /api/v1/workspace/members/:id
POST   /api/v1/workspace/members/:id/departments
POST   /api/v1/workspace/members/:id/teams

GET    /api/v1/invitations
POST   /api/v1/invitations
PATCH  /api/v1/invitations/:id/cancel

GET    /api/v1/public/invitations/:token
POST   /api/v1/public/invitations/:token/accept
```

读取 / 写入表：

```text
ky_membership
ky_membership_department
ky_membership_team
ky_membership_role
ky_invitation
ky_user
ky_agency
ky_enterprise
```

### 2.2 不做范围

```text
角色 / 权限 / 数据范围 CRUD（Phase 1.7 Access API）
通知与审计写入细节（Phase 1.8，可预留 hook）
AI 配置（Phase 1.9）
CRM / AI 员工 / IM / 移动端
```

---

## 3. 鉴权与工作区上下文

与 `ky-org-service` 一致：

1. 登录后接口校验 `Authorization: Bearer <token>`（与 `ky-auth-service` 相同 `KY_AUTH_TOKEN_SECRET` 的 HMAC + 过期校验）。
2. 校验工作区 Header `X-KY-Workspace-Type` / `X-KY-Workspace-Id`。
3. 校验当前用户在该工作区拥有 active membership。
4. `X-KY-Request-Id` 用于 `requestId`，缺失则生成。

工作区类型约束：

| 接口 | 允许工作区类型 |
|---|---|
| `/api/v1/workspace/members*` | `platform` / `agency` / `enterprise` |
| `/api/v1/invitations*` | `platform` / `agency` / `enterprise` |
| `/api/v1/public/invitations*` | 公开，无需鉴权 |

分配部门 / 分配团队仅 `agency` / `enterprise` 工作区允许（platform 工作区无部门团队概念），其余成员接口三类工作区均可。

数据隔离：成员、邀请均按当前工作区 `workspace_type/workspace_id` 隔离，越权返回 not_found。

> 第一阶段仅做 membership 级工作区校验，page/action 级权限在 Phase 1.7 接入，接口需预留权限校验插入点。

---

## 4. 通用响应

与全局契约一致：成功 `{data, requestId}`，列表 `{data:{items,pagination}, requestId}`，错误 `{error:{code,message,details}, requestId}`。

错误码：`unauthorized` / `workspace_required` / `workspace_forbidden` / `not_found` / `validation_error` / `conflict` / `gone` / `internal_error`。

---

## 5. 接口数据要点

### 5.1 成员列表

- 过滤：`keyword`（成员显示名 / 用户名 / 邮箱 / 手机号模糊）、`departmentId`、`teamId`、`status`。
- 分页：`page`、`pageSize`。
- 返回字段：`id`、`userId`、`displayName`、`employeeNo`、`title`、`status`、`joinedAt`、关联用户 `email/phone`、`departmentIds`、`teamIds`。
- 按当前工作区隔离。

### 5.2 成员详情

- 按当前工作区返回单个成员及其部门、团队、角色 ID 列表。

### 5.3 成员状态

- 允许：`active` / `disabled` / `left`。
- 仅当前工作区内可改。

### 5.4 移除成员

- 软移除：将 `status` 置为 `left` 并 `deleted_at` 标记（保留历史），或物理删除关联后置 `left`。第一阶段采用软删除（`deleted_at`）+ 状态 `left`。
- 仅当前工作区内可移除。

### 5.5 分配部门

- 覆盖式设置成员部门集合，`isPrimary` 标记主部门，至多一个主部门。
- 仅允许当前工作区内的部门。

### 5.6 分配团队

- 覆盖式设置成员团队集合。
- 仅允许当前工作区内的团队。

### 5.7 邀请列表

- 过滤：`status`，分页。
- 仅返回当前工作区发起或目标为当前工作区的邀请；第一阶段按 `workspace_type/workspace_id = 当前工作区` 过滤。

### 5.8 创建邀请

- 写 `ky_invitation`：`workspace_type/workspace_id` 取请求 `targetWorkspaceType/targetWorkspaceId`，`invitation_type` 取 `member`/`agency_admin`/`enterprise_admin`。
- `invitee_email` / `invitee_phone` 至少一个。
- `preset_role_ids` / `preset_department_ids` / `preset_team_ids` 存为 jsonb。
- 生成唯一 `token`，`status=pending`，`expires_at` 取请求或默认 7 天。
- `invited_by_membership_id` 取当前工作区 membership。
- 约束：
  - 普通工作区只能邀请加入“当前工作区自身”（target = 当前工作区）。
  - 平台可邀请目标为机构 / 企业（`agency_admin` / `enterprise_admin`）。
  - 机构可邀请目标为其名下企业（`enterprise_admin`，对应 `agency.enterprises.invite_admin`），目标企业必须属于当前机构。

### 5.9 取消邀请

- 仅当前工作区发起的 `pending` 邀请可取消，置 `status=cancelled`。

### 5.10 公开查询邀请

- 按 token 查询，返回 `workspaceType/workspaceId/workspaceName/inviteeEmail/status/expiresAt/presetRoles`。
- 过期或不存在分别返回 `gone` / `not_found`。

### 5.11 接受邀请

- 入参 `userId`。
- 校验：邀请存在、`status=pending`、未过期；用户存在。
- 在事务内：
  - 若该用户在目标工作区已有未删除 membership，则复用，否则创建 `ky_membership`（`status=active`，`joined_at=now()`）。
  - 写入 `preset_department_ids` -> `ky_membership_department`，`preset_team_ids` -> `ky_membership_team`，`preset_role_ids` -> `ky_membership_role`。
  - 邀请置 `status=accepted`、`accepted_user_id`、`accepted_at`。
- 返回 `membershipId/workspaceType/workspaceId`。

> 安全说明：第一阶段公开接受按契约接收 `userId`；后续硬化阶段应改为接受人登录态校验，确保 `userId` 与登录用户一致。本阶段在文档中标注该硬化项。

---

## 6. 验收标准

### 6.1 后端

```text
go build ./services/ky-membership-service/...
go vet  ./services/ky-membership-service/...
go test ./services/ky-membership-service/...
GET /readyz 反映数据库与 token secret 状态
```

### 6.2 鉴权

```text
缺 token -> 401；缺工作区 Header -> 400；无 membership -> 403
分配部门/团队在 platform 工作区 -> 403 workspace_forbidden
公开邀请接口无需鉴权
```

### 6.3 业务

```text
可分页查询当前工作区成员并按部门/团队/状态过滤
可改成员状态、软移除成员
可覆盖式分配成员部门与团队（仅当前工作区范围）
可创建/列表/取消邀请，跨工作区不可越权
机构邀请企业管理员时目标企业必须属于当前机构
公开可按 token 查询邀请
接受邀请生成/复用 membership 并写入预设角色/部门/团队
过期或非 pending 邀请不可接受
```

---

## 7. 风险与约束

1. 服务边界：本阶段 `ky-membership-service` 直接读 `ky_membership` / `ky_agency` / `ky_enterprise` / `ky_user`，与既有阶段一致。
2. 操作权限：本阶段仅工作区/membership 级校验，page/action 级在 Phase 1.7 接入。
3. 审计：写操作预留审计 hook，本阶段不强制落 `ky_audit_log`。
4. 公开接受邀请的 `userId` 信任问题作为后续硬化项记录。
