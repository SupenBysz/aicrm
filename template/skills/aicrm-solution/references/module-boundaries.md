# 模块边界规范

本规范用于新增模块、调整职责、拆分公共能力、抽取模板或评审跨模块改动。

## 基础分层

```text
apps/ky-admin-host        后台 Host：登录、bootstrap、工作区、布局、路由挂载、插件注册、request client
packages/ky-admin-core    前端契约：插件协议、菜单、路由、权限、工作区、Header action、Workbench contribution
plugins/ky-*              业务插件：页面、菜单、路由、权限点、工作台卡片、领域请求
apps/aicrm-desktop        Electron 客户端：窗口、preload 安全桥、本地 session、网络日志、桌面能力
services/ky-*             Go 服务：按领域事实负责 API、权限校验、数据读写、审计
shared/                   Go 共享代码：跨服务公共工具和契约，不能承载具体业务流程
ops/                      数据库、部署、seed、运行配置
docs/                     需求、架构、契约、实施锁定、治理规范
template/                 后续独立项目基础框架模板和解决方案级 skill
```

## Host 边界

Host 负责：

- 登录、注册、邀请接受、无身份、403 等通用页面。
- session 读取、bootstrap、工作区选择与切换。
- 顶部通栏、侧边栏、面包屑、全局通知、锁屏等壳层能力。
- 聚合插件菜单、路由、Header action 和工作台 contribution。
- 注入 request client、QueryClient、权限上下文和工作区上下文。

Host 不负责：

- 具体业务管理页面。
- 插件内部表单、列表、详情业务。
- 绕过插件协议硬编码业务菜单。
- 直接承载业务服务的领域规则。

## Core 边界

Core 只放跨插件稳定契约：

- 插件 manifest、菜单、路由、权限、工作区、request client 类型。
- 共享 UI/运行时协议可以放入 Core，但必须服务多个插件或 Host。

Core 不放：

- 具体业务 API 调用。
- 某个插件私有模型。
- 登录、session、桌面桥实现。
- 只有一个页面使用的工具函数。

## Plugin 边界

插件负责自己的业务：

- 声明菜单、路由、权限点和页面组件。
- 通过 Host 提供的 request client 调 API。
- 按当前工作区上下文查询和展示数据。
- 在插件内部维护领域 UI 状态。

插件禁止：

- 直接读取 token 或自行拼认证 Header。
- 直接控制全局布局、工作区切换、登录跳转。
- 直接访问 `window.aicrm` 或 Electron IPC。
- 修改其他插件的私有状态。

## Desktop 边界

Electron 负责原生能力：

- 自定义窗口、最大化、最小化、关闭、全屏、置顶。
- preload 安全桥、能力白名单、本地 session、网络日志、调试入口。

Electron 禁止：

- 校验账号密码。
- 维护角色、权限、菜单、业务工作区策略。
- 根据页面 URL 猜测业务状态。
- 向 Web 暴露 `ipcRenderer` 原始对象。

## Service 边界

服务按领域事实拆分：

- `ky-auth-service`：用户、凭据、登录、token、bootstrap、平台用户基础管理。
- `ky-org-service`：机构、企业、部门、团队、系统设置、字典。
- `ky-membership-service`：成员、邀请、角色、权限、数据范围、审计、通知公告。
- `ky-ai-model-service`：AI 供应商、AI 模型、默认模型配置。

服务禁止：

- 为了页面方便直接跨领域穿透对方私有表。
- 让前端权限隐藏代替后端权限校验。
- 在无 workspace 校验的情况下返回租户数据。

## 变更检查

跨模块变更提交前回答：

- 这个能力属于 Host、Core、Plugin、Desktop、Service、Shared、Ops 还是 Template？
- 是否出现插件接管 Host 职责？
- 是否出现 Electron 持有业务权限/角色/菜单？
- 是否出现服务之间绕过 API/契约穿透私有表？
- 是否需要更新 architecture、API、permission、communication 或 template 文档？
