# 模块边界规范

本规范用于新增模块、调整职责、拆分公共能力、抽取模板或评审跨模块改动。

## 基础分层

```text
apps/ky-admin-host        后台 Host：登录、bootstrap、工作区、布局、插件注册、request client、认证流和 Desktop adapter 注入
packages/ky-admin-core    前端契约：插件协议、菜单、路由、权限、工作区、request client 和稳定 Desktop Port 类型
plugins/ky-*              业务插件：页面、菜单、路由、权限点、工作台卡片、领域请求
apps/aicrm-desktop        Electron 客户端：窗口、preload 安全桥、本地 session、Vault、设备密钥、原生运行时和桌面能力
services/ky-*             Go 服务：按领域事实负责 API、权限校验、数据读写、审计
shared/                   Go 共享代码：跨服务公共工具和契约，不能承载具体业务流程
ops/                      migration、数据库角色与 GRANT、部署、seed、systemd、Nginx 和运行配置
docs/                     需求、架构、契约、实施锁定、治理规范
template/                 后续独立项目基础框架模板和解决方案级 skill
```

## Host 边界

Host 负责：

- 登录、注册、邀请接受、无身份、403 等通用页面。
- session 读取、bootstrap、工作区选择与切换。
- 顶部通栏、侧边栏、面包屑、全局通知、锁屏等壳层能力。
- 聚合插件菜单、路由、Header action 和工作台 contribution。
- 注入 request client、QueryClient、权限上下文、工作区上下文和稳定 Desktop Port。
- 建立带认证和 workspace Header 的 SSE/fetch stream，并提供非 Desktop 降级。

Host 不负责：

- 具体业务管理页面。
- 插件内部表单、列表、详情业务。
- 绕过插件协议硬编码业务菜单。
- 直接承载业务服务的领域规则。
- 直接管理 Electron Partition、Vault、App Server 或设备私钥。

## Core 边界

Core 只放跨插件稳定契约：

- 插件 manifest、菜单、路由、权限、工作区、request client 类型。
- 共享 UI/运行时协议可以放入 Core，但必须服务多个插件或 Host。
- Desktop Port 只描述稳定 Command、Query、事件和安全结果，不读取实际 bridge。

Core 不放：

- 具体业务 API 调用。
- 某个插件私有模型。
- 登录、session、桌面桥实现。
- `window.aicrm`、IPC channel 或 Electron 运行时代码。
- 只有一个页面使用的工具函数。

## Plugin 边界

插件负责自己的业务：

- 声明菜单、路由、权限点和页面组件。
- 通过 Host 提供的 request client 调 API。
- 通过 Host 注入的 Desktop Port 使用原生能力。
- 按当前工作区上下文查询和展示数据。
- 在插件内部维护领域 UI 状态。

插件禁止：

- 直接读取 token 或自行拼认证 Header。
- 直接控制全局布局、工作区切换、登录跳转。
- 直接访问 `window.aicrm` 或 Electron IPC。
- 自行创建带 token 的 SSE、WebSocket 或 internal API 请求。
- 修改其他插件的私有状态。

## Desktop 边界

Electron 负责原生能力：

- 自定义窗口、最大化、最小化、关闭、全屏、置顶。
- preload 安全桥、能力白名单、本地 session、网络日志、调试入口。
- WebSpace/Partition、Session Vault、受限方法执行、系统浏览器、设备私钥和本地 App Server 生命周期。
- 校验服务端签发且绑定 purpose、operation、device、revision 和 expiry 的 Command Ticket，并提交设备签名结果。

Electron 禁止：

- 校验账号密码。
- 维护角色、权限、菜单、业务工作区策略。
- 根据页面 URL 猜测业务状态。
- 持有 LoginAttempt phase、账号绑定决策、业务 nextActions 或 workspace rollout 真相。
- 把凭据、Cookie、Storage、验证码、原始 App Server 协议或本地路径暴露给 Renderer。
- 向 Web 暴露 `ipcRenderer` 原始对象。

## Service 边界

服务按领域事实拆分：

- `ky-auth-service`：用户、凭据、登录、token、bootstrap、平台用户基础管理。
- `ky-org-service`：机构、企业、部门、团队、系统设置、字典。
- `ky-membership-service`：成员、邀请、角色、权限、数据范围、审计、通知公告。
- `ky-ai-model-service`：API Provider、API 模型及其平台默认配置。
- `ky-matrix-account-service`：矩阵账号、LoginAttempt、WebSpace 业务投影、脚本、契约、generation run、绑定和 receipt。
- `ky-agent-executor-service`：执行器、workspace grant、授权、executor-bound device、credential、model catalog、readiness 和 executor task/event/raw-log。

`ky-ai-model-service` 在 v9.1 目标态只拥有 API Provider、API Model 和迁移期 legacy provider；不能继续拥有 Agent Executor 领域事实。详细范围以仓库当前已锁定架构为准。

服务禁止：

- 为了页面方便直接跨领域穿透对方私有表。
- 让前端权限隐藏代替后端权限校验。
- 在无 workspace 校验的情况下返回租户数据。
- 建立跨服务私表外键，或把另一个服务的表当作本服务查询模型。
- 在所有权迁移中 dual-write，或在新写者产生数据后重新授权旧写者。

## Shared 边界

Shared 可以放：

- 统一 envelope、错误、请求哈希、签名、脱敏、认证中间件和通用 outbox 工具。
- 无业务迁移逻辑的跨服务稳定 DTO。

Shared 禁止放：

- LoginAttempt、授权会话、任务或绑定状态机。
- 领域 Store、repository、跨服务聚合查询和服务私表模型。

## 跨服务通信边界

- 跨服务 ID 是 opaque reference，不建数据库外键。
- internal API 只允许 loopback/受控内网，并校验 internal credential 与 request ID。
- transactional outbox/NATS 只发布版本化安全引用；消费者按 event ID 和资源 ID 幂等，正文通过拥有者 internal API 获取。
- NATS 不是状态、任务或事件表的替代品；消息丢失由数据库 reconciler 收敛。
- table-owner manifest、数据库角色和表级 GRANT 是服务边界验收的一部分。

## 变更检查

跨模块变更提交前回答：

- 这个能力属于 Host、Core、Plugin、Desktop、Service、Shared、Ops 还是 Template？
- 是否出现插件接管 Host 职责？
- 是否出现 Electron 持有业务权限/角色/菜单？
- 是否出现服务之间绕过 API/契约穿透私有表？
- 是否建立跨服务外键，或缺少 table-owner manifest、DB role/GRANT？
- 异步事件是否使用 outbox、安全引用、幂等消费和 reconciler？
- 所有权迁移是否保持单写者，并有 freeze/drain、cutover 和回滚分界？
- 是否需要更新 architecture、API、permission、communication 或 template 文档？
