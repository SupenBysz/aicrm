# AiCRM 矩阵账号 AI 登录脚本执行计划

> 文档状态：已锁定 / v8 执行计划  
> 锁定日期：2026-07-09  
> 关联需求：`docs/kyai_crm_matrix_account_requirements.md` v8  
> 适用范围：矩阵账号新增账号、Web 空间、Electron 受控浏览器、AI 执行代理、Codex app-server、xterm.js 终端投影、登录脚本契约、脚本版本与 token 统计、二维码刷新、AI 进展感知、扫码后账号识别、脚本版本展示与执行日志

## 1. 锁定目标

新增账号登录空间默认通过平台登录脚本驱动。脚本不存在、停用、没有可用版本或连续失败达到阈值时，由后端调用指定模型或默认多模态模型，基于脱敏页面上下文和必要截图生成受限 DSL 脚本。脚本按版本保存，记录本次和累计 token 消耗；后续优先复用成功脚本，失败达到阈值后再更新脚本。

v5 增量目标：

- 登录脚本新增 `qr_login_refresh` 用途，用于在当前 Web 空间内刷新并重新提取二维码。
- 新增账号侧滑展示阶段状态、AI 介入原因和当前动作。
- 已命中缓存脚本时不触发 AI，也不误导用户以为正在消耗 AI。
- 脚本失败后的自动 AI 重建在单次流程中最多执行一次，仍失败则进入兜底状态。

v6 增量目标：

- 用户扫码登录完成后，新增账号流程自动进入 `account_detect` 脚本链路，完成账号信息识别、采集、绑定和侧滑关闭。
- `account_detect` 脚本缺失、失效或执行失败时，自动通过指定模型或默认多模态模型生成候选脚本。
- 脚本执行过程中展示安全版本信息，让用户能判断当前使用的脚本用途、版本、状态、来源和更新原因。
- 提供脚本执行日志查看能力，包含当前流程实时日志和后端持久化运行记录，并保证日志脱敏。

v7 增量目标：

- 新增账号侧滑窗口 Tabs 化：`添加账号`、`AI自动化`、`脚本管理`、`登录空间`。
- `添加账号` 承载扫码、等待、账号识别和识别结果；普通用户只关注主流程。
- `AI自动化` 承载自动化概览、结构化日志和 Codex 终端输出。
- `脚本管理` 承载新增账号流程脚本资产治理，默认仅调试模式、超级管理员或专用权限可见。
- `登录空间` 承载 WebSpace 底层调试信息，默认仅调试模式、超级管理员或专用权限可见。
- 敏感调试支持显式读取 Cookie、Storage、Token 候选、原始截图、原始 DOM、CDP 原始快照等敏感上下文；默认不加载、不展示、不落库。

v8 增量目标：

- 将 Codex 介入从“单次任务日志展示”升级为 AiCRM 执行代理统一编排。
- 执行代理同时提供结构化事件流和终端画面流，并用同一 `runId` 关联脚本、WebSpace、Codex thread/turn 和执行状态。
- 结构化日志来自 Codex app-server JSON-RPC 事件，经执行代理脱敏、落库和推送。
- 终端输出来自 `codex --remote` TUI PTY ANSI 帧，前端使用 xterm.js 渲染。
- 执行代理支持断线补事件、补终端帧、终止执行、超时回收和运行状态持久化。
- 平台登录脚本升级为契约化维护，扫码登录页和账号识别均有固定 AI 维护目标、方法清单和验收标准。
- Codex 修复或生成脚本后必须通过契约测试，测试通过才允许激活候选脚本版本。

## 2. 执行原则

- 不在 Electron 客户端内置抖音、快手、小红书专用二维码提取规则。
- Electron 只负责受控浏览器、脱敏快照采集、受限 DSL 执行和二维码截图裁剪。
- AI 调度统一走后端服务，客户端不持有模型 API Key。
- 脚本使用受限 DSL，不执行任意 JavaScript。
- 页面截图只作为当次多模态上下文，不落库、不写日志、不进入审计明文。
- 普通用户新增账号侧滑以平台、阶段、等待扫码、二维码或加载态为主；执行脚本时允许展示安全脚本版本摘要。
- 用户侧允许展示 AI 介入原因，但禁止展示脚本 ID、版本 ID、WebSpace ID、token、原始 prompt、截图、DOM 明文和内部错误堆栈。
- 二维码刷新必须复用当前 Web 空间和当前受控浏览器，不能创建新的 Web 空间。
- 用户侧允许展示安全脚本版本信息：脚本用途、版本号、版本状态、来源、业务化原因和执行结果。
- 执行日志必须脱敏，禁止出现脚本 ID、版本 ID、WebSpace ID、token、原始 prompt、截图、DOM 明文、Cookie、Storage、密码、验证码、二次验证密钥和内部错误堆栈。
- v7 调试/超级管理员/专用权限下允许在敏感调试区显式查看上述敏感上下文；查看和导出必须二次确认并写审计，普通视图不得自动展示。
- v8 执行代理是 Codex 运行唯一协调者，前端不得直连 Codex app-server 或 PTY。
- v8 终端投影必须使用 xterm.js 渲染执行代理推送的 ANSI frames。
- v8 结构化事件和终端帧必须支持按序号补偿，断线重连不得丢失运行上下文。
- v8 脚本契约测试是候选版本激活前置条件，不允许跳过契约直接激活。

## 3. 任务拆分

### Phase 0：契约与脚手架

- `MALS-00-01` 更新矩阵账号需求文档，锁定脚本、AI、token、模型选择和安全边界。
- `MALS-00-02` 更新 TypeScript 桥接类型，增加快照、脚本执行、脚本结果类型。
- `MALS-00-03` 更新 Electron IPC channel 常量，增加 `capture-web-space-snapshot` 和 `run-web-space-login-script`。
- `MALS-00-04` 更新前端 desktop adapter，禁止业务插件直接访问 `window.aicrm`。

验收：

- 文档包含数据模型、API、IPC、DSL、安全边界和验收项。
- 类型定义可被 Web、preload、main 共同引用。

### Phase 1：数据库与权限

- `MALS-01-01` 新增脚本主表 `ky_matrix_account_login_script`。
- `MALS-01-02` 新增脚本版本表 `ky_matrix_account_login_script_version`。
- `MALS-01-03` 新增脚本运行记录表 `ky_matrix_account_login_script_run`。
- `MALS-01-04` 新增脚本策略表 `ky_matrix_account_login_script_policy`。
- `MALS-01-05` 增加脚本管理和策略管理权限点、菜单种子和角色绑定。

建议权限：

```text
<workspace>.matrix_account_login_scripts.view
<workspace>.matrix_account_login_scripts.update
<workspace>.matrix_account_login_scripts.regenerate
<workspace>.matrix_account_login_scripts.activate_version
<workspace>.matrix_account_login_script_policies.view
<workspace>.matrix_account_login_script_policies.update
```

验收：

- 数据库迁移可重复执行。
- 权限点进入 seed。
- 后端写接口不依赖前端隐藏，必须校验操作权限。

### Phase 2：后端脚本服务

- `MALS-02-01` 实现脚本查询：按平台、用途、URL 指纹、状态查找 active 脚本。
- `MALS-02-02` 实现脚本解析接口：`POST /api/v1/matrix-account-web-spaces/{id}/login-script/resolve`。
- `MALS-02-03` 实现脚本生成接口：`POST /api/v1/matrix-account-web-spaces/{id}/login-script/generate`。
- `MALS-02-04` 实现脚本运行结果回传：`POST /api/v1/matrix-account-web-spaces/{id}/login-script/run-result`。
- `MALS-02-05` 实现脚本管理接口：列表、详情、状态、重新生成、激活版本、运行记录。
- `MALS-02-06` 实现脚本策略接口：平台/用途模型、失败阈值。

验收：

- 无脚本时返回需要生成脚本的稳定响应。
- 脚本连续失败达到阈值后返回需要重新生成脚本。
- 候选版本执行成功后才提升为 active。
- 失败运行记录会增加连续失败次数。

### Phase 3：AI 模型调度

- `MALS-03-01` 实现模型选择器：本次指定模型、脚本模型、平台/场景模型、默认多模态模型、默认对话模型。
- `MALS-03-02` 扩展默认模型配置，支持默认多模态模型。
- `MALS-03-03` 实现 OpenAI-compatible 多模态调用适配，兼容文本模型兜底。
- `MALS-03-04` 实现脚本生成 prompt 模板，要求模型只输出受限 DSL JSON。
- `MALS-03-05` 实现 DSL schema 校验，不合法脚本不得入库。
- `MALS-03-06` 记录 prompt_tokens、completion_tokens、total_tokens、usage_source 和累计 token。

验收：

- 指定模型可覆盖默认模型。
- 模型停用或供应商不可用时按优先级降级。
- provider 未返回 usage 时标记 `estimated` 或 `unknown`。
- 审计记录模型、token、结果，不记录截图和敏感上下文明文。

### Phase 4：Electron 快照与 DSL 执行

- `MALS-04-01` 实现 `captureWebSpaceSnapshot`，返回 URL、标题、页面指纹、脱敏 DOM、可访问性树、可见文本、元素坐标和可选截图。
- `MALS-04-02` 实现敏感字段过滤：密码、验证码、Token、Cookie、Storage、隐藏输入值不得返回。
- `MALS-04-03` 实现 DSL 解释器，支持 `clickText`、`clickSelector`、`wait`、`waitForElement`、`captureElement`、`readText`、`navigateAllowedUrl`。
- `MALS-04-04` 实现脚本执行超时、取消和错误码。
- `MALS-04-05` 实现二维码截图裁剪返回 `qrCodeDataUrl`。
- `MALS-04-06` 实现账号识别脚本结果返回 `accountCandidate`。

验收：

- DSL 不能执行任意 JS。
- DSL 不能读取 Cookie、localStorage、sessionStorage、IndexedDB、Token、密码、验证码。
- 关闭侧滑时能取消脚本执行并释放临时 Web 空间。
- 非客户端 Web 环境保持降级提示。

### Phase 5：前端新增账号流程接入

- `MALS-05-01` 新增账号侧滑打开后创建 Web 空间并启动隐藏受控浏览器。
- `MALS-05-02` 调用后端 resolve 获取脚本；无脚本时采集快照并调用 generate。
- `MALS-05-03` 执行候选或 active 脚本，拿到二维码后展示。
- `MALS-05-04` 脚本执行失败时回传 run-result，并按后端响应决定是否重新生成。
- `MALS-05-05` 登录成功后执行 `account_detect` 脚本，识别并绑定账号。
- `MALS-05-06` 保持用户侧简洁展示，不暴露 AI 调度明细、内部脚本 ID、版本 ID 和 token 信息。

验收：

- 普通侧滑以平台、等待扫码、二维码或加载态为主，执行脚本时可展示安全版本摘要。
- 无脚本时可自动生成并展示二维码。
- 有脚本时直接复用，不触发 AI。
- 连续失败达到阈值后触发脚本更新。

### Phase 6：脚本管理后台

- `MALS-06-01` 增加登录脚本列表页。
- `MALS-06-02` 增加脚本详情页，展示 active 版本、版本历史、运行记录、成功率和累计 token。
- `MALS-06-03` 增加策略配置页，支持平台/用途指定模型和失败阈值。
- `MALS-06-04` 增加手动重新生成脚本、停用脚本、激活版本。

验收：

- 脚本列表符合后台列表页规范。
- token 展示区分本版本 token 和累计 token。
- 操作按钮按权限显示，后端同步校验。

### Phase 7：部署与回归

- `MALS-07-01` 后端单测覆盖模型选择、失败阈值、DSL schema 校验、token 统计。
- `MALS-07-02` Electron typecheck/build 通过。
- `MALS-07-03` Admin host 和矩阵账号插件 typecheck/build 通过。
- `MALS-07-04` 线上部署后完成抖音新增账号 smoke。
- `MALS-07-05` 验证脚本命中时不产生 AI token 消耗。
- `MALS-07-06` 验证脚本连续失败后能自动更新候选版本。

验收：

- Web 健康检查通过。
- Desktop 客户端重启后桥接能力可用。
- 新增账号流程不展示内部失败细节。
- 敏感信息脱敏检查通过。

## 4. 不纳入本轮

- 云端保存可跨设备恢复的 Cookie 明文包。
- 自动破解验证码、滑块、人机验证、风控或二次验证。
- 自动输入第三方平台账号密码。
- 移动端矩阵账号登录能力。
- AI 生成任意 JavaScript 并在受控浏览器中直接执行。

## 5. 推荐执行顺序

```text
MALS-00 -> MALS-01 -> MALS-02 -> MALS-03 -> MALS-04 -> MALS-05 -> MALS-06 -> MALS-07
```

第一轮最小可交付建议做到：

```text
MALS-00
MALS-01
MALS-02 resolve/generate/run-result
MALS-03 模型选择 + DSL 生成
MALS-04 快照 + DSL 执行
MALS-05 新增账号侧滑接入
```

脚本管理后台可作为第二轮迭代，但数据库和后端接口第一轮必须预留完整结构。

## 6. v5 增量执行计划任务

### Phase V5-0：契约锁定

- `MALS-V5-00-01` 更新需求文档为 v5，锁定 `qr_login_refresh`、AI 介入原因、状态展示和重试边界。
- `MALS-V5-00-02` 扩展前端、preload、main、后端和 AI 服务中的脚本用途枚举，加入 `qr_login_refresh`。
- `MALS-V5-00-03` 锁定 `generationReason` 枚举：`no_active_script`、`script_disabled`、`no_active_version`、`page_fingerprint_changed`、`script_run_failed`、`consecutive_failures`、`qr_not_found`、`refresh_script_missing`、`refresh_script_failed`、`manual_retry`。

验收：

- TypeScript 和 Go 校验均接受 `qr_login_refresh`。
- 需求文档、执行计划、前后端类型和服务校验口径一致。

### Phase V5-1：后端脚本解析与原因返回

- `MALS-V5-01-01` 调整 `resolve` 逻辑，为 `qr_login_refresh` 返回独立脚本或生成建议。
- `MALS-V5-01-02` 统一 `reason` / `generationReason` 返回值，前端不再依赖自由文本判断 AI 介入原因。
- `MALS-V5-01-03` 在脚本运行失败回传后，按失败次数和用途返回是否需要重新生成。
- `MALS-V5-01-04` 保持候选版本成功后才提升 active，刷新脚本也遵循同一规则。

验收：

- 无刷新脚本时返回 `refresh_script_missing`。
- 刷新脚本失败并达到重建条件时返回 `refresh_script_failed` 或 `script_run_failed`。
- 后端不返回截图、DOM 明文、prompt 明文或敏感凭据。

### Phase V5-2：AI 生成刷新脚本

- `MALS-V5-02-01` 调整 AI 生成校验，允许 `purpose=qr_login_refresh`。
- `MALS-V5-02-02` 扩展 prompt：刷新脚本必须寻找“刷新二维码 / 二维码已失效 / 重新获取 / reload / refresh”等入口，点击后等待二维码更新并 `captureElement`。
- `MALS-V5-02-03` 生成结果继续只允许受限 DSL JSON，不允许任意 JavaScript。
- `MALS-V5-02-04` 记录刷新脚本版本、本次 token、累计 token 和生成原因。

验收：

- 默认多模态模型可生成 `qr_login_refresh` DSL。
- 不合法 DSL 不入库。
- AI 调用失败时返回业务化错误，不暴露供应商内部细节。

### Phase V5-3：Electron DSL 执行适配

- `MALS-V5-03-01` 扩展桌面端脚本用途类型，允许执行 `qr_login_refresh`。
- `MALS-V5-03-02` 复用现有 `runWebSpaceLoginScript` IPC，不新增 channel。
- `MALS-V5-03-03` 确认 `clickText`、`clickSelector`、`wait`、`waitForElement`、`captureElement` 能覆盖刷新二维码场景。
- `MALS-V5-03-04` 刷新失败时返回稳定错误码，不关闭窗口，不释放 Profile。

验收：

- 刷新二维码不创建新窗口、不新建 Web 空间。
- 关闭侧滑仍可释放临时 Web 空间。
- DSL 仍不能读取 Cookie、Storage、Token、密码、验证码或二次验证密钥。

### Phase V5-4：前端进展状态与原因文案

- `MALS-V5-04-01` 增加统一进展状态模型 `WebSpaceFlowProgress`，包含 `phase`、`actor`、`title`、`reasonCode`、`reasonText`、`description`。
- `MALS-V5-04-02` 增加 `generationReason` 到用户文案的映射表。
- `MALS-V5-04-03` 新增账号流程按步骤更新状态：初始化、采集快照、匹配脚本、AI 生成、执行脚本、等待扫码、识别账号。
- `MALS-V5-04-04` 脚本命中时显示“已命中适配脚本，正在提取二维码”，不展示 AI 生成态。
- `MALS-V5-04-05` AI 介入时展示原因，例如“未找到可用脚本，正在自动构建适配脚本”。

验收：

- 用户能理解为什么 AI 介入。
- 页面不展示脚本 ID、版本 ID、WebSpace ID、token、prompt、截图、DOM 明文或内部错误堆栈。
- 非客户端 Web 环境保持降级提示。

### Phase V5-5：刷新二维码流程

- `MALS-V5-05-01` 二维码展示后启用“刷新二维码”按钮。
- `MALS-V5-05-02` 点击刷新后针对当前 WebSpace 执行 `qr_login_refresh`。
- `MALS-V5-05-03` 无刷新脚本时生成候选刷新脚本并执行。
- `MALS-V5-05-04` 刷新成功后替换二维码图片。
- `MALS-V5-05-05` 刷新失败时保留旧二维码，提示可重试或打开窗口手动处理。
- `MALS-V5-05-06` 单次刷新流程自动 AI 重建最多一次。

验收：

- 刷新不关闭侧滑。
- 刷新不清理登录空间。
- 刷新失败不影响当前二维码继续展示。

### Phase V5-6：回归与部署

- `MALS-V5-06-01` 运行 Go 测试：`ky-matrix-account-service`、`ky-ai-model-service`。
- `MALS-V5-06-02` 运行 TypeScript typecheck：`@ky/admin-core`、`@ky/plugin-matrix-account`、`@ky/admin-host`、`@ky/aicrm-desktop`。
- `MALS-V5-06-03` 构建 Web 后台和桌面客户端。
- `MALS-V5-06-04` 部署后端、前端，重新编译并重启客户端。
- `MALS-V5-06-05` smoke：抖音新增账号首次取码、刷新二维码、脚本命中不触发 AI、刷新失败兜底。

验收：

- Web healthz 正常。
- 后端 readyz 正常。
- Desktop 桥接能力可用。
- 新增账号和刷新二维码流程均不展示内部技术细节。

## 7. v6 增量执行计划任务

### Phase V6-0：契约锁定

- `MALS-V6-00-01` 更新矩阵账号需求文档为 v6，锁定扫码后账号识别、脚本版本展示和执行日志边界。
- `MALS-V6-00-02` 扩展 `generationReason` 枚举：`detect_script_missing`、`detect_script_failed`、`login_completed_detect_missing`、`account_identity_not_found`。
- `MALS-V6-00-03` 锁定用户侧安全展示字段：`purpose`、`version`、`version_status`、`version_source`、`reason_code`、`reason_text`、`status`、`duration_ms`、`result_summary`。

验收：

- 需求文档、执行计划、前后端枚举和 API 返回口径一致。
- 用户侧允许展示版本号，但不展示内部 ID、token、prompt、截图、DOM 或敏感凭据。

### Phase V6-1：扫码后状态机

- `MALS-V6-01-01` 调整新增账号侧滑状态机：二维码展示后持续监听登录完成状态。
- `MALS-V6-01-02` 检测到登录完成或页面进入账号主页后，自动切换到账号识别阶段。
- `MALS-V6-01-03` 进入账号识别阶段后停止二维码刷新自动重试，避免覆盖已登录页面状态。
- `MALS-V6-01-04` 账号识别成功后自动调用后端绑定结果、刷新列表并关闭侧滑。

验收：

- 用户扫码后无需手动点击识别。
- 识别阶段不会重新创建 Web 空间，也不会释放当前 Profile。
- 识别失败时停留在侧滑内并提供业务化状态，不显示内部错误详情。

### Phase V6-2：`account_detect` 脚本链路

- `MALS-V6-02-01` 前端针对当前 WebSpace 调用 `login-script/resolve`，`purpose=account_detect`。
- `MALS-V6-02-02` 无可用识别脚本时采集脱敏快照并调用 `login-script/generate`。
- `MALS-V6-02-03` 执行 active 或 candidate `account_detect` 脚本，读取 `accountCandidate`。
- `MALS-V6-02-04` 执行结果必须调用 `login-script/run-result` 回传，成功候选版本才可提升为 active。
- `MALS-V6-02-05` 单次识别流程自动 AI 重建最多一次；仍失败则进入打开窗口兜底。

验收：

- 缺少 `account_detect` 脚本时返回 `detect_script_missing`。
- 识别脚本执行失败时返回 `detect_script_failed` 或 `script_run_failed`。
- 未识别到稳定账号身份时返回 `account_identity_not_found`，但前端只展示业务化摘要。

### Phase V6-3：AI 账号识别脚本生成

- `MALS-V6-03-01` 扩展 AI 生成接口校验，允许 `purpose=account_detect`。
- `MALS-V6-03-02` 扩展 prompt：识别脚本应从账号主页、个人主页入口、昵称区域、头像区域、平台 UID、主页 URL 等非敏感信息中提取稳定账号候选。
- `MALS-V6-03-03` 要求模型输出受限 DSL JSON，结果字段限定为 `identityKey`、`platformUid`、`displayName`、`nickname`、`avatarUrl`、`homeUrl`。
- `MALS-V6-03-04` 禁止脚本读取 Cookie、Storage、Token、密码、验证码、私信内容、订单明细或其他非账号识别必要信息。

验收：

- 默认多模态模型可生成 `account_detect` DSL。
- 生成结果不合法时不入库。
- AI 失败时只返回业务化原因，不暴露供应商内部错误。

### Phase V6-4：脚本版本展示

- `MALS-V6-04-01` 后端 resolve/generate/run-result 响应补齐安全版本摘要：用途、版本号、状态、来源、原因码和用户可读原因。
- `MALS-V6-04-02` 前端进展状态展示当前执行脚本版本，例如“账号识别脚本 v3，候选版本，AI 自动构建”。
- `MALS-V6-04-03` 脚本从 candidate 升级为 active 后，当前流程状态应能反映版本变化。
- `MALS-V6-04-04` 刷新二维码和账号识别两个阶段均使用统一版本展示组件。

验收：

- 用户能看到脚本版本是否变化。
- 页面不展示脚本 ID、版本 ID、模型 ID、token、prompt、截图或 DOM。
- 版本展示不影响普通二维码等待态的简洁性。

### Phase V6-5：执行日志查看

- `MALS-V6-05-01` 前端新增当前流程实时日志，记录初始化、匹配脚本、AI 生成、执行脚本、等待扫码、识别账号、绑定账号等阶段。
- `MALS-V6-05-02` 后端新增或完善运行记录查询：`GET /api/v1/matrix-account-web-spaces/{id}/login-script/runs`。
- `MALS-V6-05-03` 运行记录返回脱敏摘要字段，默认按时间倒序展示最近记录。
- `MALS-V6-05-04` 新增账号侧滑提供“查看执行日志”入口，可在侧滑内展开或弹出轻量日志面板。
- `MALS-V6-05-05` 日志面板支持区分当前流程日志和历史运行记录。

验收：

- 当前流程中可查看脚本执行阶段和结果。
- 历史记录可看到脚本版本、用途、状态、耗时和脱敏原因。
- 日志不包含内部 ID、token、prompt、截图、DOM、Cookie、Storage、密码、验证码或堆栈。

### Phase V6-6：回归与部署

- `MALS-V6-06-01` 运行 Go 测试：`ky-matrix-account-service`、`ky-ai-model-service`。
- `MALS-V6-06-02` 运行 TypeScript typecheck/build：`@ky/admin-core`、`@ky/plugin-matrix-account`、`@ky/admin-host`、`@ky/aicrm-desktop`。
- `MALS-V6-06-03` 部署后端和前端，重新编译并重启客户端。
- `MALS-V6-06-04` smoke：抖音扫码后自动进入账号识别、无识别脚本时 AI 生成、版本展示、执行日志查看、绑定成功后关闭侧滑。

验收：

- Web healthz 正常。
- 后端 readyz 正常。
- Desktop 桥接能力可用。
- 扫码后账号识别链路自动推进。
- 脚本版本展示与执行日志均符合脱敏边界。

## 8. v7 增量执行计划任务

### Phase V7-0：契约锁定

- `MALS-V7-00-01` 更新矩阵账号需求文档为 v7，锁定新增账号侧滑 Tabs、AI自动化、脚本管理、登录空间和敏感调试边界。
- `MALS-V7-00-02` 锁定 Tab 可见性：普通用户看到 `添加账号`、`AI自动化`；调试模式、超级管理员或专用权限可看到 `脚本管理`、`登录空间`。
- `MALS-V7-00-03` 锁定敏感调试语义：默认不加载、不展示、不落库；显式查看和导出必须二次确认并审计。

### Phase V7-1：权限与迁移

- `MALS-V7-01-01` 新增脚本管理权限：`<workspace>.matrix_account_scripts.view`、`<workspace>.matrix_account_scripts.manage`。
- `MALS-V7-01-02` 新增登录空间调试权限：`<workspace>.matrix_account_web_spaces.debug`。
- `MALS-V7-01-03` 新增敏感调试权限：`<workspace>.matrix_account_sensitive_debug.view`、`<workspace>.matrix_account_sensitive_debug.export`。
- `MALS-V7-01-04` 补齐 `qr_login_refresh` 在脚本表、策略表、运行表 purpose 约束中的兼容。
- `MALS-V7-01-05` 新权限绑定平台 owner/admin、机构 owner/admin 模板、企业 owner/admin 模板。

### Phase V7-2：后端脚本管理 API

- `MALS-V7-02-01` 新增脚本列表接口，支持按平台、用途、状态筛选。
- `MALS-V7-02-02` 新增脚本详情接口，返回脚本基础信息、active 版本、统计数据。
- `MALS-V7-02-03` 新增脚本版本列表接口，返回版本号、状态、来源、模型、token、生成原因、DSL。
- `MALS-V7-02-04` 新增版本激活接口，激活候选/归档版本并归档其他 active 版本。
- `MALS-V7-02-05` 新增脚本启停接口。
- `MALS-V7-02-06` 脚本管理写操作写审计。

### Phase V7-3：前端 Tabs 重构

- `MALS-V7-03-01` 新增账号 Drawer 改为 Tabs：`添加账号`、`AI自动化`、`脚本管理`、`登录空间`。
- `MALS-V7-03-02` `添加账号` 合并二维码、等待扫码、账号识别和识别结果。
- `MALS-V7-03-03` `AI自动化` 内部使用胶囊滑块：`概览`、`结构化日志`、`终端输出`。
- `MALS-V7-03-04` `脚本管理` 按用途分组展示脚本、版本和操作。
- `MALS-V7-03-05` `登录空间` 展示 WebSpace 调试信息和敏感调试入口。

### Phase V7-4：敏感调试

- `MALS-V7-04-01` 敏感上下文读取复用 Desktop 显式快照 `includeSensitiveContext=true`。
- `MALS-V7-04-02` UI 必须二次确认后才调用敏感快照。
- `MALS-V7-04-03` 展示 Cookie、Storage、CDP、原始截图、原始 DOM/快照等调试内容。
- `MALS-V7-04-04` 关闭侧滑、释放登录空间或切换 WebSpace 时清空前端敏感状态。
- `MALS-V7-04-05` 敏感查看和导出能力按权限控制，导出单独受 `matrix_account_sensitive_debug.export` 控制。

### Phase V7-5：验收

- `MALS-V7-05-01` 普通用户只看到 `添加账号`、`AI自动化`。
- `MALS-V7-05-02` 超级管理员可看到全部 Tab。
- `MALS-V7-05-03` 脚本管理可查看脚本、版本、DSL、token 和失败原因。
- `MALS-V7-05-04` 敏感调试必须二次确认后才读取。
- `MALS-V7-05-05` 关闭侧滑后释放未完成登录空间并清空敏感状态。
- `MALS-V7-05-06` Go 测试、前端 typecheck/build、部署和客户端重启验证通过。

## 9. v8 增量执行计划任务

### Phase V8-0：契约锁定

- `MALS-V8-00-01` 更新矩阵账号需求文档为 v8，锁定执行代理双流架构、xterm.js 终端投影和脚本契约化维护。
- `MALS-V8-00-02` 锁定执行代理运行 ID 体系：`runId`、`threadId`、`turnId`、`itemId`、`scriptVersionId`、`webSpaceId`。
- `MALS-V8-00-03` 锁定执行代理 API：run 详情、结构化事件、终端帧、终端 resize、interrupt、cancel。
- `MALS-V8-00-04` 锁定脚本契约：扫码登录页契约和账号识别契约。

验收：

- 需求文档、执行计划、API 路径、事件字段和终端帧字段一致。
- 方案明确前端不直连 Codex app-server，不直接操作 PTY。
- 方案明确 xterm.js 是终端投影唯一渲染方案。

### Phase V8-1：数据库与权限

- `MALS-V8-01-01` 新增或迁移执行代理运行表 `ky_ai_executor_run`。
- `MALS-V8-01-02` 新增或迁移结构化事件表 `ky_ai_executor_run_event`。
- `MALS-V8-01-03` 新增终端帧表 `ky_ai_executor_terminal_frame`。
- `MALS-V8-01-04` 新增脚本契约表 `ky_matrix_account_login_script_contract`。
- `MALS-V8-01-05` 新增契约测试运行表，记录每次候选版本的契约测试结果。
- `MALS-V8-01-06` 复用或补齐 AI 执行器任务查看、取消、调试权限；敏感调试仍走既有专用权限。

验收：

- migration 可重复执行。
- `runId`、`sequence`、`frameSeq` 有唯一约束或可稳定去重。
- 终端帧支持按 `runId + frameSeq` 有序读取。
- 结构化事件支持按 `runId + sequence` 有序读取。

### Phase V8-2：执行代理核心

- `MALS-V8-02-01` 实现执行代理 run 创建流程，生成 `runId` 并绑定 workspace、actor、webSpace、script、contract 和 triggerReason。
- `MALS-V8-02-02` 启动和健康检查 Codex app-server，优先使用 stdio 或 unix socket 作为代理内部通信。
- `MALS-V8-02-03` 实现 Codex app-server JSON-RPC broker，完成 initialize、thread/start 或 thread/resume、turn/start。
- `MALS-V8-02-04` 记录 Codex thread、turn、item 与 AiCRM run 的关联。
- `MALS-V8-02-05` 将 app-server 通知转换为 AiCRM 结构化事件，写入 `ky_ai_executor_run_event`。
- `MALS-V8-02-06` 实现 run 状态机：pending、waiting_executor、running、waiting_user_scan、completed、failed、cancelled、timeout。
- `MALS-V8-02-07` 实现 interrupt、cancel、超时回收和进程资源释放。

验收：

- 一个 run 只产生一组可追踪的 thread/turn。
- app-server 断开时 run 能进入稳定失败或可重试状态。
- 结构化事件不包含 Cookie、Storage、Token、密码、验证码、原始截图、原始 DOM 或原始 prompt。

### Phase V8-3：PTY 终端投影

- `MALS-V8-03-01` 执行代理启动 `codex --remote` TUI PTY，并连接同一个 app-server 运行上下文。
- `MALS-V8-03-02` 捕获 PTY ANSI 输出，按 frame 写入 `ky_ai_executor_terminal_frame`。
- `MALS-V8-03-03` 实现终端帧实时推送接口 `terminal-stream?afterFrame=...`。
- `MALS-V8-03-04` 实现终端帧补偿接口 `terminal-frames?afterFrame=...`。
- `MALS-V8-03-05` 实现 `terminal-resize`，将前端 `cols/rows` 同步到 PTY。
- `MALS-V8-03-06` 终端帧过大时按字节分片，保证 frame 顺序稳定。

验收：

- 终端输出能通过 `frameSeq` 完整回放。
- 断线重连后前端能补齐遗漏终端帧。
- resize 后 TUI 布局能跟随 xterm 尺寸变化。
- 终端帧默认不写入敏感调试上下文。

### Phase V8-4：前端 xterm.js 终端组件

- `MALS-V8-04-01` 引入 xterm.js、FitAddon 和 WebLinksAddon。
- `MALS-V8-04-02` 将 `AI自动化 > 终端输出` 从 `<pre>` 替换为 xterm.js。
- `MALS-V8-04-03` 实现终端帧订阅、断线重连和按 `afterFrame` 补帧。
- `MALS-V8-04-04` 实现 FitAddon 自适应和 resize 上报。
- `MALS-V8-04-05` 保留底部固定状态栏，展示执行中、已完成、失败、取消、超时和耗时。
- `MALS-V8-04-06` 默认只读投影，不开放键盘输入回传；后续人工接管单独评审。

验收：

- ANSI 颜色、光标移动、清屏、进度刷新能正确渲染。
- 终端内容滚动时底部状态栏固定可见。
- 关闭 Drawer 后订阅释放，重新打开不重复订阅。
- 非客户端 Web 环境保持降级提示。

### Phase V8-5：结构化事件流

- `MALS-V8-05-01` 实现结构化事件实时流 `events-stream?after=...`。
- `MALS-V8-05-02` 实现结构化事件补偿接口 `events?after=...`。
- `MALS-V8-05-03` 前端结构化日志改为消费 run 事件流，并显示 run、脚本、契约、阶段、状态、耗时。
- `MALS-V8-05-04` 结构化日志增加脚本契约、方法、测试结果和版本激活状态。
- `MALS-V8-05-05` Codex 原始 JSON-RPC payload 仅在调试权限下展示脱敏摘要，普通用户只看业务化事件。

验收：

- 结构化日志和终端投影使用同一 `runId`。
- 断线重连后结构化日志可补齐。
- 普通用户看不到 threadId、turnId、itemId、脚本 ID、版本 ID、原始 prompt 或敏感上下文。

### Phase V8-6：脚本契约与契约测试

- `MALS-V8-06-01` 建立扫码登录页契约 `*.qr_login_page.v1`。
- `MALS-V8-06-02` 建立账号识别契约 `*.account_detect.v1`。
- `MALS-V8-06-03` 扩展脚本生成上下文，将契约目标、方法 schema 和验收标准传给 Codex。
- `MALS-V8-06-04` Codex 生成或修复脚本后先保存 candidate 版本。
- `MALS-V8-06-05` 执行契约测试：获取二维码、刷新二维码、验证二维码可识别、检测登录阶段、账号身份稳定性。
- `MALS-V8-06-06` 契约测试通过后才激活候选版本；失败则标记 failed 或 learning，并记录失败原因。

验收：

- 扫码登录页脚本必须能获取二维码、刷新二维码并验证可识别。
- 账号识别脚本未检测到扫码完成时必须返回 pending，不得创建空账号。
- 没有稳定 `identityKey` 时不得绑定账号。
- 契约测试结果可在脚本管理中查看。

### Phase V8-7：新增账号流程接入

- `MALS-V8-07-01` 新增账号流程在脚本失效时创建执行代理 run，而不是直接调用模型生成接口。
- `MALS-V8-07-02` `AI自动化` 概览展示 run 状态、触发原因、当前契约、当前方法和脚本版本。
- `MALS-V8-07-03` 结构化日志和终端输出均按 runId 切换。
- `MALS-V8-07-04` Codex 修复成功并通过契约测试后，自动重新执行当前阶段脚本。
- `MALS-V8-07-05` Codex 修复失败时保留当前侧滑，不创建空账号，并提供打开窗口兜底。

验收：

- 二维码未出现时不会提前进入账号绑定。
- 未扫码成功时不会运行账号绑定提交。
- Codex 介入期间用户可看见执行状态和终端投影。
- 失败后用户可继续打开窗口手动处理。

### Phase V8-8：回归与部署

- `MALS-V8-08-01` Go 测试覆盖执行代理状态机、事件补偿、终端帧补偿、契约测试和候选版本激活。
- `MALS-V8-08-02` TypeScript typecheck 覆盖 admin core、matrix account plugin、admin host 和 desktop。
- `MALS-V8-08-03` 构建 Web 后台和桌面客户端。
- `MALS-V8-08-04` 部署后端、前端，重新编译并重启客户端。
- `MALS-V8-08-05` smoke：抖音新增账号取码失败触发 Codex run、xterm 终端投影、结构化事件、契约测试、候选版本激活、重新取码。

验收：

- Web healthz 正常。
- 后端 readyz 正常。
- Desktop 桥接能力可用。
- 终端投影和结构化日志可断线补偿。
- 普通视图无敏感信息泄漏。
