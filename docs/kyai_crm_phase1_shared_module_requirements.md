# KyaiCRM Phase 1.17 跨服务共享模块抽取 实现需求

> 文档状态：已锁定  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.17 / 共享模块抽取（技术债收敛）  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.1–1.16 全部已实现并锁定  

---

## 1. 背景与目标

随着后端特性增加，跨服务复制粘贴的“同源逻辑”累积为已登记技术债。本阶段新建一个共享 Go 模块，把**字节相同、安全/一致性敏感**的三项收敛为单一来源，消除复制漂移风险，并为后续特性提供统一基座。

保守原则：只抽取**字节相同、纯函数或无状态 SQL 包装**；不动各服务的 `ws()` 中间件、Store 结构、路由、handler 业务。各服务对外可见的 Store 方法签名/handler 调用点**保持不变**（用薄包装委托到共享实现），把改动半径压到最小。

---

## 2. 抽取项（本阶段）

经实测盘点确认字节相同、可安全统一：

| 概念 | 现状 | 来源数 | 抽取后单一来源 |
|---|---|---|---|
| Token 签发/校验 | `internal/auth/token.go` 4 份（auth 含 SignToken，3 消费方仅 Verify，三者 Verify 字节相同） | 4 | `shared/auth` |
| 会话有效性校验 | `SessionActive`（org/membership/ai 字节相同）+ auth-service `IsSessionActive`（同逻辑、方法名不同） | 4 | `shared/session` |
| 个人通知写入 | `internal/store/notification_store.go` `CreateUserNotification` membership/org 字节相同 | 2 | `shared/notify` |

### 2.1 显式延后（登记技术债，下一轮抽取）

```text
基础助手 randomSuffix/nullStr/itoa —— 平凡且调用面极广，高 churn 低收益
scope 助手 scope_helpers/scope_store —— org 与 membership 实测不一致（OrgScope vs ScopeFilter 结构不同），需专门统一设计
ws() 中间件 / handler 模式 —— 依赖各服务 Store 与路由，抽取收益低风险高
membership createNotificationTx（事务版、带 scope/recipient）—— membership 专用，不在本轮
auth password.go —— 仅 auth-service 使用，不抽取
```

---

## 3. 共享模块设计

### 3.1 模块

```text
路径：/data/Coolly/shared
module github.com/Kysion/KyaiCRM/shared   （Go 1.25，仅依赖标准库）
go.work 增加 use ./shared
（workspace 模式本地解析，无需 replace、无需网络）
```

> 实现修正（实测）：本仓库始终以 workspace 模式构建，`use ./shared` 已使 `shared` 包可直接 import 并本地解析。**不在各消费 go.mod 写 `require github.com/Kysion/KyaiCRM/shared v0.0.0`**——该合成版本号会触发 go 去 VCS 拉取（`git ls-remote` 失败），而 `use` 单独即可解析。故落地为：仅 `use ./shared`，不加 require。（非 workspace 独立构建不在本项目构建路径内。）

### 3.2 包：`shared/auth`

```go
package auth
type TokenPayload struct { UserID, SessionID string; Exp int64 }
func SignToken(secret string, payload TokenPayload) (string, error)
func VerifyToken(secret, token string) (TokenPayload, error)
// 内部 sign(secret, bodyPart)；与现行 HMAC-SHA256 + base64url 算法/字段完全一致
```

- 算法、字段 tag（`userId/sessionId/exp`）、签名格式与现行完全一致 → 与既有 token 跨服务兼容（不需重新登录）。

### 3.3 包：`shared/session`

```go
package session
// Active 报告会话是否存在、active 且未过期；缺失会话视为非活跃（非错误）。
func Active(ctx context.Context, db *sql.DB, sessionID string, now time.Time) (bool, error)
```

- 等价于现行 `SessionActive`（`SELECT status, expires_at FROM ky_user_session WHERE id=$1`；`status=='active' && expires_at.After(now)`；`sql.ErrNoRows -> false,nil`）。

### 3.4 包：`shared/notify`

```go
package notify
// CreateUserNotification 写入一条个人通知（scope_type='user', recipient_user_id=userID）。
// 自生成 id（ntf_<rand>），自包含、不依赖各服务的 randomSuffix。
func CreateUserNotification(ctx context.Context, db *sql.DB, userID, title, content, notificationType string) error
```

- INSERT 列/值与现行字节一致（`scope_type='user', scope_id=userID, recipient_user_id=userID, status='normal'`）。

---

## 4. 各服务改造（委托，签名不变）

```text
auth 包：
  ky-auth-service/internal/auth/token.go  删除 token 逻辑 -> 引用 shared/auth（password.go 保留）
  其余 3 服务 internal/auth/token.go       删除 -> 引用 shared/auth.VerifyToken/TokenPayload
  调用点（ws()、登录签发）保持调用 auth.VerifyToken / auth.SignToken 不变（改 import 路径或起别名）

session 包：
  org/membership/ai 的 Store.SessionActive 保留方法签名，内部 return session.Active(ctx, s.db, id, now)
  auth-service 的 Store.IsSessionActive 同样保留签名，内部 return session.Active(ctx, s.db, id, now)
  （handler/invitation 调用点不变；四服务统一单一来源）

notify 包：
  membership/org 的 Store.CreateUserNotification 保留方法签名，内部 return notify.CreateUserNotification(ctx, s.db, ...)
  （notifyUsers/notifyMember/notifyOrgMembers 调用点不变）
```

要点：消费服务内部 `auth` 包的同名符号（`auth.VerifyToken` 等）改为来自 `shared/auth`。两种落地任选其一：① 删除本地 token.go，把 import 由 `.../internal/auth` 改为 `shared/auth`；② 保留本地 `internal/auth` 包名作薄转发（`var VerifyToken = sharedauth.VerifyToken`）。**采用 ①**（更彻底、无转发层），仅改 import 路径，符号名不变。

测试迁移：`ky-org-service/internal/auth/token_test.go` 现测试本地 `auth.VerifyToken`，删除本地 token.go 后会失效 → 将该 token 签验往返/互通测试**移入 `shared/auth`**（共享侧单测），删除 org 本地 token_test.go。其余受影响测试（`session_logic_test.go` 测纯决策函数、`notification_clause_test.go` 测可见性子句）不依赖被抽取符号，保持原样。

注：`shared/notify.CreateUserNotification` 签名**不接收预生成 id**，内部自行生成 `ntf_<rand>`（自带 crypto/rand 后缀），与现行 `"ntf_"+randomSuffix()` 等价；调用方（org/membership 的 Store 方法）签名不变。

---

## 5. 验收标准

```text
新建 shared 模块仅依赖标准库；go.work + 各 go.mod require 正确
shared/auth Verify 与现行 token 兼容（同密钥可验签历史 token）
shared/session.Active / shared/notify.CreateUserNotification 行为等价现行
四服务 import 改为 shared/* 后 go build / vet / test 全绿（-count=1）
现有单测（org token_test、membership notify_test、session_logic_test 等）保持通过或等价迁移
shared 模块自带最小单测：token 签验往返、session active 判定、（notify 行为以服务侧覆盖）
对外行为零变化：token 格式、会话判定、通知写入列值不变
```

---

## 6. 风险与约束

1. 多模块 workspace 依赖：必须同时改 `go.work`（use）+ 各 `go.mod`（require v0.0.0），workspace 模式本地解析；遗漏会导致 import 解析失败 —— 以 `go build ./...` 验证。
2. auth-service 的 `SignToken` 移入 shared 后，登录签发与各服务验签必须仍用同算法/同字段 —— shared/auth 一字不改地承接现算法。
3. 不改任何 SQL 语义、不改 token 格式 → 无需数据迁移、无需重新登录。
4. 本轮不碰 scope 助手（结构不一致）与基础助手（高 churn）→ 仍为技术债，已登记。
5. 沙箱无真实 DB：以 build/vet/test + 算法往返单测验证；真实会话/通知路径属外部 runbook。
