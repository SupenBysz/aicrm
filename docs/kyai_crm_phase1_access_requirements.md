# KyaiCRM Phase 1.7 权限中心与数据范围实现需求

> 文档状态：已锁定 / Phase 1.7 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.7 / 权限中心与数据范围  
> 编写日期：2026-06-16  
> 前置基线：Phase 1 文档基线、工程骨架、数据库 schema/seed、Phase 1.4 Auth/Bootstrap、Phase 1.5 组织主体管理、Phase 1.6 成员与邀请  

---

## 1. 阶段目标

1. 实现 Access API（角色、权限、成员授权、数据范围）。
2. 首次引入 page/action 级权限校验内核，并回填到 Phase 1.5/1.6 已实现接口的预留校验点。
3. 暴露数据范围（data scope）模型，供前端与鉴权使用。

本阶段采用的范围决策：

- 决策 A：本阶段实现权限（page/action）强校验 + 数据范围建模/暴露/合法性校验；`department_tree` / `team` / `specified_*` 等行级递归过滤显式延后（见第 8 节）。
- 决策 B：本阶段将权限校验回填到 Phase 1.5（org）与 Phase 1.6（membership）既有接口。
- 决策 C：本阶段明确机构/企业 owner 的权限自举路径，避免“新主体无人有权配角色”死锁。

---

## 2. 范围

### 2.1 后端范围

Access API 落在 `ky-membership-service`（契约指定）：

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

权限校验内核落在 `ky-membership-service` 与 `ky-org-service`（各自内置同构实现）。

读取 / 写入表：

```text
ky_role
ky_permission
ky_role_permission
ky_membership_role
ky_role_data_scope
ky_membership
```

### 2.2 不做 / 显式延后

```text
行级数据范围过滤（递归部门树 / 团队 / 指定范围过滤）
通知与审计写入细节（Phase 1.8）
AI 配置（Phase 1.9）
CRM / AI 员工 / IM / 移动端
```

---

## 3. 权限校验内核

### 3.1 有效权限解析

每个服务内置 permission 解析器，输入 `membershipId`，聚合：

```text
ky_membership_role → ky_role_permission → ky_permission
```

输出当前工作区有效权限码集，按 `ky_permission.category` 分类：

```text
menu   -> menuKeys
page   -> permissions
action -> actionPermissions
```

仅统计 `status='normal'` 且角色 `status='normal'`、未删除的记录。

### 3.2 中间件升级

将 `ws()` 中间件升级为：

```text
ws(allowedTypes, requiredPerms, handler)
```

- `requiredPerms` 为“满足其一即可”（OR）的权限码集合。
- 校验顺序：token → 工作区 Header → 工作区类型 gating → active membership → 有效权限解析 → requiredPerms 命中校验。
- `requiredPerms` 为空表示仅需 membership（用于读接口可下放，但本阶段读接口也应给出对应 `*.view` 权限）。
- 命中失败返回 `403 permission_denied`。
- 解析结果在单次请求内只计算一次。

### 3.3 错误码

```text
unauthorized        401 未登录 / token 无效
workspace_required  400 缺工作区 Header
workspace_forbidden 403 工作区类型不符 / 无 membership
permission_denied   403 无对应 page/action 权限
not_found / conflict / validation_error / internal_error 同既有约定
```

---

## 4. Access API 数据要点

### 4.1 角色列表 `GET /api/v1/roles`

- 默认按当前工作区返回 `workspace_type=当前类型 AND (workspace_id=当前工作区 OR workspace_id IS NULL[模板])` 的角色。
- 过滤：`workspaceType`（平台可查模板）、`status`，分页。
- requiredPerms：`platform.roles.view` / `agency.roles.view` / `enterprise.roles.view`。

### 4.2 创建角色 `POST /api/v1/roles`

- 写 `ky_role`：`workspace_type=当前类型`，`workspace_id=当前工作区`（平台为 `platform_root`），`is_system=false`。
- `code` 在 `(workspace_type, workspace_id, code)` 未删除范围唯一，冲突 409。
- `permissionIds` 必须全部属于当前 `workspace_type` 的权限目录（`ky_permission.workspace_types` 含当前类型），否则 400 validation_error。
- 可选 `dataScope` 写入 `ky_role_data_scope`，校验 scopeType 与所需 ID 列表组合合法（见数据模型锁定规则）。
- requiredPerms：`*.roles.create`。

### 4.3 更新角色 `PATCH /api/v1/roles/:id`

- 仅当前工作区且 `is_system=false` 的角色可改名/描述/数据范围。
- 系统角色返回 409 conflict（不可编辑）。
- requiredPerms：`*.roles.update`。

### 4.4 角色状态 `PATCH /api/v1/roles/:id/status`

- 允许 `normal` / `disabled`。
- 系统角色不可停用，返回 409。
- requiredPerms（OR，满足其一即可）：`platform.roles.disable`、`agency.roles.update`、`enterprise.roles.update`。
- 说明：此处平台与机构/企业刻意不对称——seed 权限字典中仅平台存在 `platform.roles.disable` 动作，机构/企业没有 `*.roles.disable`，其角色启停归入 `*.roles.update`。该不对称与契约 §12.4 及 `008_seed.sql` 一致，实现时不得擅自补 `agency.roles.disable` / `enterprise.roles.disable`。

### 4.5 角色分配权限 `POST /api/v1/roles/:id/permissions`

- 覆盖式设置角色权限。
- 角色须属当前工作区；系统角色不可改权限，返回 409。
- `permissionIds` 必须全部属当前 `workspace_type` 目录，否则 400。
- requiredPerms：`*.roles.update_permissions`。

### 4.6 权限列表 `GET /api/v1/permissions`

- 返回当前 `workspace_type`（或查询参数 `workspaceType`）对应目录权限，可按 `category` 过滤。
- requiredPerms：`*.permissions.view`。

### 4.7 成员分配角色 `POST /api/v1/memberships/:id/roles`

- 覆盖式设置 membership 的角色集合（写 `ky_membership_role`）。
- membership 必须属当前工作区；roleIds 必须属当前工作区或可用模板，且 `workspace_type` 匹配。
- requiredPerms：`*.roles.assign`。

### 4.8 成员权限摘要 `GET /api/v1/memberships/:id/permissions`

- membership 必须属当前工作区。
- 返回 `{permissions, actionPermissions, menuKeys, dataScopes}`。
- requiredPerms：`*.roles.view`。

### 4.9 数据范围列表 `GET /api/v1/data-scopes`

- 返回当前工作区可用的数据范围类型定义（枚举 + 说明），以及当前调用者有效 dataScopes。
- requiredPerms：`platform.data_scopes.view` / `agency.data_scopes.view` / `enterprise.data_scopes.view`。

---

## 5. 回填既有接口权限（决策 B）

为既有接口补 `requiredPerms`，示例（完整映射在实现时对照权限矩阵补全）：

```text
org 服务:
  POST   /platform/agencies            -> platform.agencies.create
  PATCH  /platform/agencies/:id        -> platform.agencies.update
  PATCH  /platform/agencies/:id/status -> platform.agencies.disable | platform.agencies.freeze
  POST   /platform/enterprises         -> platform.enterprises.create
  ... 其余写接口同理
  GET    /platform/agencies            -> platform.agencies.view
  GET    /organizations/current        -> agency.profile.view | enterprise.profile.view
  POST   /departments                  -> agency.departments.create | enterprise.departments.create
  ... 其余按权限矩阵

membership 服务:
  GET    /workspace/members            -> platform.members.view | agency.members.view | enterprise.members.view
  PATCH  /workspace/members/:id/status -> *.members.disable
  DELETE /workspace/members/:id        -> *.members.remove
  POST   /workspace/members/:id/departments -> agency.members.assign_department | enterprise.members.assign_department
  POST   /workspace/members/:id/teams       -> agency.members.assign_team | enterprise.members.assign_team
  POST   /invitations                  -> platform.members.invite | agency.members.invite | agency.enterprises.invite_admin | enterprise.members.invite
  PATCH  /invitations/:id/cancel        -> *.members.invite
  GET    /invitations                  -> *.invitations.view
```

公开邀请接口（`/public/invitations*`）不参与权限校验。

---

## 6. Owner 权限自举（决策 C）

为避免新机构/企业无人有权配置角色，约定：

1. 平台 seed 的 `platform_owner` 已绑定全量平台权限（既有）。
2. 机构 / 企业内置 owner / admin 角色模板已在 seed 绑定其工作区全量 page/action/menu 权限（既有 Phase 1.3 seed）。
3. 自举路径：
   - 平台创建机构 / 企业后，通过邀请（`agency_admin` / `enterprise_admin`，Phase 1.6 已支持 preset roles）将对应 owner / admin 角色注入第一个负责人；接受邀请即获得管理权限。
   - 机构开通企业后，可邀请企业管理员（`agency.enterprises.invite_admin`）完成企业侧自举。
4. 因此第一个管理员的权限来自“邀请预设角色 + seed 内置角色权限”，无需先有人在该工作区配角色，消除死锁。

本阶段不改 seed 结构，只在文档中固化该自举约定，并在 Access API 中保证内置角色不可被破坏（系统角色保护）。

---

## 7. 验收标准

### 7.1 后端

```text
go build ./services/ky-membership-service/... ./services/ky-org-service/...
go vet  同上
go test 同上 + 全服务
GET /readyz 正常
```

### 7.2 权限校验

```text
无对应 page/action 权限调用 -> 403 permission_denied
平台/机构/企业角色与授权严格隔离，跨工作区不可越权
系统内置角色不可改名/删/停用/改权限
不能把非本工作区类型的权限授予角色
回填后 Phase 1.5/1.6 写操作需对应 action 权限
```

### 7.3 业务

```text
角色 CRUD + 状态 + 分配权限可用
权限目录可查
成员授权（覆盖式）可用
成员权限摘要返回 permissions/actionPermissions/menuKeys/dataScopes
数据范围列表返回类型定义与当前有效范围
```

---

## 8. 显式延后项（行级数据范围过滤）

本阶段不实现以下行级过滤，留待 Phase 1.7b 或并入后续阶段：

```text
department / department_tree -> 列表仅返回负责部门及下级
team / specified_team        -> 列表仅返回指定团队
specified_agency/enterprise  -> 平台运营按指定主体过滤
self                         -> 仅本人
custom                       -> 自定义范围
```

延后理由：行级过滤需改动几乎所有 list 查询并实现递归部门树，风险集中；本阶段先确保权限（page/action）真正生效与数据范围可建模/可读，过滤逻辑单独切分降低复审面。`log` 式提示：data-scope 字段会在 bootstrap 与成员权限摘要中返回，但服务端尚未据此做行级裁剪，前端不得据此误判已裁剪。

---

## 9. 风险与约束

1. 服务边界：org 与 membership 各自内置同构 permission 解析器，读取相同权限表，与既有阶段“服务直接读共享表”一致；后续可下沉到统一鉴权服务。
2. 一致性：两服务的有效权限解析口径必须一致（同一聚合 SQL 语义），实现时以 membership 服务为基准，org 服务对齐。
3. 审计：角色 / 授权变更预留审计 hook，Phase 1.8 落 `ky_audit_log`。
4. 行级数据范围未裁剪的暴露口径需在响应/文档中明确，避免前端误判。
