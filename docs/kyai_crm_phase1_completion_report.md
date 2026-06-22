# KyaiCRM 第一阶段完成报告

> 文档状态：已锁定 / Phase 1 完成基线  
> 项目名称：KyaiCRM  
> 报告日期：2026-06-16  

KyaiCRM 第一阶段（多租户用户中心与多后台身份底座）后端 4 服务、前端 Auth 流程、数据库 schema/seed、部署与验收脚本已全部实现并锁定。本报告汇总各阶段交付与锁定状态。

---

## 1. 阶段完成总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1.1–1.2 | 工程骨架（monorepo / Host+Core+Plugins / 四 Go 服务骨架） | ✅ 锁定 |
| 1.3 | 数据库 schema（001–007）+ seed（008） | ✅ 锁定 |
| 1.4 | Auth / Bootstrap（后端 + 前端登录/选择/工作台） | ✅ 锁定 |
| 1.5 | 组织主体管理（机构/企业/当前组织/部门/团队） | ✅ 锁定 |
| 1.6 | 成员与邀请（含公开邀请接受） | ✅ 锁定 |
| 1.7 | 权限中心与数据范围（Access API + page/action 强校验回填） | ✅ 锁定 |
| 1.8 | 通知与审计（审计写 hook + 读、登录日志、通知消费、公告桥接） | ✅ 锁定 |
| 1.9 | AI 配置（供应商/模型/默认模型，API Key 加密） | ✅ 锁定 |
| 1.10 | 部署与验收（脚本、运行手册、验收清单） | ✅ 锁定 |

---

## 2. 后端服务

```text
ky-auth-service        18081  注册/登录/登出/me/bootstrap/平台用户/登录日志
ky-org-service         18082  机构/企业/当前组织/机构企业/部门/团队（+审计）
ky-membership-service  18083  成员/邀请/角色/权限/数据范围/通知/公告/审计读
ky-ai-model-service    18086  AI 供应商/模型/默认模型（+审计，API Key 加密）
```

四服务统一：HMAC token 校验、工作区 gating、active membership、`HasAny` 权限校验、best-effort 审计、`/readyz` 健康反映。`go build/vet/test` 全绿。

> Phase 1.17 起新增 `shared` 模块（`shared/auth`·`shared/session`·`shared/notify`）为 token 签验、会话校验、个人通知写入的单一来源，四服务经 go.work `use ./shared` 薄委托接入。

---

## 3. 前端

```text
apps/ky-admin-host：登录/注册/身份选择/无身份/403/工作台占位
packages/ky-admin-core：插件契约与 WorkspaceIdentity 类型
plugins/ky-*：七个插件骨架
typecheck + vite build 通过
```

---

## 4. 数据与安全基线

- 表统一 `ky_` 前缀；平台用固定工作区 `platform_root`，不建 `ky_platform/ky_organization*`。
- 权限字典完整 seed；平台 owner/admin、机构/企业 owner/admin/operator/readonly/member、部门/团队负责人模板均绑定权限与数据范围。
- 权限（page/action）强校验已在 org/membership/ai 服务生效。
- AI Provider API Key AES‑256‑GCM 加密，响应永不返明文。
- 关键写操作写 `ky_audit_log`；公告发布桥接通知。

---

## 5. 验收与部署

```text
scripts/acceptance.sh   端到端验收（A–I：健康/登录/bootstrap/鉴权负路径/组织/成员邀请/权限/通知审计/AI）
scripts/run_local.sh    一键本地构建+启动+验收
docs/kyai_crm_phase1_deployment_runbook.md   运行手册 + 验收清单
ops/native/*            env example、nginx、systemd unit
```

沙箱内已完成：脚本 `bash -n`、四服务 `go build/vet/test`、Nginx 路由与端点一致性核对。真实端到端验收为外部环境 runbook（需 PostgreSQL/psql/htpasswd + KY_AI_SECRET_KEY）。

---

## 6. 显式延后（Phase 1.11+）

> 更新：Settings / Dictionaries / Workbench summary 已于 Phase 1.11 实现并锁定（见 `kyai_crm_phase1_settings_workbench_implementation_lock.md`），Nginx 预留注释已移除。
> 更新：公开邀请接受已于 Phase 1.12 硬化为登录态（见 `kyai_crm_phase1_invitation_hardening_implementation_lock.md`）。
> 更新：行级数据范围过滤已端到端闭合 —— Phase 1.13「成员列表/详情」、1.13b「审计日志」、1.13c「邀请/部门/团队列表」全部生效。数据范围现作用于全部 Phase 1 list 面。
> 更新：公开接受邀请已 Phase 1.12 硬化为登录态；会话有效性校验已 Phase 1.14 在 org/membership/ai 全部登录后接口生效（撤销即时失效，见 `kyai_crm_phase1_session_enforcement_implementation_lock.md`）。

> 更新：事件级通知（单成员事件）已 Phase 1.15 落地（成员禁用/移除/调部门/调团队/授权角色 → 受影响成员个人通知，见 `kyai_crm_phase1_event_notification_implementation_lock.md`）。
> 更新：事件级通知 fan-out 已 Phase 1.16 落地（role.permissions_updated → 角色全部成员；agency/enterprise.status_changed → 主体全部活跃成员，见 `kyai_crm_phase1_notification_fanout_implementation_lock.md`）。invitation 通知仍延后（无法定向 userId）。
> 更新：Phase 1.17 新建 `shared` 模块，token（4→1）、session（4→1）、个人通知写入（2→1）收敛为单一来源（`shared/auth`、`shared/session`、`shared/notify`），各服务薄委托接入，行为零变化（见 `kyai_crm_phase1_shared_module_implementation_lock.md`）。基础助手/scope 助手抽取仍为技术债。
> 更新：Phase 1.18 AI 配置补全 —— 供应商停用级联（停模型 + 清平台默认）、独立可审计的 API 密钥轮换端点、停用供应商下禁建模/禁启用模型（见 `kyai_crm_phase1_ai_config_hardening_implementation_lock.md`）。机构/企业级默认模型留待 Phase 1.19。

```text
invitation 通知（延后：被邀请人无账号，无法定向 userId）
通知 fan-out 批量/异步化（当前逐条插入，规模有界）
基础助手（randomSuffix/nullStr/itoa）与 scope 助手跨服务共享模块抽取（技术债，下一轮）
机构/企业级默认模型（Phase 1.19：打开 AI ws 闸门 + 扩展权限矩阵 + 目录只读）
specified_agency/enterprise 平台跨主体数据面
auth token introspection 端点（替代各服务直读 ky_user_session，可选）
provider 软删级联、AI 用量/限额、模型探活
前端页面接入、真实云部署 / HTTPS / 监控告警
CRM 业务、AI 员工/执行器/工作流、IM、移动端（始终不在第一阶段范围）
```

---

## 7. 锁定文档索引

```text
需求/架构：kyai_crm_multi_tenant_identity_requirements / _architecture / _technical_selection /
          _data_model / _permission_matrix / _admin_pages / _api_contracts / _workspace_layout /
          _deployment / _phase1_implementation_plan
阶段锁定：_phase1_skeleton_lock
          _phase1_auth_bootstrap_requirements / _lock / _implementation_lock
          _phase1_org_management_requirements / _implementation_lock
          _phase1_membership_requirements / _implementation_lock
          _phase1_access_requirements / _implementation_lock
          _phase1_audit_notification_requirements / _implementation_lock
          _phase1_ai_config_requirements / _implementation_lock
          _phase1_deployment_acceptance_requirements
          _phase1_event_notification_implementation_lock
          _phase1_notification_fanout_requirements / _implementation_lock
          _phase1_shared_module_requirements / _implementation_lock
          _phase1_ai_config_hardening_requirements / _implementation_lock
          _phase1_deployment_runbook
          _phase1_completion_report（本文件）
```

---

## 8. 结论

KyaiCRM 第一阶段“多租户用户中心与多后台身份底座”已完成并可锁定。后端 4 服务、前端 Auth 流程、数据库、权限、审计、通知、AI 配置、部署与验收脚本齐备，编译/单测/复审全部通过。后续业务模块可在此底座上继续构建。
