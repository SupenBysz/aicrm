# KyaiCRM Phase 1.14 会话有效性校验实现锁定记录

> 文档状态：已锁定 / Phase 1.14 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
ky-org-service / ky-membership-service / ky-ai-model-service:
  internal/store/session_store.go   新增 SessionActive
  internal/server/server.go         ws() 在验签后校验会话 active（+time 导入）
ky-membership-service:
  internal/server/invitation_handlers.go  acceptPublicInvitation 验签后校验会话 active
```

修复安全风险：logout / 撤销会话后旧 token 在非 auth 服务仍可用直到过期。现撤销即时对全部登录后接口生效。

---

## 2. 行为

每服务 store `SessionActive(sessionID, now)`：

```text
SELECT status, expires_at FROM ky_user_session WHERE id=$1
-> status='active' AND expires_at>now；无记录 -> false（非错误）
```

`ws()` 与公开接受邀请的校验顺序：

```text
store/secret 就绪 -> Bearer 解析 -> VerifyToken（签名+过期）
-> SessionActive(payload.SessionId)   ← 新增；error->500，false->401 unauthorized
-> 工作区 Header/类型 gating -> ActiveMembershipID -> HasAny(requiredPerms)
```

会话失效统一返回 `401 unauthorized`，不区分 revoked/expired/不存在（不泄漏会话状态）。

---

## 3. 复审与验证

独立复审核验：三服务 SessionActive SQL 一致且正确（no-rows→false）；ws() 顺序（验签后、工作区/权限前）；accept 处理前校验；time 导入齐备；`payload.SessionID` 对应 `ky_user_session.id`；各包无符号冲突；nil store 守卫在前。结论：

```text
NO BLOCKERS
```

验证：

```text
go build / vet / test 四服务通过（-count=1）
新增单测：会话 active/revoked/expired/边界(now) 决策语义
```

---

## 4. 口径更新

- 完成报告 backlog 移除“session-active 级 token 校验”（本阶段完成）。
- Phase 1.12 邀请硬化登记的 session-active 后续项一并落地。

---

## 5. 后续 backlog（已登记）

```text
两服务/三服务数据范围与会话校验的共享模块抽取（技术债）
auth token introspection 端点（替代各服务直接读 ky_user_session，后续可选）
事件级通知自动生成、provider 停用级联、AI 密钥轮换、机构/企业级默认模型
前端页面接入、真实云部署/HTTPS/监控、CRM 业务
```

---

## 6. 结论

会话撤销现即时对 org / membership / ai-model 全部登录后接口及公开接受邀请生效，闭合 Phase 1.12 登记的 session-active 硬化项。
