# KyaiCRM Phase 1.9 AI 配置实现锁定记录

> 文档状态：已锁定 / Phase 1.9 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
services/ky-ai-model-service
```

该服务为第一阶段最后一个待实现后端服务。至此 4 个 Go 服务全部实现。

---

## 2. 已实现接口（全部平台后台专属）

```text
GET   /api/v1/ai-models/providers
POST  /api/v1/ai-models/providers
PATCH /api/v1/ai-models/providers/:id
PATCH /api/v1/ai-models/providers/:id/status
GET   /api/v1/ai-models
POST  /api/v1/ai-models
PATCH /api/v1/ai-models/:id
PATCH /api/v1/ai-models/:id/status
GET   /api/v1/ai-models/settings
PATCH /api/v1/ai-models/settings
```

并保留 `GET /readyz`、`GET /healthz`。

---

## 3. 实现要点

### 3.1 结构

```text
internal/config/config.go     env + AuthTokenSecret + AISecretKey
internal/auth/token.go        与 ky-auth-service 一致的 HMAC token 校验
internal/crypto/secret.go     AES-256-GCM 加密器（key 来自 KY_AI_SECRET_KEY）
internal/store/*.go           db/HasAny + provider/model/settings/audit 存储
internal/server/*.go          ws() 平台门 + provider/model/settings handler + audit
```

### 3.2 鉴权

- `ws(requiredPerms, handler)`：token → 工作区 Header → 平台工作区 gating → active membership → `HasAny(requiredPerms)`。
- 非平台工作区 403 `workspace_forbidden`；无权限 403 `permission_denied`。
- 10 个 `platform.ai_*` 权限码均已 seed。

### 3.3 API Key 加密（决策 A）

- AES‑256‑GCM，nonce 前置，base64 存储于 `api_key_encrypted`。
- 密钥由 `KY_AI_SECRET_KEY` 派生（hex/base64 32 字节直用，否则 SHA‑256 归一为 32 字节）。
- 响应永不返回明文：`publicProvider` 剥离密文，仅暴露 `hasApiKey` + `apiKeyMasked('***')`。
- 缺密钥时 provider 创建/更新（写 apiKey）返回 503；`/readyz` 标记 degraded（`aiSecretConfigured=false`）。
- 更新供应商未提供 apiKey 时保留原密文（SQL 不更新该列）。
- 审计 detail 不含明文 apiKey。

### 3.4 模型类型（决策 B）

- API 仅接受 `text_generation` / `embedding`；`vision`/`audio` 返回 400。DB 枚举保留四类。

### 3.5 默认模型（决策 C）

- `GET/PATCH /ai-models/settings`，scope `platform/platform_root`，按 `(scope_type,scope_id,setting_key)` upsert。
- 校验：chat/summary → `text_generation`+`enabled`；embedding → `embedding`+`enabled`；不满足 400。
- nil = 保持不变；空串 = 清除。

### 3.6 唯一约束与审计

- provider `(provider_type,name)`、model `(provider_id,model_key)` 未删除唯一，冲突 409；模型 providerId 不存在 409。
- 审计 instrument：`ai_provider.created/updated/status_changed`、`ai_model.created/updated/status_changed`、`ai_model_settings.updated`（15 列插入，best-effort）。

---

## 4. 复审与验证

独立复审逐项核验 SQL 正确性、安全（密钥永不外泄、503 行为）、权限门、模型类型限制、默认模型校验、Go ServeMux 字面量优先级、审计列数（15）。

复审结论：

```text
NO BLOCKERS
```

验证：

```text
go build / vet  四服务通过
go test 四服务通过
```

新增单元测试：

```text
AES-GCM 加解密往返 / 非确定性 / 篡改拒绝 / Mask
phase1ModelType 仅 text_generation/embedding / status 合法性
```

---

## 5. 部署一致性

- `ops/native/external-dependencies.env.example` 新增 `KY_AI_SECRET_KEY`。
- `ops/native/ky-admin-host.nginx.conf` 已将 `/api/v1/ai-models` 反代到 `18086`。
- ON CONFLICT 目标与 schema 唯一索引一致：`ky_ai_model_setting (scope_type,scope_id,setting_key)`。

---

## 6. 显式延后与后续

1. 真实模型调用 / 连通性测试 / AI 业务执行不在范围。
2. provider 停用不级联其 model（前端提示）；密钥轮换/历史密文迁移为后续硬化项。
3. 机构/企业级默认模型为后续阶段。

至此 Phase 1.1–1.9 全部实现并锁定，后端 4 服务齐备。后续：

```text
Phase 1.10 部署与验收（端到端：DB 环境 + seed + 启动 + 联调）
```
