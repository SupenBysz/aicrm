# AiCRM 矩阵账号模块需求与契约

> 文档状态：已锁定 / 矩阵账号 v8 输入基线  
> 锁定日期：2026-07-09  
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
- 在客户端运行时启动或协助启动 Codex app-server、Codex TUI PTY 与执行代理进程，但不得把 Codex 原始协议直接暴露给业务插件。
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
- 脚本指定模型、平台/场景模型和默认模型解析。
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
  model_id
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

脚本模型选择优先级：

```text
本次请求指定模型
脚本 model_id
平台/场景策略 model_id
系统默认多模态模型
系统默认对话模型
```

### 5.6 平台登录脚本版本

```text
ky_matrix_account_login_script_version
  id
  script_id
  version
  model_id
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

用户侧可查看的脚本运行日志字段必须经过脱敏，建议限定为：

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
  model_id
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
verifyQrCodeReadable -> qr_code_verify
detectLoginPhase     -> login_phase_detect
getAccountIdentity   -> account_detect
getAccountProfile    -> account_detect
```

新增 `qr_code_verify`、`login_phase_detect` 可先作为契约方法存在，落库执行仍可复用现有脚本版本结构；实现阶段再决定是否扩展 `purpose` 约束。

### 5.10 AI 执行代理运行记录

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
POST /api/v1/matrix-account-web-spaces/{id}/login-script/generate
POST /api/v1/matrix-account-web-spaces/{id}/login-script/run-result
GET  /api/v1/matrix-account-web-spaces/{id}/login-script/runs
POST /api/v1/matrix-account-web-spaces/{id}/abandon
POST /api/v1/matrix-account-web-spaces/{id}/clear
```

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

AI 执行代理运行接口：

```text
POST /api/v1/ai-executor-runs
GET  /api/v1/ai-executor-runs/{runId}
GET  /api/v1/ai-executor-runs/{runId}/events?after=0
GET  /api/v1/ai-executor-runs/{runId}/events-stream?after=0
GET  /api/v1/ai-executor-runs/{runId}/terminal-frames?afterFrame=0
GET  /api/v1/ai-executor-runs/{runId}/terminal-stream?afterFrame=0
POST /api/v1/ai-executor-runs/{runId}/terminal-resize
POST /api/v1/ai-executor-runs/{runId}/interrupt
POST /api/v1/ai-executor-runs/{runId}/cancel
```

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
  elementRects: Array<{ key: string; text?: string; selector?: string; rect: { x: number; y: number; width: number; height: number } }>;
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

执行代理链路：

```text
App
├─ xterm.js 终端投影
│  └─ WebSocket/SSE terminal frames <- ANSI frames <- PTY <- codex --remote
└─ 结构化日志
   └─ WebSocket/SSE events <- AiCRM 执行代理 <- Codex app-server JSON-RPC
```

执行代理职责：

- 启动、停止和健康检查 Codex app-server。
- 启动、停止和 resize `codex --remote` TUI PTY。
- 作为 Codex app-server JSON-RPC broker，归一 `threadId`、`turnId`、`itemId` 到 AiCRM `runId`。
- 记录结构化事件和 ANSI terminal frames。
- 支持断线后按 `sequence` 和 `frameSeq` 补齐。
- 支持 `interrupt`、`cancel`、超时回收和资源释放。
- 将脚本契约、失败上下文、脱敏页面快照和浏览器调试能力作为 Codex 修复上下文。

前端终端投影要求：

- 使用 xterm.js 渲染终端，不用 `<pre>` 模拟 ANSI。
- 默认只读投影，不把键盘输入回传 PTY。
- 支持 FitAddon 自适应容器。
- 支持 WebLinksAddon 识别链接。
- 支持自动跟随、清屏、复制、重连。
- 底部固定状态栏展示执行中、已完成、失败、取消、超时和耗时。
- resize 时调用 `POST /api/v1/ai-executor-runs/{runId}/terminal-resize` 上报 `cols`、`rows`。

生产安全：

- Web 前端不得直连 Codex app-server。
- 非本机或非受控内网不得暴露未鉴权的 Codex WebSocket。
- 终端帧和结构化事件不得自动带出敏感调试上下文。
- 执行代理应按 workspace、actor、runId 写审计。

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
- 无脚本或脚本连续失败达到阈值时，可调用指定模型或默认多模态模型生成候选脚本版本。
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
- AI 自动化终端输出使用 xterm.js 渲染执行代理终端帧，并支持断线后补帧。
- 同一次 Codex 介入必须使用同一 `runId` 关联结构化事件、终端帧、脚本版本和 WebSpace。
- 扫码登录页脚本契约必须包含获取二维码、刷新二维码、验证二维码可识别、检测登录阶段。
- 账号识别脚本契约必须包含检测扫码完成、获取稳定账号身份、获取账号展示资料。
- Codex 修复后必须通过契约测试才允许激活候选脚本版本。
- TypeScript typecheck 通过。
- admin host build 通过。
