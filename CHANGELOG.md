# AiCRM 更新日志

## [Unreleased] - 顶部明暗快捷切换（2026-10-29）

- 恢复公告与全屏按钮之间的亮色/暗色切换，保留当前配色并自动保存为个人偏好；跟随系统仍在个人偏好中设置。
- 已单独部署Web，验证及回滚见 `docs/deployment/2026-10-29-header-theme-toggle-release.md`。

## [Unreleased] - 多配色外观主题（2026-10-29）

- 增加经典金、商务蓝、翡翠绿及配套亮暗模式，支持跟随系统和个人偏好保存。
- 用户下拉新增“个人偏好”侧滑，支持跟随平台默认及个人主题自动保存；移除顶部独立主题按钮。
- 系统配置“外观主题”页签仅维护平台默认，按专用查看权限过滤，并修正无权或旧页签链接。
- 个人偏好增加同步状态、冲突重读确认和不确定保存结果重试核对；侧滑避让顶部主栏及底部状态栏。
- 桌面窗口按钮预留顶部栏底部分隔线，取消集成按钮区的背景模糊，修复暗色下横线断开；Web 宿主兼容现有客户端。
- 新增本人偏好与平台默认 API、迁移 106、独立权限、版本冲突保护和平台变更记录。
- 统一宿主、公共组件、品牌预览、脚本编辑器及桌面窗口背景的主题消费；修复重复 Ant Design 实例导致的暗色控件不一致。
- 已部署到 console.kysion.com，发布版本、备份迁移及验收边界见 `docs/deployment/2026-10-29-appearance-preferences-release.md`。

## [Unreleased] - 外部贡献集成（2026-10-29）

### 系统配置与组织统计

- 平台版权风格、字段存在性与条件更新，冲突保留输入；保存期间禁止继续编辑，旧写入口仍保留兼容语义。
- 机构/企业动态统计及有效用户心跳；修复多角色同时具有 all 与受限范围时被误拒绝，终端明确显示未接入。

### 机构品牌

- 按贡献来源原项目补齐素材卡片、即时生成预览、图片更换/删除、版权预览及独立回滚；动态统计恢复文字摘要与打开时刷新详情，保留目标权限和素材鉴权。

- 机构品牌草稿、PNG 素材、发布/回滚、逐字段平台继承与工作区展示；修复隐藏素材字段预览、抽屉过期请求与历史版本残留。
- 机构品牌更新与平台继承变更触发当前工作区刷新；保留平台短 LOGO 设置，应用名称用于页面标题。
- 品牌和域名抽屉固定 Header，避让宿主 Header 与客户端状态栏；仅正文滚动。

### 域名及部署接线

- 复用 CF 托管域名生命周期、持久任务、网关、六服务入口与会话隔离代码；K3s 默认显式关闭全部接入开关。
- 补齐 Auth 入口解析与 Org 已发布素材代理，内部路由仍不公开；增加 Worker/Gateway 独立镜像构建定义，不加入默认部署集合。
- 迁移 100/102/103 归 Org，101/104 归 Auth；新权限仅注册，角色授权另行管理。回退保留扩展数据，已有入口不得通过关闭门禁回滚。

### 验证边界

- 已完成相关 Go 测试、权限负向/并集回归、专项 race 检查、强制类型检查、Host 构建、独立数据库和升级/重跑测试、本地 API 及部分浏览器路径。
- 尚未发布本批版本；真实 CF/DNS/TLS、K3s 入口适配、完整 Linux Executor 与独立评审仍未完成。最终布局、工作区切换等视觉验收详见 `docs/contributions-integration/实施与验证记录.md`。

## [Unreleased] - 2026-10-29 CST +0800

### 更新内容

- 增加准生产测试环境的容器构建与部署资产，普通服务支持 SIGTERM 和限时优雅退出。
- 构建采用 Gitea 固定提交与 GitHub 集中构建，保留 Codex 协议校验门禁。

### 部署 / 迁移说明

- 首期 Web 与五个普通服务；Executor 延后。使用新空数据库，迁移由独立 Job 执行。
- 首次验收之前不启用自动发布；数据库不能随应用镜像自动降级。

### 验证方式

- Go 服务测试、容器构建、Kubernetes 校验及实际验收结果见准生产部署记录。

## [Unreleased] - 脚本管理主补丁

- 复用参考项目脚本管理：Monaco编辑器、JS/CSS独立版本、公共资源、权限、API与服务端运行时解析。
- 新增086—094、096、099数据库迁移及Host/代理接线；桌面运行时参考补丁未应用，数据库和服务部署未执行。

本文件记录 AiCRM 主平台与衍生模板资产的版本变更。格式遵循“按版本维护，每个版本包含更新时间、更新内容、部署/迁移说明和验证方式”的规范。

## [Unreleased] - 2026-10-13 10:13:33 CST +0800

### 更新内容

- 直接应用 kwwcrm 同基线系统配置增量补丁：URL Tab 状态、分组表单与字典、MFA 布尔配置、品牌 Logo 字体、local/MinIO/OSS 存储配置及测试/激活、主题上下文消息；不重复实现既有模块。
- 保留既有菜单、权限、加密、通知/短信/邮件/App 版本后端能力；图片消费者参考增量保持独立，尚未应用。
- 复用历史迁移052的限定兼容修正，仅对匹配固定SHA-256的原文件剥离外层事务，保持迁移文件与账本校验和不变；其他含事务的增量迁移仍拒绝。

### 部署 / 迁移说明

- 新增078—081迁移及配置接口Nginx代理；部署顺序为数据库增量迁移、组织服务、Host。081可能将未通过当前指纹测试的云存储切到local，发布前核对实际存储。
- 当前工作空间源码已应用，构建产物已生成；尚未执行运行环境发布或数据库迁移，当前项目无配置的数据库连接、运行密钥和独立部署目标。

### 验证方式

- Core build、系统配置插件typecheck/build、Host typecheck/build、组织服务server/store与shared/crypto测试、组织服务编译均通过。
- 数据库部署脚本语法及测试通过，包含052固定checksum接受/漂移拒绝及新增迁移账本渲染；git diff --check通过。
- 真实UI、数据库执行、云存储读写、短信/邮件实际收件与服务上线尚未验收。

## [0.1.6] - 2026-07-12

### 更新内容

- 锁定脚本候选、契约测试与激活的 P0 策略：`generate/repair` 只能生成 candidate，`contract_test` 只能生成测试结果；低稳定选择器、坐标、敏感定位、旧修订和缺失/失败测试均不得激活。
- 自动脚本修复预算固定为单次 Attempt 最多一次；脚本关键方法必须使用稳定 `elementKey` 和锁定的 `keySource` 枚举。
- 永久停用 `ky-ai-model-service` 中旧 TUI/PTY/WebSocket executor worker；旧 task/run 创建、terminal resize 和 interrupt 写入口统一返回 `410 legacy_endpoint_gone`。
- 移除 Desktop Vault 生成并经 Renderer 传递的本机 HMAC verification receipt；Renderer、Plugin 和普通 Bearer 不得确认 snapshot seal、cleanup 或 onboarding complete 成功。
- Matrix 公共步骤结果与 Store 双层拒绝可信运行时专属成功结果；生产 capability 继续保持 session detection 和 server-verifiable receipt 关闭。
- 加固 `ky-ai-model-service` systemd 单元，增加严格 umask、no-new-privileges、私有临时目录和只读系统/用户目录保护。

### 部署 / 迁移说明

- 新增 `035_executor_legacy_output_cleanup.sql`，一次性收敛旧非终态 executor task、清理原始 TUI/Codex 输出和路径字段，并将旧授权状态与危险执行开关恢复为 fail-closed。
- 迁移 035 不新增或删除表结构；执行后仍不开放可信授权、generation run、contract test、candidate 激活或 v9 onboarding 生产门禁。
- 部署前先停止旧 `ky-ai-model-service` 并确认其 Codex/TUI 子进程全部退出，再安装 no-worker 新 binary/unit；随后执行迁移 035、启动新服务并部署后台静态资源。禁止在旧 worker 仍运行时先清库，避免迁移后迟到输出重新写入。
- 新服务启动并通过 readyz 后，复扫数据库、日志和 API 响应中的敏感 canary；任一残留都阻止继续进入 P1。

### 验证方式

- 执行全部 Go 服务 `go test ./...`，并对 Matrix 与 AI Model 服务执行 `go test -race ./...`、`go vet ./...`。
- 执行 `pnpm typecheck`、`pnpm build`、Vault/legacy-flow/trust-boundary 定向测试。
- 执行 `pnpm test:database-deploy`，并在生产等价 PostgreSQL 副本验证迁移首次执行、重复执行和回滚。
- 执行 `systemd-analyze verify ops/native/ky-ai-model-service.service`、solution skill 校验和 `git diff --check`。

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
