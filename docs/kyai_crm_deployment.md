# KyaiCRM 部署方案文档

> 文档状态：已锁定 / Phase 1 基线  
> 项目名称：KyaiCRM  
> 当前阶段：第一阶段 / 多租户用户中心与多后台身份底座  
> 编写日期：2026-06-15  
> 参照项目：`/data/Kysion/zhipinai_v2`  
> 关联文档：
> - `docs/kyai_crm_technical_selection.md`
> - `docs/kyai_crm_architecture.md`
> - `docs/kyai_crm_workspace_layout.md`
> - `docs/kyai_crm_phase1_implementation_plan.md`

---

## 1. 文档目的

本文档定义 KyaiCRM 第一阶段部署方案。

KyaiCRM 第一阶段部署严格复用 zhipinai_v2 的原生 VM 部署思路：

```text
Nginx + systemd + PostgreSQL + Redis + NATS + S3/MinIO + shell scripts
```

第一阶段不采用 Kubernetes-first，也不以 Docker 作为部署前提。

---

## 2. 部署目标

第一阶段部署目标：

1. 后台前端可通过浏览器访问。
2. Nginx 托管后台静态资源。
3. Nginx 将 `/api/v1/*` 反代到 Go 服务。
4. Go 服务由 systemd 管理。
5. PostgreSQL 完成 schema 初始化和 seed。
6. Redis、NATS 可被服务访问。
7. 外部依赖通过 env file 管理。
8. 部署脚本可完成数据库、服务、前端部署。
9. 验证脚本可检查核心链路。

---

## 3. 部署形态

选择：

```text
原生 VM 部署
```

核心组件：

| 组件 | 用途 |
|---|---|
| Nginx | 静态资源托管、API 反代、healthz |
| systemd | Go 服务进程管理 |
| PostgreSQL | 主数据库 |
| Redis | 短状态、会话辅助、限流、验证码等 |
| NATS | 内部事件、审计、通知事件 |
| S3/MinIO | 对象存储，头像、Logo、附件等 |
| Shell scripts | 构建、部署、验证 |

---

## 4. 服务器目录规划

推荐部署根目录：

```text
/data/kyai_crm
```

目录结构：

```text
/data/kyai_crm/
├── bin/
│   ├── ky-auth-service
│   ├── ky-org-service
│   ├── ky-membership-service
│   └── ky-ai-model-service
├── config/
│   └── external-dependencies.env
├── www/
│   └── ky-admin-host/
├── logs/
├── releases/
└── tmp/
```

说明：

- `bin/` 存放 Go 服务二进制。
- `config/` 存放运行时 env 文件。
- `www/ky-admin-host/` 存放前端构建产物。
- `logs/` 可用于脚本日志或服务补充日志。
- `releases/` 可存放历史发布包。
- `tmp/` 用于临时上传或部署解包。

---

## 5. 环境变量配置

### 5.1 运行时 env 文件

推荐路径：

```text
/data/kyai_crm/config/external-dependencies.env
```

通过环境变量覆盖：

```text
KY_RUNTIME_ENV_FILE=/data/kyai_crm/config/external-dependencies.env
```

---

### 5.2 env 示例

文件：

```text
ops/native/external-dependencies.env.example
```

内容建议：

```text
KY_PUBLIC_SITE_URL=https://www.kyai-crm.example
KY_CONSOLE_URL=https://console.kyai-crm.example
KY_API_PUBLIC_URL=https://console.kyai-crm.example
KY_ASSET_PUBLIC_URL=https://asset.kyai-crm.example
KY_COOKIE_DOMAIN=.kyai-crm.example

KY_TENANT_DATABASE_URL=postgresql://kyai_user:change_me@127.0.0.1:5432/kyai_crm_tenant?sslmode=disable
KY_POSTGRES_HOST=127.0.0.1
KY_POSTGRES_PORT=5432
KY_POSTGRES_DB=kyai_crm_tenant
KY_POSTGRES_USER=kyai_user
KY_POSTGRES_PASSWORD=change_me
KY_POSTGRES_SSLMODE=disable

KY_AUTH_TOKEN_SECRET=change_me
KY_REDIS_URL=redis://127.0.0.1:6379/0
KY_NATS_URL=nats://127.0.0.1:4222

KY_AUTH_SERVICE_HTTP_ADDR=:18081
KY_ORG_SERVICE_HTTP_ADDR=:18082
KY_MEMBERSHIP_SERVICE_HTTP_ADDR=:18083
KY_AI_MODEL_SERVICE_HTTP_ADDR=:18086
```

安全要求：

- 真实 env 文件不得提交到 Git。
- `KY_AUTH_TOKEN_SECRET` 必须使用强随机值。
- 数据库密码、API Key 不得写入 README 或公开文档。
- AI Provider API Key 必须加密存储，不能明文返回给前端。

---

## 6. 服务端口规划

| 服务 | 默认端口 | 说明 |
|---|---:|---|
| `ky-auth-service` | 18081 | 登录、注册、bootstrap、用户 |
| `ky-org-service` | 18082 | 平台、机构、企业、部门、团队、设置 |
| `ky-membership-service` | 18083 | 成员、邀请、角色、权限、通知、审计 |
| `ky-ai-model-service` | 18086 | AI 供应商和模型配置 |

可选：

| 服务 | 默认端口 | 说明 |
|---|---:|---|
| `ky-notification-service` | 18087 | 后续可选；Phase 1 不部署，通知公告先归口 `ky-membership-service` |

---

## 7. Nginx 配置

### 7.1 配置文件

推荐文件：

```text
ops/native/ky-admin-host.nginx.conf
```

部署到：

```text
/etc/nginx/sites-available/ky-admin-host.conf
/etc/nginx/sites-enabled/ky-admin-host.conf
```

或按服务器 Nginx 规范放入：

```text
/etc/nginx/conf.d/ky-admin-host.conf
```

---

### 7.2 Nginx 示例

```nginx
server {
  listen 80;
  server_name console.kyai-crm.example;

  root /data/kyai_crm/www/ky-admin-host;
  index index.html;

  location = /healthz {
    access_log off;
    default_type text/plain;
    return 200 "ok\n";
  }

  location /assets/ {
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  location /api/v1/auth/ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18081;
  }

  location /api/v1/platform/users {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18081;
  }

  location /api/v1/login-logs {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18081;
  }

  location /api/v1/platform/agencies {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18082;
  }

  location /api/v1/platform/enterprises {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18082;
  }

  location /api/v1/agency/enterprises {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18082;
  }

  location /api/v1/organizations {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18082;
  }

  location /api/v1/departments {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18082;
  }

  location /api/v1/teams {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18082;
  }

  location /api/v1/settings {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18082;
  }

  location /api/v1/platform/system-settings {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18082;
  }

  location /api/v1/dictionaries {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18082;
  }

  location ~ ^/api/v1/(platform|agency|enterprise)/workbench/summary$ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18082;
  }

  location /api/v1/roles {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18083;
  }

  location /api/v1/permissions {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18083;
  }

  location /api/v1/invitations {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18083;
  }

  location /api/v1/public/invitations {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18083;
  }

  location /api/v1/workspace/members {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18083;
  }

  location /api/v1/memberships {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18083;
  }

  location /api/v1/data-scopes {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18083;
  }

  location /api/v1/audit-logs {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18083;
  }

  location /api/v1/notifications {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18083;
  }

  location /api/v1/announcements {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18083;
  }

  location /api/v1/ai-models {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:18086;
  }

  location = /index.html {
    add_header Cache-Control "no-store";
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

说明：

- Phase 1 默认采用单域方案：`console.kyai-crm.example` 同时承载后台静态资源和同源 `/api/v1/*` 反代；`KY_API_PUBLIC_URL` 默认可与 `KY_CONSOLE_URL` 相同。
- 若使用 HTTPS，可由 Nginx 或外部网关处理证书。
- 如果后续启用 `api.kyai-crm.example` 独立入口，可另建 API server block，并同步调整 `KY_API_PUBLIC_URL`。
- Nginx 默认会透传 `Authorization`、`X-KY-Workspace-Id`、`X-KY-Workspace-Type`、`X-KY-Request-Id` 等业务请求头；网关层不得删除这些头。

---

## 8. systemd 配置

### 8.1 通用原则

每个 Go 服务一个 systemd unit。

要求：

- 使用非 root 运行用户，若条件允许。
- 明确 `Environment=KY_RUNTIME_ENV_FILE=...`。
- `WorkingDirectory=/data/kyai_crm`。
- `Restart=always`。
- 输出进入 journald。

---

### 8.2 ky-auth-service.service 示例

```ini
[Unit]
Description=KyaiCRM Auth Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/data/kyai_crm
Environment=KY_RUNTIME_ENV_FILE=/data/kyai_crm/config/external-dependencies.env
ExecStart=/data/kyai_crm/bin/ky-auth-service
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

其他服务同理：

```text
ky-org-service.service
ky-membership-service.service
ky-ai-model-service.service
```

---

## 9. 数据库部署

### 9.1 数据库名称建议

```text
kyai_crm_tenant
```

用户建议：

```text
kyai_user
```

### 9.2 Schema 文件

```text
ops/db/001_identity_schema.sql
ops/db/002_organization_schema.sql
ops/db/003_membership_schema.sql
ops/db/004_access_schema.sql
ops/db/005_audit_notification_schema.sql
ops/db/006_system_setting_schema.sql
ops/db/007_ai_model_schema.sql
ops/db/008_seed.sql
```

### 9.3 初始化流程

```text
创建数据库
创建数据库用户
执行 schema SQL
执行 seed SQL
验证平台超级管理员存在
验证 platform_root 存在
验证权限点存在
```

---

## 10. 部署脚本规划

### 10.1 deploy_database.sh

职责：

- 检查数据库连接。
- 执行 schema。
- 执行 seed。
- 输出初始化结果。

输入环境变量：

```text
KY_TENANT_DATABASE_URL
```

---

### 10.2 deploy_services.sh

职责：

- 编译 Go 服务。
- 上传或复制二进制到 `/data/kyai_crm/bin`。
- 安装 systemd unit。
- 执行 `systemctl daemon-reload`。
- enable 并 restart 服务。
- 调用 readyz 验证。

服务：

```text
ky-auth-service
ky-org-service
ky-membership-service
ky-ai-model-service
```

---

### 10.3 deploy_frontend.sh

职责：

- 执行 `pnpm install`，如需要。
- 执行 `pnpm --filter @ky/admin-host build`。
- 清理旧前端目录。
- 发布 `dist/` 到 `/data/kyai_crm/www/ky-admin-host`。
- reload Nginx。
- 检查 `/healthz`。

---

### 10.4 verify_deployment.sh

职责：

- 检查 Nginx healthz。
- 检查 systemd 服务状态。
- 检查各服务 readyz。
- 检查登录接口。
- 检查 bootstrap。
- 检查平台工作区菜单。
- 检查核心 API。

---

## 11. 健康检查

### 11.1 Nginx

```text
GET /healthz
```

预期：

```text
200 ok
```

### 11.2 服务 readyz

每个服务提供：

```text
GET /readyz
```

预期：

```json
{
  "status": "ok",
  "service": "ky-auth-service"
}
```

readyz 应检查：

- 服务启动成功。
- 数据库可连接。
- 必要配置存在。

---

## 12. 发布流程

推荐发布顺序：

```text
1. 准备 env 文件
2. 部署数据库 schema 和 seed
3. 构建并部署 Go 服务
4. 安装并启动 systemd 服务
5. 构建并部署前端
6. reload Nginx
7. 执行部署验证脚本
```

---

## 13. 回滚策略

### 13.1 前端回滚

- 保留上一版 `www/ky-admin-host` 发布包。
- 回滚时切换 symlink 或复制上一版 dist。
- reload Nginx。

### 13.2 服务回滚

- 保留上一版二进制到 `releases/`。
- 回滚时替换 `/data/kyai_crm/bin/ky-*-service`。
- restart systemd 服务。

### 13.3 数据库回滚

第一阶段建议谨慎处理：

- schema 变更必须有备份。
- 生产环境执行 schema 前先备份数据库。
- 尽量使用向前兼容变更。
- destructive migration 必须单独审批。

---

## 14. 安全要求

1. env 文件不得进入 Git。
2. 数据库密码不得写入文档和 README。
3. `KY_AUTH_TOKEN_SECRET` 必须使用强随机值。
4. AI Provider API Key 必须加密存储。
5. API 响应不得返回明文 API Key。
6. systemd 服务尽量使用低权限用户运行。
7. Nginx 只暴露必要端口。
8. 后端服务只监听本机地址或受控内网地址。
9. 日志中不得输出 token、密码、API Key。
10. 部署脚本不得打印敏感环境变量。

---

## 15. 第一阶段部署验收标准

部署完成后必须满足：

1. `GET /healthz` 返回 200。
2. 所有 systemd 服务状态为 active。
3. 所有服务 `/readyz` 返回 ok。
4. 管理后台页面可访问。
5. 登录接口可用。
6. bootstrap 接口可用。
7. 平台管理员可进入平台后台。
8. 多后台身份用户可进入身份选择页。
9. 工作区切换后菜单变化。
10. 无权限页面进入 `/403`。
11. 平台机构列表接口可访问。
12. 机构 / 企业当前组织接口可访问。
13. 成员列表接口可访问。
14. 通知未读数接口可访问。
15. AI 供应商和模型列表接口可访问。
16. 关键写操作写入审计日志。

---

## 16. 与 zhipinai_v2 的复用关系

严格复用：

- 原生 VM 部署。
- systemd 服务管理。
- Nginx 静态资源和 API 反代。
- external-dependencies.env 运行时配置文件。
- scripts/deploy_* 部署脚本模式。
- scripts/verify_* 验证脚本模式。
- Go 服务 readyz 验证模式。

替换命名：

| zhipinai_v2 | KyaiCRM |
|---|---|
| `/data/zhipinai_v2` | `/data/kyai_crm` |
| `ZP_RUNTIME_ENV_FILE` | `KY_RUNTIME_ENV_FILE` |
| `ZP_TENANT_DATABASE_URL` | `KY_TENANT_DATABASE_URL` |
| `zp-admin-host.nginx.conf` | `ky-admin-host.nginx.conf` |
| `zp-auth-service.service` | `ky-auth-service.service` |
| `zp-org-service.service` | `ky-org-service.service` |
| `zp-membership-service.service` | `ky-membership-service.service` |
| `zp-ai-model-service.service` | `ky-ai-model-service.service` |

---

## 17. 后续补充

项目进入实际部署前，还需要根据真实服务器补充：

- 真实域名。
- 真实部署目标主机。
- 数据库主机与账号。
- Redis / NATS 地址。
- 对象存储配置方式。
- HTTPS 证书配置。
- 备份策略。
- 日志归档策略。
- 监控告警策略。
