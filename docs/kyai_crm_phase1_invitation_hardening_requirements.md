# KyaiCRM Phase 1.12 邀请接受安全硬化需求

> 文档状态：已锁定 / Phase 1.12 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.12 / 安全硬化（邀请接受）  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.1–1.11 全部已实现并锁定  

---

## 1. 背景与风险

Phase 1.6 实现的公开接受邀请接口：

```text
POST /api/v1/public/invitations/:token/accept
body: { "userId": "user_001" }
```

无鉴权，`userId` 由请求体提供。风险：任何知道有效 pending token 的人，可为任意 `userId` 创建工作区 membership（被加入身份伪造）。此为 Phase 1.6 已登记的硬化项。

---

## 2. 目标

将“接受邀请”改为登录态操作：接受人必须已登录，被接受的 `userId` 取自 token，杜绝为他人伪造 membership。公开“查询邀请”预览保持匿名可访问。

---

## 3. 范围

### 3.1 改动接口

```text
GET  /api/v1/public/invitations/:token          保持公开（预览）
POST /api/v1/public/invitations/:token/accept   改为需要 Bearer token
```

### 3.2 不改

```text
邀请创建/列表/取消、其余服务接口
邀请预设角色/部门/团队的应用逻辑（AcceptInvitation 事务不变）
```

---

## 4. 接受邀请新行为

```text
POST /api/v1/public/invitations/:token/accept
Header: Authorization: Bearer <token>
body（可选）: { "userId": "user_001" }
```

要求：

1. 必须携带 `Authorization: Bearer <token>`；缺失或无效返回 401 `unauthorized`。
2. 使用与其他服务一致的 HMAC token 校验（签名 + 过期）。
3. 接受人 `userId` 一律取自 token 的 `userId`。
4. 若 body 提供了 `userId` 且与 token 的 `userId` 不一致，返回 403 `permission_denied`（防止误用/越权）。body 未提供时按 token userId 接受。
5. 其余逻辑不变：校验邀请 pending 且未过期、用户存在、事务内创建/复用 membership 并应用预设角色/部门/团队、置邀请 accepted、写审计（actor=该 userId）。

> 说明：本服务的 token 校验仅验签名+过期（与 org/membership 既有 `ws()` 口径一致）。基于会话撤销的进一步校验由 auth 服务的 me/bootstrap 承担；将 session-active 级校验列为后续硬化（非本阶段阻塞）。

---

## 5. 契约更新

更新 `docs/kyai_crm_api_contracts.md` §4.2：

```text
- 标注接受邀请需要 Authorization: Bearer <token>
- userId 取自 token；body userId 可选且必须与 token 一致
```

公开查询 §4.1 不变。

---

## 6. 验收标准

```text
go build / vet / test 四服务通过
无 token 接受邀请 -> 401
body userId 与 token 不一致 -> 403
有效登录 + 合法 pending token -> 接受成功，membership 归属 token userId
过期/非 pending 邀请 -> gone/conflict（不变）
公开查询邀请仍匿名可用
acceptance.sh 的公开接受相关断言相应调整（带上 token）
```

---

## 7. 风险与约束

1. 契约 §4.2 行为变更（从匿名 userId 到登录态）；前端邀请接受流程需在登录后调用（前端 invite 页本就属待实现，不在本阶段）。
2. session-active 级校验为后续硬化项。
3. acceptance.sh 现有 F 段仅做公开“查询”，未做公开“接受”，无需大改；如后续加“接受”断言须带 token。
