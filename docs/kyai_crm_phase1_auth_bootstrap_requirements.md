# KyaiCRM Phase 1.4 Auth / Bootstrap 实现需求

> 文档状态：已锁定 / Phase 1.4 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.4 / Auth 与 Bootstrap  
> 编写日期：2026-06-15  
> 前置基线：Phase 1 文档基线、工程骨架基线、数据库 schema/seed 基线  

---

## 1. 阶段目标

本阶段目标是打通后台启动的第一条核心链路：

```text
注册 / 登录
  ↓
获取 token
  ↓
调用 bootstrap
  ↓
返回用户可进入的后台身份
  ↓
前端选择 workspace
  ↓
进入对应后台工作台
```

完成后系统应具备：

1. 用户可以注册。
2. 用户可以登录。
3. 登录后可以获取当前用户。
4. 登录后可以调用 bootstrap。
5. bootstrap 返回平台 / 机构 / 企业后台身份。
6. bootstrap 返回每个身份的 workspace、membership、roles、permissions、actionPermissions、menuKeys、dataScopes。
7. 前端可以保存 session。
8. 前端可以根据 bootstrap 判断无身份、单身份、多身份。
9. 前端可以选择 workspace 并进入对应工作台。

---

## 2. 本阶段范围

### 2.1 后端范围

主要服务：

```text
services/ky-auth-service
```

实现 API：

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
GET  /api/v1/auth/bootstrap
```

辅助读取表：

```text
ky_user
ky_user_credential
ky_user_session
ky_login_log
ky_membership
ky_membership_role
ky_role
ky_role_permission
ky_permission
ky_role_data_scope
ky_agency
ky_enterprise
```

第一轮允许 `ky-auth-service` 直接读取 membership / role / permission / organization 表以完成 bootstrap 聚合；后续服务边界强化时可改为服务间调用。

### 2.2 前端范围

主要应用：

```text
apps/ky-admin-host
```

实现页面：

```text
/login
/register
/workspace/select
/no-workspace
/403
/w/:workspaceType/:workspaceId/workbench
```

前端 session key：

```text
ky.admin.session.v1
```

### 2.3 不做范围

本阶段不做：

```text
机构管理页面
企业管理页面
成员管理页面
权限中心页面
AI 配置页面
通知页面
审计页面
系统设置页面
CRM 业务
AI 员工
AI 执行器
AI 工作流
IM
移动端
```

---

## 3. 后端详细需求

### 3.1 配置读取

`ky-auth-service` 必须读取：

```text
KY_AUTH_SERVICE_HTTP_ADDR
KY_TENANT_DATABASE_URL
KY_AUTH_TOKEN_SECRET
KY_RUNTIME_ENV_FILE
```

要求：

1. 支持 env file 加载，`KY_RUNTIME_ENV_FILE` 指向的文件中 `KEY=value` 应被加载到进程环境。
2. 支持 PostgreSQL 连接。
3. `config.Config` 必须显式包含 `AuthTokenSecret` 字段。
4. 缺少 `KY_AUTH_TOKEN_SECRET` 时登录、token 签发和 token 校验不可用。
5. `/readyz` 应能体现数据库连接和必要配置状态；至少返回服务名、数据库是否可连接、token secret 是否已配置。

### 3.2 数据访问层

新增目录：

```text
services/ky-auth-service/internal/store/
```

建议文件：

```text
db.go
user_store.go
auth_store.go
bootstrap_store.go
```

职责：

- `db.go`：建立 pgx pool、关闭连接、ping database。
- `user_store.go`：创建用户、按账号查用户、按 ID 查用户、更新 last_login_at。
- `auth_store.go`：创建 credential、查询 credential、创建 session、注销 session、写 login log。
- `bootstrap_store.go`：查询 memberships、roles、permissions、dataScopes、workspace 名称。

### 3.3 密码处理

建议新增：

```text
services/ky-auth-service/internal/auth/password.go
```

接口：

```go
HashPassword(password string) (string, error)
VerifyPassword(hash string, password string) bool
```

第一轮明确使用：

```text
golang.org/x/crypto/bcrypt
```

不得使用明文、可逆加密或简单 SHA 作为最终登录密码校验方案。必须封装 `HashPassword` / `VerifyPassword`，便于测试和后续参数调整。

### 3.4 Token 处理

建议新增：

```text
services/ky-auth-service/internal/auth/token.go
```

第一轮可实现自定义 HMAC token。

Token payload：

```json
{
  "userId": "user_xxx",
  "sessionId": "session_xxx",
  "exp": 1234567890
}
```

要求：

1. 使用 `KY_AUTH_TOKEN_SECRET` 签名。
2. token 至少包含 user id、session id、过期时间。
3. 登录返回 token、expiresAt、user。
4. 登录后接口通过 `Authorization: Bearer <token>` 认证。
5. token 过期或签名错误返回 401。

---

## 4. Auth API 需求

### 4.1 注册

```text
POST /api/v1/auth/register
```

请求：

```json
{
  "displayName": "张三",
  "email": "zhangsan@example.com",
  "phone": "13800000000",
  "password": "password"
}
```

需求：

1. 校验 password 非空。
2. email / phone 至少一个存在。
3. 创建 `ky_user`，写入 `email`、`phone` 中已提供的字段；`username` 第一轮由服务端生成，可优先使用 email 前缀或 user id，外部注册 API 不接收 username。
4. 按锁定数据模型创建 `ky_user_credential`：
   - 第一轮密码登录统一使用 `credential_type = password` 存储密码哈希。
   - 提供 email 时，创建 `credential_type = password`、`identifier = email` 的凭据。
   - 提供 phone 时，创建 `credential_type = password`、`identifier = phone` 的凭据。
   - 多个登录标识可以共用同一个 password hash。
   - `credential_type = email` / `phone` 暂保留给后续验证码、免密或验证类凭据，不在第一轮密码登录中使用。
5. 创建 `ky_user_session`。
6. 返回 token。
7. 写 login log，可选。

响应：

```json
{
  "data": {
    "userId": "user_xxx",
    "token": "xxx",
    "expiresAt": "..."
  },
  "requestId": "req_xxx"
}
```

### 4.2 登录

```text
POST /api/v1/auth/login
```

请求：

```json
{
  "account": "platform_owner",
  "password": "password"
}
```

需求：

1. 支持 username / email / phone 登录。
2. 查询 credential。
3. 校验用户状态。
4. 校验密码。
5. 创建 session。
6. 更新 last_login_at。
7. 写 login log。
8. 返回 token 和用户摘要。

响应：

```json
{
  "data": {
    "token": "xxx",
    "expiresAt": "...",
    "user": {
      "id": "user_xxx",
      "displayName": "平台管理员",
      "avatarUrl": ""
    }
  },
  "requestId": "req_xxx"
}
```

### 4.3 登出

```text
POST /api/v1/auth/logout
```

需求：

1. 解析 token。
2. 根据 token 内的 `sessionId` 查询 `ky_user_session`。
3. 将 session 状态置为 `revoked`。
4. 返回 success。

安全要求：所有需要登录的接口在校验 token 签名和过期时间后，必须继续校验 token 对应的 `ky_user_session.status = active` 且 `expires_at` 未过期；已 logout 的 revoked session 不得继续访问 `me`、`bootstrap` 或其他登录后接口。

### 4.4 当前用户

```text
GET /api/v1/auth/me
```

需求：

1. 解析 token。
2. 查询用户。
3. 返回当前用户信息。

### 4.5 Bootstrap

```text
GET /api/v1/auth/bootstrap
```

响应结构：

```json
{
  "data": {
    "user": {},
    "workspaces": [],
    "recommendedWorkspaceId": null
  },
  "requestId": "req_xxx"
}
```

每个 workspace：

```json
{
  "id": "platform_root",
  "type": "platform",
  "name": "平台后台",
  "membershipId": "mem_platform_owner",
  "roles": [
    {
      "id": "role_platform_owner",
      "code": "platform_owner",
      "name": "平台超级管理员"
    }
  ],
  "permissions": ["platform.users.view"],
  "actionPermissions": ["platform.users.disable"],
  "menuKeys": ["menu.platform.users"],
  "dataScopes": [
    {
      "scopeType": "all"
    }
  ]
}
```

聚合规则：

1. 从 `ky_membership` 查询用户 active memberships。
2. 每个 membership 对应一个 workspace。
3. `workspace_type` 只能是 `platform`、`agency`、`enterprise`。
4. workspace name：
   - platform：固定 `平台后台`
   - agency：查 `ky_agency.name`
   - enterprise：查 `ky_enterprise.name`
5. roles 从 `ky_membership_role` + `ky_role` 查询。
6. permissions 从 `ky_role_permission` + `ky_permission` 查询。
7. 分类规则：
   - `category = menu` → `menuKeys`
   - `category = page` → `permissions`
   - `category = action` → `actionPermissions`
8. dataScopes 从 `ky_role_data_scope` 查询。
9. 不同 workspace 权限必须隔离。
10. `disabled` / `left` membership 不返回。

---

## 5. API 通用响应需求

成功响应：

```json
{
  "data": {},
  "requestId": "req_xxx"
}
```

错误响应：

```json
{
  "error": {
    "code": "unauthorized",
    "message": "未登录或 token 无效",
    "details": {}
  },
  "requestId": "req_xxx"
}
```

需要实现 helper：

```text
writeJSON
writeError
requestId
```

request id 来源：

1. 优先读取 `X-KY-Request-Id`。
2. 没有则生成一个简单 ID。

---

## 6. 前端详细需求

### 6.1 页面

#### `/login`

功能：

1. 输入账号和密码。
2. 调用 `POST /api/v1/auth/login`。
3. 保存 session 到 `ky.admin.session.v1`。
4. 登录后调用 bootstrap。
5. 根据身份数量跳转：
   - 0：`/no-workspace`
   - 1：对应 workspace workbench
   - 多个：`/workspace/select`

#### `/register`

功能：

1. 输入 displayName、email、phone、password。
2. 调用 `POST /api/v1/auth/register`。
3. 保存 token。
4. 调用 bootstrap。

#### `/workspace/select`

功能：

1. 展示 bootstrap 返回的 workspace 列表。
2. 点击进入对应工作台。

#### `/no-workspace`

展示：

```text
当前账号暂无可进入的后台身份，请联系管理员邀请加入平台、机构或企业。
```

#### `/403`

展示：

```text
当前后台身份无权访问该页面。
```

#### 工作台占位页

路由：

```text
/w/platform/platform_root/workbench
/w/agency/:agencyId/workbench
/w/enterprise/:enterpriseId/workbench
```

展示：

- 当前 workspace type。
- 当前 workspace id。
- 当前 workspace name。
- 当前角色。
- menuKeys 数量。
- permissions 数量。
- actionPermissions 数量。

### 6.2 前端状态

完善：

```text
apps/ky-admin-host/src/app-store.ts
```

状态：

```text
session
user
workspaces
currentWorkspace
```

方法：

```text
loadSession
saveSession
clearSession
setBootstrap
selectWorkspace
```

### 6.3 API client

完善：

```text
apps/ky-admin-host/src/plugin-request-client.ts
```

要求：

1. 自动加 `Authorization`。
2. 自动加 `X-KY-Workspace-Id`。
3. 自动加 `X-KY-Workspace-Type`。
4. 自动加 `X-KY-Request-Id`。
5. 统一解析 `{ data, error, requestId }`。
6. 错误时抛出可展示错误。

### 6.4 路由守卫

第一轮实现基础守卫：

1. 无 session 访问工作区页面 → `/login`。
2. 有 session 但无 workspace → `/workspace/select` 或 `/no-workspace`。
3. workspace 不存在 → `/workspace/select`。
4. 权限级守卫后续接入。

---

## 7. 数据库前置要求

在实现 Auth / Bootstrap 前，数据库至少要有：

```text
schema 已执行
seed 已执行
platform_owner 用户存在
platform_root membership 存在
platform_owner role 存在
权限 seed 存在
```

`008_seed.sql` 当前使用：

```text
CHANGE_ME_HASH
```

本阶段必须补齐一个可复现的开发凭据方案：

- 开发账号：`platform_owner`
- 开发密码：`admin123456`
- 适用范围：仅本地 / 测试环境
- 生成方式：由 `scripts/seed_dev_data.sh` 在 Auth 实现阶段调用 bcrypt 生成 hash，并更新或插入 `ky_user_credential`。

`ops/seed/README.md` 必须记录以上开发凭据约定。生产环境必须替换密码并重新生成 hash。

验收时不得依赖未替换的 `CHANGE_ME_HASH` 完成真实登录；真实登录验收前必须先运行开发 seed 或手动替换 hash。

---

## 8. 验收标准

### 8.1 后端验收

```text
go test ./services/ky-auth-service/...
ky-auth-service 可启动
GET /readyz 返回 ok
POST /api/v1/auth/login 可返回 token
GET /api/v1/auth/me 可返回当前用户
GET /api/v1/auth/bootstrap 可返回 workspaces
```

### 8.2 前端验收

```text
pnpm --filter @ky/admin-host typecheck
pnpm --filter @ky/admin-host build
/login 页面可访问
/workspace/select 页面可访问
/w/platform/platform_root/workbench 页面可访问
```

### 8.3 集成验收

在已执行 schema/seed 的数据库上：

1. 使用 `platform_owner` 登录。
2. 获得 token。
3. 调用 bootstrap。
4. 返回 `platform_root` workspace。
5. 返回 `platform_owner` role。
6. 返回 `menu.platform.*` menuKeys。
7. 返回 `platform.*` permissions。
8. 前端进入 `/w/platform/platform_root/workbench`。

---

## 9. 风险与约束

### 9.1 密码哈希

当前 seed 里是：

```text
CHANGE_ME_HASH
```

需要在 Auth 实现时处理开发密码。

### 9.2 服务边界

Bootstrap 需要读 membership / role / permission / organization 表。第一轮允许 auth service 直接读表以跑通链路；后续再拆为 `ky-auth-service` 调用 `ky-membership-service` 和 `ky-org-service`。

### 9.3 Token 方案

自定义 HMAC token 足够第一轮使用，但后续可替换 JWT。

---

## 10. 推荐执行顺序

```text
1. 锁定当前 schema/seed 基线记录
2. 在 ky-auth-service 增加数据库连接
3. 在 ky-auth-service 增加 auth/token/password 工具
4. 实现 POST /api/v1/auth/register
5. 实现 POST /api/v1/auth/login
6. 实现 GET /api/v1/auth/me
7. 实现 GET /api/v1/auth/bootstrap
8. 实现 POST /api/v1/auth/logout
9. 前端完善 API client/session store
10. 前端实现 login/register/workspace-select/no-workspace/workbench 页面
11. 前端接入 bootstrap 跳转
12. 复审并修复
13. 运行后端和前端构建验证
14. 锁定 Auth / Bootstrap 阶段
```

---

## 11. 完成定义

本阶段完成后，KyaiCRM 将从“工程骨架”进入“可登录、可识别多后台身份、可进入工作区”的状态。

完成定义：

```text
用户能登录
系统能识别用户有哪些后台身份
前端能根据身份进入平台/机构/企业后台工作台
权限和菜单能在 bootstrap 中返回
```
