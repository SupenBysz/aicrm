# KyaiCRM Phase 1.15 事件级通知自动生成实现锁定记录

> 文档状态：已锁定 / Phase 1.15 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
ky-membership-service:
  internal/store/notification_store.go  新增 CreateUserNotification + MembershipUserID
  internal/server/notify.go             notifyMember 助手 + renderContent({ws})
  internal/server/member_handlers.go    status/remove/dept/team 事件后生成通知
  internal/server/access_handlers.go    roles_assigned 事件后生成通知
```

让通知/未读数承载真实业务事件（此前仅来自公告桥接）。

---

## 2. 行为

5 个单成员事件成功 + 审计后，给“受影响成员所属用户”生成 1 条个人通知：

```text
member.status_changed        -> security      "您在『{ws}』的成员状态已变更为：<status>"
member.removed               -> organization  "您已被移出『{ws}』"
member.departments_assigned  -> organization  "您在『{ws}』的部门归属已更新"
member.teams_assigned        -> organization  "您在『{ws}』的团队归属已更新"
membership.roles_assigned    -> permission    "您在『{ws}』的角色已更新"
```

- 定向：`scope_type='user'`,`scope_id=recipient_user_id=受影响用户`，复用 Phase 1.8 可见性（`recipient_user_id=我`）→ 任意工作区可见、计入未读数。
- best-effort：通知失败不阻断业务、不回滚（与审计一致）。
- 自我抑制：受影响用户 == 操作者（`wc.UserID`）时跳过。
- `MembershipUserID` 不过滤 `deleted_at`，使 `member.removed`（软删除）后仍能定位接收人。

---

## 3. 复审与验证

独立复审 9 项全过：CreateUserNotification 列/值匹配与 CHECK 合法；MembershipUserID 软删除处理（remove 后仍可定位）；notifyMember best-effort/自我抑制/工作区名回退/{ws} 渲染；执行顺序在业务写+审计后且不阻断响应；notification_type 映射合法；可见性无需改读路径。结论：

```text
NO BLOCKERS
```

验证：

```text
go build / vet / test 四服务通过（-count=1）
新增单测：renderContent / notification_type 映射合法性 / 模板含 {ws}
```

---

## 4. 口径更新

- 完成报告 backlog 移除“事件级通知自动生成（非公告）”（本阶段就单成员事件落地）。
- 仍延后：role.permissions_updated 的角色成员 fan-out、organization.status_changed、invitation 通知。

---

## 5. 后续 backlog（已登记）

```text
role.permissions_updated 角色成员 fan-out 通知 / organization.status_changed 通知 / invitation 通知
数据范围/会话校验跨服务共享模块抽取（技术债）
specified_agency/enterprise 平台跨主体数据面
auth token introspection 端点
provider 停用级联、AI 密钥轮换、机构/企业级默认模型
前端页面接入、真实云部署/HTTPS/监控、CRM 业务
```

---

## 6. 结论

成员被禁用/移除/调部门/调团队/授权角色时，受影响成员现会收到对应类型的个人通知，未读数即时反映。通知不再仅来自公告。
