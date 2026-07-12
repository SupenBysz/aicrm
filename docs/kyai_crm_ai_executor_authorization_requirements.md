# AiCRM AI 执行器、模型绑定与 Codex 协助授权需求

> 文档状态：已锁定 / Matrix Account v9 实现输入基线
> 锁定日期：2026-07-10
> 适用范围：AI 执行器配置、Codex 授权、执行器模型目录、矩阵账号登录脚本 AI 维护、AiCRM Desktop、后台插件、执行代理服务、数据库、部署与审计
> 规范依据：`template/skills/aicrm-solution/SKILL.md` 及模块边界、权限与数据范围、API、Desktop 事件通信规范

## 1. 文档定位与覆盖关系

Phase 1 总体架构、技术选型、API 契约和实施计划明确排除了 AI 执行器。该历史基线不得被倒写为“Phase 1 已包含执行器”。

本需求属于 Post-Phase1 的 Matrix Account v9 扩展：

1. 替代矩阵账号 v4 中“脚本模型 -> 场景模型 -> 系统默认多模态 -> 系统默认对话模型”的模型兜底规则。
2. 完善矩阵账号 v8 中执行代理、Codex App Server、脚本维护和运行流归属。
3. 旧 `model_id`、旧脚本版本和已激活 DSL 保持历史语义，不回写、不重解释、不阻断执行。
4. 新生成、再生成、自动修复和契约测试逐步切换到本需求定义的 Codex 执行器链路。
5. 业务 LoginAttempt、版本化登录方法、Session snapshot/Vault、恢复和清理的真相源仍是 `docs/matrix_account_ai_onboarding_contract.md`；本需求只决定 AI 维护任务由哪个执行器/模型运行，不绕过该文档的可信桌面与上线门禁。

## 2. 业务目标和范围

本阶段必须形成以下闭环：

- 后台 AI 执行器可以配置 Codex 默认模型。
- 登录脚本可以指定维护执行器，并可配置脚本级模型覆盖。
- 脚本未配置模型时继承执行器默认模型。
- 脚本未配置执行器时只解析平台全局默认 Codex 执行器，并验证其对当前 workspace 的 grant 和可用性；不得从 grant 中任挑其他执行器。
- 客户端执行器通过本地浏览器完成 Codex 协助授权。
- 服务端执行器通过设备码模式透传官方 URL 和关联验证码，并自动监听结果。
- 授权会话、凭据状态、运行健康和模型可用性独立表达和恢复。
- 每个执行器使用独立凭据空间，不串用用户全局或其他执行器凭据。
- 脚本只能选择真实具备任务消费能力的执行器。

本期只支持：

```text
executorType = codex
runtimeType  = desktop | server
```

`remote` 暂不支持协助授权和脚本维护，必须 fail-closed。

## 3. 服务和模块职责

### 3.1 ky-agent-executor-service

新增 `ky-agent-executor-service`，拥有：

- AI 执行器配置、默认执行器、workspace 发布范围。
- Codex App Server 生命周期和协议适配。
- 授权会话、设备绑定、凭据修订和授权状态。
- Readiness、Codex 模型目录和执行器默认模型。
- 执行器任务、租约、运行事件、终端帧和结果。
- 服务端 Codex 进程及客户端 Agent 的受信通信。

现有 `ky_ai_executor_*` 表名和执行器 ID 保持兼容；迁移服务所有权，不做破坏性改名。

### 3.2 其他服务

- `ky-ai-model-service` 回归 API Provider、`ky_ai_model`、平台全局 API 模型设置及迁移期 legacy provider 生成能力。
- `ky-matrix-account-service` 继续独占登录脚本、版本、策略、契约和运行事实，只保存外部执行器 opaque ID 与模型覆盖键。
- 两个服务通过内部 API 校验绑定和创建任务，禁止读取对方私有表或建立跨服务私表外键。

### 3.3 Host、Plugin、Desktop

- 业务插件负责页面，但只能使用 Host 注入的 request client 和 Desktop adapter，禁止直接访问 `window.aicrm`。
- Admin Host 负责统一 Desktop adapter、工作区上下文、带认证的流式请求和非 Desktop 降级。
- Electron main 负责本地 App Server、系统浏览器、设备密钥和进程生命周期，不维护角色、菜单或业务权限。

## 4. 模型命名空间与解析

### 4.1 模型类型不得混用

```text
ky_ai_model.id
  API Provider 模型 ID，仅保留 legacy provider 语义。

Codex modelKey
  来自指定执行器 App Server model/list，受账号、Codex 版本和执行器能力影响。
```

新增字段：

```text
executor.default_model_key
script.executor_id
script.model_key_override
version/run/task.effective_executor_id
version/run/task.effective_model_key
version/run/task.executor_source
version/run/task.model_source
version/run/task.executor_config_revision
version/run/task.credential_binding_revision
version/run/task.runtime_binding_id
version/run/task.runtime_binding_revision
version/run/task.model_catalog_revision
```

旧 `script.model_id`、`version.model_id` 仅保留 legacy provider 语义。

### 4.2 唯一解析规则

```text
script.executor_id
  -> platform global default Codex executor，并校验当前 workspace grant
  -> 无可用执行器则阻断

script.model_key_override
  -> executor.default_model_key
  -> 无模型则阻断
```

禁止回退到平台全局多模态/对话模型、其他执行器模型或用户全局 Codex 默认模型。

来源枚举：

```text
executorSource = script_explicit | platform_default
modelSource    = script_override | executor_default
```

任务创建时必须冻结执行器、执行器配置修订、凭据修订、模型目录修订、实际模型和来源；后续配置修改不改变已创建任务。

### 4.3 模型目录

执行器服务通过 `model/list` 获取并缓存安全目录。业务字段 `modelKey` 必须取 App Server 返回目录项的 `model` 字段；目录项 `id` 只作为协议目录项标识，不得保存为任务模型键。缓存包括显示名、输入模态、reasoning effort、hidden/upgrade 元数据、目录修订、账号指纹和最后发现时间。

新配置只允许选择当前目录中非 hidden 且与脚本维护输入模态兼容的模型。历史配置若变为 hidden、消失或不兼容，保留原值用于审计，但视为不可用并要求重新选择。

账号、Codex 版本或凭据修订变化后必须刷新目录并重新校验默认模型。模型不可用时保持已授权，但 readiness 降级；新任务不得静默换模型。

## 5. Codex 授权协议

协助授权统一使用 Codex App Server 结构化协议，不解析 `codex login` 人类可读文本：

```text
account/read
account/login/start
account/login/completed
account/login/cancel
account/logout
account/updated
model/list
```

连接后必须完成 `initialize` / `initialized`，再进行方法能力检查。缺少必要方法时返回 `executor_app_server_unsupported`，不得降级解析 CLI 文本。

构建或发布时必须针对目标 Codex 版本执行 `codex app-server generate-json-schema` 并校验协议。

## 6. 三类状态

### 6.1 授权会话

```text
starting -> waiting_user -> verifying -> succeeded

任一非终态可进入：
failed | cancelled | expired | interrupted | superseded
```

- 终态不可逆，迁移使用 `revision` CAS。
- 同一执行器只允许一条非终态授权会话；数据库必须使用针对非终态枚举的 partial unique index 兜底，不能只依赖应用层查询。
- cancelled/expired/superseded 的迟到事件不得提升凭据。
- interrupted 且没有更新会话时，可对 staging 做一次恢复验证。

### 6.2 凭据与 readiness

```text
credentialStatus = unknown | not_authorized | authorized | expired | revoked
readinessStatus  = unknown | checking | ready | degraded | unavailable
```

Readiness reasonCode 至少区分：

```text
network_error
model_unavailable
default_model_missing
quota_exceeded
runtime_error
desktop_offline
credential_expired
```

首次授权期间保持 `not_authorized`；重新授权期间保留旧 `authorized` 凭据。模型、额度、网络或运行时错误不得撤销有效授权。

## 7. 凭据隔离与修订提升

路径只能由系统根据 executorId 派生：

```text
<executor-root>/<executorId>/staging/<sessionId>
<executor-root>/<executorId>/revisions/<credentialRevision>
```

授权写入 staging；`account/read(refreshToken=true)` 成功后：

1. 生成脱敏 `accountFingerprint`。
2. 在数据库 CAS 创建 `prepared` credential binding。
3. Runtime 在同一文件系统内将 staging 原子 rename 为目标 revision 目录。
4. Runtime 提交 commit proof/ACK；服务端 CAS 将 binding 变为 `active` 并切换执行器 current revision。
5. 新任务使用新 revision；旧 revision 在无活动任务后清理。

重新授权失败、取消或过期不得破坏当前有效 revision。禁止回退或探测 `process.env.CODEX_HOME`、`~/.codex`、`/root/.codex` 或其他执行器目录。

## 8. 客户端执行器授权

客户端默认调用：

```json
{
  "method": "account/login/start",
  "params": {
    "type": "chatgpt",
    "useHostedLoginSuccessPage": true,
    "appBrand": "codex"
  }
}
```

流程锁定：

1. 后台创建授权会话和短期、单次 Desktop handoff ticket。
2. 页面必须运行在目标 AiCRM Desktop，且设备绑定匹配。
3. Web 只向统一 adapter 传 `sessionId`、`executorId` 和 handoff；不传路径、命令、URL或状态。
4. Electron main 在 staging 目录启动 App Server。
5. Main 校验 `authUrl` 的 HTTPS、官方精确域名、端口和 userinfo，再调用 `shell.openExternal`。
6. 完整 `authUrl` 只存在 main 内存，不上传、不进入 renderer 或日志。
7. Main 监听 completed，再调用 `account/read(refreshToken=true)`。
8. Desktop 使用设备私钥签名回执，服务端验签后才允许提升凭据。
9. 页面可重新打开授权页、取消授权；关闭页面不等于取消。
10. Desktop 退出、会话超时或设备解绑时终止 App Server 并收敛为 interrupted。

普通浏览器可在具备权限时创建 Desktop 授权 session/handoff，但不能证明自己是 Desktop，也不能推进授权；正式结果只接受绑定设备的 claim/proof/ACK。Web UI 在调用本地 adapter 失败时返回本地错误 `desktop_client_required`；服务端只按绑定事实返回 `desktop_device_not_bound` 或 `desktop_device_offline`，不得信任 User-Agent、renderer 自报或普通 Bearer body。

## 9. 服务端执行器授权

服务端调用：

```json
{
  "method": "account/login/start",
  "params": { "type": "chatgptDeviceCode" }
}
```

App Server 结构化返回 `loginId`、`verificationUrl`、`userCode`。完整 challenge 只保存在会话 owner 进程内存：

1. 在 staging 目录启动受监管 App Server。
2. `/user-action` 只向会话发起人返回 URL、验证码和 `sessionDeadlineAt`。
3. 页面显示验证码、复制、打开官方页面和 AiCRM 管理倒计时。
4. 服务端监听 completed，并调用 `account/read(refreshToken=true)`。
5. 成功后进入凭据两阶段提升；失败、取消、过期清理 staging。
6. 取消时先调用 `account/login/cancel`，再终止受管进程组。

`sessionDeadlineAt` 是 AiCRM 的监管截止时间，不代表 Codex 设备码官方真实过期时间；Codex 结构化通知优先。

## 10. Desktop 设备信任

- Desktop 首次安装生成 Ed25519 设备密钥，私钥进入 OS credential store。
- deviceId 由公钥派生，公钥登记到执行器服务。
- 未绑定执行器首次授权需确认“绑定当前客户端并授权”。
- 已绑定其他设备时拒绝；重新绑定需独立权限和二次确认。
- 普通 Bearer API 和 renderer 不能上报正式 `authorized`。

签名 proof 至少覆盖：

```text
sessionId, executorId, loginIdHash, deviceId, sessionRevision,
result, checkedAt, nonce, accountFingerprint
```

服务端必须校验签名、设备绑定、nonce、有效期和 revision。未完成可信证明时只能显示 `client_reported`，不得更新 credentialStatus。

## 11. Desktop IPC 与事件

物理 channel：

```text
codex-executor:get-capabilities
codex-executor:start-authorization
codex-executor:get-authorization-snapshot
codex-executor:cancel-authorization
codex-executor:reopen-authorization-url
codex-executor:verify-authorization
codex-executor:check-readiness
codex-executor:get-model-catalog
codex-executor:refresh-model-catalog
codex-executor:logout
codex-executor:authorization-changed
desktop-device:get-identity
```

`start/cancel/reopen/verify/check-readiness/refresh/logout` 为 Command；`get-capabilities/get-snapshot/get-model-catalog/get-identity` 为 Query；`authorization-changed` 为 Native Event。`verify`、readiness 和 catalog refresh 都会产生受信上报或新修订，因此不得伪装成 Query。

规则：

- 输入禁止 `codexHome`、任意 path、任意 URL、任意 channel、authStatus 和账号摘要。
- Native Event 使用 version 1 envelope，`scope=system`、`correlationId=sessionId`，只含脱敏状态摘要。
- Web 通过统一 adapter 消费，插件不得直接访问 `window.aicrm`。
- Adapter 只建立一个主订阅；按 sequence 幂等消费，unsubscribe 和 React cleanup 必须完整。
- 页面先订阅再取 snapshot，避免订阅与快照之间的竞态。
- Native Event 只表示本地临时态，服务端 session SSE 是正式业务真相源。
- 非 Desktop 环境明确降级；旧 bridge 仅保留一个发布版本。

## 12. 公共 API 合同

### 12.1 执行器与模型

```text
GET   /api/v1/ai-executors
POST  /api/v1/ai-executors
GET   /api/v1/ai-executors/{executorId}
PATCH /api/v1/ai-executors/{executorId}
GET   /api/v1/ai-executors/{executorId}/models
POST  /api/v1/ai-executors/{executorId}/model-catalog/refresh
POST  /api/v1/ai-executors/{executorId}/readiness/check
POST  /api/v1/ai-executors/{executorId}/credential/verify
GET   /api/v1/ai-executors/{executorId}/workspace-grants
PUT   /api/v1/ai-executors/{executorId}/workspace-grants/{workspaceType}/{workspaceId}
DELETE /api/v1/ai-executors/{executorId}/workspace-grants/{workspaceType}/{workspaceId}
```

PATCH 为真正部分更新：字段省略表示不变，`null` 表示清空，并使用 `expectedRevision` 做并发控制。可写字段固定为 `name`、`status`、`isDefault`、`defaultModelKey`、`allowScriptSave`、`autoRepairEnabled` 和受限运行参数；授权、凭据、readiness、设备和目录字段不可由 PATCH 写入。

平台同一 executorType 只能有一个 `isDefault=true`；数据库使用 partial unique index 兜底。切换默认值必须在单个事务和同一 executorType advisory lock 内完成旧值清除与新值设置。不能把当前默认执行器直接清空；必须在同次 PATCH 指定替代执行器，或返回 `executor_default_required`。Workspace grant 的 PUT/DELETE 使用 `expectedRevision`，PUT 为幂等 upsert，DELETE 对已删除 grant 幂等成功。

Catalog refresh body 固定为 `{expectedExecutorRevision, expectedCatalogRevision}`，readiness check 为 `{expectedExecutorRevision, expectedCredentialRevision, expectedCatalogRevision}`，credential verify 为 `{expectedExecutorRevision, expectedCredentialRevision}`；三者都是 Command，必须携带 Idempotency-Key。Server runtime 统一在既有 executor task 表创建对应 taskType 并返回 202 `{taskId,status:"pending"}`，通过 §12.4 task GET/events/SSE 观察，不新建 job 资源；Desktop runtime 返回 202 `{operationId, commandTicket, expiresAt}`，ticket 绑定具体 purpose/device/revision，供 Bridge 执行，禁止返回可由裸 executorId 触发的本地写操作。

### 12.2 授权会话

```text
POST /api/v1/ai-executors/{executorId}/authorization-sessions
GET  /api/v1/ai-executors/{executorId}/authorization-sessions/current
GET  /api/v1/ai-executor-authorization-sessions/{sessionId}
GET  /api/v1/ai-executor-authorization-sessions/{sessionId}/user-action
POST /api/v1/ai-executor-authorization-sessions/{sessionId}/reopen
POST /api/v1/ai-executor-authorization-sessions/{sessionId}/cancel
POST /api/v1/ai-executor-authorization-sessions/{sessionId}/desktop-commands/{operationId}/ack
GET  /api/v1/ai-executor-authorization-sessions/{sessionId}/events
GET  /api/v1/ai-executor-authorization-sessions/{sessionId}/events-stream
POST /api/v1/ai-executors/{executorId}/credential/revoke
```

创建请求体固定为 `{ "intent": "authorize" | "change_account" }`，并必须携带 `Idempotency-Key`。同一操作者同一 key 返回相同会话；其他操作者已有活跃会话时返回 409。runtimeType 和 flowType 由服务端根据执行器配置解析，调用方不得覆盖。

授权会话普通安全投影固定包含：`id`、`executorId`、`runtimeType`、`flowType`、`intent`、`status`、`sequence`、`revision`、`userActionRequired`、`sessionDeadlineAt`、脱敏 `accountSummary`、结构化 `failure` 与生命周期时间。

普通 session 投影禁止包含 loginId、userCode、授权 URL、codexHome、命令、Token、原始输出和完整邮箱。

`/user-action` 只适用于 server device-code flow，并只向发起人返回 `verificationUrl`、`userCode` 和 `sessionDeadlineAt`。Desktop flow 调用该 GET 返回 409 `authorization_user_action_not_server_managed`。

`/reopen` 和 `/cancel` body 固定为 `{expectedSessionRevision}` 并要求 Idempotency-Key，作用域 `(actorId,sessionId,action,key)`。Server flow reopen 不改变状态，返回 200 与 `/user-action` 相同的当前 device-code 安全投影；Server flow cancel 先 CAS 终态、写 outbox、停止 App Server并返回当前 session，均不返回 commandTicket。

Desktop flow reopen 在创建持久 operation 后返回 202 `{session, desktopCommand:{operationId,expectedSessionRevision,commandTicket,expiresAt}}`；Desktop cancel 必须先在同一事务 CAS session 为 cancelled、写 event/outbox 和 command operation，再返回同结构，ticket 仅用于 best-effort 终止本地 App Server/清 staging，不能决定服务端终态。Reopen ticket purpose=`authorization_reopen`，cancel ticket purpose=`authorization_cancel`。设备执行后按 §20.3 desktop-command ACK 合同提交签名 body `{operationId,purpose,expectedSessionRevision,result,completedAt,failureCode?}`；reopen ACK 只写审计，cancel ACK 只标记本地清理结果。相同 key/hash 返回同一 operation 与可确定性重建的同一 ticket；不同 hash 返回 409。

上述 user-action、reopen 和带 ticket 响应必须设置：

```text
Cache-Control: no-store
Pragma: no-cache
Referrer-Policy: no-referrer
```

Desktop handoff/proof 使用单独受信端点，proof 必须包含设备签名；普通 Web 请求不能提交授权结果。

Revoke 请求固定为 `{ "expectedCredentialRevision": 12, "force": false, "confirmationToken": "..." }`，并必须携带 Idempotency-Key；非 force 时 confirmationToken 可省略。`force=true` 需要 force-revoke 权限、服务端签发且绑定 actor/executor/revision/action 的 5 分钟单次二次确认 token 和高危审计；普通 revoke 遇到活动任务返回冲突。Server runtime 成功响应返回新的 credentialStatus/revision；Desktop runtime 返回 `{operationId, revocationId, credentialRevision:12, revocationEpoch, status:"awaiting_device", commandTicket, expiresAt}`，ticket 和 Bridge 只能清理该 credentialRevision，设备 ACK 后才完成本地清理。Force revoke 可先使服务端 binding 无效，再等待设备清理。相同 actor/executor/revision/force/key/hash 返回同一 operation 和可确定性重建的同一 ticket；同 key 不同 hash 返回 409。

### 12.3 脚本配置

```text
PATCH /api/v1/matrix-account-login-scripts/{scriptId}
GET   /api/v1/matrix-account-login-scripts/{scriptId}/eligible-executors
GET   /api/v1/matrix-account-login-scripts/{scriptId}/eligible-executors/{executorId}/models
```

更新使用 `executorId`、`modelKeyOverride` 和 `expectedRevision`；`null` 分别表示继承平台全局默认 Codex 执行器（仍须通过当前 workspace grant 校验）和执行器默认模型。eligible 接口只返回安全投影。

### 12.4 执行器任务投影

```text
GET  /api/v1/ai-executor-tasks
GET  /api/v1/ai-executor-tasks/{taskId}
GET  /api/v1/ai-executor-tasks/{taskId}/events
GET  /api/v1/ai-executor-tasks/{taskId}/events-stream
GET  /api/v1/ai-executor-tasks/{taskId}/terminal-frames
GET  /api/v1/ai-executor-tasks/{taskId}/terminal-stream
POST /api/v1/ai-executor-tasks/{taskId}/cancel
```

公共接口只提供任务安全投影；原始 App Server 消息、底层原始日志和结果包不得直接返回。`terminal-*` 只返回由脱敏结构化事件生成并持久化到 task raw-log 的 ANSI 投影。列表、详情、事件和 ANSI 投影要求 task view 权限。Task cancel 要求 task cancel 权限，body 固定为 `{expectedRevision}` 并强制 Idempotency-Key，作用域 `(actorId,taskId,"cancel",key)`；终态或重复取消返回当前 task，同 key 不同 body 返回 409 `idempotency_key_reused`。

### 12.5 通用规则和兼容

- 普通用户接口使用统一 envelope、Bearer、平台/当前 workspace Header 和稳定错误码。设备受信端点、内部服务端点与一次性票据端点使用 §20.3/§20.6 的专用认证合同，不强制也不接受调用方覆盖 workspace；workspace 必须从 session、executor binding、device binding 或内部调用方身份派生。
- SSE 使用 Host request client 的 fetch stream 注入认证和 workspace Header，禁止 URL token。
- 现有完整路由 `POST /api/v1/ai-executors/{executorId}/authorize` 仅保留一个发布周期作为 `intent=authorize` 的 session create 别名，并返回 Deprecation/Sunset Header。旧请求只允许空 body；含 codexHome/path/authStatus 等字段返回 426 `desktop_bridge_upgrade_required`。旧客户端没有 Idempotency-Key 时，服务端先按 actor+executor 查非终态 session：同一 actor 存在则返回该 session，否则使用持久化 server-generated key 创建；其他 actor 占用仍返回 409，因此重试不创建第二个 session。
- 现有完整路由 `POST /api/v1/ai-executors/{executorId}/auth-status` 从 v9 首次部署起直接返回 410，不设可写兼容期，也不接受 authorized、deviceId 或 capabilities；只读状态统一读取 current/session/credential 投影。
- Canonical 字段为 `verificationUrl`，旧 `verificationUri` 仅兼容一个版本。
- 所有因兼容期结束、旧写入口禁用或 handler sunset 返回的 410 统一使用 `error.code=legacy_endpoint_gone`；不得借用 session/challenge 过期错误码。

稳定业务错误码：

```text
executor_runtime_unsupported
authorization_session_conflict
authorization_session_expired
authorization_user_action_not_server_managed
authorization_proof_invalid
executor_disabled
executor_app_server_unsupported
desktop_device_offline
desktop_device_not_bound
desktop_device_mismatch
desktop_bridge_upgrade_required
device_proof_replayed
idempotency_key_reused
invalid_event_cursor
executor_operation_fenced
legacy_endpoint_gone
executor_default_model_missing
executor_default_required
executor_model_unavailable
executor_assignment_forbidden
executor_not_script_maintenance_ready
executor_has_active_tasks
authorization_challenge_gone
executor_app_server_unavailable
```

浏览器打开失败、登录取消、监管超时、Desktop 断线和凭据提交失败属于已创建 Session 的 `failure.code`，不得混入 HTTP `error.code`；完整枚举见 §20.11。

HTTP 映射锁定：

| HTTP | 错误码 |
|---:|---|
| 403 | `authorization_proof_invalid`、`executor_assignment_forbidden`、`desktop_device_mismatch`、设备或 workspace 越权 |
| 400 | `invalid_event_cursor` |
| 409 | `authorization_session_conflict`、`authorization_user_action_not_server_managed`、`executor_disabled`、`desktop_device_not_bound`、`device_proof_replayed`、`idempotency_key_reused`、`executor_operation_fenced`、`executor_default_required`、`executor_default_model_missing`、`executor_model_unavailable`、`executor_not_script_maintenance_ready`、`executor_has_active_tasks` |
| 410 | `authorization_session_expired`、`authorization_challenge_gone`、`legacy_endpoint_gone` |
| 422 | `executor_runtime_unsupported`、`executor_app_server_unsupported` |
| 426 | `desktop_bridge_upgrade_required` |
| 503 | `desktop_device_offline`、`executor_app_server_unavailable`、执行器运行环境或流服务不可用 |

外部响应不得透传 App Server、CLI、Provider 或操作系统原始错误；`details` 只返回前端处理所需的安全字段。

## 13. SSE 与页面恢复

- 事件历史使用 `after` 和 `limit`；SSE 使用 event id、Last-Event-ID/after、15 秒心跳和断点恢复。
- SSE 事件只包含 session 安全投影，不含 challenge、loginId 或账号原文。
- SSE 断线时安全回补；不可用时 3–5 秒轮询 session。
- Request client 流接口必须支持 AbortSignal；cleanup 必须 abort reader、取消 timer 并释放订阅。
- Nginx 对流关闭 buffering，并配置合理读超时。
- 页面刷新读取 current session，不重新创建；多标签页观察同一 session。
- 关闭抽屉或路由切换不等于取消授权。
- v9 部署锁定为单副本 `ky-agent-executor-service`。Challenge 只在该进程内存；服务重启后 session interrupted，用户重新发起。v9 不实现多副本接管或 owner 路由。

## 14. 权限与 workspace 发布

执行器由平台工作区管理：

```text
platform.ai_executors.view
platform.ai_executors.create
platform.ai_executors.update
platform.ai_executors.authorize
platform.ai_executors.change_account
platform.ai_executors.bind_device
platform.ai_executors.rebind_device
platform.ai_executors.force_revoke
platform.ai_executor_tasks.view
platform.ai_executor_tasks.create
platform.ai_executor_tasks.cancel
```

AI 配置菜单唯一真相源继续使用 `menu.platform.ai_configuration`；`platform.ai_executors.view` 是页面权限，不得作为 menuKey。现有插件中的 `ai.executors.view` menuKey 必须在实现阶段迁移，不继续形成双轨。

脚本沿用 view/update/regenerate/activate_version；其中修改执行器和模型配置必须有独立 action permission：

```text
<workspace>.matrix_account_login_scripts.assign_executor
<workspace>.matrix_account_login_scripts.assign_model
```

- 执行器服务维护 workspace grant。
- agency/enterprise 只能看到已发布执行器的 ID、名称、runtime、readiness 和脚本维护能力摘要。
- 不得返回账号标签、设备详情、凭据详情、路径或授权会话。
- 矩阵服务保存绑定和创建任务前都必须经内部 API 复核 grant、权限和模型兼容性。

## 15. Desktop 执行器任务可用性

当前仓库没有完整 Desktop task claim、heartbeat、lease 和结果回传协议。因此：

1. 脚本可选执行器必须满足服务端计算的只读 `scriptMaintenanceReady=true`，客户端和配置接口不得写该字段。
2. Desktop Agent 传输验收前，客户端执行器只支持授权、设备绑定、模型目录和配置，不进入脚本执行器下拉列表。
3. 若后续开放 Desktop 脚本维护，必须先实现：设备心跳、task claim、lease/renew、事件/终端帧回传、complete/fail/cancel、离线租约回收、设备签名和重放保护。
4. 服务端执行器完成授权、readiness 和模型校验后可成为首个 eligible executor。
5. Active DSL 执行不依赖执行器在线；执行器只影响生成、修复、契约测试和候选提升。

## 16. 数据模型

执行器服务新增或扩展：

```text
ky_ai_executor_config
  is_default, default_model_key, config_revision, credential_status,
  current_credential_revision, readiness_status, readiness_reason_code,
  revocation_epoch

ky_ai_executor_authorization_session
  id, executor_id, runtime_type, flow_type, intent, status,
  requested_by, bound_device_id, revision,
  current_sequence, idempotency_key_hash, request_hash,
  session_deadline_at, failure_code, timestamps

ky_ai_executor_authorization_session_event
  id, session_id, sequence, event_type, safe_payload_json,
  occurred_at, created_at

ky_ai_executor_credential_binding
  executor_id, revision, status, authorization_session_id,
  runtime_type, runtime_binding_id, runtime_binding_revision,
  device_id, account_fingerprint, auth_mode, plan_type,
  binding_digest, revocation_epoch,
  verified_at, created_at, revoked_at

ky_ai_executor_device
  id, public_key, status, label, app_version,
  key_generation, last_accepted_sequence,
  last_heartbeat_at, created_at, updated_at

ky_ai_executor_device_request_ledger
  device_id, key_generation, sequence, nonce,
  request_hash, authorization_token_hash, response_reference,
  accepted_at, expires_at

ky_ai_executor_model_catalog
  executor_id, catalog_revision, model_key, display_name,
  metadata_json, account_fingerprint, last_seen_at, status

ky_ai_executor_workspace_grant
  executor_id, workspace_type, workspace_id, status

ky_ai_executor_task（扩展现有表）
  task_type, purpose（脚本 task 保存 script_purpose；控制面 task 为空），
  script_version_id, contract_id, contract_revision,
  effective_executor_id, effective_model_key,
  executor_source, model_source,
  executor_config_revision, credential_binding_revision,
  runtime_binding_id, runtime_binding_revision,
  model_catalog_revision, generation_engine,
  operation_id, lease_epoch, source_credential_revision,
  revocation_epoch

ky_ai_executor_operation_lease
  executor_id, operation_id, owner_instance_id,
  lease_epoch, lease_expires_at, source_credential_revision,
  revocation_epoch, status, created_at, updated_at

ky_ai_executor_task_cancellation_tombstone
  task_id, request_hash, reason, created_at, expires_at

ky_ai_executor_task_request_registry
  task_id, request_hash, materialized_status, created_at
```

Operation lease 固定以 executor_id 为主键，status 为 `active | released | expired | fenced`；`lease_epoch` 只能在锁定 executor 行的事务中递增，不存在第二条 active lease 的应用层竞态窗口。

Device request ledger 主键固定为 `(device_id,key_generation,sequence)`，并对 `(device_id,key_generation,nonce)` 建唯一约束；high-water、ledger、业务写入和 response reference 在同一事务提交。

授权 session event 对 `(session_id, sequence)` 唯一；session 对 `(requested_by, executor_id, idempotency_key_hash)` 唯一并保存 request hash，相同 key 不同 hash 返回冲突。事件与 `current_sequence`、状态迁移及 outbox 在同一数据库事务提交。

授权 challenge、完整 URL、loginId、验证码和凭据路径不得进入 PostgreSQL。

矩阵服务扩展：

```text
ky_matrix_account_login_script
  executor_id, model_key_override, generation_engine, config_revision

ky_matrix_account_login_script_version
  effective_executor_id, effective_model_key,
  executor_source, model_source, executor_config_revision,
  credential_binding_revision, runtime_binding_id,
  runtime_binding_revision, model_catalog_revision,
  generation_engine, generation_run_id

ky_matrix_account_login_script_generation_run
  id, workspace_type, workspace_id, web_space_id, script_id,
  script_purpose, operation, generation_reason, generation_engine,
  contract_id, contract_revision, target_version_id,
  status, dispatch_status, dispatch_attempt,
  dispatch_lease_expires_at, candidate_version_id,
  expected_script_revision,
  effective_executor_id, effective_model_key,
  executor_source, model_source, executor_config_revision,
  credential_binding_revision, runtime_binding_id,
  runtime_binding_revision, model_catalog_revision,
  failure_code, idempotency_key_hash, request_hash,
  current_sequence, revision,
  created_by, created_at, updated_at, finished_at

ky_matrix_account_login_script_generation_run_event
  id, generation_run_id, sequence, event_type,
  safe_payload_json, occurred_at, created_at
```

`generation_run.id == executor_task.id == runId`，不保存冗余 executor_task_id，也不生成第二个 ID。普通 `ky_matrix_account_login_script_run` 只记录 DSL 执行，不承载 AI 生成 binding；binding 只冻结在 generation run、executor task 和由其产生的 script version。Event 对 `(generation_run_id, sequence)` 唯一。Run/event/outbox 的状态与序列在同一事务提交，确保重启后可按 after/Last-Event-ID 回放。

跨服务 ID 为 opaque reference，不建跨服务外键。

## 17. 安全与审计

- 执行器服务和 Codex 子进程使用独立低权限 OS 用户，禁止 root。
- systemd 至少配置 `UMask=0077`、`NoNewPrivileges=true`、`KillMode=control-group`、受控 ReadWritePaths 和停止超时。
- 子进程使用环境白名单，移除数据库 URL、AI 密钥、内部 token、API Key、Access Token 及全局认证变量。
- 取消、超时和停止必须终止完整进程组。
- URL 只允许 HTTPS 官方精确域名，拒绝 userinfo、非默认端口和恶意 scheme。
- open-url command 只接收 sessionId，URL 只能来自 main 内存。
- userCode、authUrl、loginId、Token、auth.json、CODEX_HOME、原始 App Server/CLI 输出禁止进入数据库、审计、日志、SSE、capabilities 和前端持久缓存。

安全审计仅记录 actor、workspace、executorId、sessionId、deviceId、结果、失败码、requestId 和以下事件名：

```text
started, waiting_user, verifying, succeeded, failed,
cancelled, expired, interrupted, superseded,
credential_promoted, credential_revoked, device_bound, device_rebound,
device_unbound
```

## 18. 重新授权、注销与恢复

- “校验授权”“更换授权账号”“解除本机关联”是三个独立操作。
- 更换账号使用 staging，失败不影响当前凭据。
- 普通更换/注销遇到活动任务返回 `executor_has_active_tasks`。
- 强制解除需要独立权限、二次确认和高危审计，并取消绑定当前凭据修订的任务。
- account/logout 只表示清除执行器本地凭据，不宣称撤销 OpenAI 账号侧所有会话。
- 删除、停用、切换 runtime 或重绑设备前必须处理活跃 session 和 task。

恢复规则：

- 服务关闭前停止新授权并终止受管 App Server。
- cancelled/expired/superseded staging 永不提升，直接清理。
- interrupted 且无新 session 时可对 staging 做一次 account/read；成功则提升，否则清理并保留旧凭据。
- 不根据旧 PID 重新连接或杀进程，不自动重启旧设备码流程。

## 19. 迁移发布顺序

1. v9 文档和契约锁定。
2. 安全止血：禁用户态写 authorized、移除全局 CODEX_HOME 回退、清 capabilities 路径和原始状态。
3. Additive schema、权限 seed 和 API 类型。
4. `ky-agent-executor-service` shadow read，迁移执行器领域所有权。
5. 服务端 App Server 设备码授权。
6. Desktop bridge v2、设备身份、浏览器授权和事件。
7. 模型目录、执行器默认模型、脚本 executor/model 配置。
8. 服务端执行器脚本维护与契约测试。
9. 可选 Desktop Agent 任务传输；未完成前不发布为 eligible。
10. Feature flag 切换生成、修复和契约测试。
11. 稳定后停止 legacy provider 自动生成；历史数据和 active DSL 保留。

兼容：保留 `aiexec_platform_codex`；旧授权只有专属目录通过 account/read 才能继承；全局/环境来源一律 unknown；旧 bridge 保留一个版本；旧 model_id 不迁为 modelKey。

## 20. 实施级锁定合同

### 20.1 凭据两阶段提交与恢复

Credential binding 状态固定为：

```text
prepared -> committing -> active
              |            |
              v            v
         quarantined    revoked
```

Binding 元数据必须包含 `runtimeType`、`runtimeBindingId`、`deviceId`（Desktop）、`verifiedAt`、`revision`、`bindingDigest` 和 `revocationEpoch`。任务同时冻结 credential revision 与 runtime binding revision。

`bindingDigest`/`quarantineDigest` 固定为 SHA-256 lowercase hex：递归枚举目录内普通文件，拒绝 symlink、hardlink、device/socket/FIFO；relative path 统一为 NFC UTF-8 与 `/` 分隔，禁止 `..`，按 path 的 UTF-8 bytes 升序；每项记录 `{path,size,sha256}`，对该数组的 RFC 8785 canonical JSON UTF-8 bytes 求 SHA-256。mtime、所有者和平台 ACL 不进入摘要。Desktop 与 Server 必须使用同一测试向量，proof、prepared binding、durable ACK 和 quarantine ACK 均使用此算法。

`accountFingerprint` 固定为 `SHA-256(UTF-8(trim(account.type) + "\n" + lowercase(trim(account.email))))` 的 64 位 lowercase hex；`planType` 明确不参与，套餐变化不得被识别成另一个账号。缺失/空 email、控制字符或超长字段必须使成功 proof fail-closed；账号 type/email 原文只存在于受信 Main 的瞬时内存，不进入 Renderer、HTTP body、数据库、日志或审计。Desktop 与 Go 必须共同消费 `docs/testdata/aicrm_account_fingerprint_vectors.json`。

服务端提交：

1. Runtime 先刷新 staging 全部凭据文件与目录并计算 bindingDigest；DB CAS 创建携带该 digest 和当前 revocationEpoch 的 `prepared` binding。
2. DB CAS 将该 binding 从 `prepared` 改为 `committing`；CAS 成功后才允许触碰目标 revision。
3. Runtime 使用 same-filesystem no-replace rename 将 staging 提升为 revision 目录，刷新全部凭据文件、revision 目录与父目录并重新计算 digest；digest 必须与 prepared bindingDigest 一致，此后目标 revision 永久只读。
4. 从只读目标创建一次性 COW verification staging，在该副本执行 `account/read(refreshToken=false)` 后销毁副本；即使 App Server 产生写入也不得回写目标。DB CAS 仅在目标 digest 仍等于 prepared bindingDigest 时，于同一事务激活 binding、切换 current revision 并写审计 outbox。
5. 响应丢失时按相同 session/revision 重试，返回同一 active 结果。

Desktop 提交：

1. Desktop 在本地 staging 完成登录和 account/read。
2. 提交设备签名 proof；服务端创建 prepared binding，并返回一次性 activation token 和目标 revision。
3. Desktop 使用同卷 no-replace rename 提升 revision，并在提交 ACK 前完成 durable barrier：刷新凭据文件、revision 目录和父目录；Windows 使用 `FlushFileBuffers`、原子替换及目录可用的等价持久化屏障。屏障失败不得 ACK。
4. 服务端校验 ACK bindingDigest 等于 prepared digest 后 CAS 激活；ACK 丢失可幂等重试。
5. 服务端拒绝或会话已终态时，Desktop 将候选目录 quarantine，绝不替换旧 revision。

服务端恢复矩阵固定为：`prepared + staging` 可重试；`committing + staging` 继续 rename；`committing + revision` 重新验证后激活或 quarantine；staging 与 revision 同时存在、两者都不存在或摘要不匹配时一律 quarantine/fail 并告警，不猜测提升。Desktop activation token 有效期 10 分钟；rename 成功但 ACK 中断时，绑定设备在有效期内重放同一 ACK，过期后本地 quarantine 并提交清理证明。服务端 binding 只有收到目标设备签名 ACK 才能 active；后续 readiness proof 持续证明 revision 可用。数据库不得把未收到对应 runtime proof 的 revision 标成 active。

### 20.2 App Server 传输与 OS 隔离

- 授权、account/read、model/list、thread/start、turn 和 item 等全部 App Server 操作一律使用 `codex app-server --listen stdio://`；授权期与任务期都不开放 host TCP、loopback/受控内网 WebSocket 或未认证 Unix socket。
- v9 不启动 `codex --remote`，也不把 PTY 连接到 App Server。结构化事件由 stdio JSON-RPC 归一；只读“终端”由执行器服务把同一事件渲染为脱敏 ANSI 投影并写入 task raw-log，不形成第二条可调用 Codex 的控制通道。
- 控制面 `ky-agent-executor-service` 使用固定低权限用户；Codex Runtime 使用隔离的 systemd 模板/瞬态单元和独立安全主体。
- Server Linux Runtime 瞬态单元固定使用 `DynamicUser=yes`、`ProtectSystem=strict`、`ProtectHome=true`、`PrivateTmp=true`、`PrivateDevices=true`、`NoNewPrivileges=true`、空 `CapabilityBoundingSet`、`UMask=0077`、`LimitCORE=0` 和 `KillMode=control-group`。
- Runtime 只绑定当前 executor credential revision、只读工作区和专用 scratch；其他 executor home、服务配置和外部依赖环境文件不可见。
- Runtime 环境使用显式 allowlist，禁止继承控制面数据库、AI 密钥、内部 token、API Key、Access Token 与全局 Codex 认证变量。
- Credential root、staging、revision 和 quarantine 排除普通备份、诊断包和 core dump。

Active credential revision 必须不可变且不得被任何 App Server 直接挂载为可写。v9 对每个 Codex executor 强制 `maxConcurrency=1`：Server 与 Desktop service operation 都取得 executor 级数据库 lease；Server 另取 OS 文件锁，Desktop Main 另取本地 mutex/file lock。取得锁后才从 active revision 创建专用 COW operation staging，并仅在该 staging 启动唯一 App Server。若 OAuth 刷新导致认证文件变化，操作结束后必须按 §20.1 两阶段协议把 staging 提升为新的同账号 credential revision；提升失败时 readiness 降级且不得启动下一操作。重新授权使用独立 staging，但 normal commit 必须等待 operation lease；force revoke 递增 revocation epoch、取消当前操作并使所有迟到 promotion CAS 失败。禁止两个 Runtime 共享同一可写 credential home。

Lease 是持久 fencing 合同而非内存互斥：每个 executor 同时最多一条 active `ky_ai_executor_operation_lease`。Acquire 在事务内锁 executor 行，递增永不回退的 `leaseEpoch`，冻结 `operationId/ownerInstanceId/sourceCredentialRevision/revocationEpoch`，TTL 固定 30 秒；owner 每 10 秒用全部字段 CAS renew，release 同样 CAS。接管只允许 lease 过期后创建更大的 epoch。Task 状态/事件/结果、COW credential promotion、Desktop activation ACK 和控制面 task 结果都必须携带并 CAS 校验 `operationId + leaseEpoch + sourceCredentialRevision + revocationEpoch`；旧 owner 恢复后的任何迟到写一律返回 fenced，不得产生 outbox。

Force revoke 必须在同一事务递增 executor `revocationEpoch`、使当前 binding 无效、fence active lease、把关联非终态 task 标为 cancelled 并写审计/任务 outbox；事务后再终止 Runtime。任何基于旧 epoch 的 result、promotion、proof 或 ACK 均拒绝。普通重新授权 activation 也必须等待或取得同一 executor lease，不能越过运行中 task。

### 20.3 Desktop 设备与受信授权 API

设备登记：

```text
POST /api/v1/ai-executor-operation-confirmations
POST /api/v1/ai-executor-operation-confirmations/{confirmationId}/confirm
POST /api/v1/ai-executor-devices/registration-challenges
POST /api/v1/ai-executor-devices
POST /api/v1/ai-executor-devices/{deviceId}/heartbeat
POST /api/v1/ai-executors/{executorId}/device-bindings
POST /api/v1/ai-executors/{executorId}/device-binding/rebind
DELETE /api/v1/ai-executors/{executorId}/device-binding
POST /api/v1/ai-executors/{executorId}/credential-revocations/{revocationId}/ack
```

Operation confirmation 创建 body 为 `{action, executorId, expectedRevision, targetDeviceId?}`，返回 `{confirmationId, challengeText, expiresAt}`；confirm body 为 `{challengeText}`。仅 fresh-login 不超过 10 分钟的 owner 可确认；平台启用 MFA 时必须先 step-up。成功返回绑定上述全部字段的 5 分钟单次 confirmationToken，错误或过期不得签发。该 token 仅用于 `force_revoke | rebind_device | unbind_device` 对应动作。

- Registration challenge 绑定当前用户、平台 workspace、公钥摘要和 120 秒 TTL。
- 创建设备必须提交对 challenge 的 proof-of-possession；deviceId 为公钥摘要，不接受调用方任意指定。
- Heartbeat、catalog、readiness、claim、proof、activation ACK 和 revocation ACK 使用下列固定设备签名 Header。
- 服务端检查 5 分钟时钟窗，并在 PostgreSQL 持久化单调 sequence、nonce 和 request ledger；进程重启不得清零。重放判定和业务写入必须处于同一事务。

```text
X-AiCRM-Device-Id: <sha256-public-key>
X-AiCRM-Device-Timestamp: <unix-milliseconds>
X-AiCRM-Device-Nonce: <128-bit-base64url>
X-AiCRM-Device-Sequence: <uint64>
X-AiCRM-Content-SHA256: <lowercase-hex>
X-AiCRM-Device-Signature: <base64url-no-padding-ed25519>
```

签名输入固定为 UTF-8：

```text
AICRM-DEVICE-V1\n
<UPPERCASE_METHOD>\n
<CANONICAL_PATH>\n
<TIMESTAMP>\n
<NONCE>\n
<SEQUENCE>\n
<BODY_SHA256>\n
<AUTHORIZATION_TOKEN_SHA256_OR_EMPTY>
```

所有设备签名端点禁止 query string。`CANONICAL_PATH` 取路由模板展开后的原始 ASCII path；资源 ID 只允许 `[A-Za-z0-9_-]+`，拒绝 percent-encoding、`+`、空段、重复 `/`、`.`/`..` 段和尾随 `/`。因此 TS 与 Go 不做 URL decode、query 排序或 path normalize，直接对校验后的 request-target path 签名/验签。Body 为空时 SHA-256 取空字节摘要；Authorization token hash 取 scheme 后 token 的原始 ASCII 字节，未使用 token 时为空串。

设备验签事务顺序固定为：先按 `(deviceId,keyGeneration,sequence)` 查 ledger；若已存在且 requestHash、nonce、Authorization token hash 完全一致，则返回原 response reference，不再次执行业务；任一字段不同返回 409 `device_proof_replayed`。若 sequence 未出现，再检查 nonce 在同 key generation 内唯一且 `sequence > lastAcceptedSequence`，随后同事务插入 ledger、CAS 提升 high-water 并提交业务结果；低序、乱序或并发 CAS 失败均拒绝。Desktop 必须串行分配 sequence。Ledger 至少保留到相关 session/operation 审计保留期结束，且不得短于 token expiry 加 5 分钟时钟窗；设备 rekey 创建新的 keyGeneration，旧 generation 永久拒绝新请求。

Ed25519 `publicKey` 固定为 raw 32 bytes 的 base64url-no-padding；deviceId 固定为 `SHA-256(raw32)` 的 64 位 lowercase hex。签名固定为 raw 64 bytes 的 base64url-no-padding。注册 challenge 创建使用用户 Bearer，body 固定为 `{publicKey, deviceLabel?, appVersion?}`；服务端先校验 raw32 编码并把其摘要、actor/workspace 写入 challenge。设备创建同时使用用户 Bearer 和待登记私钥的同一套 X-AiCRM Header 签名，body 固定为 `{challengeId, challenge, publicKey, deviceLabel, appVersion}`，首次 sequence 必须为 1。Challenge 响应固定为 `{challengeId, challenge, expiresAt, algorithm:"Ed25519"}`；服务端校验 challenge 原文、actor/workspace/公钥摘要绑定、一次性消费、公钥编码与签名后派生并返回 deviceId。Heartbeat body 固定为 `{bridgeVersion, appVersion, capabilities, occurredAt}`。

初始 bind body 固定为 `{deviceId, expectedRevision}`，由目标设备使用同一套 X-AiCRM Header 对完整 HTTP 请求签名；rebind 固定为 `{fromDeviceId, toDeviceId, expectedRevision, confirmationToken}`，同样由目标设备签名；普通 unbind 固定为 `{deviceId, expectedRevision, confirmationToken, force:false}` 并由当前设备签名。设备丢失时仅 owner 可提交 `force:true`，以二次确认 token 替代设备签名并写高危审计。Confirmation token 由服务端二次确认接口签发，绑定 actor/executor/from/to/action，5 分钟 TTL、单次消费；rebind/unbind 缺失或不匹配固定返回 403。所有请求使用用户 Bearer，rebind/unbind 还要求 owner 权限。

Desktop 授权提交：

```text
POST /api/v1/ai-executor-authorization-sessions/{sessionId}/desktop-handoffs
POST /api/v1/ai-executor-authorization-sessions/{sessionId}/desktop-handoffs/{handoffId}/claim
POST /api/v1/ai-executor-authorization-sessions/{sessionId}/desktop-proofs
POST /api/v1/ai-executor-authorization-sessions/{sessionId}/desktop-activations/{activationId}/lease-renewals
POST /api/v1/ai-executor-authorization-sessions/{sessionId}/desktop-activations/{activationId}/ack
POST /api/v1/ai-executor-authorization-sessions/{sessionId}/desktop-commands/{operationId}/ack
```

- Handoff 由有 authorize 权限的发起人以 `{deviceId, expectedSessionRevision}` 创建并强制 Idempotency-Key，作用域 `(actorId,sessionId,deviceId,key)`；返回 audience=`aicrm-desktop` 的 compact JWS `handoffTicket`、nonce、handoffId 和 120 秒有效期。相同 key/hash 返回同一 handoff 和由持久 claims 可确定性重建的同一 ticket；同 key 不同 hash 返回 409。Ticket 过期后同 key 仍返回原过期 handoff，必须用新 key 显式重建。
- Claim 使用 `Authorization: AiCRM-Handoff <handoffTicket>` 加设备签名，body 为 `{handoffId, claimedAt}`；只允许成功一次，相同设备相同请求幂等，其他 claim 返回 409。成功响应固定为 `{handoffId, executorId, claimToken, expiresAt, sessionRevision, replayed}`，其中 `executorId` 只能来自服务端已冻结并完成票据校验的 handoff/session 事实，不接受 Desktop 输入或推断；5 分钟 `claimToken` 只允许在受信 Desktop 内存及加密恢复 journal 中短暂保留。
- Proof 使用 `Authorization: AiCRM-Claim <claimToken>` 加设备签名，body 固定为 `{handoffId, sessionRevision, loginIdHash, result, checkedAt, accountFingerprint, candidateBindingDigest}`；不得包含凭据、路径、URL或账号原文。
- 成功 proof 在取得 executor operation lease 后返回 `{operationId, activationId, credentialRevision, leaseEpoch, sourceCredentialRevision, revocationEpoch, activationToken}`；ACK 后服务端才激活。
- Lease renewal 使用同一 `Authorization: AiCRM-Activation <activationToken>` 加设备签名，body 固定为 `{operationId, activationId, credentialRevision, leaseEpoch, sourceCredentialRevision, revocationEpoch, bindingDigest}`；成功响应固定为 `{activationId, executorId, operationId, credentialRevision, leaseEpoch, sourceCredentialRevision, revocationEpoch, renewedAt, leaseExpiresAt, replayed}`。服务端只允许未过期的 exact active lease 用完整冻结元组 CAS 延长到 `min(DB now + 30s, activation.expiresAt, session.deadlineAt)`，不得复活过期 epoch；相同签名重放返回第一次 ledger `acceptedAt` 可确定性重建的原时间，不再次延长。
- ACK 使用 `Authorization: AiCRM-Activation <activationToken>` 加设备签名，body 固定为 `{operationId, activationId, credentialRevision, leaseEpoch, sourceCredentialRevision, revocationEpoch, durableBarrierCompletedAt, bindingDigest}`，并执行 §20.2 fencing CAS。
- 同一 proof/ACK 的完全相同重试按持久 ledger 返回原结果；相同幂等键不同 body 返回 `idempotency_key_reused`，相同 sequence 不同请求返回 `device_proof_replayed`。

Desktop proof 成功后必须先持久化 activation fence，立即完成一次 fresh renewal，随后固定每 10 秒续租，请求超时 5 秒且 singleflight；续租响应先写加密 journal 和本地 operation lease fence，再清理 outbound request journal。服务端 `replayed:true` 或本地 journal 恢复只完成旧请求解歧，必须再用新 sequence 成功 fresh renewal 才允许继续文件 promotion。ACK 前停止 ticker、等待在途续租并完成最后一次 fresh renewal；ACK 一旦结果不明，只能精确重放同一 ACK，禁止再签发 heartbeat、renew 或其他请求。

所有设备签名请求共享一个 Main-only sequence lane。任何已持久化但尚无确定响应的 exact request 必须把 lane 锁定到其 semantic reference；心跳和其他请求不得越过它消耗更高 sequence，只有同一引用完成精确恢复并持久化响应后才可解锁。进程启动必须先扫描加密 outbound journal、恢复唯一 pending head，再启动 heartbeat；发现多个不相容 pending head、journal 损坏或安全存储不可用一律 fail-closed。

`desktop-commands/{operationId}/ack` 只用于 authorization cancel/reopen 的本地执行回执，使用 `Authorization: AiCRM-Command <commandTicket>` 加设备签名，body 固定为 `{operationId, purpose, expectedSessionRevision, result, completedAt, failureCode?}`，其中 purpose 为 `authorization_cancel | authorization_reopen`，result 为 `succeeded | failed | stale_target`。Cancel API 在签发 ticket 的同一事务先把 session 置为终态 cancelled 并禁止迟到 proof/promotion；ACK 只确认本地 App Server/staging 已清理，不得复活或再次迁移 session。Reopen ACK 只写审计和 operation 终态，不改变 session 状态。Verify/catalog/readiness/logout 分别使用其专用 proof/ACK 端点，不复用本端点。

上述 ticket/token 均设置精确 audience、session/executor/device、purpose、nonce、issuedAt、expiresAt 和 server key id；服务端只保存 token hash、消费状态和 request hash。响应使用 `Cache-Control: no-store`，代理、前端日志和持久缓存不得记录 token。Heartbeat、claim、proof、activation/revocation/desktop-command ACK、catalog、readiness 和 credential-verification 端点不使用用户 Bearer，也不接受 workspace Header 覆盖，workspace 从 session 与 binding 派生；registration、bind、rebind 和普通 unbind 按本节前述合同同时校验用户 Bearer、权限和设备 PoP，`force:true` unbind 是唯一无需设备签名的例外，但必须 owner + fresh-login + 二次确认 token + 高危审计。

Trusted-token key rotation 使用独立公钥环。`KY_AGENT_EXECUTOR_TRUSTED_TOKEN_KEY_ID` 与 `KY_AGENT_EXECUTOR_TRUSTED_TOKEN_PRIVATE_KEY` 只表示当前 active signer；`KY_AGENT_EXECUTOR_TRUSTED_TOKEN_KEYRING_FILE` 只保存最多 8 把 raw32 Ed25519 公钥、单调 revision、activeKid 及每把 key 的半开签名窗口。旧私钥不得保留；retired key 的 `verifyUntil` 必须精确等于 `signingNotAfter + 600s`。active 私钥派生公钥必须等于 keyring activeKid；签发时 `iat` 必须属于 active signing window，验签时还要校验 token `iat` 属于该 key 的窗口且当前时间早于 verifyUntil。重复 kid、未知字段、非 canonical base64url/UTC 秒、重叠窗口、revision 非正安全整数或公私钥不匹配均拒绝启动写平面。

公钥只通过独立只读接口 `GET /api/v1/public/ai-executor-trusted-token-keyring` 发布，不混入 platform-profile。响应固定包含 `schemaVersion=1`、issuer、revision、activeKid、DB 时钟 generatedAt、`refreshAfterSeconds=30`、`maxTokenLifetimeSeconds=600`、固定 Desktop audiences、按 kid 排序的 OKP/Ed25519 JWK 投影和覆盖上述安全字段的 keyringDigest；不得返回私钥、nonce secret、内部路径或配置。接口必须 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`，拒绝 query、Cookie、Authorization 和 workspace Header；keyring 未完整时返回 503。

Desktop Main 只能从后台 `webUrl` 的 HTTPS origin 获取 keyring；生产禁止把默认 loopback HTTP 当作根信任，禁止 redirect、Bearer、Cookie 和 workspace Header，并限制 5 秒/64 KiB。Main 用 safeStorage 加密持久化 `(origin,revision,keyringDigest)` 双高水位：revision 回退、同 revision 内容变化或 origin 静默切换均拒绝；unknown kid 最多强制刷新一次。compact JWS 必须本地执行 canonical base64url/JSON、精确 header、Ed25519、issuer/audience/purpose/TTL、key window、jti、registered device 和当前 target CAS 验证；`aicrm-operation-confirmation` 即使签名正确也不得进入 Desktop Bridge。Renderer 提供的 ticket 只作为待验密文，不能成为 executor/device/revision 真相。

Desktop 本地 logout 只能由服务端签发 audience=`aicrm-desktop-command`、purpose=`credential_logout`、绑定 executor/device/revocationId/credentialRevision/revocationEpoch/operationId、120 秒单次 compact JWS command ticket 触发。Bridge 先 CAS 校验 ticket 目标仍是本机 current revision 和 epoch；若已变化则不得触碰任何 revision，并以 stale-target 结果 ACK。匹配时先把只读 `revisions/<credentialRevision>` no-replace rename 到 quarantine 并完成 durable barrier，再从 quarantine 创建一次性 COW 副本执行 `account/logout`，最后销毁副本和 quarantine；绝不把 revision 目录挂载为可写。随后以 `Authorization: AiCRM-Command <ticket>` 加设备签名提交固定 body `{operationId, revocationId, credentialRevision, revocationEpoch, completedAt, quarantineDigest, result}`；服务端再次 CAS revision/epoch。任意 renderer 仅凭 executorId 不得删除凭据。Force revoke 在设备离线时先使服务端 binding 无效，并在设备下次 heartbeat 强制本地 quarantine。

Desktop 模型目录和 readiness 上行：

```text
POST /api/v1/ai-executors/{executorId}/model-catalog-snapshots
POST /api/v1/ai-executors/{executorId}/readiness-proofs
POST /api/v1/ai-executors/{executorId}/credential-verification-proofs
```

三者必须由绑定设备签名，并覆盖 executorId、deviceId、operationId、credential revision、account fingerprint、Codex version、catalog/readiness revision（适用时）、验证结果、时间和 body hash。Credential verification proof 固定 body 为 `{operationId, credentialRevision, accountFingerprint, checkedAt, authorized, failureCode?}`；只允许更新该 operation 目标 revision 的 credential/readiness 投影。Desktop 在 Agent task transport 完成前仍强制 `scriptMaintenanceReady=false`，但允许后台保存经过签名的模型目录和默认模型配置。

用户触发的 verify/catalog/readiness 结果还必须携带对应 operationId，并在 `Authorization: AiCRM-Command <commandTicket>` 下提交；服务端校验 pending operation、purpose 和 expected revision 后才消费。设备后台周期性 heartbeat/readiness 可只用设备签名，但只能更新观测态，不能修改默认模型、授权状态或其他配置。

### 20.4 `scriptMaintenanceReady` 判定式

该字段是执行器服务按 `(executorId, workspaceId, purpose, resolvedModelKey)` 实时计算的只读 API 投影，不持久化，也不接受客户端上报：

```text
executorType == codex
AND runtimeType == server                 # v9 首期
AND status == enabled
AND current workspace grant == enabled
AND credentialStatus == authorized
AND current credential/runtime binding 有效
AND readinessStatus == ready
AND server worker/task consumer heartbeat 未过期
AND allowScriptSave == true
AND effective model 存在于当前 catalog revision
AND effective model 与任务输入模态兼容
```

`resolvedModelKey` 先按 §4.2 解析；未解析出模型时本式为 false。自动修复还必须满足 `autoRepairEnabled=true`。达到最大并发时任务进入有界队列，不把 ready 改为 false；worker 心跳失效或队列被运维关闭时为 false。Desktop 在受信 task claim/lease/result 协议验收前无条件为 false。

### 20.5 Generation engine 与物理运行真相源

```text
generationEngine = legacy_provider | codex_executor
scriptPurpose = qr_login_prepare | qr_login_refresh | account_detect | session_check
operation = generate | repair | contract_test
taskType = credential_verify | model_catalog_refresh | readiness_check |
           script_generate | script_repair | script_contract_test

pending -> waiting_executor -> running -> completed
任一非终态 -> failed | cancelled | timeout
```

- 现有 `script_repair` 任务保持原值；additive migration 扩展 task_type check constraint，不重写历史任务。
- `operation` 到 taskType 的映射唯一为 `generate -> script_generate`、`repair -> script_repair`、`contract_test -> script_contract_test`；`scriptPurpose` 只表示四类业务脚本，不得塞入 operation/taskType。
- Executor task 不新增冗余 operation 列；operation 由不可变 taskType 唯一反推，现有 `purpose` 列固定保存 scriptPurpose。
- 新建 task 初始状态固定为 `pending`；`queued` 只属于 Matrix generation run。`waiting_user_scan` 仅为历史 task 兼容值，v9 上述 taskType 不得写入。
- `credential_verify | model_catalog_refresh | readiness_check` 是控制面 task，不关联 Matrix generation run，`generation_engine` 和脚本关联字段为空；后三类脚本 task 才使用同 ID generation run 合同。
- 现有脚本 additive backfill 为 `legacy_provider`。
- 新脚本仅在 cutover feature flag 开启后默认为 `codex_executor`。
- 迁移任务只在目标 executor eligible 后，逐脚本使用 expected revision CAS 切换。
- 一旦脚本切换为 `codex_executor`，生成、修复和契约测试 fail-closed，运行时不得回退 legacy provider。
- Active DSL 的实际浏览器执行始终不受 generation engine 影响。
- Version 和 task 固化当次 engine。

v9 以现有 `ky_ai_executor_task`、`ky_ai_executor_task_event`、`ky_ai_executor_task_raw_log` 为唯一物理运行存储；`runId = task.id`，`/ai-executor-runs` 只是安全投影。本轮不创建第二套 executor run/event/terminal 物理表，v8 run/task 命名归一另列技术债。

Codex 任务必须在 App Server `thread/start.params.model` 显式传入冻结的 `effectiveModelKey`。v9 不启动 TUI，不存在第二处模型解析。不得依赖 CODEX_HOME 或账号默认模型。App Server 拒绝该模型或目录修订已失效时，任务在执行前失败为 `executor_model_unavailable`。

### 20.6 跨服务异步生成合同

执行器服务内部接口：

```text
POST /internal/v1/executor-bindings/resolve
POST /internal/v1/executor-tasks
GET  /internal/v1/executor-tasks/{taskId}
GET  /internal/v1/executor-tasks/{taskId}/result
POST /internal/v1/executor-tasks/{taskId}/cancel
```

Matrix 脚本上下文使用独立的可信提交与内部读取合同：

```text
POST /api/v1/matrix-account-web-spaces/{webSpaceId}/script-context-snapshots
POST /api/v1/matrix-account-script-context-snapshots/{snapshotId}/desktop-proofs
GET  /internal/v1/matrix-account-script-context-snapshots/{snapshotId}
```

- 第一个 POST 是用户 Command，要求脚本 regenerate 权限、`expectedWebSpaceRevision` 和 Idempotency-Key，只创建 operation 并返回绑定设备/目标/用途/修订的一次性 Desktop ticket；不得接受 snapshot body。
- `desktop-proofs` 不使用普通 Bearer 或 workspace Header，必须同时校验 command ticket、设备签名、sequence/nonce/request ledger 和严格脱敏 schema；Renderer/Plugin 不得作为 proof 中继。
- 用户 Command body/response、Desktop proof body 和 30 分钟 TTL 严格使用 Matrix §5.12 的固定字段，未知字段拒绝。
- internal GET 只接受 Agent Executor internal token、`X-KY-Request-Id` 和 `X-KY-Executor-Task-Id: <runId>`；Matrix 校验该 generation run 冻结了同一 snapshot，只返回 Matrix §5.12 的安全投影，不返回截图、路径或原始浏览器内容。
- P1 shadow 阶段三条能力均保持 intake 关闭；建表不等于授权 Desktop 或 Agent 写入。

- 仅允许 loopback/受控内网，并校验 `X-KY-Internal-Token` 和 `X-KY-Request-Id`。
- Resolve 输入 workspace、script、scriptPurpose、operation、generationEngine、可选 executor/model；返回完整冻结 binding、唯一 taskType 或结构化错误。
- Matrix service 预生成全局 UUID `runId`，Create task 必须携带 `requestedTaskId=runId`、scriptPurpose、operation/taskType、Idempotency-Key 和已解析 binding revision；executor task 主键必须采用该 runId，返回 202 `{taskId: runId, status:"pending"}`。相同 ID 不同 request hash 返回冲突。
- 所有内部响应使用统一 envelope，禁止返回凭据、路径和原始输出。

矩阵服务新增 canonical 异步资源：

```text
POST /api/v1/matrix-account-web-spaces/{webSpaceId}/login-script/generation-runs
POST /api/v1/matrix-account-login-scripts/{scriptId}/generation-runs
POST /api/v1/matrix-account-login-script-contracts/{contractId}/tests
GET  /api/v1/matrix-account-login-script-generation-runs/{runId}
GET  /api/v1/matrix-account-login-script-generation-runs/{runId}/events
GET  /api/v1/matrix-account-login-script-generation-runs/{runId}/events-stream
GET  /api/v1/matrix-account-login-script-generation-runs/{runId}/terminal-frames
GET  /api/v1/matrix-account-login-script-generation-runs/{runId}/terminal-stream
POST /api/v1/matrix-account-login-script-generation-runs/{runId}/cancel
```

- WebSpace POST body 固定为 `{scriptPurpose, operation, generationReason, expectedWebSpaceRevision, contextSnapshotId?}`，operation 只允许 `generate|repair`。Script POST body 固定为 `{operation, generationReason, expectedScriptRevision, contextSnapshotId?}`，scriptPurpose 从脚本资源派生且调用方不得覆盖，operation 同样只允许 `generate|repair`。Contract test canonical 入口固定为 `/contracts/{contractId}/tests`，body 为 `{candidateVersionId, expectedScriptRevision, expectedContractRevision, contextSnapshotId?}`；服务端从 contract 与 candidate 派生 script/scriptPurpose，设置 generationReason=`contract_validation`，冻结 `contractId/contractRevision/targetVersionId`，operation 固定为 `contract_test`。GenerationReason 必须取 Matrix 需求 §5.6 已锁定枚举，未知值返回 validation_error。只有属于当前 workspace、同目标且已脱敏的 snapshot ID 可选；手动维护时 webSpaceId 可为空。
- 三个 canonical POST 都必须携带 Idempotency-Key，作用域为 `(actorId,targetType,targetId,key)`。Matrix 先解析 binding，再预生成 runId，并在同一事务创建 generation run、初始 event 和 task-dispatch outbox。相同 key/hash 返回同一 run；相同 key 不同 hash 返回 409。
- Outbox dispatcher 以同一个 runId 幂等创建 executor task。执行器暂时不可达时 run 保持 queued、`dispatchStatus=pending` 并重试；永久校验失败才 CAS 为 failed。API 不等待 task RPC，稳定返回 202 `{runId, status, dispatchStatus}`，因此不存在 nullable taskId 或 200/202 联合响应。
- Dispatch 状态机固定为 `pending -> dispatching -> dispatched`，任一非终态可进入 `cancelled | failed`。Dispatcher 以 CAS 抢占 pending（或 lease 已过期的 dispatching），写入 30 秒 dispatch lease、递增 attempt 后才调用内部 create；崩溃后由 reconciler 重置过期 claim 并以相同 runId 重试。
- 内部 cancel 必须先幂等 upsert `taskId` cancellation tombstone，再处理 task：task 未创建时返回 accepted；后续 create 在同一事务检查 tombstone并直接创建 cancelled task，绝不入 worker 队列。只要同 taskId 尚未物化 cancelled task，tombstone 的 `expires_at` 必须为 null、不得过期。物化后才可清理 tombstone，但 task request registry 以 taskId 为永久主键保存 request hash/final status，taskId 永不允许复用或重新入队。Create 已返回时 Matrix 必须重读 run；若业务 run 已 cancelled，立即写 cancel outbox 并把 dispatchStatus 收敛为 cancelled。Task worker 在 claim 和 running 前都检查 tombstone。因此 cancel/create 任意时序或 dispatcher 崩溃均不能留下可运行孤儿 task。
- Generation run 状态固定为 `queued -> running -> materializing -> succeeded`，任一非终态可进入 `failed | cancelled`；终态不可逆，所有迁移使用 revision CAS。
- Executor task 终态通过 transactional outbox/NATS 发布安全引用。`generate|repair` 成功时 Matrix consumer 拉取内部 result 并创建 candidate version；`contract_test` 成功时只创建契约测试记录并更新目标 candidate 的验证结果，绝不创建新 candidate。Candidate 只有在绑定同一 version/contract revision 的最近测试通过后才可 activate。
- NATS 丢失时 Matrix reconciler 按 runId（亦即 taskId）补查，保证最终收敛。
- Desktop onboarding 订阅该 run，成功后继续 candidate 执行和 LoginAttempt 流程；同一个 runId 关联 Matrix generation run、executor task、结构化事件、ANSI 投影、脚本版本，以及存在时的 WebSpace。
- Generation-run cancel body 固定为 `{expectedRevision}` 并要求 Idempotency-Key，作用域 `(actorId,runId,"cancel",key)`。Matrix 先在同一事务 CAS 非终态 run 为 cancelled 并写 event/cancel-outbox：task 尚未创建时 dispatcher 不再创建；已创建时以同 runId 幂等调用内部 cancel；迟到 task result 只记审计并不得创建 candidate。终态 cancel 重试返回当前 run，相同 key 不同 body 返回 409。
- 旧 `/login-script/generate` 在兼容发布周期仅服务 `legacy_provider` 同步链路；旧 `/matrix-account-login-scripts/{scriptId}/regenerate` 在同周期代理脚本 generation-runs 并原样返回 202。Codex 脚本必须使用 generation-runs；兼容期后两个旧入口返回 410，不返回混合 200/202 联合类型。

Generation-run 历史响应使用与 §20.9 相同的 `{data:{items,nextSequence,hasMore},requestId}` envelope；SSE event 固定为 `matrix.script-generation.changed`、终态 `matrix.script-generation.terminal` 和关闭 `matrix.script-generation.stream.closed`。资源 changed、terminal 与 reason=`terminal` 的 closed 都先持久化并各占唯一递增 sequence；Frame 固定为 `id:<sequence>`、上述 `event`、`data:{runId,sequence,occurredAt,run:<安全投影>}`，closed data 的 run 可省略但固定含 `{runId,sequence,reason}`。Last-Event-ID 优先于 after，15 秒心跳，终态后按更大 id 发送 terminal/closed 并断开；权限或 workspace 失效只发送无 id、非持久化的连接级关闭，重连返回 401/403。

### 20.7 路由权限与默认角色

| API/字段 | 权限 | 资源限制 |
|---|---|---|
| executor POST | `platform.ai_executors.create` | 平台 workspace；type/runtime 白名单 |
| executor GET、models GET、session 安全投影、events/SSE | `platform.ai_executors.view` | 平台 workspace |
| executor PATCH、defaultModelKey、workspace grant、catalog refresh、readiness check、credential verify | `platform.ai_executors.update` | expectedRevision；Desktop 签发 command ticket |
| session create(intent=authorize)、本人 user-action、cancel | view + `platform.ai_executors.authorize` | challenge 仅发起人；owner 可取消任意会话 |
| session create(intent=change_account)、普通 revoke | authorize + `platform.ai_executors.change_account` | 无活动任务 |
| force revoke | `platform.ai_executors.force_revoke` | owner、二次确认、高危审计 |
| device register/initial bind | `platform.ai_executors.bind_device` | 当前设备 proof-of-possession |
| rebind/unbind | `platform.ai_executors.rebind_device` | owner、二次确认 |
| signed heartbeat/catalog/readiness/proof | 设备签名，不接受普通 Web body | 必须匹配绑定设备/session |
| executor task list/detail/events/SSE/terminal | `platform.ai_executor_tasks.view` | 平台 workspace 安全投影 |
| executor task cancel | `platform.ai_executor_tasks.cancel` | expectedRevision、owner/admin |
| eligible executors/models GET | `<workspace>.matrix_account_login_scripts.view` | 仅安全 grant 投影 |
| script PATCH executorId | update + `assign_executor` | workspace grant |
| script PATCH modelKeyOverride | update + `assign_model` | resolved executor catalog |
| 同时修改 executor/model | update + 两个 assign 权限 | 原子校验和写入 |
| generation run create | view + `<workspace>.matrix_account_login_scripts.regenerate` | 当前 WebSpace/script；重新解析 binding |
| contract test create | view + `<workspace>.matrix_account_login_scripts.regenerate` | candidate、script、contract 同属当前 workspace 且 revision 匹配 |
| contract/test-runs GET | `<workspace>.matrix_account_login_scripts.view` | 当前 workspace 安全投影 |
| generation run GET/events/SSE/terminal | `<workspace>.matrix_account_login_scripts.view` | 当前 workspace；发起人或 workspace owner/admin |
| generation run cancel | `<workspace>.matrix_account_login_scripts.regenerate` | 发起人或 workspace owner/admin；终态幂等 |

默认角色 seed：platform_owner 拥有全部 executor 权限；platform_admin 除 force_revoke/rebind 外拥有管理、授权和任务权限；platform_operator 默认仅 view。Platform/agency/enterprise 的 owner/admin 默认拥有对应脚本 assign_executor/assign_model；operator、readonly 和 member 默认不拥有。rebind 和 force_revoke 仅 platform_owner。

### 20.8 Desktop Bridge 类型合同

Bridge 最低版本为 2：

```ts
interface CodexAuthorizationCapabilities {
  bridgeVersion: 2;
  supportsAppServerAuth: true;
  supportsDeviceProof: true;
  supportsSignedCatalog: true;
}

interface CodexAuthorizationStartInput {
  sessionId: string;
  executorId: string;
  handoffId: string;
  handoffTicket: string;
}

interface CodexSessionCommandInput {
  sessionId: string;
  operationId: string;
  expectedSessionRevision: number;
  commandTicket: string;
}

interface CodexVerifyCommandInput {
  executorId: string;
  operationId: string;
  expectedExecutorRevision: number;
  expectedCredentialRevision: number;
  commandTicket: string;
}

interface CodexModelCatalogRefreshCommandInput {
  executorId: string;
  operationId: string;
  expectedExecutorRevision: number;
  expectedCatalogRevision: number;
  commandTicket: string;
}

interface CodexReadinessCheckCommandInput {
  executorId: string;
  operationId: string;
  expectedExecutorRevision: number;
  expectedCredentialRevision: number;
  expectedCatalogRevision: number;
  commandTicket: string;
}

interface CodexCredentialLogoutCommandInput {
  executorId: string;
  revocationId: string;
  operationId: string;
  credentialRevision: number;
  commandTicket: string;
}

interface CodexAuthorizationSnapshot {
  sessionId: string;
  executorId: string;
  sequence: number;
  status: "starting" | "waiting_user" | "verifying" | "succeeded" |
    "failed" | "cancelled" | "expired" | "interrupted" | "superseded";
  canReopen: boolean;
  canCancel: boolean;
  localFailureCode?: string;
}
```

所有方法返回 `Promise<DesktopCommandResult<T>>`：

```text
window.aicrm.codex.authorization.getCapabilities()        Query
window.aicrm.codex.authorization.start(input)             Command
window.aicrm.codex.authorization.getSnapshot(sessionId)   Query
window.aicrm.codex.authorization.cancel(sessionCommand)   Command
window.aicrm.codex.authorization.reopen(sessionCommand)   Command
window.aicrm.codex.authorization.verify(verifyCommand)    Command
window.aicrm.codex.authorization.checkReadiness(readinessCommand) Command
window.aicrm.codex.authorization.getModelCatalog(executorId) Query
window.aicrm.codex.authorization.refreshModelCatalog(refreshCommand) Command
window.aicrm.codex.authorization.logout(logoutCommand)    Command
window.aicrm.codex.authorization.onChanged(listener)      -> unsubscribe
```

除 start 使用 handoff ticket 外，所有 Command 都必须校验服务端 compact JWS command ticket 的 audience、purpose、executor/session、deviceId、operationId、目标 revision、expiry 和单次消费状态；任意 renderer 仅凭 ID 不得触发。Cancel API、reopen API、readiness check、model refresh、credential verify 和 credential revoke 分别签发对应 purpose 的 ticket。事件 payload 为 snapshot 安全子集并带标准 envelope。类型契约放 `packages/ky-admin-core/src/ai-executor-desktop.ts`，运行时 adapter 放 `apps/ky-admin-host/src/desktop-client.ts`，插件只消费 Host 注入接口。能力缺失返回本地 `desktop_client_required`；版本小于 2 返回 `desktop_bridge_upgrade_required`。

### 20.9 SSE 线协议

事件历史响应固定为：

```json
{
  "data": { "items": [], "nextSequence": 12, "hasMore": false },
  "requestId": "req_xxx"
}
```

SSE frame：

```text
id: 12
event: authorization.session.changed
data: {"sessionId":"...","sequence":12,"occurredAt":"...","session":{...安全投影...}}
```

- 资源状态 changed、terminal 和 reason=`terminal` 的 closed 都先持久化为独立 session event，并各自占用下一个唯一 sequence/SSE id。终态发送 `authorization.session.terminal`，再以更大 id 发送 `authorization.stream.closed`；closed data 固定为 `{sessionId,sequence,reason:"terminal"}`，随后关闭。
- 心跳 15 秒；心跳不携带业务 payload。
- 同时存在 `Last-Event-ID` 与 `after` 时，以合法的 Last-Event-ID 为准；Header 缺失时才使用 after。
- 权限、登录态或 workspace 失效属于连接级关闭：发送不带 `id`、不持久化、不推进资源 sequence 的安全 closed reason 后断开；重连按标准 401/403，不能把某个观察者的权限变化写成所有观察者可回放的资源事件。
- Session 安全投影字段严格使用 §12.2 定义。

ANSI 投影的 task 与 generation-run 端点共用同一物理 `ky_ai_executor_task_raw_log.sequence`。渲染器必须把普通帧、task 终态和 stream closed 都写成独立 raw-log 行，形成唯一递增序列；不得临时复用最后一帧 ID：

投影行固定 `source=executor`、`direction=internal`，并在 `raw_json.projectionKind` 写 `ansi_frame|terminal|closed`；`terminal_line/raw_json` 只能含已脱敏投影。Canonical terminal API 只读取这三类行，绝不返回其他 codex/mcp/raw log。共享 sequence 允许因其他内部行出现间隙，但 cursor 只前进、不重编号。

```json
{
  "data": {
    "items": [{"sequence": 41, "kind": "frame", "encoding": "base64", "payload": "...", "byteLength": 128, "createdAt": "..."}],
    "nextSequence": 42,
    "hasMore": false
  },
  "requestId": "req_xxx"
}
```

```text
id: 41
event: executor.task.ansi-frame
data: {"runId":"...","sequence":41,"kind":"frame","encoding":"base64","payload":"..."}

id: 42
event: executor.task.terminal
data: {"runId":"...","sequence":42,"kind":"terminal","status":"completed"}

id: 43
event: executor.task.stream-closed
data: {"runId":"...","sequence":43,"kind":"closed","reason":"terminal"}
```

Matrix generation-run terminal 端点代理同一 runId raw-log，并把 event namespace 映射为 `matrix.script-generation.ansi-frame|terminal|stream-closed`，不复制物理数据。History/SSE 使用 `after`/Last-Event-ID、15 秒心跳及同样的资源终态关闭规则；权限/workspace 失效同样只做无 id、非持久化的连接级关闭。旧 `/ai-executor-runs/{runId}/terminal-*` 仅在兼容周期代理 canonical task 端点。

所有 history/SSE cursor 必须是非负十进制整数；格式非法、溢出或 Last-Event-ID 含多个值时，在建立 stream 前返回 400 `invalid_event_cursor`。Header 合法时优先于 query after；cursor 大于当前序列时允许等待后续事件，不回退或重放旧帧。

### 20.10 兼容投影和单写者切换

旧只读 `authStatus` 兼容映射：

```text
unknown/not_authorized/revoked -> not_authorized
authorized                     -> authorized
expired                        -> expired
首次授权活动会话               -> authorizing
重新授权活动会话               -> 继续 authorized
```

`authStatus` 永远不可写，保留一个发布周期后删除。旧 `capabilities` 只保留非敏感能力布尔值；删除 codexHome、statusText 和原始 probes。`authAccountLabel` 只返回脱敏摘要；`appServerListen` 兼容期固定安全值 `stdio://`，不再由前端配置。

- `/api/v1/ai-executors/codex` GET 在一个发布周期内代理平台默认执行器安全投影；PATCH 在新 UI 切换后返回 410。
- 旧 Desktop `codex.authorize` 一律返回 `desktop_bridge_upgrade_required`，不再启动旧登录流程；旧 `getAuthStatus` 仅可无参返回上述安全兼容投影，收到 `codexHome`、path 或其他旧参数时同样返回升级错误。
- Shadow read 阶段 `ky-ai-model-service` 是唯一写者，新 executor service 只读。
- Cutover 先 drain/freeze executor 写入，再切 DB role 写权限、Nginx 路由和后台 feature flag；之后 `ky-agent-executor-service` 成为唯一写者，禁止 dual-write。
- 旧 model-service executor handler 在兼容周期只做代理，周期结束返回 410。

### 20.11 HTTP 错误、Session failure 与幂等

HTTP `error.code` 用于请求级失败：permission/workspace、validation、conflict、not_found、runtime unsupported、proof invalid、device mismatch/offline、bridge required、App Server unavailable、model missing/unavailable、active tasks、idempotency key reused。

Session `failure.code` 只描述已创建会话终态：

```text
codex_binary_missing
app_server_start_failed
app_server_protocol_unsupported
browser_open_failed
device_code_unavailable
login_cancelled
session_deadline_exceeded
login_failed
verification_failed
desktop_disconnected
service_restarted
credential_commit_failed
device_proof_invalid
```

Cancel 对终态或已取消会话返回当前资源；revoke 对已 revoked 返回成功；同一 catalog/readiness refresh 返回当前 job；rebind 到同一设备幂等成功。相同 Idempotency-Key 不同 body 固定返回 409 `idempotency_key_reused`。

### 20.12 审计 outbox 与崩溃测试

- 授权会话关键迁移、credential promote/revoke、device bind/rebind/unbind 与审计 outbox 必须在同一数据库事务提交；force revoke 仍使用 `credential_revoked` 并标记 `force=true`。
- Outbox 消费按 eventId 幂等；高危状态事务无法写 outbox 时整体失败，不允许 best-effort 静默丢审计。
- 测试覆盖 FS rename 前后、DB prepared/active 提交前后、Desktop durable flush 前后断电、cancel/completed 竞态、Desktop ACK 中断、服务重启、设备重放、审计写失败和 quarantine 清理。
- 并发测试覆盖 task 运行时触发 verify/model refresh、token rotation、重新授权、普通 revoke 与 force revoke，证明 executor lease/COW/revocation epoch 不串凭据、不损坏 active revision，且 v9 第二个任务只能排队。
- Fencing 测试必须覆盖 owner 暂停超过 TTL、较大 leaseEpoch 接管、旧 owner 恢复并提交 task result/promotion/activation ACK，以及 force-revoke 与迟到 Desktop ACK 竞态；所有旧 epoch 写必须被 CAS 拒绝且无 outbox。
- 设备重放测试必须覆盖签名请求成功后服务重启再原包重放、同 sequence 不同 body/token、同 nonce 不同 sequence、并发乱序 sequence；只有完全相同请求可返回原 response reference。
- 不可变修订测试必须证明 verification/account logout 只写 COW/quarantine，prepared digest 与 activation ACK digest 不一致时拒绝 active。
- 敏感泄漏测试为每类 challenge/token/path 注入唯一 canary，并对 DB、日志、审计、SSE、Nginx、前端缓存和诊断包扫描精确 canary；不得用泛化关键词替代。
- OS 越权测试必须从 Codex Runtime 真实尝试读取 sibling executor home、服务环境文件和密钥路径，并确认 EACCES/不可见；还必须从同机其他 UID、控制面 UID 的非父进程和相邻 Runtime 尝试连接 App Server，并证明不存在可连接的 socket/port/pipe handle。

## 21. 验收矩阵

### 21.1 授权与信任

- 客户端点击后系统浏览器打开官方 URL，无需执行命令。
- 服务端结构化返回 URL 和验证码并自动监听。
- 普通浏览器、伪造状态、重放、跨设备和跨 executor proof 均被拒绝。
- 20 个并发请求只产生一个 session 和一个 App Server。
- App Server completed 但 account/read 未确认时不提升凭据。
- Desktop 未完成 durable barrier 或未提交 activation ACK 时不激活凭据；ACK 重放只作用于同一 revision。
- 取消、过期、重启、Desktop 退出均进入确定终态。
- 更换账号失败保留旧 credential revision。
- 所有 Desktop Command 都需要与 operation、device 和目标 revision 绑定的一次性服务端 ticket；裸 ID 调用被拒绝。

### 21.2 安全、状态与恢复

- 两个执行器不能互相发现或使用凭据。
- 子进程非 root，环境无数据库、内部 token、AI 密钥及全局认证变量。
- App Server 授权期和任务期都只有 stdio，不存在可从 host/loopback/内网连接的 socket。
- Active credential revision 只读；并发 task/verify/model refresh 由单执行器 lease + COW 串行化，token rotation 不破坏旧 revision。
- 恶意 URL 不会打开。
- 全库、日志、审计、Nginx、前端缓存扫描敏感 challenge、Token、路径和原始输出命中数为 0。
- 登录成功但模型、额度或网络不可用时保持 authorized，仅 readiness 降级。
- 迟到 completion 不复活终态 session；interrupted 可按规则恢复。
- SSE 断线、刷新和多标签页恢复同一 session。

### 21.3 模型、脚本、权限和通信

- 脚本覆盖模型优先于执行器默认；无覆盖时准确继承。
- 缺失或不可用时明确阻断，不回退全局 API 模型。
- 切换执行器时不兼容模型必须清空或重选。
- 任务创建后修改配置不改变冻结结果。
- Matrix generation run.id 与 executor task.id 相同；只有 task/event/raw-log 三张执行物理表，事件可在重启后按 sequence 回放。
- 历史 model_id 和 active DSL 不变。
- 不具备 scriptMaintenanceReady 的 Desktop 执行器不出现在 eligible 列表。
- Agency/enterprise 只能读取已发布安全摘要，越权 API 被后端拒绝。
- Desktop event 具备 snapshot、envelope、sequence 幂等、unsubscribe 和完整 cleanup。
- 非 Desktop Web 明确降级且不调用 IPC。

## 22. 锁定判定

以下条件全部满足即可锁定：

1. Phase 1 历史基线不被回写，v9 覆盖关系明确。
2. `ky-agent-executor-service` 服务归属明确。
3. Codex modelKey 与 `ky_ai_model.id` 完全分离。
4. 授权会话、凭据和 readiness 状态分离。
5. 设备信任、专属目录和进程安全边界闭合。
6. API、权限、IPC/SSE、迁移和验收无未决二选一。
7. Desktop 无任务传输时不会错误发布为脚本可选执行器。

上述条件已于 2026-07-10 经架构、API/权限/IPC/SSE、安全与恢复复审全部通过，本方案正式锁定。
