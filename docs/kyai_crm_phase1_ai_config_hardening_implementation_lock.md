# KyaiCRM Phase 1.18 AI 配置补全（停用级联 + 密钥轮换）实现锁定记录

> 文档状态：已锁定 / Phase 1.18 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
ky-ai-model-service:
  store/provider_store.go
    + ProviderEnabled(ctx,id)                存在且 status='enabled'
    + DisableProviderCascade(ctx,id,by)      事务：停供应商→停其模型→清平台默认设置；返回计数
    + RotateProviderAPIKey(ctx,id,enc,by)    重写密文；缺失→ErrNotFound
  server/provider_handlers.go
    ~ updateProviderStatus                   disabled 走级联（审计带计数）；enabled 仅供应商
    + rotateProviderAPIKey                    新端点：加密轮换、审计无明文、仅返脱敏
  server/model_handlers.go
    ~ createModel                            ProviderExists→ProviderEnabled（停用/不存在→400）
    ~ updateModelStatus                      启用前校验所属供应商启用（停用→400）
  server/server.go
    + POST /api/v1/ai-models/providers/{id}/rotate-api-key  ws(platform, rotate_key)
  server/ai_hardening_test.go                空 key/无 cipher/脱敏/审计动作 单测
ops/db/008_seed.sql
    + platform.ai_providers.rotate_key       （平台 owner/admin 经 LIKE 'platform.%' 自动绑定）
```

无新增表 / 无 schema 变更（仅 seed 增一条权限）。

---

## 2. 行为

```text
停用供应商（PATCH .../status status=disabled）
  事务：provider→disabled；其全部未删除模型→disabled；
        平台默认模型设置中指向这些模型的项→model_id=NULL。
  审计 ai_provider.status_changed，detail 含 modelsDisabled / defaultsCleared。
  供应商不存在 -> ErrNotFound（404），不写审计、不部分提交。
启用供应商（status=enabled）：仅供应商恢复，模型不自动恢复。
密钥轮换（POST .../rotate-api-key {"apiKey":...}）
  无 cipher→503；空 key→400；供应商不存在→404；
  AES-256-GCM 重新加密写入；审计 ai_provider.api_key_rotated（detail=nil，零密钥材料）；
  响应仅 {id, apiKeyMasked}，绝不返明文/密文。
护栏：已停用/不存在供应商下 createModel→400；启用其模型→400；停用模型不受限。
```

强一致取向：级联是事务（非 best-effort），因“默认模型悬挂”属配置正确性问题。

---

## 3. 复审与验证

两轮独立复审（需求 + 实现）均 NO BLOCKERS：事务原子且占位符 $1..$4 与参数序一致、列名合 schema 007、错误先于 Commit 返回（无部分提交）、不存在供应商不写审计；轮换零密钥材料入审计、响应仅脱敏；护栏拦截建模/启用而不拦停用；路由/权限/seed 自动绑定一致；测试覆盖空 key/无 cipher/脱敏。

```text
NO BLOCKERS
shared + 四服务 go build / vet / test 全绿（-count=1）
新增单测：rotate 空 key 400 / 无 cipher 503 / Mask 不漏明文 / 审计动作
gofmt 干净（本阶段改动文件）；nginx /api/v1/ai-models 前缀已覆盖新端点
```

口径修正：需求中“422”按本服务既有约定落地为 `400 validation_error`（全服务一致）。`ProviderExists` 现无调用方但为导出方法保留（非编译问题）。

---

## 4. 显式延后（Phase 1.19）

```text
机构/企业级默认模型：打开 AI 服务 ws() platform-only 闸门 + 扩展权限矩阵
  （agency/enterprise.ai_model_settings.* 与目录只读 ai_models.view）+ 角色绑定
  + default 设置 scope_type/scope_id 参数化 —— 单列 Phase 1.19。
provider 软删级联、AI 用量/限额、模型探活 —— 不在 Phase 1。
```

---

## 5. 结论

停用供应商现级联停用其模型并清除悬挂的平台默认模型；新增独立、可审计、最小授权的 API 密钥轮换端点；并禁止在停用供应商下建模/启用模型。AI 供应商·模型配置闭环（平台域）完成；机构/企业级默认模型留待 1.19。
