# KyaiCRM API 接口契约文档

> 文档状态：已锁定 / Phase 1 基线  
> 项目名称：KyaiCRM  
> 当前阶段：第一阶段 / 多租户用户中心与多后台身份底座  
> 编写日期：2026-06-15  
> 关联文档：
> - `docs/kyai_crm_multi_tenant_identity_requirements.md`
> - `docs/kyai_crm_architecture.md`
> - `docs/kyai_crm_data_model.md`
> - `docs/kyai_crm_permission_matrix.md`
> - `docs/kyai_crm_admin_pages.md`

---

## 1. 文档目的

本文档定义 KyaiCRM 第一阶段后台 API 契约。

API 范围覆盖：

- 认证与 bootstrap。
- 后台身份与工作区。
- 用户。
- 平台、机构、企业。
- 部门、团队。
- 成员与邀请。
- 角色、权限、数据范围。
- 通知、公告。
- 审计、登录日志。
- 系统设置、字典。
- AI 供应商与模型配置。

本文档只定义第一阶段 API 形态，不包含 CRM 业务、IM、移动端、AI 员工、AI 执行器等接口。

---

## 2. 通用约定

### 2.1 API 前缀

统一使用：

```text
/api/v1
```

---

### 2.2 请求格式

默认请求格式：

```text
Content-Type: application/json
Accept: application/json
```

文件上传接口后续可使用：

```text
multipart/form-data
```

---

### 2.3 认证 Header

登录后接口需要：

```text
Authorization: Bearer <token>
```

---

### 2.4 工作区 Header

所有工作区内接口必须携带：

```text
X-KY-Workspace-Id: <workspaceId>
X-KY-Workspace-Type: <platform|agency|enterprise>
X-KY-Request-Id: <uuid>
```

公共接口例外：

- 登录。
- 注册。
- 邀请 token 查询。
- 接受邀请。
- 公开系统配置，可选。

---

### 2.5 通用响应结构

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

---

### 2.6 通用错误码

| 错误码 | HTTP 状态 | 说明 |
|---|---:|---|
| `unauthorized` | 401 | 未登录或 token 无效 |
| `permission_denied` | 403 | 无权限 |
| `workspace_required` | 400 | 缺少工作区 Header |
| `workspace_forbidden` | 403 | 用户无当前工作区身份 |
| `not_found` | 404 | 资源不存在 |
| `validation_error` | 400 | 参数错误 |
| `conflict` | 409 | 数据冲突 |
| `rate_limited` | 429 | 请求过于频繁 |
| `internal_error` | 500 | 服务内部错误 |

---

## 3. Auth API

服务：

```text
ky-auth-service
```

### 3.1 登录

```text
POST /api/v1/auth/login
```

请求：

```json
{
  "account": "admin@example.com",
  "password": "password"
}
```

响应：

```json
{
  "data": {
    "token": "jwt_or_token",
    "expiresAt": "2026-06-16T00:00:00Z",
    "user": {
      "id": "user_001",
      "displayName": "平台管理员",
      "avatarUrl": ""
    }
  },
  "requestId": "req_xxx"
}
```

说明：

- 登录成功后前端保存 session key：`ky.admin.session.v1`。
- 登录后应立即调用 bootstrap。

---

### 3.2 注册

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

响应：

```json
{
  "data": {
    "userId": "user_001",
    "token": "jwt_or_token",
    "expiresAt": "2026-06-16T00:00:00Z"
  },
  "requestId": "req_xxx"
}
```

---

### 3.3 登出

```text
POST /api/v1/auth/logout
```

响应：

```json
{
  "data": {
    "success": true
  },
  "requestId": "req_xxx"
}
```

---

### 3.4 当前用户

```text
GET /api/v1/auth/me
```

响应：

```json
{
  "data": {
    "id": "user_001",
    "displayName": "张三",
    "avatarUrl": "",
    "phone": "13800000000",
    "email": "zhangsan@example.com",
    "status": "normal"
  },
  "requestId": "req_xxx"
}
```

---

### 3.5 Bootstrap

```text
GET /api/v1/auth/bootstrap
```

响应：

```json
{
  "data": {
    "user": {
      "id": "user_001",
      "displayName": "张三",
      "avatarUrl": "",
      "phone": "13800000000",
      "email": "zhangsan@example.com"
    },
    "workspaces": [
      {
        "id": "platform_root",
        "type": "platform",
        "name": "平台后台",
        "membershipId": "mem_001",
        "roles": [
          {
            "id": "role_platform_admin",
            "code": "platform_admin",
            "name": "平台管理员"
          }
        ],
        "permissions": ["platform.users.view"],
        "actionPermissions": ["platform.users.disable"],
        "menuKeys": ["menu.platform.workbench", "menu.platform.users"],
        "dataScopes": [
          {
            "scopeType": "all"
          }
        ]
      },
      {
        "id": "agency_001",
        "type": "agency",
        "name": "华东机构",
        "membershipId": "mem_002",
        "roles": [],
        "permissions": [],
        "actionPermissions": [],
        "menuKeys": [],
        "dataScopes": []
      }
    ],
    "recommendedWorkspaceId": null
  },
  "requestId": "req_xxx"
}
```

说明：

- 前端以此决定进入无身份页、身份选择页或直接进入工作台。
- 每个 workspace 的权限、菜单和数据范围必须独立计算。

---

## 4. Public Invitation API

服务：

```text
ky-membership-service
```

### 4.1 查询邀请

```text
GET /api/v1/public/invitations/:token
```

响应：

```json
{
  "data": {
    "id": "inv_001",
    "workspaceType": "enterprise",
    "workspaceId": "enterprise_001",
    "workspaceName": "A 企业",
    "inviteeEmail": "user@example.com",
    "status": "pending",
    "expiresAt": "2026-06-20T00:00:00Z",
    "presetRoles": [
      {
        "id": "role_enterprise_member",
        "name": "普通成员"
      }
    ]
  },
  "requestId": "req_xxx"
}
```

---

### 4.2 接受邀请

```text
POST /api/v1/public/invitations/:token/accept
```

鉴权（Phase 1.12 硬化）：

```text
Authorization: Bearer <token>   必填
```

- 接受邀请需要登录态；缺少或无效 token 返回 401。
- 被接受的 `userId` 一律取自 token，不信任请求体；body `userId` 可选，若提供必须与 token 用户一致，否则返回 403。

请求（body 可选）：

```json
{
  "userId": "user_001"
}
```

响应：

```json
{
  "data": {
    "membershipId": "mem_001",
    "workspaceType": "enterprise",
    "workspaceId": "enterprise_001"
  },
  "requestId": "req_xxx"
}
```

---

## 5. Platform User API

服务：

```text
ky-auth-service
```

### 5.1 全局用户列表

```text
GET /api/v1/platform/users?page=1&pageSize=20&keyword=&status=
```

权限：

```text
platform.users.view
```

响应字段：

```json
{
  "id": "user_001",
  "displayName": "张三",
  "phone": "13800000000",
  "email": "zhangsan@example.com",
  "status": "normal",
  "lastLoginAt": "2026-06-15T00:00:00Z",
  "createdAt": "2026-06-01T00:00:00Z"
}
```

---

### 5.2 用户详情

```text
GET /api/v1/platform/users/:id
```

权限：

```text
platform.users.view
```

---

### 5.3 修改用户状态

```text
PATCH /api/v1/platform/users/:id/status
```

权限：

```text
platform.users.disable
platform.users.enable
```

请求：

```json
{
  "status": "disabled",
  "reason": "安全原因"
}
```

---

## 6. Platform Organization API

服务：

```text
ky-org-service
```

### 6.1 机构列表

```text
GET /api/v1/platform/agencies?page=1&pageSize=20&keyword=&status=
```

权限：

```text
platform.agencies.view
```

---

### 6.2 创建机构

```text
POST /api/v1/platform/agencies
```

权限：

```text
platform.agencies.create
```

请求：

```json
{
  "name": "华东机构",
  "code": "east-agency",
  "contactName": "负责人",
  "contactPhone": "13800000000",
  "contactEmail": "agency@example.com"
}
```

---

### 6.3 机构详情

```text
GET /api/v1/platform/agencies/:id
```

权限：

```text
platform.agencies.view
```

---

### 6.4 更新机构

```text
PATCH /api/v1/platform/agencies/:id
```

权限：

```text
platform.agencies.update
```

---

### 6.5 修改机构状态

```text
PATCH /api/v1/platform/agencies/:id/status
```

权限：

```text
platform.agencies.disable
platform.agencies.freeze
```

请求：

```json
{
  "status": "disabled",
  "reason": "停用原因"
}
```

---

### 6.6 企业列表

```text
GET /api/v1/platform/enterprises?page=1&pageSize=20&keyword=&status=&agencyId=
```

权限：

```text
platform.enterprises.view
```

---

### 6.7 创建企业

```text
POST /api/v1/platform/enterprises
```

权限：

```text
platform.enterprises.create
```

请求：

```json
{
  "name": "A 企业",
  "code": "enterprise-a",
  "agencyId": "agency_001",
  "contactName": "企业联系人",
  "contactPhone": "13800000000",
  "contactEmail": "enterprise@example.com"
}
```

说明：

- `agencyId` 可为空，表示直属平台。

---

### 6.8 企业详情

```text
GET /api/v1/platform/enterprises/:id
```

权限：

```text
platform.enterprises.view
```

---

### 6.9 更新企业

```text
PATCH /api/v1/platform/enterprises/:id
```

权限：

```text
platform.enterprises.update
```

---

### 6.10 调整企业归属机构

```text
PATCH /api/v1/platform/enterprises/:id/agency
```

权限：

```text
platform.enterprises.assign_agency
```

请求：

```json
{
  "agencyId": "agency_001"
}
```

---

### 6.11 修改企业状态

```text
PATCH /api/v1/platform/enterprises/:id/status
```

权限：

```text
platform.enterprises.disable
```

---

## 7. Current Organization API

服务：

```text
ky-org-service
```

适用于机构后台和企业后台。

### 7.1 当前组织信息

```text
GET /api/v1/organizations/current
```

权限：

```text
agency.profile.view
enterprise.profile.view
```

响应根据当前 `X-KY-Workspace-Type` 返回机构或企业信息。

---

### 7.2 更新当前组织信息

```text
PATCH /api/v1/organizations/current
```

权限：

```text
agency.profile.update
enterprise.profile.update
```

---

## 8. Agency Enterprise API

服务：

```text
ky-org-service
```

适用于机构后台的服务企业管理。机构只能访问当前机构名下或平台授权范围内的企业。

### 8.1 机构服务企业列表

```text
GET /api/v1/agency/enterprises?page=1&pageSize=20&keyword=&status=
```

权限：

```text
agency.enterprises.view
```

### 8.2 机构服务企业详情

```text
GET /api/v1/agency/enterprises/:id
```

权限：

```text
agency.enterprises.view
```

### 8.3 机构开通企业

```text
POST /api/v1/agency/enterprises
```

权限：

```text
agency.enterprises.create
```

请求：

```json
{
  "name": "A 企业",
  "code": "enterprise-a",
  "contactName": "企业联系人",
  "contactPhone": "13800000000",
  "contactEmail": "enterprise@example.com"
}
```

### 8.4 机构编辑企业基础信息

```text
PATCH /api/v1/agency/enterprises/:id
```

权限：

```text
agency.enterprises.update
```

说明：第一阶段机构对企业的写权限仅限平台授权范围内的基础资料维护，不包含复杂代运营业务。

---

## 9. Department API

服务：

```text
ky-org-service
```

### 8.1 部门列表

```text
GET /api/v1/departments?parentId=&status=
```

权限：

```text
agency.departments.view
enterprise.departments.view
```

说明：

- 根据 workspace header 返回当前机构或企业部门。

---

### 8.2 创建部门

```text
POST /api/v1/departments
```

权限：

```text
agency.departments.create
enterprise.departments.create
```

请求：

```json
{
  "parentId": null,
  "name": "技术部",
  "code": "tech",
  "leaderMembershipId": "mem_001",
  "sortOrder": 10
}
```

---

### 8.3 更新部门

```text
PATCH /api/v1/departments/:id
```

权限：

```text
agency.departments.update
enterprise.departments.update
```

---

### 8.4 删除部门

```text
DELETE /api/v1/departments/:id
```

权限：

```text
agency.departments.delete
enterprise.departments.delete
```

---

## 9. Team API

服务：

```text
ky-org-service
```

### 9.1 团队列表

```text
GET /api/v1/teams?departmentId=&status=
```

权限：

```text
agency.teams.view
enterprise.teams.view
```

---

### 9.2 创建团队

```text
POST /api/v1/teams
```

权限：

```text
agency.teams.create
enterprise.teams.create
```

请求：

```json
{
  "name": "项目一组",
  "code": "project-1",
  "departmentId": "dep_001",
  "leaderMembershipId": "mem_001",
  "description": "项目协作团队"
}
```

---

### 9.3 更新团队

```text
PATCH /api/v1/teams/:id
```

权限：

```text
agency.teams.update
enterprise.teams.update
```

---

### 9.4 管理团队成员

```text
POST /api/v1/teams/:id/members
```

权限：

```text
agency.teams.manage_members
enterprise.teams.manage_members
```

请求：

```json
{
  "membershipIds": ["mem_001", "mem_002"]
}
```

---

## 10. Membership API

服务：

```text
ky-membership-service
```

说明：平台成员、机构成员、企业成员统一使用 `ky_membership` 模型；`/api/v1/workspace/members` 在 `platform/platform_root`、`agency/:agencyId`、`enterprise/:enterpriseId` 三类工作区下均合法。

### 10.1 当前工作区成员列表

```text
GET /api/v1/workspace/members?page=1&pageSize=20&keyword=&departmentId=&teamId=&roleId=&status=
```

权限：

```text
platform.members.view
agency.members.view
enterprise.members.view
```

说明：

- 根据 workspace header 返回当前后台主体成员。
- 部门负责人、团队负责人按数据范围过滤。

---

### 10.2 成员详情

```text
GET /api/v1/workspace/members/:id
```

权限：

```text
platform.members.view
agency.members.view
enterprise.members.view
```

---

### 10.3 修改成员状态

```text
PATCH /api/v1/workspace/members/:id/status
```

权限：

```text
platform.members.disable
agency.members.disable
enterprise.members.disable
```

请求：

```json
{
  "status": "disabled",
  "reason": "离职"
}
```

---

### 10.4 移除成员

```text
DELETE /api/v1/workspace/members/:id
```

权限：

```text
platform.members.remove
agency.members.remove
enterprise.members.remove
```

---

### 10.5 分配成员部门

```text
POST /api/v1/workspace/members/:id/departments
```

权限：

```text
agency.members.assign_department
enterprise.members.assign_department
```

请求：

```json
{
  "departments": [
    {
      "departmentId": "dep_001",
      "isPrimary": true
    }
  ]
}
```

---

### 10.6 分配成员团队

```text
POST /api/v1/workspace/members/:id/teams
```

权限：

```text
agency.members.assign_team
enterprise.members.assign_team
```

请求：

```json
{
  "teamIds": ["team_001", "team_002"]
}
```

---

## 11. Invitation API

服务：

```text
ky-membership-service
```

### 11.1 邀请列表

```text
GET /api/v1/invitations?page=1&pageSize=20&status=
```

权限：

```text
platform.invitations.view
agency.invitations.view
enterprise.invitations.view
```

---

### 11.2 创建邀请

```text
POST /api/v1/invitations
```

权限：

```text
platform.members.invite
agency.members.invite
agency.enterprises.invite_admin
enterprise.members.invite
```

请求：

```json
{
  "targetWorkspaceType": "enterprise",
  "targetWorkspaceId": "enterprise_001",
  "invitationType": "member",
  "inviteeEmail": "new-user@example.com",
  "inviteePhone": "13800000000",
  "roleIds": ["role_enterprise_member"],
  "departmentIds": ["dep_001"],
  "teamIds": ["team_001"],
  "expiresAt": "2026-06-30T00:00:00Z"
}
```

说明：

- `targetWorkspaceType` / `targetWorkspaceId` 表示被邀请人将加入的平台、机构或企业工作区；平台创建机构管理员、企业管理员邀请时也必须明确目标工作区。
- `invitationType` 第一阶段取值建议为 `member` / `agency_admin` / `enterprise_admin`，用于区分普通成员邀请和跨主体管理员邀请。
- `agency.enterprises.invite_admin` 仅允许在当前机构授权企业范围内创建企业管理员邀请。

---

### 11.3 取消邀请

```text
PATCH /api/v1/invitations/:id/cancel
```

权限：

```text
platform.members.invite
agency.members.invite
agency.enterprises.invite_admin
enterprise.members.invite
```

---

## 12. Access API

服务：

```text
ky-membership-service
```

### 12.1 角色列表

```text
GET /api/v1/roles?page=1&pageSize=20&workspaceType=&status=
```

权限：

```text
platform.roles.view
agency.roles.view
enterprise.roles.view
```

说明：

- 默认按当前 workspace header 返回当前工作区角色。
- 平台可查询模板角色。

---

### 12.2 创建角色

```text
POST /api/v1/roles
```

权限：

```text
platform.roles.create
agency.roles.create
enterprise.roles.create
```

请求：

```json
{
  "name": "部门管理员",
  "code": "department_admin",
  "description": "部门管理角色",
  "permissionIds": ["perm_001", "perm_002"],
  "dataScope": {
    "scopeType": "department_tree",
    "departmentIds": ["dep_001"]
  }
}
```

---

### 12.3 更新角色

```text
PATCH /api/v1/roles/:id
```

权限：

```text
platform.roles.update
agency.roles.update
enterprise.roles.update
```

---

### 12.4 修改角色状态

```text
PATCH /api/v1/roles/:id/status
```

权限：

```text
platform.roles.disable
agency.roles.update
enterprise.roles.update
```

请求：

```json
{
  "status": "disabled",
  "reason": "停用原因"
}
```

---

### 12.5 角色分配权限

```text
POST /api/v1/roles/:id/permissions
```

权限：

```text
platform.roles.update_permissions
agency.roles.update_permissions
enterprise.roles.update_permissions
```

请求：

```json
{
  "permissionIds": ["perm_001", "perm_002"]
}
```

---

### 12.6 权限列表

```text
GET /api/v1/permissions?workspaceType=platform&category=
```

权限：

```text
platform.permissions.view
agency.permissions.view
enterprise.permissions.view
```

---

### 12.7 成员分配角色

```text
POST /api/v1/memberships/:id/roles
```

权限：

```text
platform.roles.assign
agency.roles.assign
enterprise.roles.assign
```

请求：

```json
{
  "roleIds": ["role_001", "role_002"]
}
```

---

### 12.8 成员权限摘要

```text
GET /api/v1/memberships/:id/permissions
```

权限：

```text
platform.roles.view
agency.roles.view
enterprise.roles.view
```

响应：

```json
{
  "data": {
    "permissions": [],
    "actionPermissions": [],
    "menuKeys": [],
    "dataScopes": []
  },
  "requestId": "req_xxx"
}
```

---

### 12.9 数据范围列表

```text
GET /api/v1/data-scopes
```

权限：

```text
platform.data_scopes.view
agency.data_scopes.view
enterprise.data_scopes.view
```

---

## 13. Notification API

服务：

```text
ky-membership-service
```

后续可拆至：

```text
ky-notification-service
```

### 13.1 通知列表

```text
GET /api/v1/notifications?page=1&pageSize=20&read=&type=
```

权限：

```text
platform.notifications.view
agency.notifications.view
enterprise.notifications.view
```

---

### 13.2 未读数

```text
GET /api/v1/notifications/unread-count
```

响应：

```json
{
  "data": {
    "count": 3
  },
  "requestId": "req_xxx"
}
```

---

### 13.3 标记已读

```text
PATCH /api/v1/notifications/:id/read
```

---

### 13.4 全部已读

```text
POST /api/v1/notifications/read-all
```

---

## 14. Announcement API

服务：

```text
ky-membership-service
```

### 14.1 公告列表

```text
GET /api/v1/announcements?page=1&pageSize=20&status=
```

权限：

```text
platform.announcements.view
agency.announcements.view
enterprise.announcements.view
```

---

### 14.2 创建公告

```text
POST /api/v1/announcements
```

权限：

```text
platform.announcements.create
```

请求：

```json
{
  "title": "系统公告",
  "content": "公告内容",
  "targetScope": "all",
  "targetIds": []
}
```

说明：

```text
targetScope = all / agency / enterprise / user
```

- `all` 表示全部可见。
- `agency` / `enterprise` 表示指定机构或企业工作区可见，`targetIds` 填对应主体 ID。
- `user` 表示指定用户可见，`targetIds` 填 user ID；如需计入工作区未读数，发布时应生成对应 `ky_notification` 记录。

---

### 14.3 发布公告

```text
PATCH /api/v1/announcements/:id/publish
```

权限：

```text
platform.announcements.publish
```

---

## 15. Audit API

服务：

```text
ky-membership-service
```

### 15.1 操作日志

```text
GET /api/v1/audit-logs?page=1&pageSize=20&action=&resourceType=&actorUserId=&startAt=&endAt=
```

权限：

```text
platform.audit.view
agency.audit.view
enterprise.audit.view
```

说明：

- 平台按平台权限查看全局。
- 机构按机构授权范围查看。
- 企业只看当前企业。
- 部门 / 团队负责人只看 scope 范围。

---

### 15.2 登录日志

```text
GET /api/v1/login-logs?page=1&pageSize=20&userId=&result=&startAt=&endAt=
```

权限：

```text
platform.login_logs.view
```

---

## 16. Settings API

服务：

```text
ky-org-service
```

### 16.1 当前工作区设置

```text
GET /api/v1/settings
```

权限：

```text
agency.settings.view
enterprise.settings.view
```

---

### 16.2 更新当前工作区设置

```text
PATCH /api/v1/settings
```

权限：

```text
agency.settings.update
enterprise.settings.update
```

请求：

```json
{
  "settings": {
    "inviteExpiresDays": 7,
    "defaultRoleId": "role_001"
  }
}
```

---

### 16.3 平台系统设置

```text
GET /api/v1/platform/system-settings
PATCH /api/v1/platform/system-settings
```

权限：

```text
platform.settings.view
platform.settings.update
```

说明：基础设置、安全策略、注册策略、租户策略等都通过该聚合接口按 setting key 或 `section` 参数读写，第一阶段不单独定义 `/platform/system-settings/security` 子路由。

---

### 16.4 字典列表

```text
GET /api/v1/dictionaries
```

权限：

```text
platform.dictionaries.view
```

说明：第一阶段字典配置仅由平台后台维护，机构和企业后台的设置通过 `GET/PATCH /api/v1/settings` 读取和更新，不单独定义 `agency.dictionaries.*` 或 `enterprise.dictionaries.*` 权限。

---

## 17. AI Model API

服务：

```text
ky-ai-model-service
```

### 17.1 供应商列表

```text
GET /api/v1/ai-models/providers?page=1&pageSize=20&status=&type=
```

权限：

```text
platform.ai_providers.view
```

---

### 17.2 创建供应商

```text
POST /api/v1/ai-models/providers
```

权限：

```text
platform.ai_providers.create
```

请求：

```json
{
  "name": "Anthropic",
  "providerType": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "apiKey": "secret",
  "status": "enabled",
  "remark": "默认供应商"
}
```

说明：

- `apiKey` 服务端必须加密存储。
- 响应不能返回明文 API Key。

---

### 17.3 更新供应商

```text
PATCH /api/v1/ai-models/providers/:id
```

权限：

```text
platform.ai_providers.update
```

---

### 17.4 修改供应商状态

```text
PATCH /api/v1/ai-models/providers/:id/status
```

权限：

```text
platform.ai_providers.update_status
```

请求：

```json
{
  "status": "disabled"
}
```

---

### 17.5 模型列表

```text
GET /api/v1/ai-models?page=1&pageSize=20&providerId=&modelType=&status=
```

权限：

```text
platform.ai_models.view
```

---

### 17.6 创建模型

```text
POST /api/v1/ai-models
```

权限：

```text
platform.ai_models.create
```

请求：

```json
{
  "providerId": "provider_001",
  "name": "Claude Opus",
  "modelKey": "claude-opus-4-8",
  "modelType": "text_generation",
  "contextLength": 200000,
  "defaultParameters": {
    "temperature": 0.7
  },
  "status": "enabled",
  "remark": "默认文本模型"
}
```

---

### 17.7 更新模型

```text
PATCH /api/v1/ai-models/:id
```

权限：

```text
platform.ai_models.update
```

---

### 17.8 修改模型状态

```text
PATCH /api/v1/ai-models/:id/status
```

权限：

```text
platform.ai_models.update_status
```

---

### 17.9 默认模型配置

```text
GET /api/v1/ai-models/settings
PATCH /api/v1/ai-models/settings
```

权限：

```text
platform.ai_model_settings.view
platform.ai_model_settings.update
```

请求：

```json
{
  "defaultChatModelId": "model_001",
  "defaultSummaryModelId": "model_002",
  "defaultEmbeddingModelId": "model_003"
}
```

---

## 18. Workbench API

### 18.1 平台工作台摘要

服务：

```text
ky-org-service / ky-membership-service 聚合，第一阶段可由 ky-org-service 提供
```

```text
GET /api/v1/platform/workbench/summary
```

权限：

```text
platform.workbench.view
```

响应：

```json
{
  "data": {
    "userCount": 100,
    "agencyCount": 5,
    "enterpriseCount": 20,
    "todayLoginCount": 12,
    "enabledAiProviderCount": 2,
    "enabledAiModelCount": 8,
    "recentAuditLogs": []
  },
  "requestId": "req_xxx"
}
```

---

### 18.2 机构工作台摘要

```text
GET /api/v1/agency/workbench/summary
```

权限：

```text
agency.workbench.view
```

---

### 18.3 企业工作台摘要

```text
GET /api/v1/enterprise/workbench/summary
```

权限：

```text
enterprise.workbench.view
```

---

## 19. API 与服务映射

| API 范围 | 服务 |
|---|---|
| `/api/v1/auth/*` | `ky-auth-service` |
| `/api/v1/platform/users*` | `ky-auth-service` |
| `/api/v1/platform/agencies*` | `ky-org-service` |
| `/api/v1/platform/enterprises*` | `ky-org-service` |
| `/api/v1/agency/enterprises*` | `ky-org-service` |
| `/api/v1/organizations*` | `ky-org-service` |
| `/api/v1/departments*` | `ky-org-service` |
| `/api/v1/teams*` | `ky-org-service` |
| `/api/v1/settings*` | `ky-org-service` |
| `/api/v1/platform/system-settings*` | `ky-org-service` |
| `/api/v1/dictionaries*` | `ky-org-service` |
| `/api/v1/platform/workbench/summary` | `ky-org-service` |
| `/api/v1/agency/workbench/summary` | `ky-org-service` |
| `/api/v1/enterprise/workbench/summary` | `ky-org-service` |
| `/api/v1/workspace/members*` | `ky-membership-service` |
| `/api/v1/invitations*` | `ky-membership-service` |
| `/api/v1/public/invitations*` | `ky-membership-service` |
| `/api/v1/roles*` | `ky-membership-service` |
| `/api/v1/memberships*` | `ky-membership-service` |
| `/api/v1/permissions*` | `ky-membership-service` |
| `/api/v1/data-scopes*` | `ky-membership-service` |
| `/api/v1/audit-logs*` | `ky-membership-service` |
| `/api/v1/login-logs*` | `ky-auth-service` |
| `/api/v1/notifications*` | `ky-membership-service`，后续可拆至 `ky-notification-service` |
| `/api/v1/announcements*` | `ky-membership-service`，后续可拆至 `ky-notification-service` |
| `/api/v1/ai-models*` | `ky-ai-model-service` |

---

## 20. 第一阶段 API 验收标准

1. 所有登录后接口必须校验 token。
2. 所有工作区接口必须校验 `X-KY-Workspace-*`。
3. 用户无当前工作区身份时返回 403。
4. 用户无页面或操作权限时返回 403。
5. 列表接口按数据范围过滤。
6. 详情接口不能越权读取。
7. 所有关键写操作写入审计日志。
8. Bootstrap 返回多后台身份、权限、菜单和数据范围。
9. 工作区切换后使用同一接口可返回不同数据范围。
10. AI 配置接口只允许平台授权角色访问和修改。
11. 明文 API Key 不允许出现在响应中。
12. 邀请 token 查询和接受流程可闭环。
