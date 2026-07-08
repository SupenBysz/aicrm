---
name: kycrm-create-module
description: KyCRM 模块创建指南。Use when Codex needs to create a new KyCRM admin module, admin plugin, or full business module; scaffold plugin files, Go service code, database migration and permission seed, menu/route/permission placeholders, register a plugin into admin host, register a backend service, generate Ant Design list pages, or validate newly created plugin/business modules.
---

# KyCRM Create Module

## 概览

使用本 skill 创建 KyCRM 后台插件模块或完整业务模块。它约束插件命名、脚手架命令、菜单/路由/权限占位、前端 API client、Go 服务、数据库脚本、列表页规范和验证流程。

## 基本规则

- 创建完整业务模块时优先使用 `scripts/create_business_module.sh`；只需要前端插件页面时使用 `scripts/create_admin_plugin.sh`。
- 不要手工复制旧插件或旧 Go 服务作为新模块起点。
- 新插件默认落在 `plugins/ky-<slug>`，包名默认 `@ky/plugin-<slug>`。
- 新业务服务默认落在 `services/ky-<slug>-service`。
- 页面脚手架必须使用 `ListPageCard`，标题和副标题放在列表卡片外。
- 筛选控件放在 `ListPageCard.toolbar`，状态筛选使用 `Segmented`。
- 操作列使用 `table-action-column` 和 `table-action-grid`，并设置横向滚动。
- 权限点必须同步前端权限、后端权限校验和 `ops/db` 权限种子。
- 只有前端插件脚手架需要用户明确要求时才使用 `--register-host`；完整业务模块脚手架默认注册 host、服务构建、部署清单和 Nginx，可用 skip 参数关闭。

## 工作流程

1. 判断用户要“前端插件”还是“完整业务模块”。
2. 完整业务模块：读取 `references/business-module-scaffold.md`，确认 slug、标题、字段、工作区类型、API 路径、服务名和端口。
3. 前端插件：读取 `references/admin-plugin-scaffold.md`，确认 slug、标题、路由、导航分组、权限前缀。
4. 读取 `references/permission-menu-api-rules.md`，检查菜单、路由、权限、API 和 SQL 权限种子是否符合规范。
5. 读取 `references/validation-checklist.md`，执行新模块验证。

## Reference 加载规则

- 创建完整业务模块时，读 `references/business-module-scaffold.md`。
- 创建后台插件脚手架时，读 `references/admin-plugin-scaffold.md`。
- 设计权限、菜单 key、路由、API 路径时，读 `references/permission-menu-api-rules.md`。
- 生成后验证、host 注册验证和 typecheck 时，读 `references/validation-checklist.md`。

## 和其他 Skill 的关系

- 项目初始化使用 `kycrm-initialize-project`。
- 架构边界、权限数据范围和 API 契约仍遵循 `aicrm-solution`。
- 列表页布局遵循后台列表页规范：标题在卡片外、toolbar 在卡片 header、批量操作在新增按钮左侧。
