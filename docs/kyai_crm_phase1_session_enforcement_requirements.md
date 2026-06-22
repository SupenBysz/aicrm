# KyaiCRM Phase 1.14 会话有效性校验实现需求

> 文档状态：已锁定 / Phase 1.14 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.14 / 会话有效性校验（安全硬化）  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.1–1.13c 全部已实现并锁定  

---

## 1. 背景与风险

`ky-auth-service` 的 `me`/`bootstrap` 在验签后会校验 `ky_user_session.status='active'` 且未过期（`IsSessionActive`）。但 `ky-org-service` / `ky-membership-service` / `ky-ai-model-service` 的 `ws()` 中间件、以及 membership 的公开接受邀请，仅校验 token **签名 + 过期**，不校验会话是否仍 active。

风险：用户 logout（会话置 `revoked`）后，其旧 token 在这三个服务上仍可用，直到 token 自然过期；撤销不即时生效。

---

## 2. 目标

让 org / membership / ai-model 三服务在 token 验签后**同步校验会话 active**，使 logout / 撤销会话即时对全部登录后接口生效。

---

## 3. 范围

### 3.1 改动

```text
ky-org-service / ky-membership-service / ky-ai-model-service:
  ws() 中间件：VerifyToken 通过后，按 token.sessionId 校验会话 active；失败 401
ky-membership-service:
  acceptPublicInvitation：同样在验签后校验会话 active
```

### 3.2 不改 / 延后

```text
auth 服务（me/bootstrap 已校验，不变）
公开查询邀请（匿名，不涉及会话）
token 结构、权限/工作区校验逻辑（不变）
跨服务 token introspection 端点（后续可选，本阶段各服务直接读 ky_user_session）
```

---

## 4. 会话校验

每服务 store 新增：

```text
SessionActive(ctx, sessionID, now) (bool, error)
  SELECT status, expires_at FROM ky_user_session WHERE id=$1
  返回 status='active' AND expires_at > now
  无记录 -> false（非错误）
```

中间件顺序（org/membership/ai 的 `ws()`）：

```text
store 就绪 + token secret 就绪
-> Authorization Bearer 解析
-> VerifyToken（签名+过期）
-> SessionActive(payload.SessionId)   ← 新增；false -> 401 unauthorized
-> 工作区 Header / 类型 gating
-> ActiveMembershipID
-> HasAny(requiredPerms)
```

> 顺序：会话校验置于 token 验签之后、工作区/权限之前，使无效会话尽早 401。

membership 公开接受邀请：在 `VerifyToken` 之后、处理前，增加同样的 `SessionActive` 校验；失败 401。

错误：会话失效统一返回 `401 unauthorized`（与未登录同语义，不泄漏会话状态细节）。

---

## 5. 实现要点

1. 三服务各 store 新增 `SessionActive`（读 `ky_user_session`，使用 `ky_user_session` 主键）。
2. 三服务 `ws()` 在 `VerifyToken` 成功后调用 `SessionActive`；error → 500 internal_error；false → 401。
3. membership `acceptPublicInvitation` 同步增加该校验。
4. token payload 已含 `SessionID`（Phase 1.4 签发），无需改 token。

---

## 6. 验收标准

```text
正常登录 token + active 会话 -> 各服务接口可用（不变）
logout 后（会话 revoked）-> org/membership/ai 接口 401；公开接受邀请 401
会话过期（expires_at 过去）-> 401
无该 session 记录 -> 401
auth me/bootstrap 行为不变
go build / vet / test 四服务通过；复审 NO BLOCKERS
```

---

## 7. 风险与约束

1. 每个登录后请求新增一次 `ky_user_session` 主键查询；主键命中，开销可忽略。
2. 各服务直接读 `ky_user_session`（auth 域表），与既有“服务直接读共享表”一致；后续可改为 auth 的 token introspection 端点（登记为后续优化）。
3. 会话失效统一 401，不区分 revoked/expired/不存在，避免信息泄漏。
4. 不改 token 结构与签发流程。
