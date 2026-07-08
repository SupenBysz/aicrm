# 项目初始化流程

## 适用范围

使用 KyCRM / `kysion-crm` 模板创建新独立项目时遵循本流程。目标是让生成项目具备明确身份、可构建的 app 包、干净的模板内容和可追踪的初始化元数据。

## 初始化前检查

在模板源仓库中确认以下文件存在：

```bash
test -f scripts/create_project_from_template.sh
test -f template/manifest.yaml
```

确认输出目录安全：

- 目录不存在，或目录存在但为空。
- 不允许把输出目录设置为当前源仓库。
- 不要覆盖已有业务项目。

## 交互式初始化

当用户没有给完整参数，或明确要求“交互式初始化/向导初始化”时使用：

```bash
scripts/create_project_from_template.sh --interactive
```

交互式流程需要收集：

- 输出目录。
- 产品英文名。
- 产品中文名。
- 项目 / 仓库 slug。
- 根 `package.json` 包名。
- Git 远端地址。
- 管理后台目录、包名、显示名、说明。
- 桌面客户端目录、包名、窗口 / 应用名、显示名、说明。
- 是否初始化 Git 仓库。

如果用户在交互中选择初始化 Git，脚本只执行 `git init -b main` 和设置 `origin`，不会自动提交或推送。

## 参数化初始化

当用户已经给出关键参数时，直接组装命令：

```bash
scripts/create_project_from_template.sh \
  --output /tmp/new-crm \
  --project-slug new-crm \
  --product-name NewCRM \
  --product-cn-name 新企CRM \
  --package-name new-crm \
  --admin-dir console \
  --admin-package @new/console \
  --admin-name 新企CRM管理后台 \
  --desktop-dir desktop \
  --desktop-package @new/desktop \
  --desktop-app-name "NewCRM Desktop"
```

未提供的 app 显示名和说明可以使用脚本默认值。用户要求绑定远端时追加 `--git-remote <url>`；用户要求初始化仓库时再追加 `--init-git`。

## 配置文件初始化

当初始化参数较多、需要用户审阅，或后续可能复用时，优先创建配置文件：

```bash
scripts/create_project_from_template.sh --config template/examples/full-custom-apps.yaml
```

配置文件加载后，命令行参数可以继续覆盖配置值：

```bash
scripts/create_project_from_template.sh \
  --config template/examples/full-custom-apps.yaml \
  --output /tmp/another-crm \
  --project-slug another-crm
```

配置文件只支持模板示例中使用的简单 YAML 结构：2 空格缩进、对象和标量值。不支持数组、锚点、复杂 YAML 类型。

## Git 处理规则

- 不要默认提交或推送生成项目。
- 用户只说“初始化项目”时，不加 `--init-git`，除非已明确要求。
- 用户说“创建并绑定仓库”时，可使用 `--init-git --git-remote <url>`。
- 用户说“推送生成结果”时，先生成干净模板输出，再同步到用户明确指定的目标仓库工作副本，移除 `.template-generated.json` 后提交推送。

## 保守迁移边界

初始化脚本会处理：

- 根包名和说明。
- app 目录名。
- app 包名、显示名、说明。
- HTML 标题。
- 根脚本、部署脚本、Nginx 示例和文档里的 app 引用。
- 默认超级管理员账号密码占位。
- 旧域名和本地环境痕迹替换。
- 生成 `.template-generated.json`，记录项目身份和 app 元数据。

初始化脚本默认不处理：

- `window.aicrm`。
- `AICRM_*` 环境变量名。
- `ky_` 数据库表前缀。
- `KY_` 请求头和环境变量前缀。
- Go module path。

如用户要求改这些运行时契约，先说明这是第二阶段迁移，需单独评估源码、配置、文档和验证范围。

## 生成后验证

优先使用验证脚本：

```bash
scripts/validate_generated_project.sh /tmp/new-crm
```

用户要求完整构建验证时追加：

```bash
scripts/validate_generated_project.sh /tmp/new-crm --with-build
```
