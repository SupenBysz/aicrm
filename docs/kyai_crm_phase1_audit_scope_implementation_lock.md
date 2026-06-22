# KyaiCRM Phase 1.13b 审计日志数据范围过滤实现锁定记录

> 文档状态：已锁定 / Phase 1.13b 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
services/ky-membership-service
  internal/store/scope_store.go      VisibleMembershipIDs（复用 ScopeFilter 谓词）
  internal/store/audit_store.go      ListAuditLogs 增加 actorMembershipIDs 过滤
  internal/server/audit_handlers.go  解析 caller 范围并传入
ops/db/005_audit_notification_schema.sql  新增 ky_audit_log_actor_membership_idx（幂等）
```

---

## 2. 行为

- caller 范围按 `ResolveMemberScope` 解析（并集最宽松）。
- `Unrestricted`（平台/机构/企业 owner/admin 持 all/current_*）→ 传 nil，审计行为不变（平台全局 / 工作区内）。
- 受限（部门/团队负责人）→ `VisibleMembershipIDs` 物化可见成员 id 集合，审计仅返回 `actor_membership_id IN (集合)`。
  - 可见集为空 → ListAuditLogs 追加 `false` → 空列表。
  - `actor_membership_id` 为空（公开/系统事件）→ 受限 caller 不可见。
- total 与 items 应用同一过滤（过滤参数在 total 查询前入 args）。

---

## 3. 复审与验证

独立复审重点核验最高风险项——`ListAuditLogs` 占位符编号（base → 各过滤 → actor IN → limit/offset 连续正确）与 total 含 scope 过滤；nil/空/非空三态语义；VisibleMembershipIDs 谓词与 Phase 1.13 一致；平台路径保持 Unrestricted；新增索引幂等且列正确。结论：

```text
NO BLOCKERS
```

附带清理：移除 handler 中不可达的 nil 兜底（`VisibleMembershipIDs` 恒返回非 nil），并加注释说明三态。

验证：

```text
go build / vet / test 四服务通过（-count=1 复跑）
新增单测：审计 IN 占位符编号 / 可见成员空集语义
```

---

## 4. 口径更新

- 完成报告：行级数据范围过滤已生效面 = 成员列表/详情 + 审计日志。
- 仍延后（1.13c）：departments / teams（需将解析器移植到 ky-org-service）/ invitations（实体↔范围映射不清晰）。

---

## 5. 结论

审计日志行级数据范围裁剪已实现并锁定。部门/团队负责人现仅能看到其可见成员产生的审计事件。
