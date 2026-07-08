# 初始化参数指南

## 目录

- 全局参数。
- 配置文件结构。
- 管理后台 app 参数。
- 桌面客户端 app 参数。
- 命名建议。
- 常用命令样例。

## 全局参数

| 参数 | 含义 | 建议 |
| --- | --- | --- |
| `--output` | 生成项目输出目录 | 必填；目录必须不存在或为空。 |
| `--project-slug` | 项目 / 仓库 slug | 使用小写字母、数字和短横线，例如 `new-crm`。 |
| `--product-name` | 产品英文名 | 用于文档、桌面应用名默认值等。 |
| `--product-cn-name` | 产品中文名 | 用于中文显示名、README 和元数据。 |
| `--package-name` | 根 `package.json` 包名 | 默认使用 `project-slug`。 |
| `--git-remote` | Git 远端地址 | 仅设置元数据；配合 `--init-git` 时写入 origin。 |
| `--init-git` | 初始化 Git 仓库 | 只有用户明确要求时使用。 |
| `--config` | 从 YAML 配置文件读取初始化参数 | 适合参数较多或需要审阅复用的初始化。 |
| `--interactive` | 交互式初始化 | 参数不完整或需要用户逐项确认时使用。 |
| `--dry-run` | 预览复制操作 | 只看计划，不写文件。 |

## 配置文件结构

配置文件使用简单 YAML，示例位于 `template/examples/`：

```yaml
project:
  output: /tmp/new-crm
  slug: new-crm
  productName: NewCRM
  productChineseName: 新企CRM
  packageName: new-crm

repository:
  remote: https://github.com/example/new-crm.git
  initGit: false

apps:
  admin:
    dir: console
    packageName: "@new/console"
    displayName: 新企CRM管理后台
    description: 新企CRM Web 管理后台 Host。
  desktop:
    dir: desktop
    packageName: "@new/desktop"
    appName: NewCRM Desktop
    displayName: 新企CRM桌面端
    description: 新企CRM Electron 桌面客户端。
```

支持的示例：

- `template/examples/minimal.yaml`：最小默认配置。
- `template/examples/full-custom-apps.yaml`：完整自定义 apps 配置。
- `template/examples/with-git-remote.yaml`：初始化 Git 并绑定远端。
- `template/examples/enterprise-branding.yaml`：企业品牌化记录字段示例。

命令行参数会覆盖配置文件值：

```bash
scripts/create_project_from_template.sh \
  --config template/examples/full-custom-apps.yaml \
  --output /tmp/override-crm
```

## 管理后台 App 参数

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `--admin-dir` | 管理后台在 `apps/` 下的目录名 | `ky-admin-host` |
| `--admin-package` | 管理后台 NPM 包名 | `@ky/admin-host` |
| `--admin-name` | 管理后台显示名称 | `<产品中文名> 管理后台` |
| `--admin-description` | 管理后台说明 | 多租户 CRM 后台管理 Host 说明 |

`--admin-dir` 只允许单段安全路径，使用字母、数字、点、下划线或短横线。不要填 `apps/console`，应填 `console`。

## 桌面客户端 App 参数

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `--desktop-dir` | 桌面客户端在 `apps/` 下的目录名 | `aicrm-desktop` |
| `--desktop-package` | 桌面客户端 NPM 包名 | `@ky/aicrm-desktop` |
| `--desktop-app-name` | 桌面窗口 / 应用名称 | `<产品英文名> Desktop` |
| `--desktop-name` | 桌面客户端显示名称 | `<产品中文名> 桌面端` |
| `--desktop-description` | 桌面客户端说明 | Electron 桌面客户端壳说明 |

`--desktop-dir` 只控制生成项目的目录名，不代表会重命名 `window.aicrm` 或 `AICRM_*` 运行时契约。

## 命名建议

- 项目 slug：`kysion-crm`、`new-crm`、`customer-crm`。
- 根包名：通常与项目 slug 一致。
- NPM scope：建议与组织或产品缩写一致，例如 `@new/console`、`@new/desktop`。
- 管理后台目录：`console`、`admin`、`admin-host`。
- 桌面客户端目录：`desktop`、`desktop-client`。
- 中文显示名：避免过长，优先使用产品名加模块名。

## 常用命令样例

交互式初始化：

```bash
scripts/create_project_from_template.sh --interactive
```

配置文件初始化：

```bash
scripts/create_project_from_template.sh \
  --config template/examples/full-custom-apps.yaml
```

默认模板生成：

```bash
scripts/create_project_from_template.sh \
  --output /tmp/kysion-crm
```

自定义 app 目录和包名：

```bash
scripts/create_project_from_template.sh \
  --output /tmp/new-crm \
  --project-slug new-crm \
  --product-name NewCRM \
  --product-cn-name 新企CRM \
  --admin-dir console \
  --admin-package @new/console \
  --desktop-dir desktop \
  --desktop-package @new/desktop
```

初始化 Git 并设置远端：

```bash
scripts/create_project_from_template.sh \
  --output /tmp/new-crm \
  --project-slug new-crm \
  --product-name NewCRM \
  --product-cn-name 新企CRM \
  --git-remote git@github.com:example/new-crm.git \
  --init-git
```
