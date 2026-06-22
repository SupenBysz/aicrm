# KyaiCRM Phase 1.15 事件级通知自动生成实现需求

> 文档状态：已锁定 / Phase 1.15 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.15 / 事件级通知自动生成  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.1–1.14 全部已实现并锁定  

---

## 1. 背景与目标

通知此前仅由公告发布桥接产生（Phase 1.8），事件级生成被显式延后。本阶段在关键**成员生命周期事件**成功后，给受影响成员所属用户自动生成个人通知，使未读数/通知列表反映真实业务事件。

本阶段决策：

- 决策 A（A‑1）：仅 5 个单成员事件，无 fan-out。
- 决策 B（B‑1）：notification_type 按枚举语义映射。
- 决策 C（C‑1）：个人定向（`recipient_user_id`），文案含工作区名。
- 决策 D（D‑1）：best-effort 不阻断业务；受影响用户 == 操作者时自我抑制。

---

## 2. 范围

### 2.1 触发事件（ky-membership-service）

业务写成功 + 审计后，给“受影响成员所属用户”生成 1 条通知：

```text
member.status_changed        PATCH /workspace/members/:id/status
member.removed               DELETE /workspace/members/:id
member.departments_assigned  POST /workspace/members/:id/departments
member.teams_assigned        POST /workspace/members/:id/teams
membership.roles_assigned    POST /memberships/:id/roles
```

### 2.2 不做 / 延后

```text
role.permissions_updated 的角色成员 fan-out（受众面大，单独阶段）
invitation 相关（被邀请人常无账号，按 email/phone 无法定向 userId）
organization.status_changed（机构/企业状态，受众更广，单独阶段）
通知的删除/归档接口（不变）
```

---

## 3. 通知生成

### 3.1 定向与字段

```text
scope_type = 'user'
scope_id = 受影响用户 userId
recipient_user_id = 受影响用户 userId
notification_type 见 3.2
title / content 见 3.3
status = 'normal'
```

可见性复用 Phase 1.8 规则（`recipient_user_id=我` 命中）→ 受影响用户在任意工作区可见，未读数计入。

### 3.2 notification_type 映射

```text
member.status_changed        -> security
member.removed               -> organization
member.departments_assigned  -> organization
member.teams_assigned        -> organization
membership.roles_assigned    -> permission
```

均在 `ky_notification.notification_type` 枚举内（invite/security/system/permission/organization）。

### 3.3 文案

中文简述事件 + 工作区名（`WorkspaceName(wsType, wsID)`，复用既有）。示例：

```text
member.status_changed (disabled): 标题“成员状态变更” 内容“您在『<工作区名>』的成员状态已变更为：已禁用”
member.removed:                  标题“成员移除”     内容“您已被移出『<工作区名>』”
member.departments_assigned:     标题“部门调整”     内容“您在『<工作区名>』的部门归属已更新”
member.teams_assigned:           标题“团队调整”     内容“您在『<工作区名>』的团队归属已更新”
membership.roles_assigned:       标题“权限变更”     内容“您在『<工作区名>』的角色已更新”
```

### 3.4 行为约束

```text
best-effort：通知插入失败仅记录，不影响业务响应/不回滚（与审计一致）。
自我抑制：受影响用户 == 操作者用户（wc.UserID）时跳过生成。
受影响成员不存在/无 user（理论不会）-> 跳过。
```

---

## 4. 实现要点

1. store 新增：
   - `MembershipUserID(ctx, membershipID) -> (userID string, error)`（读 `ky_membership.user_id`，未删除）。
   - `CreateUserNotification(ctx, userID, title, content, notificationType) error`（非事务插入 `ky_notification`，`scope_type='user'`,`scope_id=userID`,`recipient_user_id=userID`）。
2. handler 在各事件成功 + 审计后：
   - 取受影响成员 userId；若 == wc.UserID → 跳过（自我抑制）。
   - 取 `WorkspaceName`，拼文案，调用 `CreateUserNotification`（忽略错误，best-effort）。
3. 复用既有可见性/未读数/标记已读路径，无需改通知读接口。

---

## 5. 验收标准

```text
禁用某成员 -> 该成员收到 security 通知，其未读数 +1
移除/分配部门/分配团队/授权角色 -> 受影响成员各收对应类型通知
操作者操作自己 -> 不自发通知
通知插入失败不阻断业务
notification_type 取值合法；文案含工作区名
go build / vet / test 四服务通过；复审 NO BLOCKERS
```

---

## 6. 风险与约束

1. 无 fan-out：每事件 1 条通知，受众单一，规模可控。
2. best-effort 与审计一致；通知非关键路径，失败不回滚。
3. role.permissions_updated / organization.status_changed / invitation 通知延后（受众面或定向问题）。
4. 个人通知用 `recipient_user_id` 定向，文案含工作区名以区分来源工作区。
5. 与 Phase 1.13c 数据范围无冲突：通知读路径按 recipient/scope，不经成员数据范围裁剪。
