# KyaiCRM Phase 1 部署运行手册与验收清单

> 文档状态：运行手册 / Phase 1 收尾  
> 项目名称：KyaiCRM  
> 编写日期：2026-06-16  
> 关联：`docs/kyai_crm_deployment.md`、`docs/kyai_crm_phase1_deployment_acceptance_requirements.md`  

本手册指导在具备真实依赖（PostgreSQL/Redis/NATS）的环境中完成 KyaiCRM 第一阶段后端 4 服务 + 前端的部署与端到端验收。

---

## 1. 前置依赖

```text
PostgreSQL（已创建库与账号）
Redis、NATS（服务可访问，第一阶段未强依赖业务调用）
工具：psql、htpasswd（apache2-utils）、curl、go 1.25、node 22、pnpm
环境变量：见 ops/native/external-dependencies.env.example
  必填：KY_TENANT_DATABASE_URL、KY_AUTH_TOKEN_SECRET、KY_AI_SECRET_KEY
```

> `KY_AI_SECRET_KEY` 缺失时，AI 供应商写接口返回 503，且 ai 服务 `/readyz` 为 degraded。

---

## 2. 部署步骤

```text
1) 准备 env：cp ops/native/external-dependencies.env.example /data/kyai_crm/config/external-dependencies.env 并填写
   export KY_RUNTIME_ENV_FILE=/data/kyai_crm/config/external-dependencies.env
   source 之或交由 systemd 注入

2) 数据库：
   KY_EXECUTE_DATABASE_DEPLOY=1 scripts/deploy_database.sh
   （执行 ops/db/001..007 schema + 008 seed）

3) 开发凭据（仅本地/测试）：
   scripts/seed_dev_data.sh
   （为 platform_owner 写入 bcrypt(admin123456)，替换 008_seed.sql 的 CHANGE_ME_HASH）

4) 构建并部署服务：
   scripts/build_services.sh
   KY_EXECUTE_SERVICE_DEPLOY=1 scripts/deploy_services.sh
   （安装二进制 + systemd unit，daemon-reload、enable、restart、readyz 验证）

5) 构建并部署前端：
   scripts/build_frontend.sh
   KY_EXECUTE_FRONTEND_DEPLOY=1 scripts/deploy_frontend.sh
   （dist -> /data/kyai_crm/www/ky-admin-host，nginx -t + reload，healthz 检查）

6) 验证：
   scripts/verify_deployment.sh        # systemd active + readyz + healthz
   scripts/acceptance.sh               # 端到端业务验收（对测试库）
```

本地一键（具备 DB 时）：

```text
source 一份 KY_* env（含 KY_AI_SECRET_KEY）
scripts/run_local.sh
```

---

## 3. 服务与端口

```text
ky-auth-service        18081   /auth/*, /platform/users, /login-logs
ky-org-service         18082   /platform/agencies, /platform/enterprises, /agency/enterprises,
                               /organizations, /departments, /teams
ky-membership-service  18083   /workspace/members, /memberships, /invitations, /public/invitations,
                               /roles, /permissions, /data-scopes, /audit-logs, /notifications, /announcements
ky-ai-model-service    18086   /ai-models*
```

Nginx 同源代理 `/api/v1/*`，静态托管 `ky-admin-host`。

---

## 4. 端到端验收清单（对应 scripts/acceptance.sh A–I）

```text
A 健康：/healthz=200；四服务 /readyz=ok（ai 含 aiSecretConfigured=true）
B 登录：platform_owner/admin123456 -> token
C Bootstrap：含 platform_root、platform_owner 角色、菜单/权限/数据范围
D 鉴权负路径：无 token=401；agency 工作区头访问平台 AI 接口=403
E 组织：创建机构、列表可见
F 成员/邀请：成员列表、创建邀请、公开查询邀请
G 权限中心：roles/permissions/data-scopes 可查、创建角色
H 通知/审计：发布公告 -> 未读数>=1；audit-logs 含写操作；login-logs 可读
I AI：创建供应商（apiKey 不外泄）、拒绝 vision、设置默认模型类型校验
```

通过判定：`acceptance.sh` 退出码 0，PASS 全绿。

---

## 5. 回滚与安全

```text
回滚：保留上一版二进制/前端 dist，替换并 restart / reload（见 deployment 文档）
安全：
  - env 不入库；KY_AUTH_TOKEN_SECRET / KY_AI_SECRET_KEY 强随机
  - 生产替换 platform_owner 默认密码并重新生成 hash
  - AI Provider API Key 加密存储，响应不返明文
  - 服务仅监听本机/受控内网，由 Nginx 暴露
```

---

## 6. 已知缺口与延后项（Phase 1.11）

```text
未实现（路由已在 nginx 预留并注释，命中返回 404）：
  /api/v1/settings、/api/v1/platform/system-settings
  /api/v1/dictionaries
  /api/v1/(platform|agency|enterprise)/workbench/summary
其他延后（见各阶段实现锁定文档）：
  事件级通知自动生成、行级数据范围过滤、公开接受邀请的 userId 硬化、
  provider 停用级联、AI 密钥轮换、机构/企业级默认模型
```

---

## 7. 沙箱说明

本仓库开发沙箱无 PostgreSQL/psql/htpasswd，真实端到端验收须在具备依赖的环境按本手册执行。沙箱内已完成：`bash -n` 脚本语法校验、四服务 `go build/vet/test`、Nginx 路由与端点一致性核对。
