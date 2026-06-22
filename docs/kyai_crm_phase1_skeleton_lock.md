# KyaiCRM Phase 1 工程骨架锁定记录

> 文档状态：已锁定 / Phase 1 工程骨架基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-15  

---

## 1. 锁定范围

本次锁定范围为 KyaiCRM Phase 1 工程骨架：

```text
/data/Coolly
├── apps/ky-admin-host
├── packages/ky-admin-core
├── plugins/ky-*
├── services/ky-auth-service
├── services/ky-org-service
├── services/ky-membership-service
├── services/ky-ai-model-service
├── ops/db
├── ops/native
├── ops/seed
├── scripts
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── go.work
└── README.md
```

---

## 2. 已锁定内容

### 2.1 根工作区

- `package.json`
- `pnpm-workspace.yaml`
- `turbo.json`
- `go.work`
- `README.md`

### 2.2 前端骨架

- `apps/ky-admin-host`
- `packages/ky-admin-core`
- `plugins/ky-identity-management`
- `plugins/ky-organization-management`
- `plugins/ky-access-management`
- `plugins/ky-audit-management`
- `plugins/ky-notification`
- `plugins/ky-system-settings`
- `plugins/ky-ai-configuration`

### 2.3 后端服务骨架

- `ky-auth-service`
- `ky-org-service`
- `ky-membership-service`
- `ky-ai-model-service`

四个服务均包含：

```text
go.mod
cmd/server/main.go
internal/config/config.go
internal/server/server.go
```

并提供：

```text
GET /readyz
GET /healthz
```

### 2.4 ops 与 scripts 骨架

- `ops/db/001_identity_schema.sql` 至 `ops/db/008_seed.sql`
- `ops/native/external-dependencies.env.example`
- `ops/native/ky-admin-host.nginx.conf`
- 四个 systemd unit
- `ops/seed/README.md`
- `scripts/build_services.sh`
- `scripts/build_frontend.sh`
- `scripts/deploy_database.sh`
- `scripts/deploy_services.sh`
- `scripts/deploy_frontend.sh`
- `scripts/verify_deployment.sh`
- `scripts/seed_dev_data.sh`

---

## 3. 验证结果

已通过：

```text
scripts/build_services.sh
go test ./services/ky-auth-service/... ./services/ky-org-service/... ./services/ky-membership-service/... ./services/ky-ai-model-service/...
```

复审结论：

```text
NO BLOCKERS
```

---

## 4. 后续阶段

下一阶段进入：

```text
Phase 1.3 数据库 schema 与 seed 细化
```

目标：将 `ops/db/*.sql` 从占位文件推进为可执行 PostgreSQL DDL 与基础 seed。
