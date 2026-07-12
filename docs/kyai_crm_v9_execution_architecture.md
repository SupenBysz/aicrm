# AiCRM Matrix Account v9.1 执行架构

> 文档状态：已锁定 / Post-Phase1 v9.1 执行架构
> 锁定日期：2026-07-12
> 适用范围：矩阵账号新增账号、可信桌面运行时、Session Vault、AI 脚本维护、Codex 执行器、协助授权、模型目录和灰度发布
> 不改变范围：Phase 1 用户、组织、成员、权限和 API Provider 模型基线

## 1. 文档定位与覆盖顺序

本文档把已经锁定的 Matrix Account v9 业务、执行器和可信桌面合同收敛为唯一实施架构。三份详细合同按领域分别拥有权威，不形成彼此覆盖的全局优先级：

1. `docs/matrix_account_ai_onboarding_contract.md` 是新增账号业务动作、LoginAttempt、Vault 快照、恢复和清理的真相源。
2. `docs/kyai_crm_matrix_account_requirements.md` 是矩阵账号、脚本、契约、generation run、权限和页面要求的真相源。
3. `docs/kyai_crm_ai_executor_authorization_requirements.md` 是 Codex 执行器、模型、授权、执行器绑定设备、任务和传输要求的真相源。
4. 本文档只锁定上述领域如何落到 Host、Core、Plugin、Desktop、Services、Ops 和发布流程；交叉范围发生冲突时必须共同修订相关详细合同，不能由本文或任意一份合同单方面覆盖另一领域。
5. `docs/kyai_crm_architecture.md`、`docs/kyai_crm_api_contracts.md` 和 `docs/kyai_crm_permission_matrix.md` 的 Phase 1 内容继续保留；v9.1 范围由本扩展及后续追加章节覆盖，不回写 Phase 1 历史结论。

`docs/kyai_crm_matrix_account_ai_login_script_execution_plan.md` 保留为 v8 历史执行计划。其 `codex --remote`、PTY、TUI、WebSocket、第二套 executor run 表和 API 模型兜底描述不得用于 v9.1 实现。

## 2. 不可变架构决策

- 仓库继续使用 monorepo；Matrix Service、Agent Executor、Desktop、Host、Core 和 Plugins 不拆仓。
- LoginAttempt 是新增账号唯一业务真相，Desktop 只保存可恢复的原生运行投影。
- `ky-agent-executor-service` 是执行器、执行器绑定设备信任、授权、凭据、模型目录、readiness 和 executor task 的领域所有者。
- `ky-matrix-account-service` 是矩阵账号、LoginAttempt、脚本、版本、contract、generation run、candidate、激活和绑定事务的领域所有者。
- `ky-ai-model-service` 只保留 API Provider、API 模型和兼容期 `legacy_provider`。
- 服务不得穿透其他服务私表，不建立跨服务外键；跨服务 ID 只作为 opaque reference。
- `runId = matrix generation run.id = executor task.id`，但 Matrix generation run 是业务资源，executor task/event/raw-log 是唯一物理执行存储。
- Codex 只使用 App Server stdio 结构化协议，不启动 remote TUI、PTY 或 WebSocket。
- 新链路在全部验收完成前 fail-closed；Host、Plugin 和 Desktop 不能通过本地布尔值打开生产门禁。

## 3. 模块职责

| 模块 | 负责 | 禁止 |
| --- | --- | --- |
| `plugins/ky-matrix-account` | 页面、业务 action、只读 store、业务化错误展示 | 直接访问 `window.aicrm`、持有凭据、推进服务端状态机 |
| `plugins/ky-ai-configuration` | 执行器配置、授权会话、模型目录和安全任务投影 UI | 发送路径、授权状态或原始 Codex 输出 |
| `apps/ky-admin-host` | request client、SSE、Desktop adapter、Port 注入、非 Desktop 降级 | 实现 Matrix 领域状态机、直接管理 Partition/Vault |
| `packages/ky-admin-core` | 稳定插件、请求、权限和 Desktop Port 类型 | 读取 `window.aicrm`、放置插件私有业务实现 |
| `apps/aicrm-desktop` | BrowserWindow、Partition、受限方法执行、Vault、设备私钥、原生 operation journal、App Server 生命周期 | 维护角色、权限、workspace 策略、Attempt phase、绑定决策和 nextActions |
| `ky-matrix-account-service` | Attempt、账号绑定、脚本、contract、generation run、onboarding operation/proof ledger、receipt、outbox、rollout | 读取 executor、membership 或 org 私表 |
| `ky-agent-executor-service` | executor、grant、授权、executor-bound device、credential、catalog、readiness、task/event/raw-log | 读取 Matrix 私表、决定账号绑定或 Attempt 状态 |
| `ky-membership-service` | workspace 身份、权限和数据范围决策 | 直接写 Matrix/Executor 业务表 |
| `ky-org-service` | owner/department/team 引用和组织范围校验 | 直接写 Matrix 账号或 Attempt |
| `shared/` | envelope、请求哈希、签名、脱敏、outbox 等通用工具 | 业务状态机、领域 Store 和跨服务 repository |
| `ops/` | migration、DB role/GRANT、systemd、Nginx、env、发布和验收脚本 | 在部署脚本中绕过服务合同修改业务数据 |

## 4. 运行拓扑

```text
Matrix Account 页面 / Drawer
        │ 业务 Command / Attempt SSE
        ▼
MatrixAccountOnboardingController + Store
        │ 注入的 MatrixAccountDesktopPort
        ▼
Host desktop-client adapter
        ▼
preload 白名单桥
        ▼
MatrixAccountNativeRuntime (Electron main)
  Browser/Partition、方法执行、观察器、Vault、设备签名、operation journal
        │ 设备签名 PoP 结果
        ▼
ky-matrix-account-service
  Attempt/receipt/binding/script/generation-run
        │ internal API / NATS 安全引用
        ▼
ky-agent-executor-service
  device/auth/credential/catalog/readiness/task
        ▼ stdio JSON-RPC
Codex App Server
```

页面发起业务 Command 后，Matrix Service 创建业务操作并签发绑定 operation、device、runtime、purpose、revision 和 expiry 的 Desktop command ticket。Host 只负责把 ticket 交给 Desktop Port。Main 验签后执行原生动作，并直接向可信 Desktop PoP API 提交设备签名结果；Renderer 不转发 proof、receipt 或敏感上下文。Matrix Service 事务推进 Attempt 后通过持久 SSE 更新页面。

已激活 DSL 的实际登录执行只经过 Matrix Service 与 Desktop NativeRuntime，不依赖 Agent Executor 在线。Agent Executor 只参与脚本生成、修复、契约测试、执行器授权和模型维护。

## 5. 服务数据所有权

### 5.1 Matrix Service

Matrix Service 独占：

```text
ky_matrix_account*
ky_matrix_account_login_attempt*
ky_matrix_account_login_method_run
ky_matrix_account_login_script*
ky_matrix_account_session_snapshot
ky_matrix_account_trusted_runtime_operation
ky_matrix_account_trusted_receipt
ky_matrix_account_outbox
```

`trusted_runtime_operation` 同时保存 onboarding command/claim 的一次性消费、设备签名 sequence/nonce 与请求哈希账本。Matrix 直接验证该领域的 Desktop proof，不调用 Agent Executor，也不复用 executor authorization 的 device proof 端点；因此已激活 DSL 的登录执行不依赖 Agent Executor 在线。

### 5.2 Agent Executor

Agent Executor 独占：

```text
ky_ai_executor_config
ky_ai_executor_authorization_*
ky_ai_executor_credential_*
ky_ai_executor_device*
ky_ai_executor_model_catalog*
ky_ai_executor_workspace_grant
ky_ai_executor_operation_lease
ky_ai_executor_task*
ky_ai_executor_outbox
```

必须提供 table-owner manifest、独立数据库角色和表级 GRANT 验收。Matrix 不能读写 `ky_ai_executor_*`；Agent Executor 不能读写 `ky_matrix_*`。Matrix 保存 executor/task ID 时不建立数据库外键。

以上是目标态而非当前完成态：现有 migration `031` 等仍包含 Matrix 指向 Membership/Org 的外键和直接查询。P1 必须先迁移为 opaque reference 与受控 internal access/reference decision API、完成回填和约束切换，之后才能启用独立 DB role/GRANT；在此之前生产门禁保持关闭。

### 5.3 跨服务决策

- Matrix 通过 Membership internal access-decision API 获取当前 actor、workspace、required permissions 和数据范围安全投影。
- Matrix 通过 Org internal reference-validation API 验证 owner、department 和 team。
- Matrix 通过锁定的 executor internal API resolve binding、创建/查询/取消 task，不读取 executor task 表。
- 内部 API 只允许 loopback/受控内网，并校验 `X-KY-Internal-Token` 和 `X-KY-Request-Id`。

## 6. LoginAttempt 唯一状态机

顶层状态固定为：

```text
active | completed | failed | cancelled | expired
```

正常阶段：

```text
created → opening → qr_preparing → qr_ready → waiting_scan
→ authenticating → authenticated → identifying → awaiting_confirmation
→ snapshot_sealing → committing → ready
```

交互阶段：

```text
verification_required | risk_controlled | qr_expired
```

终止流程：

```text
用户取消：cancelling → cleanup_pending → cancelled
到期：cleanup_pending(terminationReason=expired) → expired
不可恢复失败：cleanup_pending(terminationReason=failed) → failed
```

`status=completed` 时 `phase=ready`。清理完成前不得进入 `cancelled`、`expired` 或 `failed`。不增加含糊的 `expiring` phase。

AI 修复时保留原 phase，设置 `activity=repairing_adapter` 和 `blockedMethod`；candidate 测试、激活成功后 `attemptNo + 1` 并重跑原 `currentStep`。同一业务执行链最多自动修复一次，失败后进入明确用户兜底，不递归生成。

## 7. 绑定决策

- 登录完成后自动执行 `account.identity.get.v1` 和 `account.profile.get.v1`。
- `create_new` 且归属完整、无重复账号、无设备 Session 冲突时，业务用例自动提交 `business.binding.confirm.v1`。
- `attach_existing`、`replace_device_session`、归属不完整或存在冲突时，页面展示候选及影响范围并要求显式确认。
- 自动和人工确认都必须走同一业务方法和同一绑定事务，不允许旁路。
- `replace_device_session` 必须携带 `replaceSessionId` 与 `expectedSessionRevision`。

## 8. 公共、可信 Desktop 与内部 API

### 8.1 用户 Bearer API

```text
POST /api/v1/matrix-account-login-attempts
GET  /api/v1/matrix-account-login-attempts/{attemptId}
GET  /api/v1/matrix-account-login-attempts/{attemptId}/events
GET  /api/v1/matrix-account-login-attempts/{attemptId}/events-stream
POST /api/v1/matrix-account-login-attempts/{attemptId}/commands/refresh-qr
POST /api/v1/matrix-account-login-attempts/{attemptId}/commands/retry
POST /api/v1/matrix-account-login-attempts/{attemptId}/commands/cancel
POST /api/v1/matrix-account-login-attempts/{attemptId}/commands/open-window
POST /api/v1/matrix-account-login-attempts/{attemptId}/commands/resume
POST /api/v1/matrix-account-login-attempts/{attemptId}/binding-confirmations
POST /api/v1/matrix-accounts/{accountId}/capability-runs
```

`subscribeAccountOnboarding` 映射为 Attempt snapshot + history + `events-stream` 持久 SSE；断线后按 sequence 续订。`executeAccountCapability` 映射为 `capability-runs` 资源，body 至少绑定版本化 `methodId`、input、expected account/session revision 和幂等键；具体 capability 输入输出 schema 必须在对应平台方法合同中锁定后才可启用。

不存在公共 `complete` API。Snapshot proof 验证后，由 Matrix 内部编排器消费服务端 receipt 并完成原子绑定。

### 8.2 可信 Desktop PoP API

```text
POST /api/v1/matrix-account-login-attempts/{attemptId}/runtime-step-results
POST /api/v1/matrix-account-login-attempts/{attemptId}/snapshot-proofs
POST /api/v1/matrix-account-login-attempts/{attemptId}/cleanup-proofs
```

这些端点使用 Desktop command/claim token 与设备签名，不接受 Renderer 上报的 `verified`、workspace 覆盖、路径、Cookie、Storage 或原始凭据。Workspace、Attempt 和 actor 从服务端 operation 派生。

### 8.3 Executor internal API

```text
POST /internal/v1/executor-bindings/resolve
POST /internal/v1/executor-tasks
GET  /internal/v1/executor-tasks/{taskId}
GET  /internal/v1/executor-tasks/{taskId}/result
POST /internal/v1/executor-tasks/{taskId}/cancel
```

### 8.4 Envelope、cursor 与幂等

所有普通 HTTP 成功响应，包括 201/202 和 PoP API，使用：

```json
{"data":{},"requestId":"req_xxx"}
```

普通资源列表使用 `page/pageSize/total`。事件和终端历史使用 `after` 与 `{items,nextSequence,hasMore}`。SSE 使用 `Last-Event-ID` 优先于 `after`，每个持久事件有唯一 sequence。

用户 Command 强制 `Idempotency-Key`；相同 scope/key/request hash 返回原结果，不同 hash 返回 409 `idempotency_key_reused`。Desktop PoP 使用 device sequence/nonce ledger，不使用用户幂等键。

## 9. Desktop Port 与事件

`packages/ky-admin-core` 只定义 `MatrixAccountDesktopPort` 类型。`apps/ky-admin-host/src/desktop-client.ts` 实现 `window.aicrm` 到 Port 的适配并注入 Plugin。Plugin 不能直接读取 bridge。

通信类型固定为：

| 类型 | 用途 |
| --- | --- |
| Command | open、resume、execute method、start/stop observer、seal、restore、cleanup |
| Query | capabilities、runtime snapshot、QR snapshot、operation snapshot |
| Native Event | native operation progress/finished、method observation changed |
| Web Event | LoginAttempt SSE、账号 ready 和页面派生状态 |

Native Event 使用 versioned envelope，至少含 `runtimeSessionId`、`runtimeEpoch`、`nativeSequence`、`operationId` 和 opaque `scopeHash`。不得包含业务 nextActions、binding decision、二维码 data URL、DOM、截图、receipt 或凭据。

非持久 Native Event 使用：先订阅并缓冲，读取带 `nativeSequence` 的 snapshot，再按 sequence 排空缓存；gap、缓存溢出或 runtime epoch 变化时重读 snapshot。服务端持久事件先读 Attempt snapshot，再从其 sequence 继续 history/SSE。

二维码 data URL 只通过 `getQrSnapshot` Query 返回并只存在 Renderer 展示内存。Main 的 operation journal 不保存二维码原文、DOM、截图、receipt、Cookie 或 Storage。

## 10. Device proof、receipt 与 Vault

- Desktop 首次安装生成 Ed25519 设备密钥，私钥进入 OS credential store。
- Agent Executor 只拥有 executor authorization/task 域的设备绑定、公钥和 proof ledger；该绑定不能给 Matrix onboarding 操作越权。
- Matrix 拥有 onboarding 域的设备登记投影、key generation、sequence/nonce/request ledger，并在 `trusted_runtime_operation` 事务内直接验签。两个领域可以引用同一物理设备 ID，但 registration challenge、audience、purpose、operation 和 replay ledger 必须隔离，任一领域的 ticket/proof 不能在另一领域消费。
- P2B 必须在 Matrix 详细合同中锁定 user Bearer registration challenge、Desktop proof-of-possession、rekey/revoke 和请求签名向量；合同及测试完成前 `supportsServerVerifiableSnapshotReceipts=false`，不得签发生产 receipt。
- Matrix 验证 onboarding proof 后创建服务端 `trusted_receipt` 资源。Receipt 绑定 Attempt、WebSpace、device、snapshot、content hash、fingerprint hash、purpose、expiry 和消费状态。
- Renderer、Plugin、Native Event 和普通日志不接触 receipt bearer 或原始 proof。
- Snapshot receipt 只能在最终绑定事务消费一次；cleanup receipt 只能在物理清理后的终止事务消费一次。
- Vault 加密主密钥、Desktop 设备签名密钥和 operation journal 完整性密钥必须分离。
- 恢复进入新 Partition，不覆盖来源；校验失败不得删除来源或现有可用空间。

## 11. 脚本和 AI 维护

Automation 依次使用：

```text
login.open.v1
login.qr.get.v1
login.qr.refresh.v1
login.status.probe.v1
account.identity.get.v1
account.profile.get.v1
```

Automation 禁止使用客户端内置平台二维码或账号启发式识别。普通 DSL 全面禁止 Cookie、Storage、IndexedDB、Token、密码和验证码读取。

ElementKey 优先级固定为：

```text
平台语义属性
→ role + accessible name + landmark
→ 通过随机性过滤的 id/name
→ 稳定容器 key + 规范化文本
→ 结构选择器
→ 坐标（仅候选验证，禁止自动激活）
```

AI prompt、候选 DSL 与自动修复必须先尝试 `clickElementKey`、`waitForElementKey`、`captureElementKey`、`readElementKey`；退回 selector、text 或 coordinate 时必须记录 fallback reason 与稳定性等级。二维码、刷新、登录态和账号身份等关键方法若只依赖 low-stability selector/coordinate，不得自动激活。

AI 维护闭环固定为：

```text
active 方法失败
→ Attempt repairing_adapter
→ Matrix generation run + dispatch outbox
→ 同 ID executor task
→ Codex 生成受限 DSL candidate
→ 静态安全验证
→ 隔离 contract test
→ revision CAS 激活
→ attemptNo + 1
→ 原 Attempt 续跑
```

Generate/repair 只能创建 candidate；contract test 只能写测试记录；未测试、旧 contract revision 或关键方法仅依赖 low stability 的 candidate 不能 active。

## 12. 执行器和模型解析

```text
script.executor_id
  → platform default Codex executor
  → 校验 workspace grant
  → 无可用执行器则阻断

script.model_key_override
  → executor.default_model_key
  → 无可用模型则阻断
```

禁止回退到 `ky_ai_model` 默认多模态/对话模型、其他执行器模型、环境或用户 Codex 默认模型。任务创建时冻结 executor config、credential binding、runtime binding、catalog 和 effective model revision。

`scriptMaintenanceReady` 只由 Agent Executor 按 `docs/kyai_crm_ai_executor_authorization_requirements.md` §20.4 的完整判定式实时计算；本架构摘要不复制或缩减该公式。自动修复还必须满足该节的 `autoRepairEnabled=true`，Desktop task transport 未验收前强制 false。

## 13. 权限和数据范围

组合权限必须使用 AND：

```text
generation create = view AND regenerate
修改 executor = update AND assign_executor
修改 model = update AND assign_model
同时修改 = update AND assign_executor AND assign_model
```

Matrix Account 数据范围在 Matrix store/query 层统一应用：`all/current_*`、`self`、department/tree、team、custom。列表 items 和 total 使用同一 predicate；详情、Session 和 WebSpace 越权统一返回 404，防止 ID 探测。

Executor 公共管理 API 仅属于 platform workspace。Agency/enterprise 只能通过 Matrix API 读取 grant 允许的执行器名称、runtime、readiness 和脚本维护能力安全投影。敏感调试权限不授予任何默认角色。

## 14. NATS、outbox 与恢复

数据库是事实源，NATS 只传递 at-least-once 安全引用。Executor 终态 subject 固定为：

```text
aicrm.executor.task.terminal.v1
```

Payload 固定只含 `eventId`、`taskId`、`workspaceType`、`workspaceId`、`status` 和 `occurredAt`；因 `taskId == runId` 不再发送第二个 run 字段，也不携带结果正文或可解析路径。Matrix 按 eventId/taskId 幂等消费，再以 taskId 调用 internal result API；成功物化 candidate/test 后才 ACK。NATS 丢失由 Matrix reconciler 按 taskId 补查。

## 15. Migration 与单写者切换

从 migration `034` 起引入 migration ledger、checksum 和数据库 advisory lock；`001–033` 只在验证现有 schema 后登记 baseline。迁移固定为：

```text
expand → backfill → constraint → cutover → contract
```

必须验证 fresh DB、现网快照升级和旧二进制运行于新 schema。

Executor 领域切换固定为：

```text
ky-ai-model-service 唯一写者
→ ky-agent-executor-service shadow read
→ freeze/drain
→ 记录 cutover epoch
→ 撤旧 DB 写权限
→ 授新 DB 写权限
→ 切 Nginx/feature flag
→ 验证
```

首次 Agent Executor 成功写入前允许恢复旧写者；首次新写入后禁止恢复旧写权限，只允许新服务 forward-fix 或兼容代理，禁止 dual-write。

## 16. Feature flag、兼容与灰度

- Matrix Service 拥有 onboarding flow、generation 和 auto-repair 的 workspace/device rollout；创建 Attempt 时冻结 `flowVersion`。
- Agent Executor readiness 是能力事实；Host/Desktop 只能展示服务端投影。
- 服务端返回单一 onboarding availability 和必要 contract revisions，不再由前端拼四个布尔值开启半链路。
- 非 Desktop 为 `unsupported_web`；旧 Bridge 为 `incompatible_desktop`；缺设备信任为 `device_untrusted`。
- 已切换为 `codex_executor` 的脚本 fail-closed，不回退 legacy provider。
- 兼容入口最多保留一个平台发布版本，下一版本统一返回 410 `legacy_endpoint_gone` 或删除只读别名。

灰度顺序固定为：

```text
内部 workspace
→ 指定白名单
→ 1% → 5% → 25% → 50% → 100%
```

关闭门禁只阻止新建 v9 Attempt；存量 Attempt 必须继续完成或可信清理。Receipt、cleanup、outbox 和 reconciler 不得随业务回滚停机。

## 17. 实施阶段和硬门禁

```text
P0 合同覆盖与安全止血
P1 Additive schema、DB role、新服务骨架和 shadow read
P2A Agent Executor 授权、设备、凭据、模型和 readiness
P2B NativeRuntime、Attempt、receipt、绑定、清理和恢复
P3 固定抖音脚本完成可信业务闭环
P4 generation run、candidate、contract test、activation 和 Attempt resume
P5 PostgreSQL、Electron、安全、混沌和真实抖音验收
P6 workspace/device 灰度到 100%
P7 下一平台版本移除 legacy API、Bridge 和权限别名
```

- P0 未通过，不进入新 schema 和服务实现。
- P1 未通过，新服务不得写生产数据。
- P2A 未通过，执行器不得进入脚本 eligible 列表。
- P2B/P3 未通过，不打开新增账号 v9 生产门禁。
- P4 未通过，不得宣称 AI 正在维护脚本。
- P5 未通过，不开始生产灰度。
- P6 未完成，不移除 legacy。

## 18. 验收基线

- Skill：`python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/aicrm-solution`
- 文档与补丁：`git diff --check`
- 前端：`pnpm typecheck && pnpm build`
- 后端：所有 Go 服务 `go test ./...`
- 数据库：真实 PostgreSQL migration、幂等、权限、并发、过期、receipt 和事务故障测试。
- Desktop：Bridge、Native Event、operation journal、Vault、恢复、双实例和 Electron 假平台 E2E。
- Executor：授权、设备重放、credential revision、lease/fencing、catalog/readiness、取消和崩溃恢复。
- 安全：DB、日志、审计、SSE、Nginx、缓存和诊断包敏感 canary 零命中。
- 真实抖音：二维码、刷新、扫码、验证/风控、身份、快照、绑定、清理、恢复和 AI 修复。

只有上述门禁全部满足后，生产 onboarding availability 才允许返回 v9 automation。
