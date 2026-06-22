# KyaiCRM Phase 1.12 邀请接受安全硬化实现锁定记录

> 文档状态：已锁定 / Phase 1.12 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
services/ky-membership-service/internal/server/invitation_handlers.go（acceptPublicInvitation）
docs/kyai_crm_api_contracts.md §4.2（契约更新）
```

修复 Phase 1.6 登记的安全风险：公开接受邀请此前用请求体 `userId`、无鉴权，可为任意用户伪造 membership。

---

## 2. 硬化后行为

```text
POST /api/v1/public/invitations/:token/accept
Authorization: Bearer <token>   必填
```

- 缺少/无效 Bearer → 401 `unauthorized`。
- token 经 `auth.VerifyToken`（HMAC 签名 + 过期）校验。
- 被接受 `userId` 一律取自 token payload；请求体 `userId` 可选，若与 token 不一致 → 403 `permission_denied`。
- 下游 `UserDisplayName` / `AcceptInvitation` / 审计 actor 均使用 token 派生 userID，不再信任 body。
- nil store / 未配置 token secret → 503 `service_unavailable`。
- 公开查询 `GET /public/invitations/:token` 保持匿名不变。

---

## 3. 契约更新

`docs/kyai_crm_api_contracts.md §4.2` 增补：Bearer 必填、userId 取自 token、body userId 可选且须一致。`§4.1` 不变。

---

## 4. 复审与验证

独立复审 8 项全部 PASS，结论：

```text
NO BLOCKERS
```

验证：

```text
go build / vet / test 四服务通过
新增单测：Bearer 检测（空/Bearer 空 token/Basic/合法）
```

---

## 5. 后续硬化项（已登记，非本阶段）

```text
session-active 级校验（撤销会话即时失效）——当前本服务仅验 token 签名+过期，与 org/membership 既有 ws() 口径一致
前端 invite 接受页（登录后调用 accept）——前端 invite 页本属待实现
```

---

## 6. 结论

公开邀请接受身份伪造风险已消除。第一阶段安全硬化首项完成并锁定。
