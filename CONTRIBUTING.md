# AiCRM 贡献规范

本仓库采用主平台 monorepo 方式管理，是 AiCRM 业务专用解决方案仓库。贡献时优先服务当前产品开发、部署和业务闭环；`template/` 是从当前工程梳理出的衍生模板资产，只在需要沉淀通用能力时更新。

仓库治理以以下文档为准：

```text
docs/kyai_crm_git_repository_governance.md
```

解决方案级工程规范以以下 skill 为准：

```text
template/skills/aicrm-solution/SKILL.md
```

## 工作原则

1. 优先保持现有架构和目录边界，不为了单个页面或接口引入跨层耦合。
2. Host、Core、Plugin、Desktop、Service、Shared、Ops、Docs、Template 的职责必须分离。
3. 权限、工作区、数据范围、API 契约、事件通信和模板资产相关改动，必须先阅读对应 skill reference。
4. 前端隐藏不是安全边界，后端必须重新校验权限和数据范围。
5. Electron 主进程不维护角色、权限、菜单、工作区策略等业务上下文。
6. 模板资产不得包含生产域名、真实密钥、客户数据、构建产物、本地截图或一次性部署痕迹。
7. 上游 KyCRM 基础框架只通过 GitHub fork 关系或本地 `upstream` remote 同步，不在仓库文件中固定上游地址。

## 分支策略

主分支固定为：

```text
main
```

推荐分支：

| 分支 | 用途 |
| --- | --- |
| `feature/*` | 新功能 |
| `fix/*` | 普通缺陷修复 |
| `hotfix/*` | 紧急修复 |
| `docs/*` | 文档和规范 |
| `chore/*` | 工程治理、依赖、脚本、模板 |
| `release/*` | 版本发布准备，可选 |

推荐小步提交，保持分支短生命周期。涉及模板资产时，先确认该能力确实可复用；业务专用功能不要进入模板同步流程。

## 提交规范

提交信息推荐使用 Conventional Commits：

```text
feat: add member creation flow
fix: correct workspace breadcrumb layout
docs: use Chinese README
chore: update derived template assets
refactor: simplify admin shell layout
test: add membership permission coverage
build: adjust desktop build config
```

常用类型：

| Type | 用途 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 文档 |
| `style` | 样式或格式 |
| `refactor` | 重构 |
| `test` | 测试 |
| `build` | 构建系统 |
| `ci` | CI/CD |
| `chore` | 工程杂项 |
| `revert` | 回滚 |

## 改动边界

按改动类型读取对应规范：

| 改动类型 | 必读规范 |
| --- | --- |
| 新模块、重构、跨包移动 | `template/skills/aicrm-solution/references/module-boundaries.md` |
| 角色、权限点、菜单、数据范围 | `template/skills/aicrm-solution/references/permission-data-scope.md` |
| API、分页、错误码、批量操作 | `template/skills/aicrm-solution/references/api-contracts.md` |
| IPC、事件、订阅、桌面桥 | `template/skills/aicrm-solution/references/event-communication.md` |
| 模板资产生成、模板能力抽取 | `template/skills/aicrm-solution/references/template-extraction.md` |
| 后台列表页布局 | 全局 `admin-list-page-layout` skill |

跨模块改动必须说明影响范围，例如：

- 是否影响 Host、Plugin、Core 或 Desktop。
- 是否修改 API、权限、数据范围或数据库。
- 是否影响模板生成结果。
- 是否需要同步文档或 seed/migration。

## 文档同步

以下改动必须同步文档：

1. 数据库 schema、migration、seed。
2. API 路径、参数、响应结构、错误码。
3. 权限点、菜单、角色、数据范围。
4. 工作区、登录、bootstrap、会话、缓存策略。
5. 桌面端 IPC、preload bridge、事件订阅与消费。
6. 模板生成规则、模板默认命名、衍生模板资产说明。
7. 部署脚本、Nginx/systemd 示例、环境变量示例。

文档同步优先更新 `docs/` 下的源文档；如果属于模板执行规范，还要同步 `template/skills/aicrm-solution/references/*.md`。

版本级变化必须同步 `CHANGELOG.md`。每个版本条目必须包含版本号、更新时间、更新内容、部署/迁移说明和验证方式。

## 验证要求

按变更范围选择验证命令：

| 变更范围 | 建议验证 |
| --- | --- |
| 前端 Host / Plugin / Core | `pnpm typecheck`，必要时 `pnpm build` |
| 桌面客户端 | `pnpm --filter @ky/aicrm-desktop typecheck`，必要时启动桌面端验证 |
| Go 服务 / shared | `go test ./...` 或对应服务目录测试 |
| 数据库脚本 | 从空库执行 migration，检查 seed 可重复执行策略 |
| 文档 / 模板 skill | `git diff --check` 和 `quick_validate.py template/skills/aicrm-solution` |
| CHANGELOG | 检查版本号、日期、时间、时区、部署/迁移说明和验证方式是否齐全 |
| 模板生成 | 使用 `scripts/create_project_from_template.sh` 生成临时目录并扫描敏感信息 |
| 模块脚手架 | 在临时项目运行 `create_admin_plugin.sh` 或 `create_business_module.sh`，验证插件 typecheck/build、admin host typecheck、Go 服务 test/build |

常用命令：

```bash
pnpm typecheck
pnpm build
go test ./...
git diff --check
bash -n scripts/create_business_module.sh
python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/aicrm-solution
```

## 业务仓库与模板资产

AiCRM 主仓库：

```text
https://github.com/SupenBysz/aicrm.git
```

本地推荐 remote：

```bash
git remote add origin https://github.com/SupenBysz/aicrm.git
```

如需同步 KyCRM 基础框架或提交通用能力回上游，可在本地按需添加 `upstream` remote。该 remote 属于本地配置，不写入仓库文件、脚本默认值或模板 manifest。

衍生模板默认信息：

```text
英文产品名：KyCRM
项目 / 仓库 slug：kysion-crm
中文显示名：企迅CRM
```

生成干净模板：

```bash
scripts/create_project_from_template.sh \
  --output /tmp/kysion-crm
```

如生成的新项目需要直接绑定自己的业务仓库：

```bash
scripts/create_project_from_template.sh \
  --output /tmp/new-crm \
  --git-remote https://github.com/example/new-crm.git \
  --init-git
```

发布或移交模板输出前必须检查：

```bash
find /tmp/kysion-crm -type d \( -name node_modules -o -name dist -o -name out -o -name release -o -name .playwright-mcp \) -print
find /tmp/kysion-crm -type f \( -name '*.png' -o -name server \) -print
rg -n "Super\\.Admin|[e]ntai\\.im|[k]yaicrm|[c]loudflared|[G]lobal API Key|[t]oken-file|[t]unnel" /tmp/kysion-crm -S -g '!pnpm-lock.yaml'
```

不要从当前主仓库直接强推到任何模板或上游仓库；需要上游同步时，通过 fork compare、PR 或明确的 cherry-pick 流程处理。

## 安全要求

禁止提交：

1. `.env`、真实密钥、token、cookie、证书、私钥。
2. 生产数据库连接、真实内网 IP、隧道 token、Cloudflare 账号信息。
3. 客户数据、用户数据、审计日志、生产日志。
4. `node_modules/`、`dist/`、`out/`、`release/`、二进制构建产物。
5. 本地截图、Playwright 临时目录、调试输出。
6. 一次性部署记录或包含真实运维环境事实的文档。

模板中默认管理员账号和密码必须使用占位值，不得提交真实可用凭据。

## 合入前检查清单

提交或推送前确认：

1. 改动范围清晰，没有混入无关重构。
2. 未覆盖或回滚他人未授权改动。
3. 已按改动类型读取对应规范。
4. 已同步必要文档、migration、seed 或模板 reference。
5. 版本级变化已同步 `CHANGELOG.md`。
6. 已运行必要验证，并记录未能运行的原因。
7. 已检查敏感信息和本地临时文件。
8. 模板资产相关改动已通过生成脚本验证。
9. 提交信息符合 Conventional Commits。
