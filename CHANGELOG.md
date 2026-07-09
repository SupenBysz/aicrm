# AiCRM 更新日志

本文件记录 AiCRM 主平台与衍生模板资产的版本变更。格式遵循“按版本维护，每个版本包含更新时间、更新内容、部署/迁移说明和验证方式”的规范。

## [0.1.5] - 2026-07-09 15:49:11 CST +0800

### 更新内容

- AI 执行器 server runtime 从 `codex exec --json` 日志模式推进为 `codex app-server + codex --remote` TUI PTY 模式。
- 服务端启动本地 Codex app-server WebSocket 监听，等待 `/readyz` 后再启动 Codex TUI。
- 使用 PTY 捕获 Codex TUI 原始 ANSI 终端帧，并通过既有 `terminal.frame` 投影给前端 xterm.js。
- 终端帧写入保持原始 payload，不再按日志行自动追加换行，减少与 Codex 原生终端显示的差异。
- `terminal-resize` 支持同步调整运行中的 Codex TUI PTY cols/rows。

### 部署 / 迁移说明

- 本版本不新增数据库迁移，继续复用现有 AI 执行器 raw log 表承载终端帧。
- 需要重新构建并部署 `ky-ai-model-service` 后，server runtime 执行器终端投影才会显示真实 Codex TUI 画面。

### 验证方式

- 执行 `go test ./services/ky-ai-model-service/...`。
- 执行 `pnpm --filter @ky/plugin-matrix-account typecheck`。
- 执行 `git diff --check`。
- 验证 `codex app-server --listen ws://127.0.0.1:<port>` 的 `/readyz` 可返回成功。

## [0.1.4] - 2026-07-09 15:25:44 CST +0800

### 更新内容

- AI 执行器服务增加 `ai-executor-runs` v8 兼容接口，提供 run 查询、事件流、终端帧补偿流、终端实时流、resize、interrupt 和 cancel 能力。
- 将现有 `ai_executor_task`、事件表、raw log 表兼容映射为 `runId`、结构化事件和 `terminal.frame`，为后续 Codex 执行代理双流架构预留稳定前端契约。
- 执行器取消能力补充支持 `waiting_executor` 状态，避免客户端执行器等待接管时无法取消。
- 矩阵账号新增账号侧滑中的“执行器仿真终端”改为 xterm.js 渲染，并接入 `terminal-frames` 补偿接口和 `terminal-stream?afterFrame=` 实时投影接口。
- 结构化日志切换到 `ai-executor-runs/{runId}/events` 与 `events-stream`，与终端投影统一使用 run 语义。

### 部署 / 迁移说明

- 本版本不新增数据库迁移，暂时复用现有 AI 执行器 task/event/raw log 表作为 v8 兼容层。
- 需要重新构建并部署 `ky-ai-model-service` 与后台前端资源后生效。

### 验证方式

- 执行 `go test ./services/ky-ai-model-service/...`。
- 执行 `pnpm --filter @ky/plugin-matrix-account typecheck`。
- 执行 `pnpm --filter @ky/plugin-matrix-account build`。
- 执行 `pnpm --filter @ky/admin-host build`。
- 执行 `git diff --check`。

## [0.1.3] - 2026-07-09 15:14:31 CST +0800

### 更新内容

- 锁定矩阵账号模块 v8 输入基线：AI 自动化升级为执行代理双流架构。
- 明确结构化日志来自 Codex app-server JSON-RPC，经 AiCRM 执行代理归一为 `runId` 事件流。
- 明确终端投影来自 `codex --remote` TUI PTY ANSI 帧，前端使用 xterm.js 渲染。
- 增加脚本契约化维护要求，扫码登录页脚本必须支持获取二维码、刷新二维码、验证二维码可识别和检测登录阶段。
- 增加账号识别脚本契约要求，未扫码成功或无稳定账号身份时不得创建空账号。
- 增加 v8 迭代任务拆分，覆盖执行代理、终端帧、结构化事件、xterm 前端、脚本契约、契约测试和回归验收。

### 部署 / 迁移说明

- 本版本仅更新需求与执行计划文档。
- 本版本不包含数据库迁移。
- 本版本不要求生产服务部署。

### 验证方式

- 执行 `git diff --check`。
- 执行 `python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/aicrm-solution`。

## [0.1.2] - 2026-07-08 19:15:23 CST +0800

### 更新内容

- 完成用户管理创建用户闭环：支持创建登录账号、绑定角色、选择部门/团队归属、调整角色、调整归属、重置密码、启停/移除与批量操作。
- 用户管理状态筛选统一为胶囊滑块，当前登录身份禁止被禁用或移除。
- `ky-auth-service` 增加用户资料更新与密码重置审计，避免敏感明文进入审计详情。
- 明确 AiCRM 主仓库为业务专用解决方案仓库，衍生模板资产不再固定上游模板仓库地址。
- 模板初始化脚本默认不设置 Git remote，生成新项目时必须通过 `--git-remote` 显式传入目标业务仓库。

### 部署 / 迁移说明

- 本版本不包含数据库迁移。
- 已部署 `ky-auth-service`、`ky-membership-service` 和后台前端。
- 本地与公网健康检查通过，`Super.Admin` 登录与 bootstrap 冒烟通过。

### 验证方式

- 执行 `pnpm --filter @ky/plugin-identity-management typecheck`。
- 执行 `pnpm --filter @ky/plugin-identity-management build`。
- 执行 `pnpm --filter @ky/admin-host typecheck`。
- 执行 `pnpm --filter @ky/admin-host build`。
- 执行 `go test ./services/ky-auth-service/... ./services/ky-membership-service/...`。
- 执行 `git diff --check`。
- 执行 `scripts/verify_deployment.sh`。

## [0.1.1] - 2026-07-08 11:22:27 CST +0800

### 更新内容

- 模板初始化脚本增加 `--interactive` 交互式向导。
- 模板初始化支持配置 `apps/` 下管理后台与桌面客户端的目录、NPM 包名、显示名称和说明。
- 生成项目时同步更新根脚本、应用 `package.json`、HTML 标题、部署脚本、Nginx 示例和文档中的 app 引用。
- `template/manifest.yaml` 增加 `apps` 默认配置，并标记桌面端稳定运行时契约。
- 更新模板抽取规范，明确应用目录/包名可初始化配置，`window.aicrm`、`AICRM_*`、数据库前缀和 Go module path 默认不随初始化重命名。
- 将初始化脚本的参数说明、交互提示、错误提示和生成摘要统一调整为中文。
- 新增 `template/skills/kycrm-initialize-project`，用于指导 AI 从 KyCRM 模板初始化独立项目、配置参数并完成生成验证。
- 初始化脚本增加 `--config <file.yaml>`，支持通过简单 YAML 配置文件初始化项目。
- 增加 `template/examples/*.yaml` 初始化配置示例。
- 增加 `scripts/validate_generated_project.sh`，用于验证生成项目的元数据、app 包名、skill、敏感信息和本地产物。
- 增加 `scripts/create_admin_plugin.sh`，支持创建后台插件脚手架，并可选注册到 admin host。
- 增加 `scripts/create_business_module.sh`，支持创建完整业务模块链路：后台插件、前端 API client、独立 Go 服务、数据库表结构、权限种子、服务注册和 Nginx API 反向代理。
- 新增 `template/skills/kycrm-create-module`，用于指导 AI 创建后台插件模块、菜单、路由、权限占位和验证流程。
- 为 package/plugin tsconfig 增加 `rootDir: "src"`，兼容 TypeScript 6 declaration build。
- 桌面客户端将 Vite 固定到 `^7.3.6`、`@vitejs/plugin-react` 固定到 `^5.2.0`，保持与 `electron-vite` 当前 peer 约束兼容；后台宿主继续使用 Vite 8。

### 部署 / 迁移说明

- 本版本不包含生产数据库迁移。
- 本版本不要求生产服务部署。
- 已生成的项目不需要自动迁移；该能力仅影响后续使用模板初始化的新项目。

### 验证方式

- 执行 `bash -n scripts/create_project_from_template.sh`。
- 执行 `bash -n scripts/validate_generated_project.sh`。
- 执行 `bash -n scripts/create_admin_plugin.sh`。
- 执行 `bash -n scripts/create_business_module.sh`。
- 执行 `git diff --check`。
- 执行 `python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/aicrm-solution`。
- 执行 `python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/kycrm-initialize-project`。
- 执行 `python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/kycrm-create-module`。
- 使用脚本生成带自定义 app 目录和包名的临时项目，并检查 `apps/` 目录、根脚本、app `package.json`、HTML 标题和生成元数据。
- 使用 `--config template/examples/full-custom-apps.yaml` 生成临时项目，并执行 `scripts/validate_generated_project.sh`。
- 在临时模板项目中执行 `scripts/create_admin_plugin.sh --register-host`，并验证 `@ky/admin-core` build、新插件 typecheck/build 和 `@ky/admin-host` typecheck。
- 在临时模板项目中执行 `scripts/create_business_module.sh`，并验证新服务 `go test` / `go build`、`scripts/build_services.sh`、新插件 typecheck/build 和 `@ky/admin-host` typecheck/build。

## [0.1.0] - 2026-07-08 05:14:05 CST +0800

### 更新内容

- 建立 KyaiCRM 多租户后台管理底座基线，包含 Admin Host、Admin Core、后台插件、Electron 桌面客户端、Go 后端服务、共享模块、数据库脚本、部署脚本和技术文档。
- 增加 KyCRM / `kysion-crm` / 企迅CRM 衍生模板资产配置。
- 增加 `scripts/create_project_from_template.sh`，支持从当前工程生成干净模板项目，并可选初始化 Git 远端地址。
- 增加解决方案级 skill：`template/skills/aicrm-solution/`。
- 增加模板内置工程规范 reference：模块边界、权限与数据范围、API 契约、桌面端事件通信、模板抽取规范。
- 完善桌面端事件通信规范，补充订阅与消费职责、模板化要求和安全边界。
- 将 `README.md` 和 `CONTRIBUTING.md` 调整为中文说明，覆盖模板定位、贡献规则、验证要求和安全清理要求。

### 部署 / 迁移说明

- 本版本不包含生产数据库迁移。
- 本版本不要求生产服务部署。
- 模板生成脚本会排除 `.git`、`node_modules`、`dist`、`out`、`release`、本地截图、日志、私有环境文件和 dev-work 部署记录。
- 模板生成脚本会将默认超级管理员账号和密码替换为模板占位值，避免真实可用凭据进入模板仓库。

### 验证方式

- 已执行 `git diff --check`。
- 已执行 `bash -n scripts/create_project_from_template.sh`。
- 已执行 `python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/aicrm-solution`。
- 已使用 `scripts/create_project_from_template.sh` 生成临时模板目录，并检查模板内未包含本地截图、依赖目录、构建产物、旧默认密码、真实部署域名和隧道痕迹。
- 已生成并验证衍生模板输出。
