# KyaiCRM 数据模型与表设计文档

> 文档状态：已锁定 / Phase 1 基线  
> 项目名称：KyaiCRM  
> 当前阶段：第一阶段 / 多租户用户中心与多后台身份底座  
> 编写日期：2026-06-15  
> 参照项目：`/data/Kysion/zhipinai_v2`  
> 关联文档：
> - `docs/kyai_crm_multi_tenant_identity_requirements.md`
> - `docs/kyai_crm_technical_selection.md`
> - `docs/kyai_crm_architecture.md`

---

## 1. 文档目的

本文档用于定义 KyaiCRM 第一阶段的数据模型和核心表设计草案。

当前阶段重点支撑：

- 用户账号。
- 平台、机构、企业多租户主体。
- 部门、团队组织结构。
- 成员身份。
- 多后台身份。
- 邀请入职。
- 角色、权限、菜单、操作权限。
- 数据范围。
- 审计日志。
- 通知与公告。
- 系统设置。
- AI 供应商与模型配置。

本文档描述第一阶段需要落库的核心对象、关系和字段草案，后续 SQL schema 应以本文档为基础继续细化。

---

## 2. 设计原则

### 2.1 `ky_` 前缀

所有业务表统一使用 `ky_` 前缀。

示例：

```text
ky_user
ky_agency
ky_enterprise
ky_membership
ky_role
ky_permission
ky_ai_model
```

---

### 2.2 用户账号与成员身份分离

系统必须区分：

```text
用户账号 User
成员身份 Membership
后台身份 Workspace Identity
```

一个用户账号可以在多个平台、机构、企业中拥有不同成员身份。

---

### 2.3 平台 / 机构 / 企业作为核心工作区主体

第一阶段工作区类型固定为：

```text
platform
agency
enterprise
```

平台工作区固定 ID 建议：

```text
platform_root
```

机构和企业使用各自实体 ID 作为 workspace_id。

---

### 2.4 部门 / 团队不作为独立 workspace

部门和团队作为 workspace 内部的：

- 组织结构。
- 成员归属。
- 权限范围。
- 数据范围。
- 通知范围。

---

### 2.5 统一审计字段

所有核心业务表建议包含：

```text
id
created_at
updated_at
created_by
updated_by
deleted_at，可选
```

租户相关表建议额外包含：

```text
workspace_type
workspace_id
agency_id，可选
enterprise_id，可选
```

---

## 3. 核心关系总览

```text
ky_user
  └── ky_membership
        ├── workspace_type: platform / agency / enterprise
        ├── workspace_id: platform_root / agency_id / enterprise_id
        ├── ky_membership_role
        │     └── ky_role
        │           └── ky_role_permission
        │                 └── ky_permission
        ├── ky_membership_department
        │     └── ky_department
        └── ky_membership_team
              └── ky_team

ky_agency
  └── ky_enterprise，可选归属

ky_enterprise
  ├── ky_department
  └── ky_team
```

---

## 4. 用户与认证模型

### 4.1 ky_user

全局用户账号表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 用户 ID |
| username | text | 用户名，可选唯一 |
| display_name | text | 显示名称 |
| avatar_url | text | 头像 |
| phone | text | 手机号，可选唯一 |
| email | text | 邮箱，可选唯一 |
| status | text | normal / unverified / disabled / closed |
| last_login_at | timestamptz | 最近登录时间 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |
| deleted_at | timestamptz | 软删除，可选 |

约束：

- `phone`、`email` 可为空，但如果存在应唯一。
- 用户状态为 `disabled` 时禁止登录。

---

### 4.2 ky_user_credential

用户认证凭据表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 凭据 ID |
| user_id | text / uuid | 用户 ID |
| credential_type | text | password / phone / email / oauth |
| identifier | text | 登录标识 |
| password_hash | text | 密码哈希，仅 `credential_type = password` 使用；同一用户可为 username / email / phone 等多个登录标识创建多条 password 凭据 |
| status | text | normal / disabled |
| verified_at | timestamptz | 验证时间 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

---

### 4.3 ky_user_session

用户会话表，可选。如果第一阶段仅使用无状态 token，可后续再强化。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | session ID |
| user_id | text / uuid | 用户 ID |
| token_id | text | token 标识 |
| user_agent | text | 浏览器信息 |
| ip_address | inet / text | IP |
| status | text | active / revoked / expired |
| expires_at | timestamptz | 过期时间 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

---

### 4.4 ky_login_log

登录日志表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 日志 ID |
| user_id | text / uuid | 用户 ID，可空 |
| login_account | text | 登录账号 |
| result | text | success / failed |
| fail_reason | text | 失败原因 |
| ip_address | text | IP |
| user_agent | text | UA |
| created_at | timestamptz | 时间 |

---

## 5. 平台 / 机构 / 企业模型

### 5.1 平台建模策略

平台工作区固定为：

```text
workspace_type = platform
workspace_id = platform_root
```

第一阶段不建立 `ky_platform` 实体表，也不建立单独的 `ky_platform_setting` 表。平台配置统一写入 `ky_system_setting`：

```text
scope_type = platform
scope_id = platform_root
```

这样平台、机构、企业设置都由同一张设置表表达，避免 `ky_platform_setting`、`ky_organization_setting`、`ky_system_setting` 三套命名并存。

---

### 5.2 ky_agency

机构表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 机构 ID |
| name | text | 机构名称 |
| code | text | 机构编码 |
| logo_url | text | Logo |
| description | text | 简介 |
| owner_user_id | text / uuid | 机构所有者用户 ID |
| status | text | pending / normal / disabled / frozen |
| contact_name | text | 联系人 |
| contact_phone | text | 联系电话 |
| contact_email | text | 联系邮箱 |
| created_by | text / uuid | 创建人 |
| updated_by | text / uuid | 更新人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |
| deleted_at | timestamptz | 软删除 |

---

### 5.3 ky_enterprise

企业表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 企业 ID |
| agency_id | text / uuid | 归属机构，可空 |
| name | text | 企业名称 |
| code | text | 企业编码 |
| logo_url | text | Logo |
| description | text | 简介 |
| owner_user_id | text / uuid | 企业所有者用户 ID |
| status | text | pending / normal / disabled / frozen |
| contact_name | text | 联系人 |
| contact_phone | text | 联系电话 |
| contact_email | text | 联系邮箱 |
| created_by | text / uuid | 创建人 |
| updated_by | text / uuid | 更新人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |
| deleted_at | timestamptz | 软删除 |

说明：

- `agency_id` 为空表示直属平台。
- `agency_id` 非空表示归属某机构。

---

### 5.4 ky_agency_enterprise_relation

机构与企业关系表。如第一阶段仅需单一归属，可暂由 `ky_enterprise.agency_id` 表达；如要支持服务关系、协作关系、历史关系，则使用此表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 关系 ID |
| agency_id | text / uuid | 机构 ID |
| enterprise_id | text / uuid | 企业 ID |
| relation_type | text | owner / service / cooperation |
| status | text | pending / normal / disabled / ended |
| started_at | timestamptz | 开始时间 |
| ended_at | timestamptz | 结束时间 |
| created_by | text / uuid | 创建人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

---

## 6. 部门与团队模型

### 6.1 ky_department

部门表，支持机构或企业内部部门。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 部门 ID |
| workspace_type | text | agency / enterprise |
| workspace_id | text / uuid | 机构 ID 或企业 ID |
| parent_id | text / uuid | 上级部门 ID，可空 |
| name | text | 部门名称 |
| code | text | 部门编码 |
| leader_membership_id | text / uuid | 部门负责人 |
| sort_order | int | 排序 |
| status | text | normal / disabled |
| created_by | text / uuid | 创建人 |
| updated_by | text / uuid | 更新人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |
| deleted_at | timestamptz | 软删除 |

---

### 6.2 ky_team

团队表，支持机构或企业内部团队。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 团队 ID |
| workspace_type | text | agency / enterprise |
| workspace_id | text / uuid | 机构 ID 或企业 ID |
| department_id | text / uuid | 归属部门，可空 |
| name | text | 团队名称 |
| code | text | 团队编码 |
| leader_membership_id | text / uuid | 团队负责人 |
| description | text | 描述 |
| status | text | normal / disabled / archived |
| created_by | text / uuid | 创建人 |
| updated_by | text / uuid | 更新人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |
| deleted_at | timestamptz | 软删除 |

---

## 7. 成员与邀请模型

### 7.1 ky_membership

成员身份表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 成员 ID |
| user_id | text / uuid | 用户 ID |
| workspace_type | text | platform / agency / enterprise |
| workspace_id | text | platform_root / agency_id / enterprise_id |
| display_name | text | 组织内显示名 |
| employee_no | text | 工号，可选 |
| title | text | 职位，可选 |
| status | text | invited / active / disabled / left |
| joined_at | timestamptz | 加入时间 |
| created_by | text / uuid | 创建人 |
| updated_by | text / uuid | 更新人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |
| deleted_at | timestamptz | 软删除 |

约束：

- 同一 `user_id + workspace_type + workspace_id` 正常情况下只能有一个 active 成员身份。

---

### 7.2 ky_membership_department

成员与部门关系表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | ID |
| membership_id | text / uuid | 成员 ID |
| department_id | text / uuid | 部门 ID |
| is_primary | boolean | 是否主部门 |
| created_at | timestamptz | 创建时间 |

---

### 7.3 ky_membership_team

成员与团队关系表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | ID |
| membership_id | text / uuid | 成员 ID |
| team_id | text / uuid | 团队 ID |
| role_in_team | text | leader / member |
| created_at | timestamptz | 创建时间 |

---

### 7.4 ky_invitation

邀请表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 邀请 ID |
| workspace_type | text | platform / agency / enterprise |
| workspace_id | text | 目标工作区 ID |
| invitation_type | text | member / agency_admin / enterprise_admin |
| invitee_email | text | 被邀请邮箱，可空 |
| invitee_phone | text | 被邀请手机号，可空 |
| invited_by_membership_id | text / uuid | 邀请人成员 ID |
| token | text | 邀请 token |
| preset_role_ids | jsonb | 预设角色 ID 列表 |
| preset_department_ids | jsonb | 预设部门 ID 列表 |
| preset_team_ids | jsonb | 预设团队 ID 列表 |
| status | text | pending / accepted / expired / cancelled |
| expires_at | timestamptz | 过期时间 |
| accepted_user_id | text / uuid | 接受用户 |
| accepted_at | timestamptz | 接受时间 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

---

## 8. 权限模型

### 8.1 ky_role

角色表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 角色 ID |
| workspace_type | text | platform / agency / enterprise |
| workspace_id | text | platform_root / agency_id / enterprise_id，可空表示模板 |
| name | text | 角色名称 |
| code | text | 角色编码 |
| description | text | 描述 |
| is_system | boolean | 是否系统内置 |
| status | text | normal / disabled |
| created_by | text / uuid | 创建人 |
| updated_by | text / uuid | 更新人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |
| deleted_at | timestamptz | 软删除 |

---

### 8.2 ky_permission

权限定义表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 权限 ID |
| code | text | 权限编码 |
| name | text | 权限名称 |
| category | text | menu / page / action |
| resource | text | 资源 |
| action | text | 动作 |
| workspace_types | jsonb | 适用工作区类型 |
| description | text | 描述 |
| status | text | normal / disabled |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

示例：

```text
menu.platform.users
platform.users.view
platform.users.disable
agency.members.invite
enterprise.departments.create
ai.providers.update
```

---

### 8.3 ky_role_permission

角色权限关系表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | ID |
| role_id | text / uuid | 角色 ID |
| permission_id | text / uuid | 权限 ID |
| created_at | timestamptz | 创建时间 |

---

### 8.4 ky_membership_role

成员角色关系表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | ID |
| membership_id | text / uuid | 成员 ID |
| role_id | text / uuid | 角色 ID |
| workspace_type | text | 工作区类型 |
| workspace_id | text | 工作区 ID |
| created_by | text / uuid | 创建人 |
| created_at | timestamptz | 创建时间 |

---

### 8.5 ky_role_data_scope

角色数据范围表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | ID |
| role_id | text / uuid | 角色 ID |
| scope_type | text | all / current_agency / current_enterprise / specified_agency / specified_enterprise / department / department_tree / specified_department / team / specified_team / self / custom |
| department_ids | jsonb | 指定部门范围 |
| team_ids | jsonb | 指定团队范围 |
| agency_ids | jsonb | 指定机构范围 |
| enterprise_ids | jsonb | 指定企业范围 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

合法组合约定：

- `specified_agency` 必须配合 `agency_ids`。
- `specified_enterprise` 必须配合 `enterprise_ids`。
- `specified_department` 必须配合 `department_ids`。
- `specified_team` 必须配合 `team_ids`。
- `department` / `department_tree` 默认使用成员主部门，也可用 `department_ids` 显式指定。
- `team` 默认使用成员所属团队，也可用 `team_ids` 显式指定。
- `custom` 必须至少指定一种 ID 列表。

---

## 9. 审计与通知模型

### 9.1 ky_audit_log

审计日志表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 日志 ID |
| actor_user_id | text / uuid | 操作用户 |
| actor_membership_id | text / uuid | 操作成员身份 |
| workspace_type | text | 工作区类型 |
| workspace_id | text | 工作区 ID |
| agency_id | text / uuid | 所属机构，可选冗余，用于查询优化 |
| enterprise_id | text / uuid | 所属企业，可选冗余，用于查询优化 |
| action | text | 操作类型 |
| resource_type | text | 对象类型 |
| resource_id | text | 对象 ID |
| result | text | success / failed |
| request_id | text | 请求 ID |
| ip_address | text | IP |
| user_agent | text | UA |
| source | text | 请求来源 / 客户端来源 |
| remark | text | 备注信息 |
| detail | jsonb | 详情，承载变更前后值和扩展上下文 |
| created_at | timestamptz | 时间 |

---

### 9.2 ky_notification

通知表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 通知 ID |
| scope_type | text | user / platform / agency / enterprise |
| scope_id | text | 范围 ID |
| recipient_user_id | text / uuid | 接收用户，可空 |
| recipient_membership_id | text / uuid | 接收成员，可空 |
| title | text | 标题 |
| content | text | 内容 |
| notification_type | text | invite / security / system / permission / organization |
| status | text | normal / archived |
| created_at | timestamptz | 创建时间 |

通知范围规则：

- `scope_type=user` 时应指定 `recipient_user_id`。
- `scope_type=platform` 时 `scope_id=platform_root`。
- `scope_type=agency` / `enterprise` 时 `scope_id` 为对应主体 ID。
- 定向成员通知优先使用 `recipient_membership_id`，用于工作区内通知隔离。
- 顶部未读数默认统计当前用户在当前 workspace 可见的未读通知；系统公告是否计入未读由公告发布时是否生成通知决定。

---

### 9.3 ky_notification_read

通知已读表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | ID |
| notification_id | text / uuid | 通知 ID |
| user_id | text / uuid | 用户 ID |
| read_at | timestamptz | 已读时间 |

---

### 9.4 ky_system_announcement

系统公告表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 公告 ID |
| title | text | 标题 |
| content | text | 内容 |
| target_scope | text | all / agency / enterprise / user |
| target_ids | jsonb | 目标 ID 列表 |
| status | text | draft / published / archived |
| published_at | timestamptz | 发布时间 |
| created_by | text / uuid | 创建人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

---

## 10. 系统设置模型

### 10.1 ky_system_setting

系统设置表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | ID |
| scope_type | text | platform / agency / enterprise |
| scope_id | text | platform_root / agency_id / enterprise_id |
| setting_key | text | 配置键 |
| setting_value | jsonb | 配置值 |
| description | text | 描述 |
| updated_by | text / uuid | 更新人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

---

### 10.2 ky_dictionary

字典表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 字典 ID |
| code | text | 字典编码 |
| name | text | 字典名称 |
| scope_type | text | platform / agency / enterprise |
| scope_id | text | 范围 ID |
| status | text | normal / disabled |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

---

### 10.3 ky_dictionary_item

字典项表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 字典项 ID |
| dictionary_id | text / uuid | 字典 ID |
| label | text | 显示名称 |
| value | text | 值 |
| sort_order | int | 排序 |
| status | text | normal / disabled |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

---

## 11. AI 配置模型

### 11.1 ky_ai_provider

AI 供应商表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 供应商 ID |
| name | text | 供应商名称 |
| provider_type | text | anthropic / openai / deepseek / qwen / custom_openai_compatible |
| base_url | text | API 地址 |
| api_key_encrypted | text | 加密后的 API Key |
| status | text | enabled / disabled |
| remark | text | 备注 |
| created_by | text / uuid | 创建人 |
| updated_by | text / uuid | 更新人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |
| deleted_at | timestamptz | 软删除 |

---

### 11.2 ky_ai_model

AI 模型表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | 模型 ID |
| provider_id | text / uuid | 供应商 ID |
| name | text | 模型名称 |
| model_key | text | 模型标识 |
| model_type | text | text_generation / embedding / vision / audio |
| context_length | int | 上下文长度 |
| default_parameters | jsonb | 默认参数 |
| status | text | enabled / disabled |
| remark | text | 备注 |
| created_by | text / uuid | 创建人 |
| updated_by | text / uuid | 更新人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |
| deleted_at | timestamptz | 软删除 |

说明：数据层预留 `vision`、`audio` 枚举，第一阶段 UI、权限和验收只启用 `text_generation` 与 `embedding`。

---

### 11.3 ky_ai_model_setting

默认模型配置表。

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | text / uuid | ID |
| scope_type | text | platform / agency / enterprise，第一阶段默认 platform |
| scope_id | text | 范围 ID |
| setting_key | text | default_chat_model / default_summary_model / default_embedding_model |
| model_id | text / uuid | 模型 ID |
| updated_by | text / uuid | 更新人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

第一阶段 AI 配置建议平台级管理；如后续需要机构或企业级默认模型，可复用 `scope_type + scope_id` 扩展。

---

## 12. 推荐索引与唯一约束

### 12.1 用户

```text
ky_user(phone) unique where phone is not null
ky_user(email) unique where email is not null
ky_user_credential(credential_type, identifier) unique
```

### 12.2 成员

```text
ky_membership(user_id, workspace_type, workspace_id) unique where deleted_at is null
ky_membership(workspace_type, workspace_id, status)
```

### 12.3 部门 / 团队

```text
ky_department(workspace_type, workspace_id, parent_id)
ky_department(workspace_type, workspace_id, code) unique where deleted_at is null
ky_team(workspace_type, workspace_id, code) unique where deleted_at is null
```

### 12.4 权限

```text
ky_permission(code) unique
ky_role(workspace_type, workspace_id, code) unique where deleted_at is null
ky_membership_role(membership_id, role_id) unique
```

### 12.5 审计 / 通知

```text
ky_audit_log(workspace_type, workspace_id, created_at desc)
ky_audit_log(actor_user_id, created_at desc)
ky_notification(recipient_user_id, created_at desc)
ky_notification_read(notification_id, user_id) unique
```

---

## 13. 第一阶段建表建议顺序

建议 SQL schema 分阶段：

```text
001_identity_schema.sql
002_organization_schema.sql
003_membership_schema.sql
004_access_schema.sql
005_audit_notification_schema.sql
006_system_setting_schema.sql
007_ai_model_schema.sql
008_seed.sql
```

---

## 14. 初始种子数据建议

第一阶段需要初始化：

- `platform_root` 工作区。
- 平台超级管理员用户。
- 平台超级管理员 membership。
- 平台内置角色。
- 机构内置角色模板。
- 企业内置角色模板。
- 权限点。
- 菜单权限。
- 默认系统设置。
- 默认 AI 供应商和模型，可选。

---

## 15. 与 zhipinai_v2 的复用关系

应严格复用的设计思想：

- 用户是根身份。
- platform / agency / enterprise 工作区。
- workspace access / membership 关系。
- permissions / actionPermissions / menuKeys。
- 审计日志。
- 通知中心。
- AI 模型供应商配置。

需要在 KyaiCRM 中强化：

- 部门表。
- 团队表。
- 成员多部门。
- 成员多团队。
- 部门 / 团队负责人数据范围。
- 机构与企业服务关系。

不引入：

- AI 员工相关表。
- AI 执行器相关表。
- IM 消息业务表。
- CRM 客户、线索、商机、合同等业务表。

---

## 16. 后续工作

本文档确定数据模型草案后，后续应继续输出：

- SQL schema 文件。
- 字段类型最终确认。
- migration 策略。
- seed 数据脚本。
- API contract 与表字段映射。
