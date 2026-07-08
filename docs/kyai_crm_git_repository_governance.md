# KyaiCRM Git 仓库治理规范

> 文档状态：已确认 / 仓库治理规范
> 项目名称：KyaiCRM / AiCRM
> 当前阶段：第一阶段 / 多租户用户中心与多后台身份底座
> 编写日期：2026-07-07
> 适用范围：当前 `/data/Coolly` 解决方案及后续远端 Git 仓库规划

---

## 1. 文档目的

本文档定义 KyaiCRM 当前解决方案的 Git 仓库规划、分支策略、版本标签、发布边界和未来拆仓原则。

当前解决方案由前端后台、Electron 客户端、后台插件、Go 后端服务、共享模块、数据库脚本、部署脚本和技术文档共同组成。由于这些模块在第一阶段仍存在较强的接口、权限、路由、数据库和部署联动，当前阶段采用主仓库 monorepo 管理。

---

## 2. 总体结论

当前阶段采用：

```text
一个主平台 monorepo 仓库
```

建议远端仓库名：

```text
aicrm-platform
```

当前本地工程目录可继续保持：

```text
/data/Coolly
```

不建议在当前阶段把每个插件、每个 Go 服务或每个前端包拆成独立仓库。

---

## 3. 当前仓库组成

当前主仓库承载 15 个实际项目模块：

```text
apps/
├── ky-admin-host          后台管理 Host 应用
└── aicrm-desktop          Electron 桌面客户端

packages/
└── ky-admin-core          后台公共契约与组件能力

plugins/
├── ky-access-management
├── ky-ai-configuration
├── ky-audit-management
├── ky-identity-management
├── ky-notification
├── ky-organization-management
└── ky-system-settings

services/
├── ky-ai-model-service
├── ky-auth-service
├── ky-membership-service
└── ky-org-service

shared/                   Go 共享模块
```

根目录 `package.json`、`pnpm-workspace.yaml`、`go.work`、`scripts/`、`ops/`、`docs/` 和 `template/` 属于主仓库编排、治理与基础框架模板能力，不单独作为业务模块拆分。

---

## 4. 仓库边界

主仓库 `aicrm-platform` 包含：

1. 管理后台 Host。
2. Electron 桌面客户端源码。
3. 前端公共包。
4. 后台插件。
5. Go 后端服务。
6. Go 共享模块。
7. 数据库迁移与 seed 脚本。
8. 原生 VM 部署脚本。
9. 技术架构、需求锁定、实施锁定与治理文档。
10. 后续独立项目基础框架模板、解决方案级 skill 与通信规范模板。
11. 模块边界、权限与数据范围、API 契约、事件通信、模板抽取等模板内置工程规范。

主仓库不包含：

1. 生产环境真实密钥。
2. 客户私有数据。
3. 构建产物归档。
4. 桌面安装包正式发布产物。
5. 与当前平台无关的外部系统代码。

---

## 5. 可选独立仓库规划

### 5.1 桌面客户端仓库

候选仓库名：

```text
aicrm-desktop
```

当前阶段 Electron 客户端保留在主仓库：

```text
apps/aicrm-desktop
```

只有满足以下条件时，才拆为独立仓库：

1. 客户端有独立版本节奏。
2. 客户端安装包、自动更新、渠道包、签名流程稳定。
3. 客户端研发权限需要和平台后台明显隔离。
4. 客户端依赖主平台接口已形成稳定契约。
5. 客户端 CI/CD 与平台后台发布流程明显分离。

拆出后，主仓库只保留客户端接口契约、下载入口、版本规则和必要文档。

### 5.2 运维部署仓库

候选仓库名：

```text
aicrm-ops
```

只有在正式引入 Kubernetes、复杂多环境部署、独立运维团队或跨客户交付环境时，才考虑拆出运维仓库。

当前阶段继续将原生 VM 部署脚本保留在：

```text
ops/
scripts/
```

### 5.3 文档仓库

候选仓库名：

```text
aicrm-docs
```

只有当产品手册、实施文档、客户交付文档和内部技术文档规模明显扩大，并且需要独立发布站点时，才拆出文档仓库。

当前阶段技术文档继续保留在：

```text
docs/
```

---

## 6. 分支策略

主分支固定为：

```text
main
```

分支类型：

| 分支 | 用途 |
|---|---|
| `main` | 主干分支，必须保持可构建、可部署 |
| `feature/*` | 新功能开发 |
| `fix/*` | 普通缺陷修复 |
| `hotfix/*` | 线上紧急修复 |
| `release/*` | 版本发布准备，可选 |
| `docs/*` | 文档调整，可选 |
| `chore/*` | 工程治理、依赖、脚本等非业务调整 |

当前阶段推荐 trunk-based 工作方式：

1. 分支保持短生命周期。
2. 小步提交，尽快合入 `main`。
3. 合入前必须完成对应构建或测试验证。
4. 长周期功能用开关、配置或渐进式提交控制风险。

---

## 7. 提交规范

提交信息推荐使用 Conventional Commits：

```text
feat: add member creation flow
fix: correct workspace breadcrumb layout
docs: add git repository governance
chore: update frontend dependencies
refactor: simplify admin shell layout
test: add membership permission coverage
build: adjust desktop build config
```

常用 type：

| Type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 文档 |
| `style` | 纯样式或格式 |
| `refactor` | 重构 |
| `test` | 测试 |
| `build` | 构建系统 |
| `ci` | CI/CD |
| `chore` | 工程杂项 |
| `revert` | 回滚 |

提交应遵循：

1. 一个提交只表达一个清晰意图。
2. 不把无关格式化和业务修改混在一起。
3. 不提交真实密钥、客户数据、临时日志和本机构建缓存。
4. 涉及数据库变更时，提交必须包含迁移脚本或说明。
5. 涉及接口变更时，提交必须同步更新前端调用、后端处理和契约文档。

---

## 8. 标签策略

主仓库允许按发布对象打标签。

平台整体发布：

```text
platform/v2026.07.07
platform/v0.1.0
```

后台 Host 发布：

```text
admin-host/v0.1.0
```

桌面客户端发布：

```text
desktop/v0.1.0
```

后端服务发布：

```text
auth-service/v0.1.0
membership-service/v0.1.0
org-service/v0.1.0
ai-model-service/v0.1.0
```

标签规则：

1. 平台联动发布使用 `platform/*`。
2. 单模块独立发布使用对应模块前缀。
3. 正式发布标签必须指向已验证提交。
4. 标签创建后原则上不重写。
5. 需要撤回发布时新增修复标签，不覆盖旧标签。

---

## 9. 发布边界

一次发布需要明确影响范围：

1. 是否包含后台静态资源。
2. 是否包含 Electron 客户端。
3. 是否包含 Go 服务二进制。
4. 是否包含数据库迁移。
5. 是否包含 seed 数据调整。
6. 是否包含 Nginx 或 systemd 配置变化。
7. 是否包含接口契约变化。
8. 是否影响旧客户端兼容性。

发布记录至少需要包含：

```text
版本号
提交范围
影响模块
构建命令
部署命令
数据库迁移说明
回滚方式
验证结果
```

---

## 10. CI 与验证基线

主仓库基础验证命令：

```bash
pnpm typecheck
pnpm build
go test ./...
```

按模块变更补充验证：

| 变更范围 | 必要验证 |
|---|---|
| `apps/ky-admin-host` | `pnpm --filter @ky/admin-host typecheck`、`pnpm --filter @ky/admin-host build` |
| `apps/aicrm-desktop` | `pnpm --filter @ky/aicrm-desktop typecheck`、桌面启动验证 |
| `packages/ky-admin-core` | 前端全量 typecheck/build |
| `plugins/*` | 对应插件页面验证、Host build |
| `services/*` | 对应 Go 服务测试和本地启动验证 |
| `ops/db/*` | 迁移验证、seed 验证 |
| `scripts/*` | dry-run 或本地执行验证 |

当前仓库存在前后端混合模块，CI 可以先按路径增量触发，稳定后再增加全量门禁。

---

## 11. 拆仓禁止项

当前阶段禁止：

1. 每个插件独立一个 Git 仓库。
2. 每个 Go 服务独立一个 Git 仓库。
3. 使用 Git submodule 管理内部模块。
4. 将数据库迁移脚本从业务代码仓库过早拆离。
5. 将部署脚本从当前原生 VM 发布流程中过早拆离。
6. 在没有稳定接口契约前拆出 Electron 客户端仓库。

---

## 12. 远端仓库初始化建议

远端仓库初始化时建议：

```text
仓库名：aicrm-platform
默认分支：main
可见性：私有
合并策略：Squash merge 或普通 merge 二选一，团队统一
保护策略：main 禁止直接 push，合入前至少要求构建通过
```

如果团队规模较小，初期可以允许维护者直接合入，但仍需保证：

1. `main` 可构建。
2. 线上发布必须来自 `main` 或 `release/*`。
3. 发布标签必须可追溯。
4. 数据库变更必须有迁移脚本。

---

## 13. 当前执行决议

当前阶段执行以下决议：

1. `/data/Coolly` 作为主平台 monorepo 继续演进。
2. 远端仓库按 `aicrm-platform` 规划。
3. 本地默认分支调整为 `main`。
4. `apps/aicrm-desktop` 暂不拆仓。
5. `plugins/*`、`services/*` 暂不拆仓。
6. `ops/`、`scripts/`、`docs/` 暂保留在主仓库。
7. 后续只有在发布节奏、权限边界和 CI/CD 明显分离后，再评估拆出客户端或运维仓库。
