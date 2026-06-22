# KyaiCRM Phase 1.6 成员与邀请实现锁定记录

> 文档状态：已锁定 / Phase 1.6 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
services/ky-membership-service
```

依赖前置基线：Phase 1 文档基线、工程骨架、数据库 schema/seed、Phase 1.4 Auth/Bootstrap、Phase 1.5 组织主体管理。

---

## 2. 已实现接口

```text
GET    /api/v1/workspace/members
GET    /api/v1/workspace/members/:id
PATCH  /api/v1/workspace/members/:id/status
DELETE /api/v1/workspace/members/:id
POST   /api/v1/workspace/members/:id/departments
POST   /api/v1/workspace/members/:id/teams

GET    /api/v1/invitations
POST   /api/v1/invitations
PATCH  /api/v1/invitations/:id/cancel

GET    /api/v1/public/invitations/:token
POST   /api/v1/public/invitations/:token/accept
```

并保留 `GET /readyz`、`GET /healthz`。

---

## 3. 实现要点

### 3.1 结构

```text
internal/config/config.go     env 加载 + AuthTokenSecret
internal/auth/token.go        与 ky-auth-service 一致的 HMAC token 校验
internal/store/db.go          pgx 连接 + active membership 查询 + 错误分类
internal/store/member_store.go
internal/store/invitation_store.go
internal/server/*.go          中间件 + 成员/邀请/公开邀请 handler
```

### 3.2 鉴权与工作区

- 登录后接口经 `ws()` 中间件：Bearer token（HMAC+exp）+ 工作区 Header + 工作区类型 gating + active membership 校验。
- 公开邀请接口（查询 / 接受）不鉴权。
- 分配部门 / 团队仅 `agency` / `enterprise` 工作区允许；其余成员接口三类工作区可用。

### 3.3 数据隔离

- 成员、邀请均按当前工作区 `workspace_type/workspace_id` 隔离。
- 越权读取返回 not_found。
- 不能移除当前登录身份对应 membership。

### 3.4 邀请目标策略

```text
member            目标必须为当前工作区
agency_admin      仅平台后台，目标为机构
enterprise_admin  平台后台或“拥有该企业的机构”，目标企业必须属于当前机构
```

### 3.5 接受邀请

- 事务内校验 pending 且未过期；过期则置 expired 并返回 410 gone。
- 复用或创建目标工作区 membership（active）。
- 应用 preset 角色 / 部门 / 团队（幂等 ON CONFLICT）。
- 邀请置 accepted，记录 accepted_user_id / accepted_at。

### 3.6 复审修复项

- 公开邀请查询返回 `presetRoles`（`{id,name}` 对象数组），与契约一致。
- 公开邀请查询对过期 pending 邀请返回 410 gone（requirement 5.10）。
- 分配部门 / 团队引用不存在时返回 400 validation_error（区分于数据冲突）。

---

## 4. 验证结果

```text
go build ./services/ky-membership-service/...   通过
go vet  ./services/ky-membership-service/...     通过
go test ./services/ky-membership-service/...     通过
```

单元测试覆盖：

```text
邀请目标策略（member / agency_admin / enterprise_admin 组合）
工作区类型 gating 与 status 校验
preset jsonb 往返序列化
关联 ID 拆分
```

复审结论：阻塞项已全部修复（presetRoles 结构、过期 gone、引用校验），其余复审意见经核为非阻塞（`invited_by_membership_id` 由中间件保证有效、ErrGone 已映射 410、membership 复用语义正确）。

```text
NO BLOCKERS
```

---

## 5. 部署一致性

`ops/native/ky-admin-host.nginx.conf` 已将以下路由反代到 `127.0.0.1:18083`：

```text
/api/v1/workspace/members
/api/v1/invitations
/api/v1/public/invitations
```

ON CONFLICT 目标与 schema 唯一索引一致：

```text
ky_membership_department (membership_id, department_id)
ky_membership_team       (membership_id, team_id)
ky_membership_role       (membership_id, role_id)
```

---

## 6. 外部环境与后续硬化

1. 真实端到端验收需要 `KY_TENANT_DATABASE_URL` + 已执行 schema/seed + 有效登录 token。
2. 公开接受邀请的 `userId` 信任问题为后续硬化项：应改为接受人登录态校验，确保 `userId` 与登录用户一致。
3. page/action 级权限校验在 Phase 1.7 接入。
4. 写操作审计 hook 在 Phase 1.8 补全。

---

## 7. 后续阶段

```text
Phase 1.7 权限中心与数据范围（Access API：roles/permissions/memberships roles/data-scopes）
Phase 1.8 通知与审计
Phase 1.9 AI 配置
Phase 1.10 部署与验收
```
