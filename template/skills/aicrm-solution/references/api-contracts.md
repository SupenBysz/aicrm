# API 契约规范

本规范用于新增或修改前后端 API、插件请求、服务 handler、响应结构、错误码、分页、批量操作和工作区上下文。

## 通用约定

API 前缀固定：

```text
/api/v1
```

默认请求格式：

```text
Content-Type: application/json
Accept: application/json
```

登录后接口必须携带：

```text
Authorization: Bearer <token>
```

工作区内接口必须携带：

```text
X-KY-Workspace-Id: <workspaceId>
X-KY-Workspace-Type: <platform|agency|enterprise>
X-KY-Request-Id: <uuid>
```

公共接口例外：登录、注册、邀请 token 查询、接受邀请、公开系统配置。

## 响应结构

成功响应：

```json
{
  "data": {},
  "requestId": "req_xxx"
}
```

列表响应：

```json
{
  "data": {
    "items": [],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 0
    }
  },
  "requestId": "req_xxx"
}
```

错误响应：

```json
{
  "error": {
    "code": "permission_denied",
    "message": "当前后台身份无权执行该操作",
    "details": {}
  },
  "requestId": "req_xxx"
}
```

## 错误码

优先使用已定义错误码：

```text
unauthorized
permission_denied
workspace_required
workspace_forbidden
not_found
validation_error
conflict
rate_limited
internal_error
```

新增错误码前确认：

- 是否已有等价错误码。
- HTTP status 是否稳定。
- 前端是否需要特殊处理。
- 是否会暴露敏感实现细节。

## 路径与服务归属

- 认证、用户、bootstrap 归 `ky-auth-service`。
- 机构、企业、部门、团队、系统设置、字典归 `ky-org-service`。
- 成员、邀请、角色、权限、数据范围、审计、通知公告归 `ky-membership-service`。
- API Provider、API 模型及其平台默认配置归 `ky-ai-model-service`。
- 矩阵账号、LoginAttempt、脚本、契约、generation run、绑定和 receipt 归 `ky-matrix-account-service`。
- 执行器、workspace grant、授权、executor-bound device、credential、catalog、readiness 和 executor task 归 `ky-agent-executor-service`。

路径必须表达资源归属：

```text
/api/v1/platform/users
/api/v1/platform/agencies
/api/v1/agency/enterprises
/api/v1/workspace/members
/api/v1/roles
/api/v1/notifications
/api/v1/ai-models/providers
/api/v1/matrix-account-login-attempts
/api/v1/ai-executors
```

服务之间不得通过公共 Bearer API 或私表完成内部协作。受控 internal API 使用 `/internal/v1`，只允许 loopback/受控内网，并校验 internal credential 和 `X-KY-Request-Id`。跨服务 ID 只作为 opaque reference，internal response 也使用统一 envelope，禁止返回凭据、路径和原始运行输出。

## Command、幂等与并发

会产生状态变化、异步任务或高成本副作用的 Command 必须：

- 携带 `Idempotency-Key`，并持久化作用域、规范化 request hash 和原响应引用。
- 相同 key/hash 返回原结果；相同 key 不同 hash 返回 409 `idempotency_key_reused`。
- 更新已有资源时携带 `expectedRevision` 并使用数据库 CAS；冲突返回当前安全投影。
- 异步创建稳定返回 202 和持久资源 ID，不等待 worker，也不返回 nullable task ID 或 200/202 联合类型。
- 取消先持久化终态或 cancellation tombstone，再执行 best-effort 运行时终止；迟到结果不能复活资源。

Desktop 设备签名请求使用其独立的 key-generation、sequence、nonce 和 request-hash ledger；不能用用户 `Idempotency-Key` 替代防重放。

## History 与 SSE

- 持久事件对 `(resource_id, sequence)` 唯一，状态、sequence、事件和 outbox 同事务提交。
- History 使用非负 `after` 和 `{items,nextSequence,hasMore}`；SSE 使用 `Last-Event-ID` 优先于 `after`。
- SSE 由 Host request client 注入认证和 workspace Header，禁止把 token 放进 URL。
- 资源终态发送持久 terminal/closed 事件后断开；权限或 workspace 失效只发送无 ID 的连接级关闭。
- 断线后必须能从数据库按 cursor 回放；NATS 或内存监听器不能成为 history 真相源。

## 安全投影与 Desktop Command

- 普通 Web API 不接受 `authorized`、`verified`、任意 path、Cookie、Storage、Token、原始 probe 或原始 App Server/CLI 输出。
- 本地写操作必须使用服务端签发的短期单次 Command Ticket，绑定 audience、purpose、operation、device、目标 revision 和 expiry。
- 设备 proof/ACK 必须覆盖规范化请求并由设备私钥签名；服务端从已持久 operation 派生 actor/workspace，不能信任 Renderer 自报。
- 设备 proof、workspace grant 和 actor permission 是独立校验，任何一项不能替代其他项。

## 查询与分页

列表接口：

- 使用 `page`、`pageSize`。
- 筛选字段使用稳定命名，不把 UI 文案作为参数。
- 查询只在用户点击查询或明确触发时发起，避免无意识实时请求造成压力。
- 后端分页必须在数据范围过滤之后计算 `total`。

## 批量操作

批量操作必须：

- 接收明确 ID 列表，不从当前筛选条件隐式全选。
- 返回成功、失败和失败原因摘要。
- 对每个资源执行权限和数据范围校验。
- 记录审计日志，至少记录 actor、workspace、action、resourceIds、result。

## 契约检查

新增或修改 API 前回答：

- 所属服务是否正确？
- 是否需要 workspace header？
- 是否遵循统一响应结构？
- 是否使用统一错误码？
- 是否执行权限和数据范围校验？
- 是否同时校验所需 workspace grant、设备 proof 和目标 revision？
- Command 是否有持久幂等、request hash、CAS 和确定的取消合同？
- SSE 是否可认证、可回放且不使用 URL token？
- internal API 是否受控且未泄露私表、凭据、路径或原始输出？
- 前端 request client 是否统一注入 token、workspace 和 requestId？
- 文档、类型、测试或 smoke 是否同步更新？
