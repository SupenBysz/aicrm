# 权限与数据范围规范

本规范用于身份、角色、权限点、菜单、页面访问、操作按钮、数据范围、工作区缓存和后端查询改动。

## 核心原则

- 权限绑定当前 workspace，不使用全局最强角色。
- 用户账号、成员身份、后台工作区身份必须分离。
- 平台、机构、企业身份互不自动继承。
- 部门、团队是 workspace 内部管理范围，不是独立 workspace。
- 前端隐藏不是安全边界，后端必须重新校验权限和数据范围。
- 工作区切换后必须清理或隔离前端缓存，避免权限串用。
- 菜单权限、页面权限和操作权限是不同维度，menuKey 不能代替 page/action permission。
- actor RBAC、资源的 workspace grant 与受信设备 proof 是正交条件；需要其中多项时必须全部满足。

## 工作区上下文

第一阶段工作区类型固定：

```text
platform
agency
enterprise
```

工作区内请求必须携带：

```text
Authorization: Bearer <token>
X-KY-Workspace-Id: <workspaceId>
X-KY-Workspace-Type: <platform|agency|enterprise>
X-KY-Request-Id: <uuid>
```

后端必须根据 token 和 workspace header 重新计算：

```text
current_user
current_workspace_type
current_workspace_id
current_membership_id
current_roles
current_permissions
current_action_permissions
current_menu_keys
current_data_scope
current_department_scope
current_team_scope
```

## 前端权限职责

前端负责体验层控制：

- 没有菜单权限，不展示菜单。
- 没有页面权限，路由进入 `/403`。
- 没有操作权限，不展示按钮或禁用操作入口。
- 切换 workspace 后重置 Query cache 或使用 workspace-aware query key。

前端禁止：

- 根据 displayName、角色名称文本或菜单名称推断权限。
- 将平台权限用于机构/企业页面。
- 将某个 workspace 的缓存复用于另一个 workspace。
- 仅凭前端隐藏认为接口安全。

## 后端权限职责

后端负责真实安全边界：

- 每个工作区接口校验 workspace membership。
- 每个写操作校验 action permission。
- 每个列表/详情查询应用数据范围。
- 没有数据范围时返回权限拒绝或明确空范围结果，不用普通空列表掩盖权限问题。
- 审计日志记录 actor、workspace、action、resource、result。
- 服务端重新校验资源是否发布到当前 workspace；前端下拉选项或缓存中的 grant 不是授权事实。
- 设备签名端点校验 operation、device、purpose、revision、expiry 和 replay ledger；普通 Bearer body 不能模拟设备 proof。
- internal service credential 只证明服务身份，不能替代原 actor、workspace、permission 和 data scope 决策。

## 资源发布与设备信任

跨 workspace 发布的执行器、模型、模板或其他平台资源必须使用显式 grant：

- grant 绑定资源、workspace、状态和 revision，更新使用 CAS。
- 平台管理权限不自动把资源发布给 agency/enterprise。
- agency/enterprise 默认只读取已发布资源的 ID、名称、运行类型和安全能力摘要。
- 账号标签、设备详情、凭据、路径、授权会话和原始探测结果不得进入下级 workspace 投影。

受信 Desktop 操作还必须满足：

- 用户 Bearer 只证明 actor/session，并可按合同创建业务操作、registration challenge 或设备绑定请求；它不能直接声明设备可信，也不能替代 proof-of-possession。
- 设备使用 proof-of-possession 完成登记，并以服务端单次 ticket 执行具体 Command。
- ticket/proof 绑定的 audience 和 purpose 不得跨领域复用。
- rebind、force revoke、敏感导出等高危动作需要独立权限、二次确认和高危审计。

## 数据范围

数据范围至少表达：

```text
all
current_agency
current_enterprise
department_scope
team_scope
self
custom
```

查询规则：

- 平台范围不得默认看见机构/企业私有数据，除非权限矩阵明确允许。
- 机构范围只能看当前机构及授权服务企业范围。
- 企业范围只能看当前企业。
- 部门/团队负责人只能看被授权范围。
- 数据范围条件应在 store/query 层集中处理，避免散落在 handler 中。

## 新权限点检查

新增菜单、页面或操作前回答：

- 属于哪个 workspace type？
- 菜单权限、页面权限、操作权限是否分别定义？
- menuKey 是否保持唯一真相源，没有拿 page permission 形成第二菜单键？
- 权限点是否进入 seed/migration？
- bootstrap 是否返回对应 permission/actionPermission/menuKey？
- 前端路由、菜单、按钮是否按权限消费？
- 后端接口是否有权限和数据范围校验？
- 资源 grant、设备 proof、expected revision 是否按接口要求与 actor 权限做 AND 校验？
- 下级 workspace 的响应是否只有安全摘要，没有设备、凭据、路径或授权会话？
- 工作区切换后缓存 key 是否隔离？
