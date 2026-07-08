---
name: aicrm-solution
description: AiCRM 解决方案级工程规范。Use when Codex works on an AiCRM-derived monorepo, independent project template, admin host, desktop client, backend service, plugin, architecture document, repository governance, or any change involving Electron/Web communication, event subscription, event consumption, workspace/session/auth boundaries, or template scaffolding.
---

# AiCRM Solution

## 概览

将本 skill 作为 AiCRM 衍生项目的解决方案级工程规范。它负责约束架构边界、模块职责、权限与数据范围、API 契约、桌面/Web 通信和基础框架模板抽取。

## 必读上下文

修改架构、模板、桌面桥、事件通信、登录、会话、工作区、权限、API 或共享后台契约前，先检查当前仓库，再按任务读取对应资料：

- `docs/kyai_crm_architecture.md`：解决方案组成、服务职责、工作区上下文。
- `docs/kyai_crm_git_repository_governance.md`：monorepo、分支、标签、拆仓、模板边界。
- `docs/kyai_crm_api_contracts.md`：API 路径、响应结构、错误码、工作区 Header。
- `docs/kyai_crm_permission_matrix.md`：菜单、页面、操作、数据范围权限。
- `docs/aicrm_desktop_event_communication_standard.md`：Electron/Web IPC、订阅与消费规则。

按任务加载 skill references：

- 改 Host/Core/Plugin/Desktop/Service/Shared 边界时，读 `references/module-boundaries.md`。
- 改身份、角色、权限、菜单、数据范围、工作区缓存时，读 `references/permission-data-scope.md`。
- 改 API、前后端契约、分页、错误码、请求上下文时，读 `references/api-contracts.md`。
- 改 IPC、事件、订阅、消费、桌面桥、事件总线时，读 `references/event-communication.md`。
- 抽取或更新独立项目基础框架模板时，读 `references/template-extraction.md`。
- 初始化新独立项目时，使用 `template/skills/kycrm-initialize-project`。
- 创建后台插件或业务模块时，使用 `template/skills/kycrm-create-module`。

## 解决方案规则

- 保持 monorepo 契约，除非用户明确要求拆仓。
- 保持 Host、Core、Plugins、Desktop、Services、Shared、Ops、Docs、Template 职责分离。
- 优先沿用仓库现有模式和共享契约，再考虑新增抽象。
- 插件不得直接接管登录、bootstrap、工作区切换、全局布局、桌面桥或 request client。
- Electron main 不维护角色、权限、菜单、工作区策略等业务上下文。
- 后端服务按领域事实拆分，不允许跨服务直接穿透对方私有表完成业务。
- 修改跨模块边界时同步更新 docs 或 template references。

## 模板规则

准备或更新基础框架模板时：

1. 携带解决方案 docs、仓库治理 docs、通信规范和本 skill。
2. 携带 `references/*.md`，至少包括模块边界、权限与数据范围、API 契约、事件通信、模板抽取规范。
3. 模板示例不得包含生产域名、密钥、客户数据、构建产物、本地截图或真实日志。
4. 新项目应使用占位环境变量启动，并能完成本地构建。
5. 任一规范变更时，同步更新对应 docs 和 skill reference。

## 任务闸口

- 新模块或重构：先过 `module-boundaries`。
- 新权限点、菜单、角色、数据查询：先过 `permission-data-scope`。
- 新接口或修改接口返回：先过 `api-contracts`。
- 新事件、订阅、IPC、桌面能力：先过 `event-communication`。
- 新独立项目模板：先过 `template-extraction`。
- 初始化新独立项目：使用 `kycrm-initialize-project`。
- 创建后台插件或业务模块：使用 `kycrm-create-module`。

## 验证

架构、模板、文档类变更运行：

```bash
git diff --check
python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/aicrm-solution
```

实现类变更还要运行仓库中最近的 package/service typecheck、build 或 test 命令。
