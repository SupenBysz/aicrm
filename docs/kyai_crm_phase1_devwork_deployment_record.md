# KyaiCRM Phase 1 dev-work 部署记录

> 文档状态：部署记录 / dev 环境  
> 日期：2026-06-21  
> 主机：dev-work（公网 175.41.22.54；内网 10.127.79.49 / 10.64.79.49）  

---

## 1. 拓扑

```text
浏览器 → https://kyaicrm.entai.im (Cloudflare 边缘 TLS)
        → Cloudflare Tunnel (cloudflared, 隧道 tg-kysion-dev-work, token 托管)
        → http://127.0.0.1:16178 (nginx, server_name kyaicrm.entai.im)
        → 同源 /api/v1/* 反代 → 127.0.0.1:18081/18082/18083/18086 (四服务, systemd)
                静态 → /data/kyai_crm/www/ky-admin-host (前端 dist)
PostgreSQL（外部托管）：业务网 10.64.79.43:5432 / 库 kyaicrm（keyword-value DSN）
```

仅 nginx 听 16178、且绑 127.0.0.1；后端均绑 127.0.0.1，不对内外网暴露；无需放行任何公网端口（CF 隧道出站）。

---

## 2. 落地清单

```text
依赖：apt 安装 nginx / postgresql-client(psql) / apache2-utils(htpasswd) / jq
配置：/data/kyai_crm/config/external-dependencies.env (chmod 600)
       强随机 KY_AUTH_TOKEN_SECRET、KY_AI_SECRET_KEY（openssl rand -hex 32）
       KY_TENANT_DATABASE_URL 用 keyword-value（密码含 '/'，避免 URL 解析歧义）
       后端 *_HTTP_ADDR 绑 127.0.0.1；KY_*_URL = https://kyaicrm.entai.im
数据库：ops/db/001-007 schema + 008 seed（psql -v ON_ERROR_STOP=1，空库验证后执行）
       28 张 ky_ 表、138 权限、18 角色、platform_owner
凭据：scripts/seed_dev_data.sh → platform_owner / admin123456（bcrypt $2a$10$）
服务：build_services + deploy_services（/data/kyai_crm/bin + /etc/systemd/system, enable+start）
nginx：/etc/nginx/sites-enabled/kyaicrm.conf（listen 127.0.0.1:16178），移除 default 站点
前端：build_frontend（vite）+ deploy_frontend → /data/kyai_crm/www/ky-admin-host
```

---

## 3. 首次真实运行暴露并修复的问题

### 3.1 AI 服务路由冲突（致启动 panic）—— 已修复

`ky-ai-model-service` 首次启动 panic：Go 1.22 `ServeMux` 模式冲突——
`PATCH /api/v1/ai-models/{id}/status`（模型）与 `PATCH /api/v1/ai-models/providers/{id}`（供应商）
对 `/api/v1/ai-models/providers/status` 二者皆匹配且互不更specific。`go build/vet/test`（仅测 handler）**测不到**，只在运行时注册路由时 panic——正是“首次真跑”才暴露。

修复：模型路由收编到子集合 `/api/v1/ai-models/models`，使 providers/models/settings 三者为并列字面量、`{id}` 通配不再与兄弟字面量重叠。

**契约变更（AI 模型集合路径）**：

```text
GET   /api/v1/ai-models            -> GET   /api/v1/ai-models/models
POST  /api/v1/ai-models            -> POST  /api/v1/ai-models/models
PATCH /api/v1/ai-models/{id}       -> PATCH /api/v1/ai-models/models/{id}
PATCH /api/v1/ai-models/{id}/status-> PATCH /api/v1/ai-models/models/{id}/status
（providers/* 与 settings 路径不变；仍在 nginx /api/v1/ai-models 前缀内，无需改 nginx）
```

同步更新：`scripts/acceptance.sh` 的建模请求路径。

回归防护：抽出 `(*Server).buildMux()` 并加 `TestBuildMuxNoRouteConflict`（构造 mux，捕获注册期 panic），堵住此类“仅运行时可见”的路由冲突。

---

## 4. 验收

```text
verify_deployment.sh（systemd active + 四服务 /readyz=ok + nginx /healthz=ok @16178）通过
acceptance.sh A–J 首次对真库：36 passed, 0 failed
经 nginx:16178 同源登录 platform_owner → 200 + token（浏览器→CF→nginx→auth 链路成立）
```

> acceptance 写入了测试数据（验收机构 / 验收供应商 / 测试角色 / 公告 / 文本模型 / chat 默认模型）。如需洁净起点可重跑 001-008 + seed_dev_data，或单独清理这些测试行。

---

## 5. Cloudflare 接入（已完成）

```text
注意：dev-work 既有 cloudflared 的隧道在账户 f3f688…（且 --url 指向 8091），与 entai.im 所在
账户 9f275d… 跨账户，无法复用。故在 entai.im 账户新建独立隧道与连接器：

账户(entai.im)   9f275d6610ed14bc6b64411c9906e27c
zone(entai.im)   bf6e5c7916c07b6bd97f8c1b606cf638
新隧道           kyaicrm-dev-work  id=0d474105-d564-4be3-8f97-30c56856a0d0（远端托管）
ingress          kyaicrm.entai.im -> http://localhost:16178 ；catch-all http_status:404
DNS              CNAME kyaicrm.entai.im -> 0d474105….cfargotunnel.com（proxied）
连接器           systemd: cloudflared-kyaicrm.service
                 ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token-file /etc/cloudflared/kyaicrm.token
                 token 文件 600；与既有 cloudflared 实例并存、互不影响
验证             https://kyaicrm.entai.im/healthz = 200；/api/v1/auth/login = 200（token 获取成功）
```

> 安全：本次用了账户 Global API Key。建议尽快在 CF 控制台**轮换该 Global Key**，或改用范围受限的 API Token。`/etc/cloudflared/kyaicrm.token` 为隧道连接器密钥，勿外泄。

---

## 6. 运维备忘

```text
日志：journalctl -u ky-auth-service|ky-org-service|ky-membership-service|ky-ai-model-service -f
重启：systemctl restart <svc>；nginx：systemctl reload nginx
env：/data/kyai_crm/config/external-dependencies.env（600；含 DB 密码与密钥，勿入库/勿打印）
重新部署：build_services + KY_EXECUTE_SERVICE_DEPLOY=1 deploy_services；
          build_frontend + KY_EXECUTE_FRONTEND_DEPLOY=1 KY_VERIFY_CONSOLE_URL=http://127.0.0.1:16178 deploy_frontend
生产硬化（开发期未做）：改默认密码、TLS 策略、备份、监控。
```
