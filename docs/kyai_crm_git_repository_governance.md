# AiCRM Git 仓库治理规范

> 文档状态：已确认 / 仓库治理规范
> 项目名称：AiCRM
> 当前阶段：第一阶段 / 多租户用户中心与多后台身份底座
> 编写日期：2026-07-07
> 适用范围：当前 `/data/Coolly` 解决方案及后续远端 Git 仓库规划

---

## 1. 文档目的

本文档定义 AiCRM 当前解决方案的 Git 仓库规划、分支策略、版本标签、发布边界和未来拆仓原则。

当前解决方案由前端后台、Electron 客户端、后台插件、Go 后端服务、共享模块、数据库脚本、部署脚本和技术文档共同组成。由于这些模块在第一阶段仍存在较强的接口、权限、路由、数据库和部署联动，当前阶段采用主仓库 monorepo 管理。

---

## 2. 总体结论

当前阶段采用：

```text
一个主平台 monorepo 仓库
```

业务专用远端仓库：

```text
https://github.com/SupenBysz/aicrm.git
```

当前本地工程目录可继续保持：

```text
/data/Coolly
```

不建议在当前阶段把每个插件、每个 Go 服务或每个前端包拆成独立仓库。

---

## 3. 当前仓库组成

仓库组成按“当前实现态”和“P1 Agent Executor 目标态”分别计数，禁止把计划模块写成已交付模块：

| 状态 | 代码模块 | Go `shared` | 治理口径 |
|---|---:|---:|---|
| 远程实现基线 `b35233d` / P0-01 架构锁定基线 `bc1719e` | 16 | 1 | 当前共 17 个模块 |
| P1 新增 `ky-agent-executor-service` 后 | 17 | 1 | 目标共 18 个模块 |

当前 16 个代码模块为：

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
├── ky-matrix-account
├── ky-notification
├── ky-organization-management
└── ky-system-settings

services/
├── ky-ai-model-service
├── ky-auth-service
├── ky-matrix-account-service
├── ky-membership-service
└── ky-org-service

shared/                    Go 共享模块（单独计入模块总数）
```

当前 Matrix 边界固定为：

- `plugins/ky-matrix-account`：后台矩阵账号业务页面和业务用例消费方。
- `services/ky-matrix-account-service`：MatrixAccount、WebSpace、LoginAttempt、登录脚本及快照元数据的领域服务。
- `apps/aicrm-desktop`：受信 WebSpace、浏览器登录态、Vault 与后续设备证明能力。

P1 计划新增：

```text
services/ky-agent-executor-service
```

该服务将成为 Codex 执行器授权、设备信任、不可变 credential revision、model catalog、readiness、任务与事件的唯一写者。新增前继续按 17 个当前模块治理；目录、构建和部署入口真实落库并通过验证后，才切换为 18 个目标模块口径。

根目录 `package.json`、`pnpm-workspace.yaml`、`go.work`、`scripts/`、`ops/`、`docs/` 和 `template/` 属于主仓库编排、治理与基础框架模板能力，不单独作为业务模块拆分。

---

## 4. 仓库边界

主仓库 `aicrm` 包含：

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

主仓库 fork 自 KyCRM 基础框架。上游仓库只作为 fork 来源和通用能力回流目标，不作为 AiCRM 工程文件中的固定模板仓库地址。需要同步上游时，使用 GitHub fork compare/PR、或本地临时 `upstream` remote；`upstream` 属于本地 Git 配置，不写入仓库文件。

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
matrix-account-service/v0.1.0
agent-executor-service/v0.1.0
```

`agent-executor-service/*` 仅在 `services/ky-agent-executor-service` 实际落地并具备独立构建、部署和回滚能力后使用；在此之前不得创建空标签占位。

标签规则：

1. 平台联动发布使用 `platform/*`。
2. 单模块独立发布使用对应模块前缀。
3. 正式发布标签必须指向已验证提交。
4. 标签创建后原则上不重写。
5. 需要撤回发布时新增修复标签，不覆盖旧标签。
6. Matrix 与 Agent Executor 若涉及 migration、internal API、NATS、Desktop Bridge 或单写者切换，必须同时创建 `platform/*` 联动发布标签；模块标签只能作为同一提交上的发布对象索引，不能替代平台标签。
7. 只有不改变跨模块契约、数据库结构和部署顺序的单模块修复，才允许仅使用 `matrix-account-service/*` 或 `agent-executor-service/*`。

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
9. 是否创建或调整服务专属 DB role 与表写权限。
10. 是否新增 NATS subject、consumer、重放或 ACL。
11. 是否新增或变更 `/internal/v1` 服务间 API、internal token 或调用方向。
12. 是否调整功能开关、灰度 workspace 或单写者归属。
13. 是否需要 drain 旧任务、冻结旧写者和执行 cutover。

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

### 9.1 Matrix / Agent Executor 发布边界

以下任一内容发生变化，都属于平台联动发布，不能把 Matrix、Agent、Desktop 或数据库拆成互不知情的独立发布：

- Matrix generation run、executor task、credential、device ledger、receipt 或 outbox 的 migration。
- `ky-matrix-account-service` 与 `ky-agent-executor-service` 之间的 internal API。
- task terminal、授权、credential、catalog 或 readiness 使用的 NATS subject、consumer 与重放策略。
- Matrix 新链路、可信授权、默认模型、workspace grant、readiness 或单写者 feature flag。
- Nginx 路由、systemd 服务、DB role、internal token、服务账号或网络 ACL。
- Host、AI 配置插件、Matrix 插件与 Desktop Bridge 的最低兼容版本。

上述发布记录必须附带同一份 compatibility matrix，至少覆盖：当前 Host + 当前 Desktop、当前 Host + 旧 Desktop、旧 Host + 当前 Backend。旧 Desktop 不得调用不可信授权状态写入口；版本不足时固定 fail closed，并返回 `desktop_bridge_upgrade_required` 或已锁定的 410 错误，不能静默降级到旧 `auth-status`、全局 `CODEX_HOME` 或本地探针。

### 9.2 Agent Executor P1 shadow 与后续单写者切换

P1 只允许完成 additive schema、DB role/GRANT 设计、新服务骨架和 shadow read，不得写生产数据：

1. 先部署 additive migration；旧服务必须仍可运行，迁移不得立即转移写权。
2. 创建 `ky-agent-executor-service` 专属低权限 DB role、table-owner manifest 和 GRANT 方案；生产写权限保持关闭。
3. 配置 NATS subject/consumer/ACL 和 internal API token；新服务先以 intake 关闭、shadow/read-only 状态启动。
4. 部署 Matrix、Host、插件和 Desktop 的兼容读取能力，但保持可信授权、generation run 和自动修复开关关闭。

在非生产完成 P2A/P4 能力验收并通过 P5 安全、迁移与故障门禁后，生产单写者 cutover 才按以下顺序继续，禁止 dual-write：

5. drain 旧 executor task，冻结 `ky-ai-model-service` 的 executor 写入口；P0 已关闭的不可信授权入口永久不得恢复。
6. 在同一维护窗口切换 DB 写权限、Nginx/internal route 和服务端单写者 feature flag，使 `ky-agent-executor-service` 成为唯一写者。
7. 逐 workspace 灰度打开 eligible/readiness、授权和生成能力，验证 task/event/outbox/NATS 最终收敛后再扩大。
8. 保留旧读取兼容一个发布周期；旧写 API 按合同返回 Deprecation/Sunset 或 410，不代理回旧实现。

回滚分界固定为：Agent 首次成功写入生产数据前，可先撤销 Agent 写权，再恢复 `ky-ai-model-service` 为唯一旧写者；Agent 首次成功写入后，永久禁止恢复旧服务写权，只能由 Agent forward-fix 或提供兼容代理。任何回滚都先关闭新 intake 和业务 feature flag，并继续运行 ledger、outbox、reconciler 与终态清理；路由只能回退到符合 P0 fail-closed 安全基线的只读或兼容端点。

---

## 10. CI 与验证基线

主仓库基础验证命令：

```bash
pnpm typecheck
pnpm build
go test ./...
git diff --check
```

按模块变更补充验证：

| 变更范围 | 必要验证 |
|---|---|
| `apps/ky-admin-host` | `pnpm --filter @ky/admin-host typecheck`、`pnpm --filter @ky/admin-host build` |
| `apps/aicrm-desktop` | `pnpm --filter @ky/aicrm-desktop typecheck`、桌面启动验证 |
| `packages/ky-admin-core` | 前端全量 typecheck/build |
| `plugins/*` | 对应插件页面验证、Host build |
| `plugins/ky-matrix-account` | 插件 typecheck、Matrix 业务流程测试、Host build |
| `plugins/ky-ai-configuration` | 插件 typecheck/build、授权与执行器配置安全回归、Host build |
| `services/ky-matrix-account-service` | `go test ./...`、PostgreSQL 幂等/权限/并发/过期/事务测试 |
| `services/ky-ai-model-service` | `go test ./...`；单写者切换前额外验证旧 executor 写入口已冻结 |
| `services/ky-agent-executor-service`（P1） | `go test ./...`、`go test -race ./...`、设备重放/lease/fencing/credential 恢复测试 |
| 其他 `services/*` | 对应 Go 服务测试和本地启动验证 |
| `ops/db/*` | 从当前生产等价快照执行 migration、重复部署检查、seed/角色绑定、DB role 权限验证 |
| `scripts/*` | dry-run 或本地执行验证 |

当前仓库存在前后端混合模块，CI 可以先按路径增量触发，稳定后再增加全量门禁。

Matrix / Agent Executor 联动发布还必须增加：

```text
internal API contract tests
NATS duplicate / loss / replay tests
outbox 与 reconciler 崩溃恢复测试
feature flag 默认关闭与 workspace 灰度测试
旧 Desktop / 旧 Host fail-closed 兼容测试
单写者 DB role 与禁止 dual-write 验证
```

创建 `platform/*` 标签前，必须完成受影响模块的增量验证和上述跨模块验证；单个模块测试通过不能替代平台联动验收。

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
8. 当前 Matrix 插件与 Matrix service 继续留在 monorepo，并参与 `platform/*` 联动发布。
9. P1 `ky-agent-executor-service` 落地后仍留在 monorepo；在 internal API、migration、NATS、Desktop Bridge 和单写者 cutover 稳定前不得拆仓。
10. `matrix-account-service/*`、`agent-executor-service/*` 标签不解除 `platform/*` 对跨模块发布的一致性约束。
