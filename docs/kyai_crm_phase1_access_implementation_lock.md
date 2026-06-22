# KyaiCRM Phase 1.7 权限中心与数据范围实现锁定记录

> 文档状态：已锁定 / Phase 1.7 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
services/ky-membership-service   （Access API + 权限内核 + 回填 Phase 1.6 接口）
services/ky-org-service          （权限内核 + 回填 Phase 1.5 接口）
```

依赖前置基线：Phase 1 文档基线、工程骨架、数据库 schema/seed、Phase 1.4 Auth/Bootstrap、Phase 1.5 组织主体管理、Phase 1.6 成员与邀请。

---

## 2. 已实现 Access API（ky-membership-service）

```text
GET   /api/v1/roles
POST  /api/v1/roles
PATCH /api/v1/roles/:id
PATCH /api/v1/roles/:id/status
POST  /api/v1/roles/:id/permissions
GET   /api/v1/permissions
POST  /api/v1/memberships/:id/roles
GET   /api/v1/memberships/:id/permissions
GET   /api/v1/data-scopes
```

---

## 3. 权限校验内核

### 3.1 解析器

两服务各内置同构有效权限解析（口径一致）：

```text
ky_membership_role → ky_role_permission → ky_permission
仅 status='normal' 且角色 status='normal'、未删除
menu→menuKeys / page→permissions / action→actionPermissions
```

- membership 服务：`EffectivePermissions`、`DataScopesForMembership`、`ListPermissions`、`PermissionsAllBelongToWorkspaceType`、`HasAny`。
- org 服务：`HasAny`（与 membership 同 SQL 语义）。

### 3.2 中间件

两服务 `ws()` 升级为：

```text
ws(allowedTypes, requiredPerms []string, handler)
```

- `requiredPerms` 为 OR 集；命中失败返回 `403 permission_denied`。
- 校验顺序：token → 工作区 Header → 类型 gating → active membership → `HasAny(requiredPerms)`。
- 空集表示仅需 membership。

### 3.3 回填权限

- membership 服务：成员（view/disable/remove/assign_department/assign_team）、邀请（invite/cancel/view）全部接入 requiredPerms。
- org 服务：平台机构/企业、当前组织、机构企业、部门、团队全部接入 requiredPerms。
- 公开邀请接口不参与权限校验。

---

## 4. 角色与授权规则

- 角色按当前工作区隔离：`workspace_type=当前类型 AND (workspace_id=当前工作区 OR workspace_id IS NULL[模板])`。
- 创建角色：`is_system=false`，`workspace_id=当前工作区`；`code` 工作区内唯一冲突 409。
- 系统角色与模板（`workspace_id IS NULL`）不可改名/改描述/停用/改权限，返回 409 / not_found。
- 跨工作区类型授权拦截：`permissionIds` 必须全部属当前 `workspace_type` 目录（`workspace_types @> $::jsonb`），否则 400 validation_error。
- 成员授权：membership 必须属当前工作区；roleIds 必须属当前工作区或可用模板且类型匹配，否则 400 / 404。
- 数据范围合法组合校验：`specified_*` 必须带对应 ID 列表，`custom` 至少一个列表，否则 400。

---

## 5. 复审与修复

独立复审确认：

- 全部路由 requiredPerms 权限码（75 个去重）均存在于 `008_seed.sql`，无“永久 403”风险。
- 系统角色/模板保护、跨类型授权拦截、SQL 占位符与 jsonb 容器操作、事务、唯一索引目标均正确。

修复的 2 项阻塞：

1. `HasAny` 的 no-rows 判断由脆弱字符串比较改为 `errors.Is(err, sql.ErrNoRows)`（两服务）。
2. `PATCH /invitations/:id/cancel` 补齐 `agency.enterprises.invite_admin`（契约 §11.3）。

---

## 6. 验证结果

```text
go build ./services/ky-membership-service/... ./services/ky-org-service/...   通过
go vet  同上                                                                   通过
go test 全部服务                                                               通过
```

单元测试新增：

```text
data scope 合法性校验（specified_* / custom / all / self / tree）
data scope 定义按工作区类型（platform 不含 department/team）
```

复审结论：

```text
NO BLOCKERS
```

---

## 7. 部署一致性

Access API 路由（roles/permissions/memberships/data-scopes）由 `ky-membership-service`（`18083`）承载；Nginx 已有 `/api/v1/roles`、`/api/v1/permissions`、`/api/v1/memberships`、`/api/v1/data-scopes` 反代到 `18083`。

ON CONFLICT 目标与 schema 唯一索引一致：

```text
ky_role_permission (role_id, permission_id)
ky_membership_role (membership_id, role_id)
ky_role (workspace_type, COALESCE(workspace_id,''), code)
```

---

## 8. 显式延后与后续

1. 行级数据范围过滤（`department_tree`/`team`/`specified_*` 递归裁剪）按需求决策 A 延后；dataScopes 在 bootstrap 与成员权限摘要中返回，但服务端尚未据此裁剪，前端不得误判。
2. 公开接受邀请的 `userId` 信任问题为后续硬化项。
3. 角色 / 授权变更审计在 Phase 1.8 落 `ky_audit_log`。

后续阶段：

```text
Phase 1.8 通知与审计
Phase 1.9 AI 配置
Phase 1.10 部署与验收
```
