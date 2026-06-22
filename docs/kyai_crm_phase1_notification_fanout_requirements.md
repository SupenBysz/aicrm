# KyaiCRM Phase 1.16 通知 fan-out 实现需求

> 文档状态：已锁定  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.16 / 多接收人事件通知（fan-out）  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.1–1.15 全部已实现并锁定  

---

## 1. 背景与目标

Phase 1.15 实现了单成员事件通知。本阶段补齐两类**多接收人**事件通知（fan-out）：

- `role.permissions_updated`：角色权限变更 → 通知持有该角色的全部成员（membership-service）。
- `organization.status_changed`：机构/企业状态被平台变更 → 通知该主体全部活跃成员（org-service）。

`invitation` 通知（被邀请人常无账号，按 email/phone 无法定向 userId）继续延后。

本阶段决策：

- 决策 A：事件集合 = `role.permissions_updated` + `organization.status_changed`；invitation 延后。
- 决策 B：org-service 直接写 `ky_notification`（最小 CreateUserNotification 移植），登记“通知逻辑跨服务重复”技术债。
- 决策 C：fan-out 目标 = 受影响范围内活跃成员；best-effort、自我抑制操作者；逐成员插入（规模有界）。

---

## 2. 范围

```text
ky-membership-service:
  role.permissions_updated（POST /roles/:id/permissions 成功后）
    -> 持有该角色（当前工作区）的全部成员 -> permission 通知
ky-org-service:
  agency.status_changed / enterprise.status_changed（PATCH /platform/.../:id/status 成功后）
    -> 该机构/企业全部活跃成员 -> organization 通知
```

### 2.1 不做 / 延后

```text
invitation 通知（无法定向 userId）
机构/企业 update / agency_assigned 等非状态事件的通知
通知合并/去重/限频（本阶段每事件每成员 1 条）
跨服务通知逻辑共享模块抽取（技术债）
```

---

## 3. 通知生成

### 3.1 role.permissions_updated（membership-service）

- 触发：`setRolePermissions` 成功 + 审计后。
- 目标用户集：持有该角色的成员所属用户。
  ```sql
  SELECT DISTINCT m.user_id
  FROM ky_membership_role mr JOIN ky_membership m ON m.id = mr.membership_id
  WHERE mr.role_id = $1 AND m.deleted_at IS NULL
  ```
- 每个目标用户（≠ 操作者）生成 1 条：
  ```text
  notification_type = permission
  title = 权限变更
  content = "您在『<工作区名>』的角色权限已更新"
  ```
- best-effort：整体失败不阻断业务；复用 `CreateUserNotification`。

### 3.2 organization.status_changed（org-service）

- 触发：`updateAgencyStatus` / `updateEnterpriseStatus` 成功 + 审计后。
- 目标用户集：该主体全部活跃成员所属用户。
  ```sql
  SELECT DISTINCT user_id FROM ky_membership
  WHERE workspace_type = $1 AND workspace_id = $2 AND status='active' AND deleted_at IS NULL
  ```
  （`workspace_type`=agency/enterprise，`workspace_id`=被变更主体 id）
- 每个目标用户（≠ 操作者，通常平台操作者非该主体成员）生成 1 条：
  ```text
  notification_type = organization
  title = 机构状态变更 / 企业状态变更
  content = "您所属的<机构|企业>状态已变更为：<status>"
  ```
- org-service 新增最小 `CreateUserNotification`（与 membership 版同列）。
- best-effort。

### 3.3 通用

```text
定向：scope_type='user', scope_id=recipient_user_id=目标用户；复用 Phase 1.8 可见性。
自我抑制：目标用户==操作者 跳过。
逐成员插入（规模有界）；失败忽略，不回滚业务。
notification_type 取值合法（permission/organization）。
```

---

## 4. 实现要点

1. membership store 新增 `UserIDsByRole(ctx, roleID) -> []string`（DISTINCT user_id）。
2. membership handler `setRolePermissions`：成功+审计后，对每个目标用户（≠操作者）`CreateUserNotification`（permission）。
3. org store 新增 `CreateUserNotification`（最小移植）+ `ActiveMemberUserIDs(ctx, wsType, wsID) -> []string`。
4. org handler `updateAgencyStatus` / `updateEnterpriseStatus`：成功+审计后，对该主体活跃成员所属用户（≠操作者）`CreateUserNotification`（organization）。
5. 工作区名：membership 复用 `WorkspaceName`；org 用主体 name（已查询/可查）。

---

## 5. 验收标准

```text
修改某角色权限 -> 持有该角色的成员各收到 1 条 permission 通知；操作者不自发
平台停用某机构/企业 -> 该主体活跃成员各收到 1 条 organization 通知
目标集为空 -> 不生成
通知失败不阻断业务（best-effort）
notification_type 合法；文案含主体/工作区名
go build / vet / test 四服务通过；复审 NO BLOCKERS
```

---

## 6. 风险与约束

1. fan-out 规模 = 角色成员数 / 主体成员数；第一阶段逐条插入，规模有界可接受；后续可批量/异步。
2. org-service 直接写 `ky_notification` 造成通知逻辑跨服务重复 → 登记技术债。
3. invitation 通知延后（定向问题）。
4. best-effort 与审计一致；通知非关键路径。
5. 与数据范围无冲突（通知读按 recipient/scope，不经数据范围裁剪）。
