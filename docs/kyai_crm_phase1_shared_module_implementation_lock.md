# KyaiCRM Phase 1.17 跨服务共享模块抽取 实现锁定记录

> 文档状态：已锁定 / Phase 1.17 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

新建共享 Go 模块，把三项字节相同、安全/一致性敏感的逻辑收敛为单一来源：

```text
新增 shared 模块（module github.com/Kysion/KyaiCRM/shared，Go 1.25，仅标准库）
  shared/auth/token.go       TokenPayload / SignToken / VerifyToken / sign（+ token_test.go）
  shared/session/session.go  Active(ctx, *sql.DB, sessionID, now)
  shared/notify/notify.go    CreateUserNotification(ctx, *sql.DB, ...)（自生成 ntf_<rand>）
  go.work 增加 use ./shared

ky-auth-service：
  internal/auth/token.go 删除；password.go 保留（HashPassword/VerifyPassword）
  server.go 以别名 sharedauth 用 SignToken/VerifyToken/TokenPayload；本地 auth 仅 password
  store/auth_store.go IsSessionActive 委托 sessionpkg.Active（移除 database/sql 引用）

ky-org / ky-membership / ky-ai：
  删除本地 internal/auth 包；import 改 shared/auth（包名仍 auth，调用点不变）
  store SessionActive 委托 session.Active（移除 database/sql、errors 引用）

ky-org / ky-membership：
  store CreateUserNotification 委托 notify.CreateUserNotification
  membership createNotificationTx（事务版）保持不动
```

---

## 2. 行为与兼容

- token 算法/字段（HMAC-SHA256 + base64url，`userId/sessionId/exp`，过期判定）一字不改 → 历史 token 跨服务继续验签，无需重新登录。
- session 判定（`SELECT status, expires_at FROM ky_user_session WHERE id=$1`，`status='active' && expires_at.After(now)`，缺失→false）等价不变。
- 通知写入列/值（`scope_type='user', scope_id=recipient_user_id=userID, status='normal'`）等价；id 由 shared 内部生成。
- 各服务对外 Store 方法签名、handler 调用点全部不变（薄委托）。

---

## 3. 关键实现修正（实测）

```text
workspace 依赖解析：本仓库始终 workspace 构建，go.work `use ./shared` 即可本地 import 解析。
不在各消费 go.mod 写 require github.com/Kysion/KyaiCRM/shared v0.0.0 ——
该合成版本号会触发 go 走 VCS 拉取（git ls-remote 失败 / GOPROXY=off 报 module lookup disabled），
而 use 单独即可解析。故落地：仅 use ./shared，不加 require。
```

auth-service 同时使用本地 `auth`（password）与共享 token，存在包名冲突 → 共享侧以 `sharedauth` 别名导入；auth_store 的 session 包以 `sessionpkg` 别名（避开 CreateSession 的 `session` 形参遮蔽）。

---

## 4. 复审与验证

独立复审 10 项全过：shared 三包结构/算法字节等价；go.work use；三消费服务删除本地 auth、调用点不变；auth-service 别名落地且无残留旧符号；四服务 session 委托且无未用 import；org/membership 通知委托、tx 版与 randomSuffix/nullStr 不受影响；org token_test 迁入 shared/auth；go.mod 无 shared require（use-only）；无死代码/孤儿函数；单一来源达成。结论：

```text
NO BLOCKERS
```

验证：

```text
shared + 四服务 go build / vet / test 全绿（-count=1）
shared/auth 新增 5 项单测（签验往返/过期/错签/缺密钥/格式错）
gofmt 干净（本阶段改动文件）
```

---

## 5. 收敛效果与后续 backlog

收敛：token（4 处→1）、session（4 处→1）、个人通知写入（2 处→1）。

```text
仍为技术债（已登记，下一轮）：
  基础助手 randomSuffix/nullStr/itoa（平凡、高 churn）
  scope 助手（org OrgScope vs membership ScopeFilter 结构不一致，需统一设计）
  ws() 中间件 / handler 模式（依赖各服务 Store/路由）
其余 backlog：invitation 通知、auth token introspection、平台跨主体数据面、
  AI 停用级联/密钥轮换/机构企业级默认模型、前端接入、真实云部署、CRM 业务
```

---

## 6. 结论

token 签发/校验、会话有效性、个人通知写入现各有唯一来源（`shared/*`），各服务以薄委托接入；行为零变化、编译/单测/复审全绿。复制漂移风险消除，后续特性可直接复用共享基座。
