# KyaiCRM Phase 1.10 部署与验收实现锁定记录

> 文档状态：已锁定 / Phase 1.10 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
scripts/acceptance.sh
scripts/run_local.sh
docs/kyai_crm_phase1_deployment_runbook.md
docs/kyai_crm_phase1_completion_report.md
ops/native/ky-admin-host.nginx.conf（Phase 1.11 预留注释）
```

---

## 2. 交付物

### 2.1 acceptance.sh
curl 驱动端到端验收，A–I 断言覆盖：健康/readyz、登录、bootstrap、鉴权负路径（401 / 403）、组织、成员邀请、权限中心、通知与审计、AI 配置（含 apiKey 不外泄、vision 拒绝、默认模型类型校验）。逐项 PASS/FAIL，任一失败非零退出。

### 2.2 run_local.sh
一键本地：执行 schema+seed、写开发凭据、构建四服务、后台启动、等待 readyz、跑 acceptance、退出清理。env 缺失明确报错。

### 2.3 运行手册 + 完成报告
`deployment_runbook.md`（前置/部署/验收清单/回滚安全/已知缺口/沙箱说明）与 `completion_report.md`（Phase 1 跨阶段汇总）。

### 2.4 Nginx 预留注释
`/api/v1/settings`、`/platform/system-settings`、`/dictionaries`、`workbench/summary` 四处加 Phase 1.11 预留注释，保留路由不删除。

---

## 3. 复审与修复

独立复审逐条比对 acceptance.sh 断言与真实 handler 行为（登录返回 data.token、创建机构 200、邀请默认目标当前工作区、AI provider 不返明文、vision 400、默认模型类型校验、负路径 401/403 顺序等），结论除一项外全部一致。

修复 1 项阻塞：

- `json_field` 的 jq 分支原期望 jq 路径，但调用处传入裸字段名（仅 grep 分支支持），在装有 jq 的环境会静默取空导致 token/id 提取失败（误判 FAIL）。已统一为：两分支均接收裸字段名，jq 分支解析 `.data.<key>`。已用真实信封形状验证 jq 与 grep 两条路径均能正确提取 token/id。

---

## 4. 沙箱内验证

```text
bash -n scripts/acceptance.sh / run_local.sh        通过
nginx 大括号配平（29/29）                            通过
go build / vet / test 四服务                         全绿
json_field jq/grep 提取验证（data.token/data.id）    通过
Nginx 路由与全部已实现端点前缀一致性核对              通过
```

复审结论：

```text
NO BLOCKERS
```

---

## 5. 外部环境待执行（runbook）

真实端到端验收需 PostgreSQL/psql/htpasswd + `KY_AI_SECRET_KEY`，按 `deployment_runbook.md` 执行 `run_local.sh` 或分步部署后跑 `acceptance.sh`。沙箱无上述依赖，故真实跑库为外部 runbook，不阻塞本阶段交付物锁定。

---

## 6. 结论

Phase 1.10 交付物（验收脚本、本地运行助手、运行手册、完成报告、Nginx 预留）已实现并通过沙箱校验与复审。至此 KyaiCRM 第一阶段全部阶段实现并锁定，详见 `kyai_crm_phase1_completion_report.md`。
