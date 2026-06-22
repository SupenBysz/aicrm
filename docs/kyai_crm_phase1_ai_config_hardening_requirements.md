# KyaiCRM Phase 1.18 AI 配置补全（停用级联 + 密钥轮换）实现需求

> 文档状态：已锁定  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.18 / AI 供应商·模型配置补全  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.1–1.17 全部已实现并锁定  

---

## 1. 背景与目标

Phase 1.9 落地了 AI 供应商/模型/平台默认模型（API Key 加密）。本阶段补齐两处配置完整性缺口，**严格限于供应商与模型配置**，不涉任何 AI 业务：

- A. 供应商停用级联：停用供应商时，其模型一并停用、并清除指向这些模型的平台默认模型设置（避免“默认模型指向已不可用模型”）。
- B. API 密钥轮换：为供应商提供独立的密钥轮换端点（独立权限 + 独立审计动作），重新加密、响应永不返明文。

附带一致性护栏：禁止在已停用供应商下新建/启用模型。

### 1.1 显式延后（Phase 1.19）

```text
机构/企业级默认模型：需打开 AI 服务 ws() 的 platform-only 闸门、扩展权限矩阵
  （agency/enterprise.ai_model_settings.*、目录只读 ai_models.view）并绑定角色、
  default 设置按 scope_type/scope_id 参数化 —— 体量与风险显著更大，单列 Phase 1.19。
provider 删除（软删）级联、AI 用量/限额、模型探活 —— 不在本阶段。
```

---

## 2. 范围（均 platform 工作区，沿用现有 ws 闸门）

```text
A. 停用级联（事务）
   PATCH /api/v1/ai-models/providers/{id}/status  status=disabled
     -> 该供应商全部未删除模型 status=disabled
     -> 清除平台默认模型设置中 model_id ∈ 这些模型 的项（置 NULL）
   status=enabled 时：仅恢复供应商自身，不自动恢复模型（管理员显式启用模型）。

B. 密钥轮换
   POST /api/v1/ai-models/providers/{id}/rotate-api-key   body {"apiKey":"..."}
     -> 重新 AES-256-GCM 加密写入；独立审计动作；响应返回脱敏 key，不返明文。

C. 护栏
   createModel：供应商已停用则拒绝（422 validation_error）。
   updateModelStatus -> enabled：供应商已停用则拒绝。
```

---

## 3. 行为细化

### 3.1 停用级联（store 事务）

新增 `DisableProviderCascade(ctx, providerID, updatedBy) -> (modelsDisabled int, defaultsCleared int, err error)`：

```sql
BEGIN
  UPDATE ky_ai_provider SET status='disabled', updated_by=$u, updated_at=now()
    WHERE id=$p AND deleted_at IS NULL;            -- 行不存在 -> ErrNotFound（回滚）
  UPDATE ky_ai_model SET status='disabled', updated_by=$u, updated_at=now()
    WHERE provider_id=$p AND deleted_at IS NULL AND status<>'disabled';   -- 计数 modelsDisabled
  UPDATE ky_ai_model_setting SET model_id=NULL, updated_by=$u, updated_at=now()
    WHERE scope_type='platform' AND scope_id='platform_root'
      AND model_id IN (SELECT id FROM ky_ai_model WHERE provider_id=$p);  -- 计数 defaultsCleared
COMMIT
```

- `updateProviderStatus` handler：`status=='disabled'` 走 `DisableProviderCascade`；`status=='enabled'` 走原 `UpdateProviderStatus`（仅供应商）。
- 审计：保留 `ai_provider.status_changed`（detail 增加 `modelsDisabled`/`defaultsCleared` 计数）；级联本身不另发多条审计（计数已在 detail）。
- best-effort 不适用：级联是业务事务，失败即整体回滚并返回错误（与“默认模型悬挂”风险相比，强一致更重要）。

### 3.2 密钥轮换

```text
权限：platform.ai_providers.rotate_key（新增 seed + 绑定 platform owner/admin）
入参：{"apiKey":"<新明文，必填非空>"}；空 -> 422
流程：GetProvider 存在校验 -> cipher.Encrypt(new) -> store.RotateProviderAPIKey(id, enc, updatedBy)
审计：ai_provider.api_key_rotated（detail 不含明文/密文；可含 keyMasked=最后4位）
响应：{ id, apiKeyMasked }；绝不返明文或密文。
```

- 与 `updateProvider`（可顺带改 key）区别：独立端点 + 独立权限 + 独立审计动作，便于密钥变更可审计、可最小授权。
- 不要求校验旧 key（持有 rotate_key 权限即可；旧 key 明文通常不可得）。

### 3.3 护栏

- `createModel`：插入前 `ProviderEnabled(ctx, providerID)`（存在且 status='enabled'）为假 -> 422「供应商不存在或已停用」。
- `updateModelStatus` 目标 `enabled`：`ProviderEnabled` 为假 -> 422「供应商已停用，无法启用其模型」。
- `ProviderEnabled` 新增 store 方法（`SELECT 1 ... WHERE id=$1 AND status='enabled' AND deleted_at IS NULL`）。

---

## 4. 实现要点

```text
store/provider_store.go：
  + DisableProviderCascade(ctx, id, updatedBy) (int, int, error)   事务
  + RotateProviderAPIKey(ctx, id, apiKeyEncrypted, updatedBy) error
  + ProviderEnabled(ctx, id) (bool, error)
server/provider_handlers.go：
  ~ updateProviderStatus：disabled 分支调用级联，detail 带计数
  + rotateProviderAPIKey handler
server/model_handlers.go：
  ~ createModel / updateModelStatus：ProviderEnabled 护栏
server/server.go：
  + POST /api/v1/ai-models/providers/{id}/rotate-api-key  ws("platform", rotate_key, …)
ops/db/008_seed.sql：
  + 权限 platform.ai_providers.rotate_key（scope ["platform"]）+ 绑定平台 owner/admin
  （可选）menu/page 不变
```

无新增表、无 schema 变更（仅 seed 增一条权限 + 绑定）。

---

## 5. 验收标准

```text
停用供应商 -> 其全部模型变 disabled；指向这些模型的平台默认设置被置 NULL；
  审计 detail 含 modelsDisabled/defaultsCleared；事务失败整体回滚。
启用供应商 -> 仅供应商恢复，模型不自动恢复。
轮换密钥 -> 密文变化、响应仅脱敏、审计动作 ai_provider.api_key_rotated 无明文。
已停用供应商下 createModel / 启用模型 -> 422。
go build / vet / test 通过（ky-ai-model-service + 复用 shared）。
新增/更新单测：级联计数 SQL 形态、ProviderEnabled 判定、轮换不返明文、护栏拒绝。
复审 NO BLOCKERS。
```

---

## 6. 风险与约束

1. 级联为强一致事务（非 best-effort）；与审计/通知的 best-effort 取向不同 —— 因“默认模型悬挂”是配置正确性问题，需强一致。
2. 启用不反向级联，避免“误启用一批历史模型”；语义明确写入文档与审计。
3. 轮换端点与 updateProvider 的 key 更新并存：前者用于安全敏感的独立审计/最小授权，后者用于常规编辑；二者均经同一加密路径。
4. 新增权限需绑定平台 owner/admin（与其余 ai_providers.* 一致），否则现有平台管理员无法轮换。
5. 沙箱无真实 DB：以 build/vet/test + SQL 形态/单测验证；真实级联属外部 runbook。
6. 机构/企业级默认模型严格延后至 1.19，避免在本阶段引入 ws 闸门与权限矩阵扩张。
