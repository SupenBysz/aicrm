# KyaiCRM Phase 1.11 设置 / 字典 / 工作台实现需求

> 文档状态：已锁定 / Phase 1.11 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.11 / 设置·字典·工作台（Phase 1 后补，闭合预留路由）  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.1–1.10 全部已实现并锁定  

---

## 1. 阶段目标

实现此前在 Nginx 预留、admin-pages 文档引用但未实现的后端面：工作区设置、平台系统设置、平台字典、三类工作台摘要。全部落在 `ky-org-service`。完成后移除对应 Nginx 预留注释。

---

## 2. 范围

### 2.1 接口

```text
GET   /api/v1/settings                          agency/enterprise
PATCH /api/v1/settings                          agency/enterprise
GET   /api/v1/platform/system-settings          platform
PATCH /api/v1/platform/system-settings          platform
GET   /api/v1/dictionaries                       platform
GET   /api/v1/platform/workbench/summary         platform
GET   /api/v1/agency/workbench/summary           agency
GET   /api/v1/enterprise/workbench/summary       enterprise
```

### 2.2 鉴权（复用 ws）

| 接口 | allowedTypes | requiredPerms |
|---|---|---|
| GET /settings | agency,enterprise | agency.settings.view / enterprise.settings.view |
| PATCH /settings | agency,enterprise | agency.settings.update / enterprise.settings.update |
| GET /platform/system-settings | platform | platform.settings.view |
| PATCH /platform/system-settings | platform | platform.settings.update |
| GET /dictionaries | platform | platform.dictionaries.view |
| GET /platform/workbench/summary | platform | platform.workbench.view |
| GET /agency/workbench/summary | agency | agency.workbench.view |
| GET /enterprise/workbench/summary | enterprise | enterprise.workbench.view |

### 2.3 表

```text
ky_system_setting (scope_type, scope_id, setting_key, setting_value jsonb)
ky_dictionary / ky_dictionary_item
读：ky_user / ky_agency / ky_enterprise / ky_membership / ky_department / ky_team /
    ky_login_log / ky_ai_provider / ky_ai_model / ky_audit_log / ky_invitation（工作台聚合）
```

### 2.4 不做 / 延后

```text
机构/企业级字典（第一阶段字典仅平台）
设置项的强 schema 校验（本阶段按通用 key->jsonb 存取）
工作台实时缓存/复杂指标
```

---

## 3. 设置模型

统一“(scope_type, scope_id, setting_key) -> setting_value(jsonb)”模型，`(scope_type,scope_id,setting_key)` 唯一，upsert。

### 3.1 当前工作区设置 `/settings`

- scope = 当前工作区（agency/enterprise）。
- GET：返回 `{ settings: { <settingKey>: <value>, ... } }`，无设置返回空对象。
- PATCH：请求 `{ "settings": { "inviteExpiresDays": 7, "defaultRoleId": "role_001" } }`，对每个 key upsert（value 存为 jsonb）。
- 仅当前工作区可读写。

### 3.2 平台系统设置 `/platform/system-settings`

- scope = platform/platform_root。
- GET：返回 `{ settings: { general:{...}, security:{...}, registration:{...}, tenant:{...}, ... } }`（按 setting_key 聚合，seed 已含这四节）。可选 `?section=security` 只返回该节。
- PATCH：请求 `{ "settings": { "security": {...} } }`，按 key upsert；不拆 `/security` 子路由。

---

## 4. 字典 `/dictionaries`

- 平台维护，scope = platform/platform_root。
- GET：返回字典数组，每项含 `code/name/status` 与 `items:[{label,value,sortOrder,status}]`（按 sortOrder 排序）。
- 可选 `?code=` 过滤单个字典。

---

## 5. 工作台摘要

### 5.1 平台 `/platform/workbench/summary`

```json
{
  "userCount": 0,
  "agencyCount": 0,
  "enterpriseCount": 0,
  "todayLoginCount": 0,
  "enabledAiProviderCount": 0,
  "enabledAiModelCount": 0,
  "recentAuditLogs": []
}
```

- 计数源：`ky_user`（未删除）、`ky_agency`、`ky_enterprise`、`ky_login_log`（当日 result=success 可计 total）、`ky_ai_provider`/`ky_ai_model`（status=enabled）。
- recentAuditLogs：`ky_audit_log` 全局最近 5 条（id/action/resourceType/createdAt/actorUserId）。

### 5.2 机构 `/agency/workbench/summary`

```json
{
  "memberCount": 0,
  "departmentCount": 0,
  "teamCount": 0,
  "enterpriseCount": 0,
  "pendingInvitationCount": 0,
  "recentAuditLogs": []
}
```

- scope = 当前机构。enterpriseCount = 该机构名下未删除企业数。pendingInvitationCount = 当前工作区 pending 邀请数。recentAuditLogs = 当前工作区最近 5 条。

### 5.3 企业 `/enterprise/workbench/summary`

```json
{
  "memberCount": 0,
  "departmentCount": 0,
  "teamCount": 0,
  "pendingInvitationCount": 0,
  "recentAuditLogs": []
}
```

- scope = 当前企业。

---

## 6. 部署一致性

实现后移除 `ops/native/ky-admin-host.nginx.conf` 中 settings/system-settings/dictionaries/workbench 四处的 “Phase 1.11 预留” 注释（路由本就指向 18082，无需改 proxy）。

---

## 7. 验收标准

```text
go build / vet / test 四服务通过
GET/PATCH /settings 按工作区隔离可读写
平台系统设置聚合读写、section 过滤可用
/dictionaries 返回字典 + 项（平台）
三类工作台摘要返回契约字段；计数与 recentAuditLogs 正确
无对应权限 403 permission_denied；工作区类型不符 403 workspace_forbidden
nginx 预留注释移除
```

---

## 8. 风险与约束

1. 工作台聚合跨域读多张表，沿用既有“服务直接读共享表”模式。
2. 设置按通用 key->jsonb 存取，不做强 schema；具体业务键含义由前端约定。
3. 字典第一阶段仅平台维护（与既有权限锁定一致）。
4. 工作台为只读摘要，无写操作、无审计。
