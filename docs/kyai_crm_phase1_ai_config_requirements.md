# KyaiCRM Phase 1.9 AI 配置实现需求

> 文档状态：已锁定 / Phase 1.9 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.9 / AI 配置  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.4 Auth/Bootstrap、Phase 1.5 组织主体管理、Phase 1.6 成员与邀请、Phase 1.7 权限中心、Phase 1.8 通知与审计  

---

## 1. 阶段目标

实现 `ky-ai-model-service`：AI 供应商、AI 模型、默认模型配置。全部平台后台专属。严格限定在“配置”，不接入任何 AI 业务执行。

本阶段决策：

- 决策 A：API Key 使用 AES‑256‑GCM 加密存储，密钥来自环境变量 `KY_AI_SECRET_KEY`（32 字节）；响应永不返回明文 API Key。
- 决策 B：Phase 1 API 仅接受 `text_generation` / `embedding` 两类模型；`vision` / `audio` 由 DB 枚举保留但 API 拒绝。
- 决策 C：默认模型配置校验模型类型匹配（embedding 设置须指向 embedding 模型，chat/summary 须指向 text_generation 模型，且模型须 enabled）。

---

## 2. 范围

### 2.1 后端范围

```text
services/ky-ai-model-service
```

实现 API（全部 `platform` 工作区 + `platform.ai_*` 权限）：

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

读写表：

```text
ky_ai_provider
ky_ai_model
ky_ai_model_setting
ky_audit_log         （审计写入）
ky_membership / ky_role / ky_role_permission / ky_permission  （仅权限校验）
```

### 2.2 不做 / 显式延后

```text
真实模型调用、连通性测试、AI 业务执行
AI 员工 / 执行器 / 工作流 / 协作 / 对话业务 / 费用统计
provider 停用级联停用其 model（记为后续优化）
DELETE 接口（契约未定义；以软删除 + disabled 状态停用）
```

---

## 3. 鉴权

`ky-ai-model-service` 内置与 org/membership 同口径的校验：token（HMAC + exp）→ 工作区 Header → 工作区类型 gating → active membership → `HasAny(requiredPerms)`。

| 接口 | allowedTypes | requiredPerms |
|---|---|---|
| `GET /ai-models/providers` | platform | `platform.ai_providers.view` |
| `POST /ai-models/providers` | platform | `platform.ai_providers.create` |
| `PATCH /ai-models/providers/:id` | platform | `platform.ai_providers.update` |
| `PATCH /ai-models/providers/:id/status` | platform | `platform.ai_providers.update_status` |
| `GET /ai-models` | platform | `platform.ai_models.view` |
| `POST /ai-models` | platform | `platform.ai_models.create` |
| `PATCH /ai-models/:id` | platform | `platform.ai_models.update` |
| `PATCH /ai-models/:id/status` | platform | `platform.ai_models.update_status` |
| `GET /ai-models/settings` | platform | `platform.ai_model_settings.view` |
| `PATCH /ai-models/settings` | platform | `platform.ai_model_settings.update` |

非平台工作区返回 `workspace_forbidden`；无对应权限返回 `permission_denied`。

---

## 4. API Key 加密（决策 A）

- 新增环境变量 `KY_AI_SECRET_KEY`：32 字节密钥（建议 base64/hex 配置，加载后解码为 32 字节）。
- 使用 AES‑256‑GCM 加密 `api_key_encrypted`（随机 nonce 前置存储），不得明文落库。
- 响应永不返回明文 API Key；返回 `hasApiKey`（布尔）或 `apiKeyMasked`（如 `***last4`）。
- 缺少或非法 `KY_AI_SECRET_KEY` 时：
  - provider 创建 / 更新（涉及写入 apiKey）返回 503 `service_unavailable`。
  - `/readyz` 标记 `degraded`，体现 `aiSecretConfigured=false`。
- 更新供应商时若请求未提供 `apiKey`，保留原密文不变；提供空串视为不修改。

---

## 5. 接口数据要点

### 5.1 供应商列表 `GET /ai-models/providers`

- 过滤：`status`、`type`（provider_type），分页。
- 返回字段：id/name/providerType/baseUrl/status/remark/hasApiKey/createdAt/updatedAt，不含明文 apiKey。

### 5.2 创建供应商 `POST /ai-models/providers`

- 写 `ky_ai_provider`：name/providerType/baseUrl/remark/status（默认 enabled）；apiKey 加密存入 `api_key_encrypted`。
- `(provider_type, name)` 未删除唯一，冲突 409。
- name、providerType 必填。

### 5.3 更新供应商 `PATCH /ai-models/providers/:id`

- 可改 name/baseUrl/remark/apiKey；providerType 不可改（保持唯一键稳定）。
- 未提供 apiKey 时保留原密文。

### 5.4 供应商状态 `PATCH /ai-models/providers/:id/status`

- `enabled` / `disabled`。

### 5.5 模型列表 `GET /ai-models`

- 过滤：`providerId`、`modelType`、`status`，分页。
- 返回 id/providerId/name/modelKey/modelType/contextLength/defaultParameters/status/remark/时间。

### 5.6 创建模型 `POST /ai-models`

- `providerId` 必须存在（未删除），否则 409。
- `modelType ∈ {text_generation, embedding}`（决策 B）；`vision`/`audio` 返回 400。
- `(provider_id, model_key)` 未删除唯一，冲突 409。
- name、modelKey 必填；contextLength、defaultParameters 可选。

### 5.7 更新模型 `PATCH /ai-models/:id`

- 可改 name/contextLength/defaultParameters/remark；modelType、providerId、modelKey 不可改（保持唯一键稳定）。

### 5.8 模型状态 `PATCH /ai-models/:id/status`

- `enabled` / `disabled`。

### 5.9 默认模型配置

`GET /ai-models/settings`：

- 返回 scope_type=platform、scope_id=platform_root 的三项设置：
  ```text
  defaultChatModelId
  defaultSummaryModelId
  defaultEmbeddingModelId
  ```
- 未设置项返回 null。

`PATCH /ai-models/settings`：

- 请求：
  ```json
  {
    "defaultChatModelId": "model_001",
    "defaultSummaryModelId": "model_002",
    "defaultEmbeddingModelId": "model_003"
  }
  ```
- 仅更新出现的字段；显式置空（空串/null）表示清除该默认。
- 校验（决策 C）：
  - `default_chat_model` / `default_summary_model` 指向的模型必须存在、`status='enabled'` 且 `model_type='text_generation'`。
  - `default_embedding_model` 指向的模型必须存在、`status='enabled'` 且 `model_type='embedding'`。
  - 不满足返回 400 validation_error。
- 写 `ky_ai_model_setting`（`scope_type='platform'`,`scope_id='platform_root'`,`setting_key` 三选一），按 `(scope_type,scope_id,setting_key)` upsert。

---

## 6. 审计

复用 Phase 1.8 形态，内置 `WriteAudit` + `audit()` 助手，`source='ky-ai-model-service'`，instrument：

```text
ai_provider.created / ai_provider.updated / ai_provider.status_changed
ai_model.created / ai_model.updated / ai_model.status_changed
ai_model_settings.updated
```

审计 detail 不得包含明文 API Key。

---

## 7. 通用响应与错误码

沿用全局契约。错误码：`unauthorized`/`workspace_required`/`workspace_forbidden`/`permission_denied`/`not_found`/`conflict`/`validation_error`/`service_unavailable`/`internal_error`。

---

## 8. 验收标准

### 8.1 后端

```text
go build / vet / test 全服务通过
GET /readyz 反映数据库、token secret、AI 密钥状态
```

### 8.2 安全

```text
api_key 加密存储；任何响应不含明文 apiKey
缺少 KY_AI_SECRET_KEY 时 provider 写接口 503 且 readyz degraded
审计 detail 不含明文 apiKey
```

### 8.3 业务

```text
平台可增改查供应商/模型/默认模型；非平台或无权限 403
供应商 (type,name)、模型 (providerId,modelKey) 唯一约束生效
modelType 仅接受 text_generation/embedding
默认模型 setting_key 与模型类型/状态匹配校验生效
关键写操作写入 ky_audit_log
```

---

## 9. 风险与约束

1. 加密密钥来自 `KY_AI_SECRET_KEY`，缺失时禁用涉密写入并在 readyz 体现；密钥轮换/历史密文迁移为后续硬化项。
2. modelType 在数据层保留四类，API 仅放开两类，口径需在文档与响应中保持一致。
3. provider 停用不级联其 model，前端需提示；记为后续优化。
4. 默认模型固定平台 scope（platform_root），机构/企业默认模型为后续阶段。
5. 与既有服务一致：`ky-ai-model-service` 直接读权限相关表做校验。
