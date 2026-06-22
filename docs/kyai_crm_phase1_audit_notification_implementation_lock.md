# KyaiCRM Phase 1.8 通知与审计实现锁定记录

> 文档状态：已锁定 / Phase 1.8 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
ky-membership-service  审计读 + 审计写 hook + 通知消费 + 公告(创建/发布/桥接)
ky-org-service         审计写 hook
ky-auth-service        登录日志读
```

---

## 2. 已实现接口

```text
GET   /api/v1/notifications
GET   /api/v1/notifications/unread-count
PATCH /api/v1/notifications/:id/read
POST  /api/v1/notifications/read-all

GET   /api/v1/announcements
POST  /api/v1/announcements
PATCH /api/v1/announcements/:id/publish

GET   /api/v1/audit-logs            （ky-membership-service）
GET   /api/v1/login-logs            （ky-auth-service）
```

---

## 3. 实现要点

### 3.1 审计

- 两服务内置 `WriteAudit(entry)`（17 列插入，best-effort，业务不因审计失败回滚）。
- 各 server 提供 `audit()` 助手，从 wsContext + 请求构造条目，成功写操作后调用。
- 已 instrument：
  - org：agency/enterprise 创建/更新/状态/归属、organization.updated、department 创建/更新/删除、team 创建/更新/成员设置。
  - membership：member 状态/移除/部门/团队、invitation 创建/取消/接受、role 创建/更新/状态/权限、membership.roles_assigned、announcement 创建/发布。
- 审计读 `audit-logs`：platform 全局；agency/enterprise 限当前工作区；支持 action/resourceType/actorUserId/startAt/endAt + 分页。

### 3.2 登录日志

- `ky-auth-service` 新增 `GET /api/v1/login-logs`：requireAuth（token+session）→ 平台工作区校验 → membership → `HasAny(platform.login_logs.view)`。
- 支持 userId/result/startAt/endAt + 分页。

### 3.3 通知消费

- 可见性：`recipient_user_id=我 OR scope_type='platform' OR (scope_type=当前类型 AND scope_id=当前工作区)`，仅 `status='normal'`。
- 列表含每条 `read` 布尔；未读数与全部已读与可见性一致。
- 标记已读对 `ky_notification_read` 幂等 upsert；不可见通知 404。

### 3.4 公告

- 平台创建（draft）/发布（published + published_at）；重复发布 409。
- 列表：平台看全部（按状态）；机构/企业看 published 且 `target_scope='all' OR (target_scope=当前类型 AND 当前ID ∈ target_ids)`（jsonb `@>`）。
- 发布桥接生成 `ky_notification`（`notification_type='system'`）：
  ```text
  all        -> scope_type='platform', scope_id='platform_root'
  agency     -> 每个 targetId scope_type='agency'
  enterprise -> 每个 targetId scope_type='enterprise'
  user       -> 每个 targetId scope_type='user', recipient_user_id=targetId
  ```

### 3.5 权限门

所有新路由经 `ws(allowedTypes, requiredPerms, handler)`：`*.notifications.view`、`*.announcements.view`、`platform.announcements.create/publish`、`*.audit.view`、`platform.login_logs.view`，均已 seed。公开邀请接口豁免。

---

## 4. 复审与修复

独立复审确认 SQL 列/约束、占位符、jsonb 容器、权限码 seed、审计列数（17）、登录日志列均正确。

修复 1 项阻塞：

- `notificationVisible` 此前向 `visibilityClause` 传入独立 args 切片，导致占位符与 `n.id=$1` 错位（off-by-one）。改为共享同一 args 切片，使可见性占位符从 `$2` 起，正确对应。

附带清理：

- membership 审计 ID 由 `aud_<action>_<resourceId>_<rand>` 简化为 `aud_<rand>`，与 org 服务一致。

---

## 5. 验证结果

```text
go build / vet  三服务通过
go test 全部服务通过
```

新增单元测试：

```text
visibilityClause 占位符与参数顺序（空 args 与已有 args 两种）
```

复审结论：

```text
NO BLOCKERS
```

---

## 6. 部署一致性

`ops/native/ky-admin-host.nginx.conf` 已将 `/api/v1/notifications`、`/api/v1/announcements`、`/api/v1/audit-logs` 反代到 `18083`（membership），`/api/v1/login-logs` 反代到 `18081`（auth）。

---

## 7. 显式延后与后续

1. 事件级通知（成员/权限变更等逐事件通知）延后；本阶段通知主要来自公告桥接。
2. 行级数据范围对审计/通知的进一步裁剪延后。
3. 公开接受邀请的 `userId` 信任问题仍为后续硬化项。

后续阶段：

```text
Phase 1.9 AI 配置（ky-ai-model-service，唯一未实现服务）
Phase 1.10 部署与验收
```
