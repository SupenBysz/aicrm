# KyaiCRM Phase 1.16 通知 fan-out 实现锁定记录

> 文档状态：已锁定 / Phase 1.16 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
ky-membership-service:
  internal/store/notification_store.go  新增 UserIDsByRole（持角色成员的去重 user_id）
  internal/server/notify.go             新增 notifyUsers（多接收人 fan-out + 自我抑制）
  internal/server/access_handlers.go    setRolePermissions 成功+审计后 fan-out
ky-org-service:
  internal/store/notification_store.go  新增 CreateUserNotification（最小移植）+ ActiveMemberUserIDs
  internal/server/notify.go             新增 notifyOrgMembers（活跃成员 fan-out + 自我抑制）
  internal/server/agency_handlers.go    updateAgencyStatus 成功+审计后 fan-out
  internal/server/enterprise_handlers.go updateEnterpriseStatus 成功+审计后 fan-out
  internal/server/notify_test.go        notification_type 映射合法性测试
```

补齐多接收人事件通知（fan-out），承接 Phase 1.15 单成员通知。

---

## 2. 行为

```text
role.permissions_updated      -> permission    持有该角色全部成员（≠操作者）
  "您在『<工作区名>』的角色权限已更新"
agency.status_changed         -> organization  机构全部活跃成员（≠操作者）
  "您所属的机构『<机构名>』状态已变更为：<status>"
enterprise.status_changed     -> organization  企业全部活跃成员（≠操作者）
  "您所属的企业『<企业名>』状态已变更为：<status>"
role.status_changed           -> permission    持有该角色全部成员（≠操作者）
  停用："您在『<工作区名>』的角色已被停用，相关权限已收回"
  启用："您在『<工作区名>』的角色已恢复启用，相关权限已生效"
```

> 复审补齐（1.17 审阅环）：权限解析器对角色按 `r.status='normal'` 过滤，故**停用角色会即时收回其全部持有者的权限**，与 `permissions_updated` 同质。为契约一致，`updateRoleStatus` 亦 fan-out 至角色持有者（`permission` 类型、自我抑制、best-effort）。

- 定向：`scope_type='user'`,`scope_id=recipient_user_id=目标用户`，复用 Phase 1.8 可见性。
- best-effort：fan-out 在业务写 + 审计之后；失败忽略、不阻断/回滚响应。
- 自我抑制：目标用户 == 操作者（`wc.UserID`）跳过。
- 逐成员插入（规模有界）；目标集为空即 no-op。
- 工作区/主体名：membership 复用 `WorkspaceName`（回退 wsID）；org 查 `GetAgency/GetEnterprise` 名称（回退 id）。

---

## 3. 复审与验证

独立复审 8 项全过：执行顺序在业务写+审计后且非阻断；两个 helper 均自我抑制；UserIDsByRole / ActiveMemberUserIDs SQL 正确（DISTINCT、deleted_at、status='active'）；CreateUserNotification 列/值与 CHECK 合法（user / organization / permission）；机构/企业 handler 传 workspace_type/workspace_id 与成员键一致；无占位符/nil 问题；空集 no-op；与 Phase 1.15 一致。结论：

```text
NO BLOCKERS
```

验证：

```text
go build / vet / test 通过（ky-membership-service、ky-org-service，-count=1）
新增单测：org notification_type 映射合法性
```

---

## 4. 决策落地

- 决策 A：事件集合 = role.permissions_updated + organization.status_changed；invitation 延后。
- 决策 B：org-service 直接写 `ky_notification`（最小移植），通知逻辑跨服务重复登记为技术债。
- 决策 C：fan-out 目标 = 受影响范围活跃成员；best-effort、自我抑制、逐成员插入。

---

## 5. 后续 backlog（已登记）

```text
invitation 通知（被邀请人无账号，无法定向 userId）
通知逻辑跨服务共享模块抽取（与数据范围/会话校验同一技术债）
通知 fan-out 批量/异步化（当前逐条插入，规模有界）
specified_agency/enterprise 平台跨主体数据面
auth token introspection 端点
provider 停用级联、AI 密钥轮换、机构/企业级默认模型
前端页面接入、真实云部署/HTTPS/监控、CRM 业务
```

---

## 6. 结论

角色权限变更现通知该角色全部成员；平台变更机构/企业状态现通知该主体全部活跃成员。事件级通知在单成员（1.15）之上完成多接收人 fan-out。invitation 通知仍延后。
