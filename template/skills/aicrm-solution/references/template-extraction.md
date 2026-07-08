# 基础框架模板抽取规范

本规范用于把当前 AiCRM 解决方案封装为后续创建新独立项目的基础框架工程模板。

## 模板目标

模板应保留可复用后台底座能力：

- monorepo 工程组织。
- Admin Host + Admin Core + Plugins。
- Go 多服务骨架。
- 多租户、多工作区、多身份、权限、数据范围基础模型。
- 登录、bootstrap、工作区选择与切换。
- 基础系统设置、品牌配置、通知、公告、审计。
- Electron/Web 混合客户端桥接规范。
- 解决方案级 skill 与规范 references。

模板不应携带具体客户和运行环境事实。

## 默认模板命名

当前基础模板默认命名为：

```text
英文产品名：KyCRM
项目 / 仓库 slug：kysion-crm
中文显示名：企迅CRM
桌面应用名：KyCRM Desktop
后台标题：企迅CRM 管理后台
模板专用仓库：https://github.com/kysion/kysion-crm.git
```

这些默认值以 `template/manifest.yaml` 为准。生成新项目时可以通过脚本参数覆盖。

`apps/` 下应用默认值同样以 `template/manifest.yaml` 为准：

```text
后台 Host 源目录：apps/ky-admin-host
后台 Host 默认包名：@ky/admin-host
桌面客户端源目录：apps/aicrm-desktop
桌面客户端默认包名：@ky/aicrm-desktop
```

生成新项目时允许覆盖应用目录、包名、显示名称和说明；默认不重命名 `window.aicrm`、`AICRM_*` 环境变量、数据库前缀和 Go module path 等运行时契约。

## 必须保留

```text
apps/ky-admin-host
apps/aicrm-desktop
packages/ky-admin-core
plugins/ky-*
services/ky-*
shared/
ops/db/
ops/native/*.example 或占位配置
scripts/
docs/kyai_crm_architecture.md
docs/kyai_crm_api_contracts.md
docs/kyai_crm_permission_matrix.md
docs/aicrm_desktop_event_communication_standard.md
docs/kyai_crm_git_repository_governance.md
CHANGELOG.md
template/skills/aicrm-solution/
```

## 必须替换

抽取新项目时替换：

- 产品名、包名、应用名、桌面应用名。
- `ky` / `KY` / `ky_` 前缀，如新项目需要独立命名体系。
- API 域名、Web URL、桌面客户端 URL、部署路径。
- 默认超级管理员账号密码。
- 品牌 Logo、短名、长名、主题色。
- 数据库名、Redis key 前缀、对象存储 bucket。
- Git 远端地址、标签前缀、发布名称。

## 必须删除

不得进入模板：

- 生产 `.env`、密钥、token、cookie、证书、私钥。
- 真实客户数据、用户数据、日志、审计记录。
- 构建产物、安装包、`dist/`、`out/`、`release/`。
- 本地截图、Playwright 临时目录、调试输出。
- 绑定当前环境的 Nginx/systemd 非 example 配置。
- 已过期的一次性部署记录。
- `docs/kyai_crm_phase1_devwork_deployment_record.md` 等包含真实域名、IP、隧道、账号或运维痕迹的部署记录。

## 模板目录建议

当前仓库模板源使用：

```text
template/
  docs/
  skills/
    aicrm-solution/
```

初始化新项目后建议落地为：

```text
docs/
template/skills/aicrm-solution/
```

如果模板作为独立仓库发布，可保留 `template/` 作为模板资产根目录，并在生成脚本中把 `template/docs/*` 复制到新项目 `docs/`。

## 生成脚本

第一版生成脚本：

```bash
scripts/create_project_from_template.sh \
  --output /tmp/kysion-crm \
  --project-slug kysion-crm \
  --product-name KyCRM \
  --product-cn-name 企迅CRM \
  --package-name kysion-crm \
  --git-remote https://github.com/kysion/kysion-crm.git
```

交互式初始化：

```bash
scripts/create_project_from_template.sh --interactive
```

应用参数可通过命令行显式覆盖：

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

如需生成后直接绑定模板专用仓库，可追加 `--init-git`。脚本只初始化 remote，不自动提交或推送。

第一版采用保守模式：

- 复制干净工程骨架。
- 排除 `.git`、依赖、构建产物、本地截图、日志、env 私有文件。
- 排除 dev-work 部署记录等环境事实文档。
- 更新根 `package.json` 的 `name` 和 `description`。
- 支持重命名 `apps/` 下管理后台与桌面客户端目录。
- 更新管理后台与桌面客户端 `package.json` 的包名、显示名和说明。
- 更新根脚本、部署脚本、Nginx 示例、文档中的应用目录与包名引用。
- 将默认超级管理员账号/密码替换为模板占位值。
- 对文档、模板、示例部署配置做安全文本替换。
- 不批量改源码里的 `ky_`、`KY_`、`window.aicrm`、`AICRM_*` 和 Go module path。

## 生成检查

生成新项目后必须验证：

- `pnpm install` 或锁定包管理器安装流程可执行。
- 前端 Host 可以 typecheck/build。
- Go workspace 可以 test/build 最小服务。
- 数据库 migration 可以从空库执行。
- 登录、bootstrap、工作区选择、权限守卫可走通。
- 桌面客户端在 Web 模式不可用时能降级，在客户端模式下能识别桥能力。
- `quick_validate.py template/skills/aicrm-solution` 通过。

## 规范同步

模板中以下内容必须同步维护：

- `SKILL.md` 的触发范围和任务闸口。
- `references/module-boundaries.md`。
- `references/permission-data-scope.md`。
- `references/api-contracts.md`。
- `references/event-communication.md`。
- `references/template-extraction.md`。

任一 docs 规范发生变化时，检查是否需要同步对应 reference。
