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
- AI 供应商、AI 模型、默认模型配置归 `ky-ai-model-service`。

路径必须表达资源归属：

```text
/api/v1/platform/users
/api/v1/platform/agencies
/api/v1/agency/enterprises
/api/v1/workspace/members
/api/v1/roles
/api/v1/notifications
/api/v1/ai-models/providers
```

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
- 前端 request client 是否统一注入 token、workspace 和 requestId？
- 文档、类型、测试或 smoke 是否同步更新？
