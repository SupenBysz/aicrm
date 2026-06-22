# KyaiCRM Phase 1.10 部署与验收实现需求

> 文档状态：已锁定 / Phase 1.10 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.10 / 部署与验收（第一阶段收尾）  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.1–1.9 全部已实现并锁定（4 个 Go 服务 + 前端 Auth 流程）  

---

## 1. 阶段目标

把已实现的 4 个 Go 服务与前端推进到“可部署、可端到端验收”的收口状态：部署脚本可执行、验收脚本覆盖全 API 面、运行手册明确，并集中处理此前各阶段记录的“外部环境待办”。

本阶段原则上不新增业务功能，只交付部署编排、验收脚本与文档。

本阶段决策：

- 决策 A（A‑2）：`settings` / `dictionaries` / `workbench/summary` 路由判定为 Phase 1 显式延后，从验收范围剔除，在 Nginx 对应 location 加注释说明“预留未实现”，登记为 Phase 1.11 待办。
- 决策 B（B‑1）：交付 `scripts/acceptance.sh` + 运行手册；真实跑库执行作为外部环境 runbook。沙箱内仅做 `bash -n` 语法校验 + 各服务编译/单测。
- 决策 C（C‑1）：新增 `scripts/run_local.sh` 一键本地运行助手，便于具备 DB 时一键验收。

---

## 2. 范围与产出

```text
1. scripts/acceptance.sh         curl 驱动端到端验收
2. scripts/run_local.sh          一键本地构建+启动+验收
3. docs/kyai_crm_phase1_deployment_runbook.md   部署运行手册 + 验收清单
4. Nginx 预留路由注释（settings/dictionaries/workbench）
5. verify_deployment.sh 维持（健康/readyz 层面），acceptance.sh 承担业务验收
6. Phase 1 完成报告（跨阶段锁定汇总）
```

### 2.1 不做 / 显式延后

```text
settings / dictionaries / workbench summary 接口实现（Phase 1.11）
真实云部署 / HTTPS 证书 / 监控告警（按 deployment 文档后续补充）
新业务功能
```

---

## 3. 验收脚本 `scripts/acceptance.sh`

仅依赖 `curl`（可选 `jq`，无则用 grep 兜底）。输入环境变量：

```text
KY_ACCEPT_BASE_URL        默认 http://127.0.0.1
KY_ACCEPT_AUTH_URL        默认 http://127.0.0.1:18081（直连 auth，绕过 nginx 亦可）
KY_ACCEPT_ADMIN_ACCOUNT   默认 platform_owner
KY_ACCEPT_ADMIN_PASSWORD  默认 admin123456
```

断言项（逐项 PASS/FAIL，任一失败非零退出）：

```text
A. 健康：GET /healthz=200；四服务 /readyz=ok（ai 含 aiSecretConfigured=true）
B. 登录：POST /api/v1/auth/login -> 200 且含 token
C. Bootstrap：GET /api/v1/auth/bootstrap -> 含 platform_root 工作区、platform_owner 角色、menuKeys/permissions/dataScopes 非空
D. 鉴权负路径：
   - 无 token 调 /api/v1/roles -> 401 unauthorized
   - 用平台 token 但 X-KY-Workspace-Type=agency 调平台 AI 接口 -> 403 workspace_forbidden
E. 组织：POST /platform/agencies -> 201/200；GET /platform/agencies 可见
F. 成员/邀请：GET /workspace/members（平台工作区）；POST /invitations（平台成员邀请）；GET /public/invitations/:token
G. 权限中心：GET /roles、/permissions、/data-scopes 200；POST /roles 创建；POST /roles/:id/permissions
H. 通知/审计：POST /announcements + PATCH /:id/publish -> 通知未读数 >=1；GET /audit-logs 含本次写操作；GET /login-logs 200
I. AI 配置：POST /ai-models/providers（断言响应不含明文 apiKey，仅 hasApiKey/掩码）；
   POST /ai-models modelType=vision -> 400；POST /ai-models modelType=text_generation -> 成功；
   PATCH /ai-models/settings 指向非 embedding 模型作 embedding 默认 -> 400；指向合法模型 -> 成功
```

工作区调用统一带 Header：`Authorization`、`X-KY-Workspace-Type: platform`、`X-KY-Workspace-Id: platform_root`、`X-KY-Request-Id`。

负路径 D 用“平台 token + agency 工作区头访问平台 AI 接口”得到 403，避免额外造低权限账号。

脚本须标注：对一次性测试库执行（会创建机构/角色/公告/AI 配置等数据）。

---

## 4. 一键本地运行 `scripts/run_local.sh`

```text
前置：本地 PostgreSQL 可用，已 source 一份 KY_* env（含 KY_AI_SECRET_KEY）
步骤：
 1) deploy_database.sh（KY_EXECUTE_DATABASE_DEPLOY=1）执行 schema+seed
 2) seed_dev_data.sh 写入 platform_owner 开发凭据
 3) build_services.sh 构建四服务二进制
 4) 后台启动四服务（各自 HTTP_ADDR），记录 PID
 5) 等待 readyz
 6) acceptance.sh
 7) 退出时清理后台进程
安全：仅用于本地/测试；不触碰生产；缺 DB 时明确报错退出
```

---

## 5. 运行手册 `docs/kyai_crm_phase1_deployment_runbook.md`

```text
前置依赖、env 准备、数据库初始化、开发凭据、构建、部署、验证、回滚、安全
端到端验收清单（对应 acceptance.sh A–I）
显式延后项与已知缺口（settings/dictionaries/workbench）
外部环境提示（psql/htpasswd/PostgreSQL/KY_AI_SECRET_KEY）
```

---

## 6. Nginx 预留路由处理（决策 A）

在 `ops/native/ky-admin-host.nginx.conf` 中，对 `/api/v1/settings`、`/api/v1/platform/system-settings`、`/api/v1/dictionaries`、`workbench/summary` 的 location 增加注释：

```text
# Phase 1.11 预留：Settings/Dictionaries/Workbench 接口尚未实现，命中将返回 404；保留路由以备后续。
```

不删除 location（避免后续回加），仅注释说明。

---

## 7. 验收标准

### 7.1 沙箱内（本阶段可执行）

```text
bash -n scripts/acceptance.sh / run_local.sh 语法通过
go build / vet / test 四服务全绿
nginx 配置注释完成；文档完成
```

### 7.2 外部环境（runbook，具备 DB 时执行）

```text
四服务 readyz=ok（ai 含 aiSecretConfigured=true）
acceptance.sh 全部 PASS
平台 owner 可登录/bootstrap/进入工作台
写操作进审计；公告进通知未读数；AI apiKey 不外泄
```

---

## 8. 风险与约束

1. 沙箱无 PostgreSQL/psql/htpasswd，真实端到端为外部 runbook；本阶段交付物以脚本可执行性 + 编译/单测为准。
2. `acceptance.sh` 对测试库写入数据，须在一次性/可重置库执行。
3. settings/dictionaries/workbench 为已知延后缺口，命中返回 404，不纳入验收。
4. 默认开发凭据 `platform_owner/admin123456` 仅限本地/测试；生产必须替换。
5. `KY_AI_SECRET_KEY` 缺失时 AI provider 写接口 503，验收前必须配置。
