# KyaiCRM Phase 1.11 设置 / 字典 / 工作台实现锁定记录

> 文档状态：已锁定 / Phase 1.11 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
services/ky-org-service（settings/dictionaries/workbench）
scripts/acceptance.sh（J 段）
ops/native/ky-admin-host.nginx.conf（移除预留注释）
```

闭合了此前在 Nginx 预留、admin-pages 文档引用但未实现的后端面。

---

## 2. 已实现接口

```text
GET   /api/v1/settings                     agency/enterprise
PATCH /api/v1/settings                     agency/enterprise
GET   /api/v1/platform/system-settings     platform（可选 ?section=）
PATCH /api/v1/platform/system-settings     platform
GET   /api/v1/dictionaries                  platform（可选 ?code=）
GET   /api/v1/platform/workbench/summary    platform
GET   /api/v1/agency/workbench/summary      agency
GET   /api/v1/enterprise/workbench/summary  enterprise
```

---

## 3. 实现要点

### 3.1 设置

- 统一 `(scope_type, scope_id, setting_key) -> setting_value(jsonb)` 模型，按唯一索引 upsert。
- `/settings` 限当前工作区（agency/enterprise）；`/platform/system-settings` 限平台，支持 `section` 过滤、聚合返回 `{settings:{key:value}}`。
- PATCH 写操作进审计（`settings.updated` / `system_settings.updated`）。

### 3.2 字典

- 平台维护，`scope=platform/platform_root`；返回字典数组含 `items`（按 sortOrder）。

### 3.3 工作台摘要

- 平台：userCount/agencyCount/enterpriseCount/todayLoginCount/enabledAiProviderCount/enabledAiModelCount/recentAuditLogs（全局最近 5）。
- 机构：member/department/team/enterprise/pendingInvitation 计数 + 当前工作区最近 5 审计。
- 企业：member/department/team/pendingInvitation 计数 + 当前工作区最近 5 审计。
- 只读，无写、无审计；跨域读共享表（沿用既有模式）。

### 3.4 鉴权

- 复用 `ws(allowedTypes, requiredPerms, handler)`；8 个权限码均已 seed。
- 工作区类型不符 403 `workspace_forbidden`；无权限 403 `permission_denied`。

---

## 4. 复审与验证

独立复审核验 SQL 列/约束/jsonb 扫描、工作台 33 处聚合列存在、路由门、ServeMux 无冲突、响应形态，结论：

```text
NO BLOCKERS
```

验证：

```text
go build / vet / test 四服务通过
bash -n scripts/acceptance.sh 通过
nginx 预留注释移除、路由指向 18082
```

新增单测：settings/平台接口工作区门（typeAllowed）。

---

## 5. 部署一致性

- Nginx 既有 `/api/v1/settings`、`/platform/system-settings`、`/dictionaries`、`workbench/summary` 路由保持指向 `18082`，移除 Phase 1.11 预留注释。
- acceptance.sh 增加 J 段：平台系统设置 GET/PATCH、字典、平台工作台摘要。

---

## 6. 结论

Phase 1.11 设置/字典/工作台已实现并锁定，KyaiCRM 第一阶段所有“预留未实现”后端面全部闭合。详见 `kyai_crm_phase1_completion_report.md`。
