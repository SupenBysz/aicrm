# AiCRM 矩阵账号模块需求与契约

> 文档状态：已锁定 / 矩阵账号 v9 实现输入基线
> 锁定日期：2026-07-10
> 适用范围：工作台矩阵账号菜单、Web 后台插件、Electron 受控浏览器能力、AI 执行代理、后端矩阵账号服务、数据库权限与审计

## 1. 模块目标

矩阵账号模块用于管理直播电商全域运营中的第三方平台 Web 账号资产。第一阶段覆盖：

- 抖音账号。
- 快手账号。
- 小红书账号。
- 账号档案、归属、状态、Web 空间、客户端登录态元数据。

本模块不保存第三方平台账号密码、短信验证码或 2FA 密钥。用户通过 Electron 客户端受控 Web 空间扫码或手动登录，系统保存的是 Web 登录态能力，而不是平台登录凭据明文。

v3 锁定新增语义：

- “新增账号”不是表单创建账号档案。
- 点击“新增账号”后必须先打开侧滑窗口，并进入初始化/等待二维码状态。
- “新增账号”必须创建一个新的客户端 Web 空间，并默认隐藏加载对应平台登录页。
- 客户端应优先将平台登录二维码透传给 Web 后台展示，供用户扫码登录。
- 受控浏览器窗口只作为二维码无法提取、平台要求额外验证或用户主动排查时的兜底入口。
- 用户扫码登录成功后，由 Web 后台自动轮询客户端识别非敏感账号信息，不要求用户手动点击“开始识别”。
- 后端根据稳定平台身份键创建或绑定矩阵账号档案。
- 账号识别并绑定成功后，侧滑窗口自动关闭并刷新列表。
- 用户主动关闭侧滑且未成功识别时，必须自动释放本次登录空间资源并清理临时 Profile。
- Web 浏览器环境仅支持已识别账号的档案管理，不支持新增登录空间。

v4 锁定新增语义：

- 新增账号的二维码获取和登录态识别默认由平台登录脚本驱动，不再依赖客户端内置平台专用二维码提取规则。
- 登录脚本缺失、停用、无可用版本或连续失败达到阈值时，由后端调用指定模型或默认多模态模型生成受限 DSL 脚本。
- AI 可基于脱敏 DOM、可访问性树、页面文本、元素坐标和必要页面截图生成脚本；截图只用于当次模型上下文，不落库、不写日志、不进入审计明文。
- 脚本必须按版本保存，并记录生成模型、本次 token 消耗和脚本累计 token 消耗。
- 脚本可配置指定模型；未指定时按平台/场景模型、默认多模态模型、默认对话模型顺序兜底。
- 客户端只执行受限 DSL，不执行任意 JavaScript，不读取 Cookie、Storage、Token、密码、验证码或二次验证密钥。
- 新生成脚本先作为候选版本执行，执行成功后才提升为 active 版本。
- 普通新增账号侧滑不展示脚本失败明细、AI 调度明细、token 消耗或内部版本更新细节；执行脚本时只展示平台、阶段、二维码/加载态和安全脚本版本摘要。

v5 锁定新增语义：

- 登录脚本除默认获取二维码外，必须支持独立的刷新二维码脚本用途 `qr_login_refresh`。
- 二维码刷新必须复用当前侧滑、当前 Web 空间和当前受控浏览器，不创建新的 Web 空间，不释放 Profile。
- 刷新二维码失败时保留旧二维码，不关闭侧滑，并提供“打开窗口”兜底入口。
- 新增账号侧滑允许展示 AI 介入的用户可理解原因，例如“未找到可用脚本，正在自动构建适配脚本”。
- 用户侧只展示阶段、原因和当前动作，不展示脚本 ID、版本 ID、WebSpace ID、token、原始 prompt、截图、DOM 明文或内部错误堆栈。
- 已命中可用脚本时必须表达为“已命中适配脚本”，不得误导用户以为每次都在消耗 AI。
- 单次新增或刷新流程中，脚本失败后的自动 AI 重建最多执行一次；仍失败则停止自动重试并进入兜底状态。

v6 锁定新增语义：

- 用户扫码登录成功后，新增账号流程必须自动进入账号信息识别与采集阶段，不再停留在“等待扫码”或依赖用户手动重试。
- 账号信息识别必须优先走 `account_detect` 脚本链路；客户端启发式识别只能作为兜底能力，不能替代脚本解析、AI 生成和运行结果回传。
- `account_detect` 脚本缺失、失效、执行失败或未识别到稳定账号身份时，应按脚本生成规则调用指定模型或默认多模态模型自动生成或更新候选脚本。
- 新增账号侧滑在执行脚本时必须展示安全脚本版本信息，至少包含脚本用途、版本号、版本状态、来源和用户可理解的执行/生成原因。
- 新增账号侧滑必须提供查看脚本执行日志能力，区分当前流程实时日志和后端持久化运行记录。
- 用户侧可见日志只能展示阶段、动作、结果、耗时、错误码和脱敏业务原因；禁止展示脚本 ID、版本 ID、WebSpace ID、token、原始 prompt、截图、DOM 明文、Cookie、Storage、密码、验证码、二次验证密钥和内部错误堆栈。
- 当前流程日志用于帮助用户理解正在发生什么；持久化运行记录用于后续排查脚本命中、版本切换和失败原因，默认同样只返回脱敏摘要。

v7 锁定新增语义：

- 新增账号侧滑窗口采用 Tabs 结构：`添加账号`、`AI自动化`、`脚本管理`、`登录空间`。
- `添加账号` 合并扫码登录、等待扫码、账号识别和识别结果，是普通用户默认主流程。
- `AI自动化` 合并自动化概览、结构化日志和 Codex 终端输出，用于说明当前脚本命中、脚本版本、触发原因、Codex 介入状态和流程日志。
- `脚本管理` 用于查看和维护新增账号流程涉及的脚本资产，默认仅调试模式、超级管理员或具备专用权限用户可见。
- `登录空间` 用于查看 WebSpace、Browser Partition、Device、当前 URL、资源释放等底层调试信息，默认仅调试模式、超级管理员或具备专用权限用户可见。
- 脚本管理范围覆盖 `qr_login_prepare`、`qr_login_refresh`、`account_detect`、`session_check`。
- 脚本管理可展示脚本 DSL、版本、模型、token 统计、失败原因、运行统计和版本状态。
- 敏感调试区支持在显式点击和二次确认后查看 Cookie、Storage、Token 候选、验证码/二维码图片、密码字段当前值、二次验证相关页面内容、原始截图、原始 prompt、未脱敏 DOM 明文和 CDP 原始快照。
- 敏感调试能力默认不加载、不展示，仅在调试模式、超级管理员或专用权限下开放；查看与导出必须写审计。
- 敏感数据默认只即时读取，不落库；关闭侧滑或释放登录空间后前端状态必须清空。
- 普通 `添加账号` 和 `AI自动化` 默认视图不自动混入敏感明文。

v8 锁定新增语义：

- Codex 介入不再作为简单模型 API 调用或混合日志展示，而是通过 AiCRM 执行代理统一编排。
- AI 自动化必须拆成两条可独立补偿的运行流：结构化事件流和终端画面流。
- 结构化事件流来自 Codex app-server JSON-RPC，经 AiCRM 执行代理归一为 `runId` 下的事件序列。
- 终端画面流来自 `codex --remote` TUI PTY 的 ANSI 帧，Web 前端必须使用 xterm.js 渲染，不再用 `<pre>` 模拟终端。
- AiCRM 执行代理必须统一管理 `runId`、Codex `threadId`、`turnId`、`itemId`、脚本版本、WebSpace 和触发原因。
- 前端只消费 AiCRM 执行代理暴露的流接口，不直接连接 Codex app-server、Codex TUI 或底层 PTY。
- 执行代理必须支持断线重连、按序号补结构化事件、按帧序号补终端画面、终止执行、超时回收和执行状态持久化。
- 每类平台登录脚本必须具备固定 AI 维护目标和方法契约，不允许 AI 无目标地生成或修复脚本。
- 扫码登录页脚本契约必须至少包含：获取二维码、刷新二维码、验证二维码可识别、检测登录阶段。
- 账号识别脚本契约必须至少包含：检测扫码完成、获取稳定账号身份、获取账号展示资料。
- Codex 修复脚本后必须通过对应契约测试，测试通过后才允许将候选版本提升为 active。
- 执行代理、结构化事件、终端帧和脚本契约均必须遵守普通视图脱敏边界；敏感调试仍仅允许在调试模式、超级管理员或专用权限下显式读取。

v9 锁定新增语义：

- AI 执行器、Codex 协助授权、执行器默认模型、脚本执行器与模型绑定的完整真相源为 `docs/kyai_crm_ai_executor_authorization_requirements.md`。
- v9 覆盖 v4 的模型解析与兜底条款，以及 v8 的执行器服务归属、物理运行真相源、App Server 传输、终端投影和任务创建入口；v8 其余脚本方法契约、受限 DSL、候选验证、脱敏与业务运行流规则继续有效。
- Codex 执行器模型键与 `ky_ai_model.id` 完全分离；旧 `model_id` 只保留 legacy provider 语义。
- 新链路按“脚本指定执行器 -> 平台全局默认 Codex 执行器，并校验当前 workspace grant”和“脚本模型覆盖 -> 执行器默认模型”解析；缺失或不可用时阻断，不从 grant 中任挑其他执行器，也不回退平台全局 API 模型。
- 客户端和服务端 Codex 授权必须通过 App Server 结构化协议、专属凭据修订和可信设备/服务证明完成，普通 Web 请求不得提交授权成功。
- 只有 `scriptMaintenanceReady=true` 的执行器能被脚本选择；Desktop Agent 任务传输未验收前，客户端执行器不进入可选列表。
- v8 的 `ky_ai_executor_run/run_event/terminal_frame`、`/ai-executor-runs` 创建入口和 `codex --remote`/WebSocket/PTY 描述只保留为历史逻辑/API/UI 投影；v9 不创建第二套 run 表，不启动 remote TUI，也不开放 App Server WebSocket。唯一物理执行存储、stdio 传输和 ANSI 只读投影以执行器授权需求 §20.2、§20.5 为准。
- v9 Codex 生成统一使用异步 `generation-runs`，Matrix 预生成的 `runId` 同时作为 executor task.id；同一 runId 关联脚本版本、事件、ANSI 投影，以及存在时的 WebSpace。旧同步 `/login-script/generate` 仅保留 `legacy_provider` 一个兼容周期，之后返回 410。
- 业务动作、LoginAttempt、版本化方法 ID 以及登录态快照封存/恢复/清理继续以 `docs/matrix_account_ai_onboarding_contract.md` 为真相源；v9 执行器链路只维护脚本方法，不把 Cookie/Profile/快照交给 AI，也不自动打开该合同 §8 的生产门禁。

## 2. 能力边界

### 2.1 Web 后台

Web 后台负责：

- 展示矩阵账号列表。
- 创建 Web 空间并通过 Desktop adapter 启动客户端受控 Web 空间。
- 先展示侧滑初始化态，再通过脚本执行结果展示客户端透传的登录二维码。
- 在无脚本或脚本失效时调用后端 AI 辅助接口生成或更新登录脚本。
- 在 AI 介入时展示业务化原因和进展状态。
- 展示执行代理的结构化事件流和 xterm.js 终端投影。
- 在终端投影底部固定展示执行中、已完成、失败、耗时等状态。
- 扫码登录成功后自动进入 `account_detect` 脚本识别链路，识别并绑定账号。
- 执行脚本时展示安全版本信息，并提供查看执行日志入口。
- 提供刷新二维码与手动打开窗口兜底操作。
- 自动轮询识别扫码登录结果，成功后自动提交后端创建/绑定账号。
- 未成功时，关闭侧滑会自动释放本次 Web 空间资源。
- 编辑、停用已识别账号档案。
- 查看登录状态、Web 空间状态和操作日志。
- 展示非客户端环境降级提示。

Web 后台禁止：

- 读取 Cookie、localStorage、sessionStorage 明文。
- 直接访问 `window.aicrm` 或 Electron IPC。
- 自行恢复第三方平台 Web 登录态。
- 保存平台账号密码、验证码或二次验证密钥。
- 通过表单手动创建矩阵账号档案。

### 2.2 Electron 客户端

Electron 客户端负责：

- 默认隐藏打开受控 Web 空间。
- 按账号隔离 Browser Partition / Profile。
- 按 Web 空间隔离 Browser Partition / Profile。
- 采集受控 Web 空间的脱敏页面快照。
- 执行后端下发的受限登录 DSL 脚本。
- 承载客户端运行时执行代理需要的本机受控浏览器、CDP 调试通道和 Profile 访问能力。
- 在客户端隔离 Runtime 内仅通过 stdio 启动 Codex app-server，用于授权、校验和模型目录；不启动 Codex remote TUI/PTY，不开放 App Server socket，也不得把 Codex 原始协议直接暴露给业务插件。Desktop Agent 任务传输验收前不执行脚本维护任务。
- 按脚本执行结果裁剪二维码区域并通过安全桥透传给 Web 后台。
- 承载用户扫码或手动登录；手动窗口默认不显示，只在用户主动打开时显示。
- 用户关闭手动窗口时仅隐藏窗口，不释放 Profile。
- Web 后台侧滑关闭或清理指令到达时，才真正关闭窗口并清理临时 Profile。
- 识别成功时关闭受控窗口但保留 Profile，确保后续账号打开仍可复用本机登录态。
- 检测登录态。
- 提取平台 UID、昵称、头像、主页等非敏感账号识别信息。
- 执行 `account_detect` 受限 DSL，并返回稳定账号身份候选信息。
- 恢复本机登录态并打开平台页面。
- 清除本机账号 Profile。
- 通过安全桥向 Web adapter 提供白名单能力。

Electron 客户端禁止：

- 直接调用 AI 模型或持有模型 API Key。
- 维护角色、权限、菜单、工作区策略。
- 绕过验证码、破解风控或自动输入敏感凭据。
- 向 Web Renderer 暴露 Cookie / Storage 明文。
- 暴露原始 `ipcRenderer` 或任意 IPC channel 转发能力。

### 2.3 后端服务

后端服务负责：

- 权限校验。
- 工作区和数据范围校验。
- 账号档案存储。
- Web 空间状态。
- 平台登录脚本、脚本版本和脚本运行记录。
- 平台登录脚本契约、契约测试和契约执行记录。
- AI 执行代理运行记录、结构化事件、终端帧和状态流。
- AI 辅助生成或更新登录脚本。
- 按 `generation_engine` 解析模型：`codex_executor` 使用脚本模型覆盖与执行器默认模型；`legacy_provider` 兼容平台/场景及历史默认 API 模型。
- 脚本生成 token 消耗统计。
- 登录任务状态（兼容既有账号登录流程）。
- 客户端登录态元数据。
- 账号去重、创建与绑定。
- 审计日志。

后端服务第一阶段不保存可跨设备恢复的 Cookie 明文包。真实 Web 登录态优先存放在 Electron 客户端独立 Profile；如果后续要做云端加密凭证库，需要单独评审。

## 3. 工作台菜单

工作台左侧菜单通过插件贡献，不在 Host 中硬编码业务菜单。

```text
矩阵账号
  抖音账号
  快手账号
  小红书账号
```

路由：

```text
/workbench/matrix-accounts/douyin
/workbench/matrix-accounts/kuaishou
/workbench/matrix-accounts/xiaohongshu
```

## 4. 权限模型

第一阶段支持平台、机构、企业三类工作区，便于平台超级管理员直接验收。

页面权限：

```text
platform.matrix_accounts.view
agency.matrix_accounts.view
enterprise.matrix_accounts.view
```

操作权限：

```text
<workspace>.matrix_accounts.create
<workspace>.matrix_accounts.update
<workspace>.matrix_accounts.update_status
<workspace>.matrix_accounts.delete
<workspace>.matrix_accounts.login
<workspace>.matrix_accounts.open
<workspace>.matrix_accounts.check
<workspace>.matrix_accounts.clear_session
```

脚本管理与调试权限：

```text
<workspace>.matrix_account_scripts.view
<workspace>.matrix_account_scripts.manage
<workspace>.matrix_account_web_spaces.debug
<workspace>.matrix_account_sensitive_debug.view
<workspace>.matrix_account_sensitive_debug.export
```

兼容权限：

```text
<workspace>.matrix_account_login_scripts.view
<workspace>.matrix_account_login_scripts.update
<workspace>.matrix_account_login_scripts.regenerate
<workspace>.matrix_account_login_scripts.activate_version
```

菜单权限：

```text
menu.platform.matrix_accounts
menu.agency.matrix_accounts
menu.enterprise.matrix_accounts
```

## 5. 数据模型

### 5.1 矩阵账号

```text
ky_matrix_account
  id
  workspace_type
  workspace_id
  platform
  platform_identity_key
  identity_source
  display_name
  platform_uid
  nickname
  avatar_url
  home_url
  owner_member_id
  department_id
  team_id
  login_status
  status
  remark
  created_by
  updated_by
  created_at
  updated_at
  deleted_at
```

平台枚举：

```text
douyin
kuaishou
xiaohongshu
```

登录状态：

```text
not_logged_in
login_pending
online
expired
verify_required
risk
```

业务状态：

```text
normal
disabled
```

账号唯一身份锁定：

```text
workspace_type + workspace_id + platform + platform_identity_key
```

`platform_uid`、`nickname`、`avatar_url`、`home_url` 是识别结果展示字段，不能作为唯一账号身份的唯一依据。没有稳定 `platform_identity_key` 时，不允许自动创建或绑定矩阵账号。

### 5.2 客户端登录态元数据

```text
ky_matrix_account_client_session
  id
  account_id
  workspace_type
  workspace_id
  member_id
  device_id
  browser_partition
  login_status
  last_login_at
  last_check_at
  expires_at
  fingerprint_hash
  created_at
  updated_at
  deleted_at
```

### 5.3 登录任务

```text
ky_matrix_account_login_task
  id
  account_id
  workspace_type
  workspace_id
  member_id
  device_id
  status
  platform_login_url
  error_message
  created_at
  expired_at
  completed_at
```

任务状态：

```text
pending
opening
waiting_login
completed
failed
cancelled
expired
```

### 5.4 Web 空间

```text
ky_matrix_account_web_space
  id
  workspace_type
  workspace_id
  platform
  member_id
  device_id
  browser_partition
  account_id
  status
  detected_identity_key
  detected_platform_uid
  detected_nickname
  detected_avatar_url
  detected_home_url
  last_opened_at
  detected_at
  created_by
  updated_by
  created_at
  updated_at
  deleted_at
```

Web 空间状态：

```text
created
opening
waiting_login
detected
bound
detect_failed
abandoned
cleared
```

### 5.5 平台登录脚本

```text
ky_matrix_account_login_script
  id
  workspace_type
  workspace_id
  platform
  purpose
  url_pattern
  page_fingerprint
  active_version_id
  model_id                    # legacy_provider only
  executor_id                 # nullable: inherit platform global default
  model_key_override          # nullable: inherit executor default
  generation_engine           # legacy_provider | codex_executor
  config_revision
  status
  failure_threshold
  success_count
  failure_count
  consecutive_failure_count
  generation_count
  total_prompt_tokens
  total_completion_tokens
  total_tokens
  last_success_at
  last_failed_at
  last_failure_reason
  created_by
  updated_by
  created_at
  updated_at
  deleted_at
```

脚本用途：

```text
qr_login_prepare
qr_login_refresh
account_detect
session_check
```

脚本状态：

```text
enabled
disabled
learning
failed
```

脚本模型选择优先级（v9 新链路；替代 v4 默认链）：

```text
脚本 model_key_override
执行器 default_model_key
缺失或不可用时阻断
```

旧 `model_id`、平台/场景 `model_id` 及系统默认多模态/对话模型只服务于迁移期 legacy provider 生成链路，不得作为 Codex 执行器链路的隐式回退。

### 5.6 平台登录脚本版本

```text
ky_matrix_account_login_script_version
  id
  script_id
  version
  model_id                    # legacy_provider only
  effective_executor_id
  effective_model_key
  executor_source
  model_source
  executor_config_revision
  credential_binding_revision
  runtime_binding_id
  runtime_binding_revision
  model_catalog_revision
  generation_engine
  generation_run_id
  dsl_json
  source
  status
  prompt_tokens
  completion_tokens
  total_tokens
  usage_source
  generation_reason
  created_by
  created_at
```

版本来源：

```text
ai_generated
manual
imported
```

版本状态：

```text
candidate
active
archived
failed
```

token 来源：

```text
provider
estimated
unknown
```

脚本生成原因：

```text
no_active_script
script_disabled
no_active_version
page_fingerprint_changed
script_run_failed
consecutive_failures
qr_not_found
refresh_script_missing
refresh_script_failed
manual_retry
detect_script_missing
detect_script_failed
login_completed_detect_missing
account_identity_not_found
contract_validation
```

脚本生成原因只用于流程判断、运行记录和用户侧业务化文案映射。普通新增账号侧滑可以展示脚本用途、版本号、版本状态、来源和用户可理解原因；不得展示原始后端错误、脚本 ID、版本 ID、token、模型调用明细、prompt、截图或 DOM 明文。

### 5.7 平台登录脚本运行记录

```text
ky_matrix_account_login_script_run
  id
  script_id
  script_version_id
  web_space_id
  workspace_type
  workspace_id
  platform
  purpose
  status
  error_code
  error_message
  duration_ms
  result_summary
  created_by
  created_at
```

运行状态：

```text
success
failed
timeout
cancelled
```

用户侧可查看的脚本运行日志字段必须经过脱敏，字段固定为：

```text
purpose
version
version_status
version_source
status
error_code
reason_code
reason_text
duration_ms
created_at
result_summary
```

`result_summary` 只能保存脱敏摘要，例如是否找到二维码、是否进入账号主页、是否识别到稳定账号身份、识别字段完整度。不得保存截图原图、DOM 明文、Cookie、Storage、Token、密码、验证码、二次验证密钥、原始 prompt 或内部堆栈。

### 5.8 平台登录脚本策略

```text
ky_matrix_account_login_script_policy
  id
  workspace_type
  workspace_id
  platform
  purpose
  model_id                    # legacy_provider 兼容期专用
  failure_threshold
  status
  created_by
  updated_by
  created_at
  updated_at
```

`failure_threshold` 默认值为 `3`，允许范围为 `1-10`。

### 5.9 平台登录脚本契约

```text
ky_matrix_account_login_script_contract
  id
  workspace_type
  workspace_id
  platform
  contract_code
  purpose_group
  target
  method_schema_json
  acceptance_schema_json
  status
  version
  created_by
  updated_by
  created_at
  updated_at
  deleted_at
```

契约代码示例：

```text
douyin.qr_login_page.v1
kuaishou.qr_login_page.v1
xiaohongshu.qr_login_page.v1
douyin.account_detect.v1
```

扫码登录页契约必须包含的方法：

```text
getQrCode
refreshQrCode
verifyQrCodeReadable
detectLoginPhase
```

账号识别契约必须包含的方法：

```text
detectLoginCompleted
getAccountIdentity
getAccountProfile
```

方法到现有脚本用途的兼容映射：

```text
getQrCode            -> qr_login_prepare
refreshQrCode        -> qr_login_refresh
verifyQrCodeReadable -> qr_login_prepare / qr_login_refresh 的输出契约断言
detectLoginPhase     -> session_check
getAccountIdentity   -> account_detect
getAccountProfile    -> account_detect
```

v9 不新增 `qr_code_verify`、`login_phase_detect` purpose；它们分别按上表作为既有 purpose 的契约方法/断言落库，避免方法名和脚本资产类型形成双轨。

业务层只调用版本化方法 ID，camelCase 名称只是平台 adapter 内部函数；映射锁定为：

| 业务方法 ID | Adapter 方法/可信运行时动作 | 脚本 purpose |
|---|---|---|
| `login.open.v1` | 打开隔离 WebSpace 后编排 `getQrCode` | `qr_login_prepare` |
| `login.qr.get.v1` | `getQrCode` + `verifyQrCodeReadable` | `qr_login_prepare` |
| `login.qr.refresh.v1` | `refreshQrCode` + `verifyQrCodeReadable` | `qr_login_refresh` |
| `login.status.probe.v1` | `detectLoginPhase` + `detectLoginCompleted` | `session_check` |
| `account.identity.get.v1` | `getAccountIdentity` | `account_detect` |
| `account.profile.get.v1` | `getAccountProfile` | `account_detect` |
| `session.snapshot.seal.v1` | Desktop Vault 内部封存，不经 AI/DSL | 无 |
| `web_space.cleanup.v1` | Desktop 可信清理与 receipt | 无 |

`generate|repair` Generation run 成功只产生 candidate adapter 版本；`contract_test` 成功只更新目标 candidate 与 contract revision 的测试结果，不创建新 candidate。LoginAttempt 必须在隔离契约测试通过并激活后，以新的 `attempt_no` 续跑原业务方法，不能另建一条脱离 Attempt 的登录流程。

### 5.10 AI 执行代理运行投影（v8 兼容）

以下 `ky_ai_executor_run/run_event/terminal_frame` 名称只描述 v8 逻辑/API 投影，不是 v9 数据库表。v9 必须映射为：

```text
ky_ai_executor_run            -> ky_ai_executor_task
ky_ai_executor_run_event      -> ky_ai_executor_task_event
ky_ai_executor_terminal_frame -> ky_ai_executor_task_raw_log(source=executor, direction=internal, terminal_line)
runId                         -> task.id
```

本轮禁止创建 `ky_ai_executor_run`、`ky_ai_executor_run_event`、`ky_ai_executor_terminal_frame` 第二套物理表。下面字段仅用于兼容投影与旧 UI DTO：

```text
ky_ai_executor_run
  id
  workspace_type
  workspace_id
  executor_id
  executor_type
  runtime_type
  task_type
  target_type
  target_id
  web_space_id
  script_id
  script_version_id
  contract_id
  run_status
  trigger_reason
  codex_thread_id
  codex_turn_id
  started_at
  completed_at
  error_message
  created_by
  created_at
  updated_at
```

```text
ky_ai_executor_run_event
  id
  run_id
  sequence
  event_type
  level
  message
  payload_json
  codex_item_id
  created_at
```

```text
ky_ai_executor_terminal_frame
  id
  run_id
  frame_seq
  encoding
  payload
  byte_length
  created_at
```

运行状态：

```text
pending
waiting_executor
running
waiting_user_scan
completed
failed
cancelled
timeout
```

`payload_json` 和 `terminal_frame.payload` 默认不得包含 Cookie、Storage、Token、密码、验证码、原始截图、未脱敏 DOM、原始 prompt 或第三方平台敏感凭据。若调试模式确需读取敏感上下文，必须进入敏感调试区并写审计，不进入普通结构化日志和终端投影。

### 5.11 脚本生成运行（v9 canonical）

Matrix service 物理保存业务生成运行，不复制 executor task 内容：

```text
ky_matrix_account_login_script_generation_run
  id                          # 与 executor task.id 使用同一 runId
  workspace_type
  workspace_id
  web_space_id                  # 手动脚本维护时可空
  script_id
  script_purpose
  operation
  generation_reason
  generation_engine
  contract_id
  contract_revision
  target_version_id
  status
  dispatch_status
  dispatch_attempt
  dispatch_lease_expires_at
  candidate_version_id
  expected_script_revision
  effective_executor_id
  effective_model_key
  executor_source
  model_source
  executor_config_revision
  credential_binding_revision
  runtime_binding_id
  runtime_binding_revision
  model_catalog_revision
  current_sequence
  revision
  idempotency_key_hash
  request_hash
  failure_code
  created_by
  created_at
  updated_at
  finished_at

ky_matrix_account_login_script_generation_run_event
  id
  generation_run_id
  sequence
  event_type
  safe_payload_json
  occurred_at
  created_at
```

Event 对 `(generation_run_id, sequence)` 唯一；run/event/outbox 状态与序列同事务提交。完整创建、幂等、SSE 和恢复合同以执行器授权需求 §20.6 为准。

```text
status = queued | running | materializing | succeeded | failed | cancelled
dispatch_status = pending | dispatching | dispatched | cancelled | failed
```

Contract test generation run 必须冻结 `contract_id/contract_revision/target_version_id`；成功只写契约测试记录与目标 candidate 验证结果，不创建新 candidate。

### 5.12 脱敏脚本上下文快照

`contextSnapshotId` 引用 Matrix service 拥有的短期、不可变安全资源，不是 Renderer 上传的任意 JSON，也不是 Desktop 原始 CDP/DOM 快照。P1 只允许 additive 建表和 shadow read；可信 Desktop 提交端点、设备证明和 command ticket 在 P2B 通过前保持关闭。

```text
ky_matrix_account_login_script_context_snapshot
  id
  workspace_type
  workspace_id
  platform
  web_space_id                  # 与 script_id 二选一
  script_id                     # 手动维护时可用
  attempt_id                    # WebSpace 属于 Attempt 时冻结
  script_purpose
  schema_version
  sanitizer_version
  page_origin
  page_path                     # 禁止 query/fragment/userinfo
  page_fingerprint
  safe_payload_json             # 严格 schema 的脱敏结构化投影
  content_hash
  status                        # ready | expired | deleted
  expires_at                    # created_at + 30 minutes
  created_by
  created_at
  deleted_at
```

`safe_payload_json` 只允许：页面标题的有界摘要、规范化可见文本片段、landmark、role/accessible name，以及带 `elementKey/keySource/stability` 的元素证据和候选验证所需矩形。固定禁止原始 DOM、原始 accessibility tree、input value、Cookie、Storage、IndexedDB、Token、密码、验证码、账号凭据、二维码 data URL、截图、任意文件路径和任意 CDP/App Server 输出。Root/element 字段采用严格白名单，未知字段拒绝；payload、文本、元素数量和单字段长度均有上限。

上下文创建链路固定为：

1. 用户以 Bearer、workspace、权限和 Idempotency-Key 为目标 WebSpace 创建 snapshot operation；服务端签发绑定 `operationId/snapshotId/webSpaceId/deviceId/purpose/sanitizerVersion/expiry/nonce` 的一次性 Desktop command ticket。
2. Host 只把 ID 与 ticket 交给统一 Desktop Port。Main 捕获并在本地完成严格脱敏，以设备签名直接提交 `/api/v1/matrix-account-script-context-snapshots/{snapshotId}/desktop-proofs`；Renderer/Plugin 不接触 payload、proof 或 receipt。
3. Matrix 验证 ticket、设备签名、sequence/nonce、target revision、schema、大小和 content hash 后一次性物化 `ready` 资源；相同请求按 ledger 幂等，不同 body 或重放拒绝。
4. Generation/contract-test create 只接收 `contextSnapshotId`。Matrix 必须验证同 workspace、同平台、同 WebSpace/Script、同 purpose、状态 ready 且未过期，再冻结到 generation run。
5. Agent Executor 仅凭同 runId 和 internal token 从 Matrix internal API 获取安全投影；响应 `no-store`，不得写 task event/raw-log、审计或普通 API。终态或 TTL 到期后清理。

用户 Command body 固定为 `{scriptPurpose,expectedWebSpaceRevision,sanitizerVersion}`，202 响应固定为 `{operationId,snapshotId,expectedWebSpaceRevision,commandTicket,expiresAt}`。Desktop proof body 固定为 `{operationId,snapshotId,webSpaceId,expectedWebSpaceRevision,runtimeEpoch,nativeSequence,schemaVersion,sanitizerVersion,pageOrigin,pagePath,pageFingerprint,safePayload,contentHash,capturedAt}`；不得扩展 screenshot、path、credential 或任意 raw 字段。Internal GET 额外要求 `X-KY-Executor-Task-Id: <runId>`，Matrix 必须校验该 run 冻结了同一 snapshot。

页面截图默认不进入该持久资源。确需视觉输入时只能使用独立的、进程内、短期、单次消费流，任何重启或超时都丢弃并回到无截图生成；截图不是 generation run 成功和恢复的必要条件。

## 6. API 契约

账号档案 API 前缀固定为：

```text
/api/v1/matrix-accounts
```

接口：

```text
GET    /api/v1/matrix-accounts
GET    /api/v1/matrix-accounts/{id}
PATCH  /api/v1/matrix-accounts/{id}
DELETE /api/v1/matrix-accounts/{id}
PATCH  /api/v1/matrix-accounts/{id}/status

POST   /api/v1/matrix-accounts/{id}/login-tasks
GET    /api/v1/matrix-accounts/{id}/login-tasks/{taskId}
POST   /api/v1/matrix-accounts/{id}/sessions/mark-online
POST   /api/v1/matrix-accounts/{id}/sessions/mark-expired
POST   /api/v1/matrix-accounts/{id}/sessions/clear
POST   /api/v1/matrix-accounts:batch-check
POST   /api/v1/matrix-accounts:batch-disable
```

`POST /api/v1/matrix-accounts` 不作为前端手动新增入口。账号档案必须由 Web 空间识别结果创建或绑定。

Web 空间接口：

```text
POST /api/v1/matrix-account-web-spaces
GET  /api/v1/matrix-account-web-spaces/{id}
POST /api/v1/matrix-account-web-spaces/{id}/detect-result
POST /api/v1/matrix-account-web-spaces/{id}/login-script/resolve
POST /api/v1/matrix-account-web-spaces/{id}/login-script/run-result
GET  /api/v1/matrix-account-web-spaces/{id}/login-script/runs
POST /api/v1/matrix-account-web-spaces/{id}/login-script/generation-runs
POST /api/v1/matrix-account-login-scripts/{scriptId}/generation-runs
GET  /api/v1/matrix-account-login-script-generation-runs/{runId}
GET  /api/v1/matrix-account-login-script-generation-runs/{runId}/events
GET  /api/v1/matrix-account-login-script-generation-runs/{runId}/events-stream
GET  /api/v1/matrix-account-login-script-generation-runs/{runId}/terminal-frames
GET  /api/v1/matrix-account-login-script-generation-runs/{runId}/terminal-stream
POST /api/v1/matrix-account-login-script-generation-runs/{runId}/cancel
POST /api/v1/matrix-account-web-spaces/{id}/abandon
POST /api/v1/matrix-account-web-spaces/{id}/clear
```

上述 WebSpace 与 script `generation-runs` 分别是自动修复和手动再生成的 `codex_executor` canonical 入口，均返回 202 `{runId,status,dispatchStatus}`。旧 `POST /api/v1/matrix-account-web-spaces/{id}/login-script/generate` 仅在一个兼容周期服务 `legacy_provider` 同步生成；旧 `POST /api/v1/matrix-account-login-scripts/{id}/regenerate` 在同周期代理 script generation-runs；随后两者固定返回 410。

WebSpace 创建 body 固定为 `{scriptPurpose,operation,generationReason,expectedWebSpaceRevision,contextSnapshotId?}`，operation 只允许 `generate|repair`；script 创建 body 固定为 `{operation,generationReason,expectedScriptRevision,contextSnapshotId?}`，scriptPurpose 从资源派生，operation 同样只允许 `generate|repair`。Cancel body 固定为 `{expectedRevision}`。WebSpace create、script create、cancel 三个 generation Command 均要求 Idempotency-Key；contract test 按下方独立入口；详细 dispatch/cancel 收敛、权限和 SSE/ANSI 协议以执行器授权需求 §20.6–§20.9 为准。

登录脚本管理接口：

```text
GET    /api/v1/matrix-account-login-scripts
GET    /api/v1/matrix-account-login-scripts/{id}
PATCH  /api/v1/matrix-account-login-scripts/{id}
PATCH  /api/v1/matrix-account-login-scripts/{id}/status
POST   /api/v1/matrix-account-login-scripts/{id}/regenerate
POST   /api/v1/matrix-account-login-scripts/{id}/versions/{versionId}/activate
GET    /api/v1/matrix-account-login-scripts/{id}/runs
GET    /api/v1/matrix-account-login-script-policies
PATCH  /api/v1/matrix-account-login-script-policies/{id}
```

登录脚本契约接口：

```text
GET    /api/v1/matrix-account-login-script-contracts
GET    /api/v1/matrix-account-login-script-contracts/{id}
PATCH  /api/v1/matrix-account-login-script-contracts/{id}
POST   /api/v1/matrix-account-login-script-contracts/{id}/tests
GET    /api/v1/matrix-account-login-script-contracts/{id}/test-runs
```

`POST /contracts/{id}/tests` 是 `contract_test` 的唯一 canonical 创建入口，body 固定为 `{candidateVersionId,expectedScriptRevision,expectedContractRevision,contextSnapshotId?}` 并要求 Idempotency-Key；script generation-runs 不接受 contract_test。成功只更新该 candidate/version + contract revision 的测试记录，不生成候选版本。

AI 执行代理运行接口（v8 兼容投影）：

```text
GET  /api/v1/ai-executor-runs/{runId}
GET  /api/v1/ai-executor-runs/{runId}/events?after=0
GET  /api/v1/ai-executor-runs/{runId}/events-stream?after=0
GET  /api/v1/ai-executor-runs/{runId}/terminal-frames?afterFrame=0
GET  /api/v1/ai-executor-runs/{runId}/terminal-stream?afterFrame=0
POST /api/v1/ai-executor-runs/{runId}/cancel
```

这些 GET/stream/cancel 在一个发布周期内代理同 ID 的 `/api/v1/ai-executor-tasks/{runId}` 安全投影，之后以 task API 为准。v9 禁止公共 `POST /ai-executor-runs` 直接创建 Codex 任务；旧 create、terminal-resize 和 interrupt 返回 410。业务取消必须调用 generation-run cancel，由 Matrix service 再通过内部 API 取消同 ID task。

终端帧响应字段：

```json
{
  "runId": "run_xxx",
  "frameSeq": 128,
  "encoding": "base64",
  "payload": "base64_encoded_ansi_frame",
  "byteLength": 4096,
  "createdAt": "2026-07-09T00:00:00Z"
}
```

结构化事件响应字段：

```json
{
  "runId": "run_xxx",
  "sequence": 42,
  "eventType": "codex.item.completed",
  "level": "info",
  "message": "Codex 已完成脚本契约测试",
  "payload": {},
  "codexItemId": "item_xxx",
  "createdAt": "2026-07-09T00:00:00Z"
}
```

脚本生成接口不得返回模型 API Key、原始 prompt 全量、Cookie、Storage、Token、密码、验证码、截图原图或第三方平台敏感凭据。

所有接口必须携带：

```text
Authorization: Bearer <token>
X-KY-Workspace-Id: <workspaceId>
X-KY-Workspace-Type: <platform|agency|enterprise>
X-KY-Request-Id: <uuid>
```

## 7. Electron 通信契约

新增 IPC domain：

```text
matrix-account
```

物理 channel：

```text
matrix-account:get-capabilities
matrix-account:start-login
matrix-account:open-account
matrix-account:check-session
matrix-account:clear-profile
matrix-account:login-state-changed
matrix-account:create-web-space-login
matrix-account:open-web-space
matrix-account:detect-web-space-account
matrix-account:clear-web-space
matrix-account:web-space-state-changed
matrix-account:capture-web-space-snapshot
matrix-account:run-web-space-login-script
```

Preload 只暴露白名单能力：

```ts
window.aicrm.matrixAccount.getCapabilities()
window.aicrm.matrixAccount.startLogin()
window.aicrm.matrixAccount.openAccount()
window.aicrm.matrixAccount.checkSession()
window.aicrm.matrixAccount.clearProfile()
window.aicrm.matrixAccount.onLoginStateChanged()
window.aicrm.matrixAccount.createWebSpaceLogin()
window.aicrm.matrixAccount.openWebSpace()
window.aicrm.matrixAccount.detectWebSpaceAccount()
window.aicrm.matrixAccount.clearWebSpace()
window.aicrm.matrixAccount.onWebSpaceStateChanged()
window.aicrm.matrixAccount.captureWebSpaceSnapshot()
window.aicrm.matrixAccount.runWebSpaceLoginScript()
```

Web 空间登录 IPC 入参：

```ts
interface MatrixAccountWebSpaceInput {
  webSpaceId: string;
  workspaceId: string;
  workspaceType: "platform" | "agency" | "enterprise";
  platform: "douyin" | "kuaishou" | "xiaohongshu";
  browserPartition?: string;
  url?: string;
  showWindow?: boolean; // 默认 false；仅用户主动兜底打开窗口时传 true
}
```

Web 空间登录 IPC 出参：

```ts
interface MatrixAccountWebSpaceBrowserResult {
  webSpaceId: string;
  platform: "douyin" | "kuaishou" | "xiaohongshu";
  browserPartition: string;
  loginStatus: "login_pending" | "unknown" | string;
  opened: boolean;
  visible: boolean;
  qrCodeDataUrl?: string; // 客户端从受控 Web 空间提取出的二维码快照
  qrCodeReason?: string; // 无法提取二维码时的用户可读原因
}
```

Web 空间快照 IPC 出参：

```ts
interface MatrixAccountWebSpaceSnapshotResult {
  webSpaceId: string;
  platform: "douyin" | "kuaishou" | "xiaohongshu";
  browserPartition: string;
  url: string;
  title: string;
  pageFingerprint: string;
  domSummary: unknown;
  accessibilityTree: unknown;
  visibleText: string;
  elementRects: Array<{
    key: string;
    keySource: "platform_semantic" | "a11y_role_name" | "stable_id_name" |
      "scoped_text" | "structural_selector" | "coordinate";
    stability: "high" | "medium" | "low";
    text?: string;
    selector?: string;
    rect: { x: number; y: number; width: number; height: number };
  }>;
  screenshotDataUrl?: string;
}
```

Web 空间脚本执行 IPC 入参：

```ts
interface MatrixAccountWebSpaceScriptInput extends MatrixAccountWebSpaceInput {
  scriptVersionId: string;
  purpose: "qr_login_prepare" | "qr_login_refresh" | "account_detect" | "session_check";
  dsl: MatrixAccountLoginScriptDsl;
}
```

Web 空间脚本执行 IPC 出参：

```ts
interface MatrixAccountWebSpaceScriptResult {
  webSpaceId: string;
  platform: "douyin" | "kuaishou" | "xiaohongshu";
  browserPartition: string;
  scriptVersionId: string;
  status: "success" | "failed" | "timeout" | "cancelled";
  qrCodeDataUrl?: string;
  accountCandidate?: {
    identityKey?: string;
    platformUid?: string;
    displayName?: string;
    nickname?: string;
    avatarUrl?: string;
    homeUrl?: string;
  };
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
}
```

脚本 DSL 只允许执行白名单动作：

```text
clickElementKey
waitForElementKey
captureElementKey
readElementKey
clickText
clickSelector
wait
waitForElement
captureElement
readText
navigateAllowedUrl
```

禁止 DSL 读取 Cookie、localStorage、sessionStorage、IndexedDB、Token、密码框内容、验证码输入值或二次验证密钥。

Web 业务插件不得直接调用 `window.aicrm`，必须经由 `apps/ky-admin-host/src/desktop-client.ts` 中的 adapter。

### 7.1 AI 执行代理通信契约

v9 执行代理链路（替代 v8 `codex --remote`/PTY/WebSocket 传输）：

```text
App
├─ xterm.js 终端投影
│  └─ SSE ANSI projection <- task raw-log <- 脱敏事件渲染器
└─ 结构化日志
   └─ SSE events <- AiCRM 执行代理 <- Codex app-server stdio JSON-RPC
```

执行代理职责：

- 只在隔离 Runtime 内通过 stdio 启动、停止和健康检查 Codex app-server。
- 作为 Codex app-server JSON-RPC broker，归一 `threadId`、`turnId`、`itemId` 到 AiCRM `runId`。
- 记录结构化事件，并从同一脱敏事件生成只读 ANSI projection；不启动 remote TUI/PTY，不形成第二控制通道。
- 支持断线后按 `sequence` 和 `frameSeq` 补齐。
- 支持 task cancel、超时回收和资源释放。
- 将脚本契约、失败上下文、脱敏页面快照和浏览器调试能力作为 Codex 修复上下文。

前端终端投影要求：

- 使用 xterm.js 渲染终端，不用 `<pre>` 模拟 ANSI。
- 默认只读投影，不把键盘输入回传 PTY。
- 支持 FitAddon 自适应容器。
- 支持 WebLinksAddon 识别链接。
- 支持自动跟随、清屏、复制、重连。
- 底部固定状态栏展示执行中、已完成、失败、取消、超时和耗时。
- FitAddon 只在前端调整只读投影尺寸，不向后端或 Codex 发送 terminal resize。

生产安全：

- Web 前端不得直连 Codex app-server。
- 授权期和任务期都不得在 host、本机 loopback 或受控内网暴露 Codex WebSocket；App Server 只允许 stdio 父子进程通道。
- 终端帧和结构化事件不得自动带出敏感调试上下文。
- 执行代理应按 workspace、actor、runId 写审计。
- 验收必须证明同机其他 UID、同 UID 非父进程和相邻 Runtime 均无法连接或调用该 App Server。

### 7.2 稳定元素 Key 合同

抖音及其他平台的 AI 脚本维护必须优先使用 Electron 快照生成的 `elementKey`，不得默认生成脆弱 CSS/XPath 或坐标动作。Key 解析优先级锁定为：

```text
1. 平台适配器 allowlist 的语义属性（如稳定 data-* 标识）
2. role + accessible name + 稳定 landmark
3. 通过随机性过滤的稳定 id/name
4. 稳定容器 key + 规范化可见文本
5. 结构选择器
6. 坐标（仅当次候选验证，禁止直接激活）
```

- `key` 是上述证据规范化后的确定性摘要，不等同于 selector；运行时按 keySource 和证据重新解析元素。
- `id/name` 含时间戳、会话片段、长哈希、递增随机数或页面刷新后变化时必须降级，不能标 high。
- AI prompt、候选 DSL 和自动修复结果都必须先尝试 `*ElementKey` 动作；使用 selector/text/coordinate 时记录 fallback reason 和稳定性等级。
- 二维码获取、二维码刷新、登录状态检测和账号身份读取等关键方法，候选版本若仅依赖 low-stability selector/coordinate，不得自动提升 active；需稳定 key 或人工批准的有期限平台例外。
- 契约测试至少覆盖刷新后 key 复现、同级节点插入、文案轻微变化、多元素歧义和不可见元素，且不得为密码、验证码、Token 字段生成可读取 key。

## 8. 列表页规范

三个平台页面共用同一套列表组件，通过平台参数区分：

- 标题放在列表卡片外，使用 H3。
- 状态筛选使用胶囊滑块。
- 查询控件放入 `ListPageCard.toolbar`。
- 支持多选时，副标题替换为 `已选择 N 项` 和 `清空选择`。
- 批量按钮位于新增按钮左侧。
- 操作列固定在右侧。
- 非客户端环境下禁用“开始登录 / 打开 Web / 检测登录态 / 清除 Profile”，并提示需要 AiCRM Desktop。
- `新增账号` 位于标题右侧；点击后先打开侧滑窗口，再初始化 Web 空间并等待扫码二维码。
- 侧滑窗口不展示“放弃本次新增 / 清理登录空间 / 已登录开始识别”等冗余按钮。
- 侧滑只保留“刷新二维码”和“打开窗口”兜底操作；扫码成功后自动识别、自动绑定并关闭侧滑。
- “刷新二维码”只针对当前 Web 空间执行 `qr_login_refresh`，刷新失败时保留旧二维码。
- 侧滑应展示当前阶段、AI 介入原因和当前动作，但不得展示内部技术细节。
- 侧滑执行脚本时展示安全脚本版本信息：用途、版本号、版本状态、来源和用户可理解原因。
- 侧滑提供“查看执行日志”入口，可查看当前流程实时日志和脱敏后的后端运行记录。
- 扫码成功后必须自动进入 `account_detect` 阶段，识别成功后自动绑定并关闭侧滑。
- 主动关闭未完成的新增侧滑时，前端必须自动调用客户端清理能力和后端 Web 空间清理接口。
- 编辑弹窗仅维护显示名称、归属、备注、状态等业务档案字段；平台 UID、昵称、头像、主页来自识别结果。

## 9. 第一阶段验收

- 工作台菜单由插件贡献，Host 不硬编码矩阵账号业务菜单。
- 工作台左侧显示“矩阵账号”一级菜单。
- 二级菜单显示“抖音账号 / 快手账号 / 小红书账号”。
- 三个平台列表页面可进入。
- Web 插件不直接访问 `window.aicrm`。
- Electron 桥接能力有类型、channel 和 adapter 占位。
- 非客户端 Web 可降级。
- 数据库迁移包含表结构和权限种子。
- 新增账号不再使用表单创建矩阵账号。
- Web 空间创建、打开、识别、绑定、放弃、清理流程契约完整。
- 识别结果不包含 Cookie、Storage、验证码、Token 等敏感信息。
- 新增账号二维码获取默认走平台登录脚本，不再依赖客户端内置平台专用提取规则。
- 无脚本或脚本连续失败达到阈值时，`codex_executor` 链路只调用已解析的 Codex 执行器与模型生成候选版本；仅迁移期 `legacy_provider` 链路可继续使用指定 API 模型或默认多模态模型。
- AI 生成脚本必须记录脚本版本、本次 token 消耗和脚本累计 token 消耗。
- 候选脚本执行成功后才提升为 active 版本。
- 页面截图仅作为当次多模态上下文，不落库、不进入审计明文、不写入客户端日志。
- 登录脚本 DSL 不允许读取 Cookie、Storage、Token、密码、验证码或二次验证密钥。
- 普通新增账号侧滑不展示脚本失败明细、AI 调度明细、token 消耗或内部版本更新细节；执行脚本时只展示安全脚本版本摘要。
- 登录脚本用途包含 `qr_login_refresh`，二维码展示后可刷新二维码。
- AI 介入时必须展示可理解原因；脚本命中时不得提示正在消耗 AI。
- 单次新增或刷新流程中的自动 AI 重建最多执行一次，失败后进入用户兜底状态。
- 扫码登录完成后自动进入 `account_detect` 脚本链路，不要求用户手动点击识别。
- `account_detect` 缺失或失败时可自动生成候选脚本，成功后才提升为 active。
- 执行脚本时必须展示安全版本信息，用户能判断当前脚本是否发生更新。
- 用户可查看当前流程和历史运行的脱敏执行日志。
- AI 自动化结构化日志可通过执行代理事件流查看，并支持断线后补事件。
- AI 自动化终端输出使用 xterm.js 渲染由同一结构化事件生成的只读 ANSI 投影，并支持断线后补帧；不启动 remote TUI/PTY。
- 同一次 Codex 介入必须使用同一 `runId` 关联结构化事件、终端帧、脚本版本，以及存在时的 WebSpace。
- v9 只使用 executor task/event/raw-log 三张既有物理表；run/terminal API 仅为兼容投影，不新建第二套执行表。
- AI 生成和修复脚本优先使用稳定 elementKey；关键方法仅依赖 low-stability selector/coordinate 时不得自动激活。
- 扫码登录页脚本契约必须包含获取二维码、刷新二维码、验证二维码可识别、检测登录阶段。
- 账号识别脚本契约必须包含检测扫码完成、获取稳定账号身份、获取账号展示资料。
- Codex 修复后必须通过契约测试才允许激活候选脚本版本。
- TypeScript typecheck 通过。
- admin host build 通过。
