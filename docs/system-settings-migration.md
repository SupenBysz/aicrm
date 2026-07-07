# 系统设置模块迁移 · 完整迭代需求方案

> 目标:将参考项目 `zhipinai_v2` 的「系统设置」模块 100% 功能适配迁移到 KyaiCRM，
> 遵守本项目既有规范，分阶段可验收交付。
>
> 状态:**已锁定(LOCKED v2)** — 经两轮评审收敛,可按阶段实施(详见 §10)。

---

## 1. 背景与目标

参考项目的「系统设置」是一个由平台后台统一管理的基础治理模块，当前 KyaiCRM 仅有
「系统设置(键值)」与「数据字典」两项，缺少其余 6 块。本次迭代补齐全部缺失功能，
做到能力对齐参考项目，同时符合 KyaiCRM 的命名/安全/架构规范。

**总目标**:平台管理员可在「系统设置」内完成 基础信息、通知模板、对象存储、短信服务、
邮件服务、App 版本 的全部配置与测试；移动端可读取基础信息并进行版本检查。

---

## 2. 迁移范围

| # | 子模块 | 状态 | 说明 |
|---|--------|------|------|
| 1 | 基础信息 | 新增 | 平台名称、ICP 备案号；平台编辑 + 对外公开读取 |
| 2 | 通知模板 | 新增 | 各类型通知模板 标题/内容/启停 + 恢复默认 |
| 3 | 对象存储设置 | 新增 | S3 兼容配置(AK/SK 密文)+ 连通测试 |
| 4 | 短信服务 | 新增 | 账号 / 签名 / 场景模板(验证码)+ 发送测试 |
| 5 | 邮件服务 | 新增 | 账号(SMTP)/ 发件身份 / 场景模板 + 发送测试 |
| 6 | App 版本设置 | 新增 | iOS/Android × 渠道 版本规则 CRUD + 公开版本检查 |
| — | 系统设置(键值) | 已有 | 保留 |
| — | 数据字典 | 已有 | 保留 |

> 注:KyaiCRM 有移动端,故 App 版本设置纳入范围(含供 App 调用的公开版本检查接口)。

---

## 3. 通用设计约定(横切关注点)

- **服务归属**:全部后端落在 `ky-org-service`(与参考的 `zp-org-service` 一致,
  且 KyaiCRM 现有 `settings_handlers.go` 已在此服务)。
- **数据库**:表名一律 `ky_` 前缀;时间戳 `created_at / updated_at timestamptz`;
  操作人 `updated_by text REFERENCES ky_user(id)`;软删除按现有惯例(需要处删 `deleted_at`)。
- **密钥加密(前置改造,P4 前必做)**:
  - 现状缺陷:`crypto.Cipher` 位于 `services/ky-ai-model-service/internal/crypto`,是 **internal 包,
    `ky-org-service` 无法导入**;且 org-service 当前无任何加密能力。
  - **前置任务 P0**:把加密能力下沉到 **`shared/crypto`**(共享模块),
    `ky-ai-model-service` 改为导入共享包(行为不变,兼容既有密文),`ky-org-service` 同样导入。
  - **密钥来源**:新增平台级 `KY_SECRET_KEY`(AES-256-GCM,SHA-256 派生),org-service 启动读取;
    部署上可将其值设为与 `KY_AI_SECRET_KEY` 相同(同一主密钥),避免再引入一套。
    AI 供应商既有密文继续用 `KY_AI_SECRET_KEY`,不受影响。
  - 所有敏感凭据(对象存储 SK、短信 AK Secret、邮件 SMTP 密码)经此加密存库;
    **接口永不回显明文**,仅返回脱敏(末 4 位)或 `hasSecret` 标识;更新密钥走专用「轮换」入口
    (PATCH 留空则保留原值)。
- **接口规范**:
  - 平台管理接口前缀 `/api/v1/platform/...`,需登录 + 平台工作区 + 对应权限。
  - 对外公开接口前缀 `/api/v1/public/...`(无需登录,只读非敏感),如基础信息、版本检查。
    org-service 当前无公开(免鉴权)路由,需新增一条免 `ws` 中间件的处理链(参照
    ky-membership-service 的 `/api/v1/public/invitations`),并在 nginx 单独 `location` 放行。
  - 请求头沿用 `X-KY-Workspace-Type` / `X-KY-Workspace-Id`;响应统一信封 `{ data, requestId }`。
- **权限门控**:复用 `ws(perms...)` 中间件;新增权限点见 §6,按 008_seed 规则自动绑定
  平台 owner/admin。
- **审计**:所有写操作记 `s.audit(...)`,`action` 形如 `storage_setting.updated`、
  `sms_account.tested`;**审计内容不含任何明文密钥**。
- **测试能力**:对象存储「连通测试」、短信/邮件「发送测试」参照已实现的「AI 模型测试」
  模式——后端解密凭据 → 真实外呼 → 返回结构化结果(ok/延迟/错误),不落库明文,
  记一条 `*.tested` 审计。
- **前端**:并入 `ky-system-settings` 插件。**导航方式(锁定)**:6 个子模块各作为「系统设置」
  导航组下的**独立菜单项**(基础信息 / 通知模板 / 对象存储 / 短信服务 / 邮件服务 / App 版本),
  与现有「系统设置 / 数据字典」并列,经 `requiredPermission` 门控;不采用单页多 Tab(6 项过多)。
  表单 + 抽屉 + 列表统一现有页面范式;密钥字段用 `Input.Password` + 轮换入口。
- **权限标签**:新增资源需同步在 `ky-access-management/src/permission-labels.ts` 补中文(资源、动作),
  使「权限目录 / 角色授权」树正确显示。
- **nginx**:为新增路由前缀补 `location`(→ ky-org-service:18082);公开路由单独放行。

---

## 4. 数据模型总览(ky_ 表)

| 表 | 用途 | 关键列 |
|----|------|--------|
| `ky_platform_profile` | 基础信息(单例) | company_name, icp_record |
| `ky_notification_template` | 通知模板 | template_key(PK), template_name, title, content, notification_type, enabled |
| `ky_storage_setting` | 对象存储(单例) | provider_key, endpoint, region, bucket, bucket_private, force_path_style, prefix, public_domain, access_key_id, secret_access_key_encrypted, last_test_* |
| `ky_sms_account` | 短信账号 | id, account_name, provider_key, region, access_key_id, access_key_secret_encrypted, default_signature_id, status, last_test_* |
| `ky_sms_signature` | 短信签名 | id, account_id(FK), signature_name, status, remark |
| `ky_sms_template` | 短信场景模板 | id, account_id(FK), scene, code_variable, code_ttl_seconds, daily_limit, interval_seconds, status, last_test_* |
| `ky_email_account` | 邮件账号(SMTP) | id, account_name, provider_key, host, port, encryption, username, password_encrypted, from_email, from_name, reply_to_email, status, last_test_* |
| `ky_email_identity` | 发件身份 | id, account_id(FK), identity_name, from_email, from_name, reply_to_email, status |
| `ky_email_template` | 邮件场景模板 | id, account_id(FK), identity_id(FK), scene, subject, body, code_variable, code_ttl_seconds, daily_limit, interval_seconds, status, last_test_* |
| `ky_app_version_rule` | App 版本规则 | id, platform, channel, latest_version_code, latest_version_name, min_supported_version_code, force_update, update_title, update_notes, update_url, enabled, internal_remark |

**补充约定**:
- **单例表**(`ky_platform_profile` / `ky_storage_setting`):固定主键 `'default'`,
  读取时若无行返回空默认值,写入用 `INSERT ... ON CONFLICT (id) DO UPDATE`(upsert)。
- **`last_test_*` 列**统一为三列:`last_test_at timestamptz`、
  `last_test_status text`(`success`/`failed`/`''`)、`last_test_message text`。
- **唯一约束**:`ky_app_version_rule` 对 `(platform, channel)` 唯一(`WHERE deleted_at IS NULL`);
  存储 `provider_key` 默认 `'s3'`(预留 OSS/MinIO/S3 区分,Phase 走 S3 兼容协议)。
- **状态列**:账号/签名/模板的 `status` 取 `enabled`/`disabled`,与现有 AI 模块一致。

---

## 5. 各子模块详细需求

### 5.1 基础信息

- **功能**:维护平台对外基础信息。字段:`companyName`(公司/平台名称)、`icpRecord`(ICP 备案号)。
- **数据**:`ky_platform_profile` 单例行(固定主键 `default`)。
- **接口**:
  - `GET /api/v1/public/platform-profile` — 公开只读(登录页/页脚展示用)。
  - `GET /api/v1/platform/platform-profile` — 平台读取(权限 `platform.basic_info.view`)。
  - `PATCH /api/v1/platform/platform-profile` — 平台更新(权限 `platform.basic_info.update`)。
- **前端**:系统设置 → 「基础信息」Tab,简单表单 + 保存。
- **验收**:更新后公开接口与前端页脚同步;非平台/无权限不可改;写操作有审计。

### 5.2 通知模板

- **功能**:管理系统内置通知模板(标题/正文/启停/说明),支持「恢复默认」。
  `templateKey` 标识场景(如 邀请、审核结果、公告桥接等),`notificationType` 分类。
- **数据**:`ky_notification_template`;首次访问按内置默认集 `ensureDefault`。
- **归属与消费(决策)**:模板的**管理**(CRUD)放 `ky-org-service`(归「系统设置」内聚,
  与参考一致);模板的**消费**(发通知/公告桥接时套用)在 `ky-membership-service`,
  同库直接 `SELECT ky_notification_template` 读取并按 `template_key` 套用 → 渲染变量。
  两服务通过同库表解耦,不新增内部 RPC。
- **接口**(权限 `platform.notification_templates.view/update`):
  - `GET /api/v1/platform/notification-templates` — 列表。
  - `PATCH /api/v1/platform/notification-templates/{key}` — 改 标题/内容/说明。
  - `PATCH /api/v1/platform/notification-templates/{key}/status` — 启停。
  - `POST /api/v1/platform/notification-templates/{key}/reset` — 恢复默认。
- **前端**:列表 + 编辑抽屉 + 启停开关 + 恢复默认按钮。
- **验收**:模板修改后实际通知使用新模板;恢复默认还原内置;启停生效。

### 5.3 对象存储设置

- **功能**:S3 兼容对象存储配置 + 连通测试。字段:provider、endpoint、region、bucket、
  bucketPrivate、forcePathStyle、prefix、publicDomain、accessKeyId、secretAccessKey(密文)。
- **数据**:`ky_storage_setting` 单例;`secret_access_key_encrypted` 加密;`last_test_*` 记录。
- **接口**(权限 `platform.storage.view/update/test`):
  - `GET /api/v1/platform/storage-setting` — 读取(SK 脱敏)。
  - `PATCH /api/v1/platform/storage-setting` — 更新(SK 留空保留,变更走专用字段)。
  - `POST /api/v1/platform/storage-setting/test` — 连通测试(列桶/HeadBucket,返回 ok/延迟/错误)。
- **前端**:配置表单 + SK 密码框 + 「测试连接」按钮 + 结果展示。
- **验收**:配置正确时测试通过;SK 永不回显;错误凭据返回友好失败。

### 5.4 短信服务

- **功能**:多账号 + 多签名 + 场景模板(验证码)+ 发送测试。
  - 账号:providerKey(如 阿里云短信)、region、accessKeyId、accessKeySecret(密文)、
    defaultSignatureId、status、lastTest*。
  - 签名:signatureName、所属账号、status。
  - 场景模板:scene、codeVariable、codeTtlSeconds、dailyLimit、intervalSeconds、status。
- **数据**:`ky_sms_account` / `ky_sms_signature` / `ky_sms_template`。
- **接口**(权限 `platform.sms.view/update/test`):
  - 账号:`GET/POST /platform/sms/accounts`,`PATCH/DELETE /platform/sms/accounts/{id}`,
    `POST /platform/sms/accounts/{id}/rotate-secret`,`POST /platform/sms/accounts/{id}/test`。
  - 签名:`GET/POST /platform/sms/signatures`,`PATCH/DELETE /platform/sms/signatures/{id}`。
  - 模板:`GET/POST /platform/sms/templates`,`PATCH/DELETE /platform/sms/templates/{id}`,
    `POST /platform/sms/templates/{id}/test`(向指定手机号发测试短信)。
- **前端**:三段式(账号 / 签名 / 模板)列表 + 抽屉;账号含「轮换密钥」「测试」。
- **验收**:真实账号可发测试短信;密钥脱敏;限频/有效期字段正确存取。
- **场景(scene)**:内置常用场景并可扩展:`login_code`(登录验证码)、`register_code`(注册)、
  `reset_password`(找回密码)、`bind_phone`(绑定手机);`codeVariable` 指明模板里的验证码占位符。
- **对接**:阶段实现可先支持 `aliyun` 一家 providerKey,留扩展位。

### 5.5 邮件服务

- **功能**:SMTP 账号 + 发件身份 + 场景模板 + 发送测试。
  - 账号:host、port、encryption(none/ssl/tls)、username、password(密文)、fromEmail、
    fromName、replyToEmail、status、lastTest*。
  - 发件身份:identityName、fromEmail、fromName、replyToEmail、所属账号。
  - 场景模板:scene、subject、body、codeVariable、codeTtlSeconds、dailyLimit、
    intervalSeconds、所属账号/身份。
- **数据**:`ky_email_account` / `ky_email_identity` / `ky_email_template`;`password_encrypted` 加密。
- **接口**(权限 `platform.email.view/update/test`):账号/身份/模板 CRUD + 轮换密码 +
  `POST /platform/email/accounts/{id}/test`、`POST /platform/email/templates/{id}/test`(向指定邮箱发测试)。
- **前端**:三段式(账号 / 身份 / 模板)列表 + 抽屉;账号含「轮换密码」「测试发送」。
- **验收**:真实 SMTP 可发测试邮件;密码脱敏;模板变量正确。
- **对接**:阶段一走标准 SMTP(`net/smtp` + STARTTLS/SSL)。

### 5.6 App 版本设置

- **功能**:按 平台(ios/android)× 渠道(channel) 维护版本规则,供 App 检查更新。
  - 规则:latestVersionCode/Name、minSupportedVersionCode、forceUpdate、updateTitle、
    updateNotes、updateUrl、enabled、internalRemark。
  - 版本检查(公开):入参 平台/渠道/当前版本号(可选 `lastPromptedDate`),返回 hasUpdate、
    forceUpdate、canRemindToday、最新版本信息。
  - **`canRemindToday` 计算(决策:无状态)**:服务端不存设备/用户提醒态;
    `canRemindToday = !forceUpdate && (lastPromptedDate 入参 != 服务端当天日期)`。
    即由客户端上报「上次弹更新提示的日期」,服务端只做比对,避免引入设备表。
- **数据**:`ky_app_version_rule`(平台+渠道唯一)。
- **接口**:
  - 平台(权限 `platform.app_version.view/create/update/delete`):
    `GET/POST /platform/app-version-rules`,`PATCH/DELETE /platform/app-version-rules/{id}`。
  - 公开:`GET /api/v1/public/app-version-check?platform=&channel=&versionCode=`。
- **前端**:版本规则列表 + 新建/编辑抽屉(平台、渠道、版本号、强更开关、更新说明、下载地址)。
- **验收**:公开检查接口按规则正确返回有/无更新与强更;强更逻辑正确;禁用规则不下发。

---

## 6. 新增权限点(随阶段加 seed 并绑定 owner/admin)

```
platform.basic_info.view / update
platform.notification_templates.view / update
platform.storage.view / update / test
platform.sms.view / update / test
platform.email.view / update / test
platform.app_version.view / create / update / delete
```

> 绑定规则沿用 008_seed:`WHERE code LIKE 'platform.%'` → 平台 owner/admin。
> 前端按钮用 `usePermissions().can(...)` 门控(注意 action 类权限亦在 `can()` 内,已修复)。

---

## 7. 迭代计划(分阶段 · 可验收)

| 阶段 | 子模块 | 迁移文件 | 产物 | 复杂度 | 外部对接 |
|------|--------|----------|------|--------|----------|
| **P0** | 加密下沉(前置) | — | `shared/crypto` 包 + `KY_SECRET_KEY` + 两服务接入(无 UI) | 中 | 无 |
| P1 | 基础信息 | `015_*.sql` | 表 + 公开/平台接口 + 菜单页表单 + 权限 seed | 低 | 无 |
| P2 | 通知模板 | `016_*.sql` | 表 + 默认集 + CRUD/启停/恢复 + 列表抽屉 | 中 | 无 |
| P3 | App 版本设置 | `017_*.sql` | 表 + 平台 CRUD + 公开检查 + 列表抽屉 | 中 | 无 |
| P4 | 对象存储 | `018_*.sql` | 表 + 加密 + 配置 + 连通测试 | 中高 | `minio-go` |
| P5 | 短信服务 | `019_*.sql` | 3 表 + 加密 + 账号/签名/模板 + 测试 | 高 | 阿里云短信 |
| P6 | 邮件服务 | `020_*.sql` | 3 表 + 加密 + 账号/身份/模板 + 测试 | 高 | `net/smtp` |

> P0 仅在 P4 之前必须完成(P1–P3 无密钥需求);为减少返工,建议 P0 紧随 P1 之后、P4 之前任一空档插入。
> 每阶段权限 seed 文件可与迁移合并或单独编号,顺延即可。

**节奏**:每阶段闭环「DB 迁移 → 后端 handler/route → 权限 seed → 前端页面 → 联调 →
构建部署(nginx/服务)→ 端到端验证」,经你验收后再进入下一阶段。

**里程碑**:P1–P3(纯配置)优先快速落地见效;P4–P6(含密钥+外呼)逐块稳妥推进。

---

## 8. 风险与依赖

- **外部凭据**:短信/邮件/存储的真实测试需有效凭据;无凭据时测试入口返回「未配置/凭据无效」
  友好提示(不报 500),参照模型测试。
- **新增 Go 依赖(锁定)**:
  - 对象存储:`github.com/minio/minio-go/v7`(S3 兼容,体积小,通吃 MinIO/OSS/AWS S3;
    连通测试用 `BucketExists`/`ListObjects`)。
  - 短信:阶段一只接 `aliyun`(走 dysmsapi HTTP + 签名,或 `aliyun-sms` 轻量 SDK),`provider_key` 留扩展。
  - 邮件:标准库 `net/smtp` + `crypto/tls`(支持 SSL/STARTTLS),不引第三方。
  - 引入新依赖会更新 `go.mod`/`go.work.sum`,在对应阶段提交。
- **密钥一致性**:所有密文用 `KY_AI_SECRET_KEY` 加密;轮换该主密钥会使既有密文失效
  (与 AI 供应商密钥同源,运维需知)。
- **移动端联调**:App 版本检查、基础信息的公开接口需与移动端约定字段;本方案按参考字段对齐。
- **nginx 路由**:每阶段新增前缀需同步 `kyaicrm.nginx.conf` 并 reload。

---

## 9. 总验收清单

- [ ] P0:`shared/crypto` 就位,ai-model 与 org 两服务均能加解密;既有 AI 密文不受影响。
- [ ] 6 子模块功能与参考项目对齐(字段、CRUD、测试)。
- [ ] 所有敏感凭据加密存储,接口/审计/日志均无明文。
- [ ] 平台权限正确门控,owner/admin 默认可用;无权用户不可见/不可操作。
- [ ] 公开接口(基础信息、版本检查)无需登录、只读、不含敏感信息。
- [ ] 前端并入 ky-system-settings,交互与现有页面范式一致。
- [ ] 后端单测 + 路由无冲突;构建部署后经 nginx(16178)端到端验证。
- [ ] 命名规范全部满足:`ky_` 表 / `KY_*` env / `X-KY-*` 头 / `ky-` 插件。

---

## 10. 评审修订记录

**第 1 轮(技术可行性 + 完整性)** — 已修复:
1. 🔴 **加密不可行**:`crypto.Cipher` 是 `ky-ai-model-service` 的 internal 包,org-service 无法导入,
   且 org-service 无加密能力 → 新增**前置阶段 P0**:下沉到 `shared/crypto` + `KY_SECRET_KEY`。(§3、§7、§9)
2. **公开路由**:org-service 当前无免鉴权路由 → 明确需新增公开处理链 + nginx 放行。(§3)
3. **前端导航**:由"多 Tab 或子菜单"二选一 → **锁定**为 6 个独立菜单项。(§3)
4. **通知模板归属/消费**:管理在 org-service、消费在 membership-service,经同库表解耦。(§5.2)
5. **`canRemindToday`**:由模糊 → **锁定**为无状态(客户端上报上次提示日期,服务端比对)。(§5.6)
6. **第三方依赖**:由"待定" → **锁定** `minio-go` / 阿里云 / `net/smtp`。(§8)
7. **完整性核查**:确认参考平台设置端点仅 6 个,**无遗漏**登录/注册/安全策略类子模块。
8. 补充:单例表 upsert、`last_test_*` 三列、`(platform,channel)` 唯一约束、状态枚举、
   迁移文件号(015–020)、权限标签同步 `permission-labels.ts`、短信/邮件场景枚举。

**第 2 轮(一致性复核)** — 通过:命名(`ky_`/`KY_*`/`X-KY-*`/`ky-`)、权限点、路由前缀、
服务归属、信封格式、密钥脱敏策略全模块一致;阶段依赖明确(P0 仅约束 P4+)。

---

## 锁定状态:✅ 可锁定(LOCKED v2)

未决技术点已全部收敛为明确决策,无悬而未决项;前置依赖(P0)已识别并排期。
**可从 P0(加密下沉)/ P1(基础信息)开始实施。** 实施中如发现与本文档不符,回写本节修订记录并升版。

*文档版本 v2 · 已锁定。*
