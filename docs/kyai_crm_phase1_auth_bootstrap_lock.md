# KyaiCRM Phase 1.4 Auth / Bootstrap 锁定记录

> 文档状态：已锁定 / Phase 1.4 实现输入  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-15  

---

## 1. 锁定范围

本次锁定范围为 KyaiCRM Phase 1.4 Auth / Bootstrap 实现需求。

基线文档：

```text
docs/kyai_crm_phase1_auth_bootstrap_requirements.md
```

相关已锁定前置基线：

```text
docs/kyai_crm_multi_tenant_identity_requirements.md
docs/kyai_crm_api_contracts.md
docs/kyai_crm_data_model.md
docs/kyai_crm_permission_matrix.md
docs/kyai_crm_phase1_skeleton_lock.md
ops/db/*.sql
```

---

## 2. 本阶段锁定目标

Phase 1.4 的目标是打通：

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

---

## 3. 已锁定关键决策

### 3.1 Auth API

实现：

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
GET  /api/v1/auth/bootstrap
```

### 3.2 Credential 语义

第一轮密码登录统一使用：

```text
credential_type = password
```

`identifier` 可为：

```text
username / email / phone
```

`credential_type = email` / `phone` 暂保留给后续验证码、免密或验证类凭据。

### 3.3 Token 与 session

token 使用 HMAC 签名，payload 至少包含：

```text
userId
sessionId
exp
```

登录后接口必须校验：

```text
token 签名
token exp
ky_user_session.status = active
ky_user_session.expires_at 未过期
```

logout 后 revoked session 不得继续访问登录后接口。

### 3.4 Bootstrap

Bootstrap 返回每个 workspace 的：

```text
workspace id/type/name
membershipId
roles: [{ id, code, name }]
permissions
actionPermissions
menuKeys
dataScopes
```

### 3.5 前端契约

已对齐：

```text
packages/ky-admin-core/src/index.ts
apps/ky-admin-host/src/plugin-request-client.ts
```

`WorkspaceIdentity.roles` 使用对象数组，且包含 `dataScopes`。

request client 必须解析 `{ data, error, requestId }`，并注入：

```text
Authorization
X-KY-Workspace-Id
X-KY-Workspace-Type
X-KY-Request-Id
```

### 3.6 开发登录

本地 / 测试默认登录：

```text
account: platform_owner
password: admin123456
```

`ops/db/008_seed.sql` 保留 `CHANGE_ME_HASH` 占位。真实登录验收前必须运行：

```text
scripts/seed_dev_data.sh
```

生成 bcrypt hash 并 upsert 开发凭据。

---

## 4. 复审结论

最终复审结果：

```text
NO BLOCKERS
```

已验证：

```text
go test ./services/ky-auth-service/...
```

通过。

---

## 5. 后续任务

下一步进入实现阶段：

```text
#68 实现 ky-auth-service 认证能力
#69 实现后台 Auth 前端流程
#70 复审并验证 Auth Bootstrap
```
