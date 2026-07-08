# AiCRM

AiCRM 是面向直播电商全域运营的 AI 智能 CRM 解决方案，目标是用后台管理、桌面客户端、多租户组织能力和 AI 配置能力支撑后续业务模块快速落地。

当前工程以 `https://github.com/SupenBysz/aicrm.git` 作为业务专用解决方案仓库。仓库 fork 自 KyCRM 基础框架，上游同步通过 GitHub fork 关系或本地 `upstream` remote 管理，不在工程文件中固定上游仓库地址。

## 阶段范围

当前阶段包含：

- 全局用户账号体系。
- 平台 / 机构 / 企业后台工作区。
- 部门和团队组织范围。
- 成员、邀请、角色、权限和数据范围。
- 审计日志、通知和公告。
- 系统设置、字典和品牌配置。
- AI 供应商和 AI 模型配置。
- 基于 Nginx 与 systemd 的原生 VM 部署方案。
- Electron 桌面客户端与 Web 后台混合方案。
- 用户创建、角色绑定、组织归属、密码重置和审计闭环。

当前阶段不包含：

- 客户、线索、商机、合同等 CRM 业务模块。
- AI 员工、AI 执行器、AI 工作流和 AI 协作。
- IM、移动端应用。
- Kubernetes 优先或 Docker 优先部署方案。

## 仓库结构

```text
apps/       前端应用宿主，包括后台 Host 和桌面客户端。
packages/   前端共享包和插件契约。
plugins/    后台业务插件，贡献页面、路由和菜单。
services/   Go 后端服务，按领域拆分。
shared/     Go 共享模块。
ops/        数据库、原生部署和 seed 资产。
scripts/    构建、部署、初始化和验收脚本。
docs/       需求、架构、API、权限、部署和治理文档。
template/   从本工程梳理出的衍生模板资产和解决方案级 skill。
```

## 命名约定

- 目录和服务：`ky-*`
- NPM 包：`@ky/*` 和 `@ky/plugin-*`
- 数据库表：`ky_` 前缀
- 环境变量：`KY_` 前缀
- 工作区请求头：`X-KY-Workspace-Id`、`X-KY-Workspace-Type`、`X-KY-Request-Id`
- 前端会话 key：`ky.admin.session.v1`

## 规范文档

当前阶段基线以 `docs/` 下的文档为准，重点文档包括：

- 总体架构：`docs/kyai_crm_architecture.md`
- API 契约：`docs/kyai_crm_api_contracts.md`
- 权限矩阵：`docs/kyai_crm_permission_matrix.md`
- 工作区布局：`docs/kyai_crm_workspace_layout.md`
- Git 仓库治理：`docs/kyai_crm_git_repository_governance.md`
- 桌面端事件通信规范：`docs/aicrm_desktop_event_communication_standard.md`
- 更新日志：`CHANGELOG.md`

## Fork 与上游同步

AiCRM 主仓库只绑定业务仓库：

```bash
git remote add origin https://github.com/SupenBysz/aicrm.git
```

如需同步 KyCRM 基础框架或将通用能力贡献回上游，可在本地按需添加 `upstream` remote。`upstream` 属于本地 Git 配置，不写入 README、脚本默认值或模板 manifest。

## 衍生模板资产

本仓库保留 `template/` 和初始化脚本，用于从 AiCRM 当前底座抽取后续独立项目的基础框架。模板是辅助资产，不是本工程的主要开发目标。

```text
英文产品名：KyCRM
项目 / 仓库 slug：kysion-crm
中文显示名：企迅CRM
```

生成干净模板项目：

```bash
scripts/create_project_from_template.sh \
  --output /tmp/kysion-crm
```

交互式初始化：

```bash
scripts/create_project_from_template.sh --interactive
```

配置文件初始化：

```bash
scripts/create_project_from_template.sh \
  --config template/examples/full-custom-apps.yaml
```

初始化时可配置：

- 全局产品英文名、中文名、项目 slug、根 `package.json` 名称、Git 远端地址。
- 管理后台应用目录、NPM 包名、显示名称和说明。
- 桌面客户端应用目录、NPM 包名、窗口 / 应用名称、显示名称和说明。

也可以通过参数直接生成，例如：

```bash
scripts/create_project_from_template.sh \
  --output /tmp/new-crm \
  --project-slug new-crm \
  --product-name NewCRM \
  --product-cn-name 新企CRM \
  --admin-dir console \
  --admin-package @new/console \
  --admin-name 新企CRM管理后台 \
  --desktop-dir desktop \
  --desktop-package @new/desktop \
  --desktop-app-name "NewCRM Desktop"
```

如需生成后直接绑定 Git 远端：

```bash
scripts/create_project_from_template.sh \
  --output /tmp/kysion-crm \
  --git-remote https://github.com/example/new-crm.git \
  --init-git
```

生成脚本采用保守模式：复制干净工程骨架，排除依赖、构建产物、本地截图、日志和私有环境文件，并将默认账号密码替换为模板占位值。

生成后验证：

```bash
scripts/validate_generated_project.sh /tmp/kysion-crm
```

## 模块脚手架

仅创建后台插件页面：

```bash
scripts/create_admin_plugin.sh \
  --slug customer-management \
  --title 客户管理 \
  --nav-group CRM \
  --route-path /customers \
  --register-host
```

创建完整业务模块链路：

```bash
scripts/create_business_module.sh \
  --slug customer-management \
  --title 客户管理 \
  --fields "customerNo:string:客户编号,level:string:客户等级,amount:number:成交金额" \
  --workspace-types enterprise \
  --nav-group CRM \
  --route-path /customers \
  --api-base /api/v1/customers \
  --http-port 18101
```

完整业务模块脚手架会生成：

- 后台插件、列表页、前端 API client、菜单和权限占位。
- 独立 Go 业务服务，包含登录、工作区和权限校验骨架。
- `ops/db` 下的表结构、权限和内置角色授权 SQL。
- `go.work`、服务构建/部署脚本、systemd unit 和 Nginx API 反向代理。

## 解决方案级 Skill

模板内置解决方案级 skill：

```text
template/skills/aicrm-solution/
template/skills/kycrm-initialize-project/
template/skills/kycrm-create-module/
```

这些 skill 约束以下工程规范：

- 模块边界。
- 权限与数据范围。
- API 契约。
- 桌面端事件通信。
- 基础框架模板抽取。
- 新独立项目初始化流程、参数说明和生成验证。
- 后台插件模块创建、完整业务模块创建、菜单路由权限占位和模块验证。

后续只有当 AiCRM 的通用底座能力需要沉淀给新项目时，才更新模板资产；日常业务功能不进入模板同步流程。

## 常用验证

按变更范围执行必要验证：

```bash
pnpm typecheck
pnpm build
go test ./...
scripts/create_business_module.sh --help
python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/aicrm-solution
python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/kycrm-initialize-project
python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/kycrm-create-module
scripts/validate_generated_project.sh /tmp/kysion-crm
```

## 贡献规范

贡献规则见：

```text
CONTRIBUTING.md
```

版本变更记录见：

```text
CHANGELOG.md
```
