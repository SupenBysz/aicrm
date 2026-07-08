# KyaiCRM 更新日志

本文件记录 KyaiCRM 主平台与 KyCRM 基础框架模板的版本变更。格式遵循“按版本维护，每个版本包含更新时间、更新内容、部署/迁移说明和验证方式”的规范。

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
- 增加 KyCRM / `kysion-crm` / 企迅CRM 基础框架模板配置，模板专用仓库为 `https://github.com/kysion/kysion-crm.git`。
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
- 已推送模板仓库 `https://github.com/kysion/kysion-crm.git` 的 `main` 分支。
