# KyaiCRM Phase 1.13b 审计日志数据范围过滤实现需求

> 文档状态：已锁定 / Phase 1.13b 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.13b / 审计日志行级数据范围  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.1–1.13 全部已实现并锁定  

---

## 1. 背景与目标

Phase 1.13 已让数据范围作用于成员列表/详情。本阶段把同一裁剪能力扩展到**审计日志列表**，使部门/团队负责人只看到其范围内成员产生的审计事件（权限矩阵：部门/团队负责人只看 scope 范围）。

复用 Phase 1.13 的 `ResolveMemberScope`，零跨服务重复（审计读在 ky-membership-service，与解析器同服务）。

---

## 2. 范围

### 2.1 改动接口（ky-membership-service）

```text
GET /api/v1/audit-logs   按 caller 数据范围裁剪（actor membership 在可见成员集内）
```

### 2.2 不改 / 延后

```text
departments / teams 列表裁剪 —— 需将解析器移植到 ky-org-service，延后 1.13c
invitations 列表裁剪 —— 实体与数据范围映射不清晰，延后 1.13c
page/action 权限校验、平台全局审计（不变）
```

---

## 3. 裁剪语义

- caller 的有效数据范围按 `ResolveMemberScope` 解析（并集最宽松）。
- `Unrestricted`（持 all/current_<wsType>，如平台 owner/admin、机构/企业 owner/admin）→ 不裁剪，行为不变。
- 否则：审计仅返回 `actor_membership_id` 落在 caller 可见成员集内的记录。
  - 可见成员集 = 对当前工作区成员应用 Phase 1.13 的 ScopeFilter 谓词得到的 membership id 集合（含 self、所属部门、所属团队/子树）。
  - caller 自身的审计动作因 self/部门范围而被包含。
- `actor_membership_id` 为空（如公开接受邀请等无 membership 上下文的事件）→ 受限 caller 不可见。
- 平台工作区：审计为全局，平台 owner/admin 持 all → Unrestricted，不受影响。

---

## 4. 实现要点

0. 在 `ops/db/005_audit_notification_schema.sql` 补加 `ky_audit_log_actor_membership_idx (workspace_type, workspace_id, actor_membership_id)`（幂等）。
1. 新增 `VisibleMembershipIDs(ctx, wsType, wsID, scope) -> []string`：对 `ky_membership`（当前工作区、未删除）应用与 Phase 1.13 一致的 scope 谓词，返回可见 membership id 集合。
2. `ListAuditLogs` 增加可选 `actorMembershipIDs []string` 过滤：
   - 传 nil → 不加过滤（Unrestricted）。
   - 传非空 → 追加 `actor_membership_id IN (...)`。
   - 传空切片（受限但可见集为空）→ 追加恒假谓词（`false`），返回空。
3. handler：解析 caller 范围；Unrestricted → 传 nil；否则取 VisibleMembershipIDs 传入（可能为空）。
4. total 与 items 应用同一过滤。

---

## 5. 验收标准

```text
平台/机构/企业 owner/admin（Unrestricted）-> 审计行为不变（全量/工作区内）
部门/团队负责人 -> 仅见其可见成员产生的审计
无可见成员集 -> 审计空列表，不泄漏
total 与 items 过滤一致
go build / vet / test 四服务通过；复审 NO BLOCKERS
```

---

## 6. 风险与约束

1. 仅审计面扩展；departments/teams/invitations 仍延后 1.13c。
2. 受限 caller 看不到无 actor membership 的系统/公开事件（合理）。
3. 可见成员集materialize为 IN 列表；第一阶段范围可接受（部门子树成员有界）。
4. 性能：现有 `ky_audit_log_workspace_created_idx`（workspace 前缀）承担主过滤；`actor_membership_id` 此前无专用索引，本阶段在 `ops/db/005_audit_notification_schema.sql` 补加 `ky_audit_log_actor_membership_idx (workspace_type, workspace_id, actor_membership_id)`（`CREATE INDEX IF NOT EXISTS`，幂等）以支撑 IN 过滤；IN 列表规模有界（部门子树成员）。
