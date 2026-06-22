# KyaiCRM Phase 1.8 通知与审计实现需求

> 文档状态：已锁定 / Phase 1.8 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.8 / 通知与审计  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.4 Auth/Bootstrap、Phase 1.5 组织主体管理、Phase 1.6 成员与邀请、Phase 1.7 权限中心  

---

## 1. 阶段目标

1. 落地审计写入：在关键写操作上写 `ky_audit_log`（兑现 Phase 1.5/1.6/1.7 预留的审计 hook）。
2. 提供审计日志读 API 与登录日志读 API。
3. 提供通知消费 API（列表 / 未读数 / 标记已读 / 全部已读）。
4. 提供系统公告 API（列表 / 创建 / 发布），发布时桥接生成通知。

---

## 2. 范围

### 2.1 后端范围

```text
ky-membership-service: 审计读、审计写 hook、通知消费、公告 + 发布桥接
ky-org-service:        审计写 hook
ky-auth-service:       登录日志读
```

实现 API：

```text
GET   /api/v1/notifications
GET   /api/v1/notifications/unread-count
PATCH /api/v1/notifications/:id/read
POST  /api/v1/notifications/read-all

GET   /api/v1/announcements
POST  /api/v1/announcements
PATCH /api/v1/announcements/:id/publish

GET   /api/v1/audit-logs
GET   /api/v1/login-logs
```

读写表：

```text
ky_audit_log
ky_notification
ky_notification_read
ky_system_announcement
ky_login_log
```

### 2.2 不做 / 显式延后

```text
通知的事件级自动生成（成员变更 / 权限变更等的逐事件通知）——本阶段仅实现公告→通知桥接，其余事件通知延后
行级数据范围对审计/通知的进一步裁剪（部门/团队负责人 scope）——延后
邮件 / 短信 / 推送外发
CRM / AI 员工 / IM / 移动端
```

---

## 3. 鉴权

沿用 Phase 1.7 的 `ws(allowedTypes, requiredPerms, handler)`：

| 接口 | allowedTypes | requiredPerms（OR） |
|---|---|---|
| `GET /notifications` | platform,agency,enterprise | `*.notifications.view` |
| `GET /notifications/unread-count` | platform,agency,enterprise | `*.notifications.view` |
| `PATCH /notifications/:id/read` | platform,agency,enterprise | `*.notifications.view` |
| `POST /notifications/read-all` | platform,agency,enterprise | `*.notifications.view` |
| `GET /announcements` | platform,agency,enterprise | `*.announcements.view` |
| `POST /announcements` | platform | `platform.announcements.create` |
| `PATCH /announcements/:id/publish` | platform | `platform.announcements.publish` |
| `GET /audit-logs` | platform,agency,enterprise | `*.audit.view` |
| `GET /login-logs` | platform | `platform.login_logs.view` |

登录日志接口落在 `ky-auth-service`，需在该服务内置等价的 token + 工作区 + 权限校验（与 membership/org 同口径）。

---

## 4. 审计写入

### 4.1 审计写入器

每个服务内置 `WriteAudit(entry)`：

```text
entry: actorUserId, actorMembershipId, workspaceType, workspaceId,
       agencyId?, enterpriseId?, action, resourceType, resourceId,
       result(success/failed), requestId, ipAddress, userAgent, source, remark, detail(jsonb)
```

- 审计写入为 best-effort，失败不阻断主流程（记录但不回滚业务）。
- 在业务写操作 **成功后** 调用。

### 4.2 instrument 范围（关键写操作）

org 服务：

```text
agency.created / agency.updated / agency.status_changed
enterprise.created / enterprise.updated / enterprise.agency_assigned / enterprise.status_changed
organization.updated
department.created / department.updated / department.deleted
team.created / team.updated / team.members_set
agency_enterprise.created / agency_enterprise.updated
```

membership 服务：

```text
member.status_changed / member.removed / member.departments_assigned / member.teams_assigned
invitation.created / invitation.cancelled / invitation.accepted
role.created / role.updated / role.status_changed / role.permissions_updated
membership.roles_assigned
announcement.created / announcement.published
```

`action` 采用 `<resource>.<verb>` 命名；`resource_type` 用资源名（agency/enterprise/department/team/membership/invitation/role/announcement/organization）。

### 4.3 审计读 `GET /api/v1/audit-logs`

- 过滤：`action`、`resourceType`、`actorUserId`、`startAt`、`endAt`，分页。
- 范围：
  - platform：全局所有日志。
  - agency：`workspace_type='agency' AND workspace_id=当前机构`。
  - enterprise：`workspace_type='enterprise' AND workspace_id=当前企业`。
- 行级 scope（部门/团队负责人）延后。

### 4.4 登录日志读 `GET /api/v1/login-logs`

- `ky-auth-service` 提供。
- 过滤：`userId`、`result`、`startAt`、`endAt`，分页。
- 仅平台 `platform.login_logs.view`。

---

## 5. 通知消费

### 5.1 可见性

“我的通知”定义：

```text
recipient_user_id = 当前用户
OR scope_type = 'platform'                       （平台广播，全局可见）
OR (scope_type = 当前 workspaceType AND scope_id = 当前 workspaceId)
```

仅 `status='normal'` 的通知。已读状态由 `ky_notification_read(notification_id, user_id)` 决定。

### 5.2 接口

```text
GET   /notifications?page&pageSize&read&type   列表，含每条 read 布尔
GET   /notifications/unread-count               我的未读数
PATCH /notifications/:id/read                   标记单条已读（必须是我可见的通知）
POST  /notifications/read-all                   标记我所有可见未读为已读
```

- `read` 过滤：`true` 仅已读 / `false` 仅未读。
- `type` 过滤：`notification_type`。
- 标记已读为对 `ky_notification_read` 的幂等 upsert（`ON CONFLICT (notification_id,user_id) DO NOTHING`）。
- 标记不可见通知返回 404。

---

## 6. 系统公告

### 6.1 列表 `GET /api/v1/announcements`

- 平台：返回全部公告（按状态过滤）。
- 机构 / 企业：仅返回 `status='published'` 且面向其可见的公告：
  ```text
  target_scope='all'
  OR (target_scope=当前 workspaceType AND 当前 workspaceId ∈ target_ids)
  ```
- 过滤：`status`（平台可用），分页。

### 6.2 创建 `POST /api/v1/announcements`

- 仅平台。写 `ky_system_announcement`，`status='draft'`，`created_by`。
- `targetScope ∈ {all, agency, enterprise, user}`；`agency/enterprise/user` 需要 `targetIds` 非空。

### 6.3 发布 `PATCH /api/v1/announcements/:id/publish`

- 仅平台。`draft` → `published`，`published_at=now()`。
- 发布桥接生成 `ky_notification`（`notification_type='system'`）：
  ```text
  all        -> 1 条 scope_type='platform', scope_id='platform_root'
  agency     -> 每个 targetId 1 条 scope_type='agency', scope_id=targetId
  enterprise -> 每个 targetId 1 条 scope_type='enterprise', scope_id=targetId
  user       -> 每个 targetId 1 条 scope_type='user', recipient_user_id=targetId, scope_id=targetId
  ```
- 重复发布（已 published）返回 409。

---

## 7. 通用响应

沿用全局契约：成功 `{data,requestId}`，列表 `{data:{items,pagination},requestId}`，错误 `{error,requestId}`。

错误码：`unauthorized`/`workspace_required`/`workspace_forbidden`/`permission_denied`/`not_found`/`conflict`/`validation_error`/`internal_error`。

---

## 8. 验收标准

### 8.1 后端

```text
go build / vet / test 三服务通过（含全服务）
GET /readyz 正常
```

### 8.2 业务

```text
关键写操作成功后写入 ky_audit_log（action/resource/workspace/actor 正确）
audit-logs 按工作区范围返回；平台全局
login-logs 仅平台可读
通知列表/未读数/标记已读/全部已读可用，可见性规则正确
公告创建/发布可用；发布生成对应 scope 的通知
无对应权限返回 403 permission_denied
```

---

## 9. 风险与约束

1. 审计写入 best-effort，不因审计失败回滚业务；但不得吞掉业务错误。
2. 事件级通知（非公告）延后；本阶段未读数主要来自公告桥接通知。
3. 平台广播以 `scope_type='platform'` 表达全局可见，避免逐用户 fan-out。
4. 行级数据范围对审计/通知的进一步裁剪延后，响应口径需在文档明确。
5. `ky-auth-service` 为登录日志读新增工作区+权限校验，需与其余服务口径一致。
