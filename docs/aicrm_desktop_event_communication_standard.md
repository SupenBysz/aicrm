# AiCRM Desktop 客户端事件通讯规范

> 文档状态：建议规范 / 待按阶段落地
> 覆盖状态：第 1–16 节保留既有渐进基线；第 17 节为 Post-Phase1 v9.1 锁定扩展
> 项目名称：KyaiCRM / AiCRM Desktop
> 编写日期：2026-07-07
> 适用范围：`apps/aicrm-desktop`、`apps/ky-admin-host` 中桌面客户端桥接能力、窗口能力、会话能力、网络日志能力、后续登录与工作区业务事件
> 当前实现基线：
> - `apps/aicrm-desktop/src/shared/constants.ts`
> - `apps/aicrm-desktop/src/shared/types.ts`
> - `apps/aicrm-desktop/src/main/ipc/*`
> - `apps/aicrm-desktop/src/preload/bridge.ts`
> - `apps/aicrm-desktop/src/preload/window-chrome.ts`
> - `apps/ky-admin-host/src/desktop-client.ts`
> - `docs/kyai_crm_v9_execution_architecture.md`（Post-Phase1 v9.1 扩展）

---

## 1. 背景与目标

AiCRM Desktop 当前采用混合方案：

```text
Electron 主进程
    │
    ├── 管理窗口、系统能力、会话文件、网络日志捕获
    │
    ▼
Preload 安全桥
    │
    ├── contextBridge 暴露 window.aicrm
    ├── 注入自定义窗口 chrome
    │
    ▼
Web 后台 / Renderer
    │
    ├── 登录、工作区、权限、通知、业务页面
    └── 通过能力检测进入客户端模式
```

随着登录、工作区、多身份、锁屏、通知、网络日志、窗口置顶、全屏、后续本地缓存和客户端专属能力逐步增加，如果 IPC、订阅和进程内事件没有统一边界，后续会出现：

1. 业务模块直接调用 Electron 能力，导致 Web 与桌面耦合。
2. 事件监听散落在页面中，路由切换后无法可靠释放。
3. 登录、会话、工作区切换事件重复触发或顺序不稳定。
4. 主进程误持有过多业务状态，导致权限和账号体系难维护。
5. 网络日志、调试、锁屏等桌面能力泄露敏感信息。

本规范目标：

1. 统一主进程、preload、Web/Renderer 之间的通讯分层。
2. 明确命令、查询、订阅事件、进程内事件的使用边界。
3. 为登录复杂化、多身份和工作区上下文扩展预留稳定事件模型。
4. 保持当前实现可渐进迁移，不要求一次性大重构。

---

## 2. 总体原则

### 2.1 单向职责边界

```text
主进程 main
  只负责原生能力、系统窗口、系统会话存储、网络捕获、应用版本、进程生命周期。

preload
  只负责安全桥接、能力白名单、参数适配、订阅释放，不做业务决策。

Web 后台 / Renderer
  负责登录态、工作区、权限、菜单、业务流程和页面内状态。
```

约束：

1. 主进程不得依赖具体业务页面、菜单、角色、权限点。
2. Web 业务模块不得直接 import Electron、`ipcRenderer`、`ipcMain`。
3. Web 业务模块不得直接散落访问 `window.aicrm`，必须通过 `apps/ky-admin-host/src/desktop-client.ts` 或后续统一 adapter。
4. 所有 IPC channel 必须集中定义在 `apps/aicrm-desktop/src/shared/constants.ts`，禁止页面或 handler 中写魔法字符串。
5. 所有跨进程 payload 必须定义在 `apps/aicrm-desktop/src/shared/types.ts` 或后续拆分的 `shared/events.ts`。

### 2.2 通讯类型分层

| 类型 | 方向 | 技术方式 | 用途 | 当前示例 |
| --- | --- | --- | --- | --- |
| Command | Web -> preload -> main | `ipcRenderer.invoke` / `ipcMain.handle` | 执行有副作用的原生动作 | `window:minimize`、`window:set-full-screen`、`session:save` |
| Query | Web -> preload -> main | `ipcRenderer.invoke` / `ipcMain.handle` | 获取快照，无订阅 | `window:get-state`、`network-log:snapshot`、`app:get-version` |
| Native Event | main -> preload/Web | `webContents.send` / `ipcRenderer.on` | 原生状态变化通知 | `window:state-changed` |
| Web Local Event | Web 进程内 | 统一事件总线 | 登录成功、工作区切换、锁屏状态变化等 Web 内部解耦 | 待补齐 |
| DOM Event / Storage Event | Web 进程内辅助 | `CustomEvent`、`storage` | 仅限兼容旧代码或跨标签页广播 | 不作为桌面通信标准 |

结论：

1. 需要返回结果的动作使用 Command/Query。
2. 状态被主进程改变且 Web 需要被动感知时使用 Native Event。
3. 纯业务状态变化优先使用 Web Local Event，不进入 Electron IPC。
4. 不允许用 DOM event 模拟 main/preload/renderer 跨进程通信。

---

## 3. 当前实现基线

### 3.1 已有 IPC 域

```text
api          api:request
app          app:get-config / app:get-version
session      session:load / session:save / session:clear
window       window:get-state / window:minimize / window:toggle-maximize
             window:set-full-screen / window:set-always-on-top
             window:open-devtools / window:close / window:state-changed
network-log  network-log:snapshot / network-log:clear
```

### 3.2 已有 bridge

preload 暴露：

```text
window.aicrm.api.request()
window.aicrm.app.getConfig()
window.aicrm.app.getVersion()
window.aicrm.session.load()
window.aicrm.session.save()
window.aicrm.session.clear()
window.aicrm.window.getState()
window.aicrm.window.minimize()
window.aicrm.window.toggleMaximize()
window.aicrm.window.setFullScreen()
window.aicrm.window.setAlwaysOnTop()
window.aicrm.window.openDevTools()
window.aicrm.window.close()
window.aicrm.window.onStateChanged()
window.aicrm.network.getSnapshot()
window.aicrm.network.clear()
```

其中 `window.aicrm.window.onStateChanged(listener)` 已符合订阅接口基本规范：返回 `() => void` 释放函数。

### 3.3 当前需要保留的兼容点

1. `window:state-changed` 当前直接发送 `DesktopWindowState`，短期保留，不强制改 envelope。
2. `preload/window-chrome.ts` 当前为了自定义窗口按钮会直接订阅 `window:state-changed`，可以保留为 preload 内部实现。
3. Web 后台通过 `window.aicrm?.app?.getVersion` 做客户端模式判断，短期保留。
4. Matrix Account、Agent Executor、App Server、authenticated SSE 与 NATS 的新增通信不得套用本节 legacy bridge 推导，统一按第 17 节执行。

---

## 4. IPC Channel 命名规范

### 4.1 物理 channel

统一使用：

```text
<domain>:<action>
<domain>:<event>
```

示例：

```text
window:get-state
window:set-full-screen
window:state-changed
network-log:snapshot
network-log:entry-added
auth:session-changed
workspace:changed
```

命名要求：

1. domain 使用小写短横线或小写单词，例如 `window`、`network-log`。
2. action 使用动词短语，例如 `get-state`、`set-full-screen`、`clear`。
3. event 使用过去式或状态变化名，例如 `state-changed`、`entry-added`、`session-expired`。
4. 新 channel 必须先加入 `IPC_CHANNELS`，再实现 main/preload/web。

### 4.2 Bridge 逻辑命名

`window.aicrm` 使用领域对象加 camelCase 方法：

```ts
window.aicrm.window.getState()
window.aicrm.window.onStateChanged(listener)
window.aicrm.network.getSnapshot()
window.aicrm.auth?.onSessionChanged(listener)
```

规则：

1. `getXxx` 表示查询快照。
2. `setXxx` 表示设置原生状态。
3. `openXxx`、`closeXxx`、`clearXxx` 表示有副作用命令。
4. `onXxx` 表示订阅事件，必须返回 unsubscribe。

---

## 5. Command / Query 规范

### 5.1 使用场景

Command/Query 适用于：

1. 窗口控制：最小化、最大化、全屏、置顶、关闭。
2. 应用信息：版本、运行配置、平台能力。
3. 本地会话存储：读取、保存、清理。
4. 网络日志：快照读取、清空、开关。
5. 后续本地能力：安全存储、文件选择、下载、自动更新。

不适用于：

1. 页面内部 UI 展开收起。
2. 权限、菜单、角色判断。
3. 工作区选择状态的普通页面联动。
4. 表单编辑、列表查询等纯 Web 业务。

### 5.2 返回值

当前简单能力可以继续返回直接结果，例如：

```ts
window.aicrm.window.getState(): Promise<DesktopWindowState>
```

新增复杂能力建议使用标准结果：

```ts
export interface DesktopCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}
```

要求：

1. 通讯失败可以 throw，业务失败应返回结构化 `error`。
2. 不把原始 Electron error、Node stack、系统路径直接透传到 Web。
3. `requestId` 用于关联日志和后续排障。
4. 幂等命令要明确幂等，例如重复 `setFullScreen(true)` 不应视为失败。

### 5.3 参数校验

主进程 handler 必须校验外部输入：

```text
Boolean 参数显式 Boolean(value)
枚举参数检查白名单
对象 payload 检查必填字段和类型
URL / path 不允许任意访问本机文件
```

preload 可以做轻量适配，但安全校验必须在 main 再做一次。

---

## 6. Native Event 订阅规范

### 6.1 标准接口

所有 Native Event 在 bridge 中必须以 `onXxx` 暴露：

```ts
type Unsubscribe = () => void;

const unsubscribe = window.aicrm.window.onStateChanged((state) => {
  // handle state
});
```

要求：

1. `onXxx` 必须返回释放函数。
2. React 中必须在 `useEffect` cleanup 调用释放函数。
3. listener 不得依赖会变化但未闭包更新的业务上下文。
4. listener 内异常不得影响 preload 后续事件分发。
5. 订阅事件只传 JSON 可序列化对象。

React 使用示例：

```tsx
useEffect(() => {
  const bridge = getDesktopBridge();
  const unsubscribe = bridge?.window?.onStateChanged?.((state) => {
    setWindowState(state);
  });

  return () => {
    unsubscribe?.();
  };
}, []);
```

### 6.2 事件 Envelope

新增 Native Event 建议统一使用 envelope：

```ts
export interface DesktopEventEnvelope<TPayload = unknown> {
  id: string;
  name: string;
  version: 1;
  source: "main" | "preload" | "web";
  scope: "app" | "window" | "session" | "workspace" | "network" | "notification" | "system";
  occurredAt: string;
  correlationId?: string;
  payload: TPayload;
}
```

示例：

```ts
export interface WorkspaceChangedPayload {
  previousWorkspaceId?: string | null;
  workspaceId: string;
  workspaceType: "platform" | "agency" | "enterprise";
}

export type WorkspaceChangedEvent = DesktopEventEnvelope<WorkspaceChangedPayload>;
```

说明：

1. 当前 `window:state-changed` 可暂不迁移，作为 legacy event。
2. 后续新增 `auth:*`、`workspace:*`、`network-log:*` 事件应优先使用 envelope。
3. Web adapter 可以把 legacy event 包装成统一本地事件，避免业务层感知差异。

### 6.3 快照 + 订阅组合

对状态类事件，必须同时提供：

```text
getSnapshot/getState 查询当前值
onXxxChanged 订阅后续变化
```

原因：订阅只保证未来变化，不保证订阅前状态。

示例：

```text
aicrm.window.getState + aicrm.window.onStateChanged
network.getSnapshot + network.onEntryAdded / network.onCleared
auth.getSession + auth.onSessionChanged
```

### 6.4 订阅与消费职责

订阅只负责建立监听关系，消费负责把事件转换为页面、store 或业务状态变化。两者必须分开治理。

订阅规则：

1. Native Event 只能通过 `window.aicrm.<domain>.onXxx()` 或 Web adapter 暴露的包装方法订阅。
2. React 组件内订阅必须放在 `useEffect`，并在 cleanup 中释放。
3. 共享事件只允许在布局、store、provider、面板入口等稳定生命周期位置订阅，禁止散落在列表行、表单项、临时弹层中。
4. 同一业务域只保留一个主订阅入口，再由本地事件总线或 store 分发给页面。
5. 订阅回调不得直接执行高风险副作用，例如登出、关闭窗口、清理全部缓存；这类动作必须进入明确的 command 或业务 action。

消费规则：

1. 消费方必须具备幂等性，同一事件重复到达时不应造成重复提示、重复跳转、重复请求或重复写入。
2. 消费方必须校验当前登录态、工作区、权限和页面上下文，丢弃过期 workspace/session 的事件。
3. 消费方需要补齐初始快照，不能只依赖订阅事件；状态类能力必须先 `getState/getSnapshot`，再订阅增量变化。
4. 消费方不得持久化或广播敏感字段；如事件 payload 含脱敏字段，也只能用于展示或排障。
5. 事件消费失败必须被捕获并记录，不允许异常向上破坏后续事件分发。

推荐消费链路：

```text
main Native Event
  -> preload 安全桥 onXxx
  -> desktop-client.ts adapter
  -> app-event-bus/store
  -> 页面组件消费派生状态
```

不推荐：

```text
页面组件直接 window.aicrm.*.onXxx
页面路由切换时重复订阅
订阅回调里直接改全局登录态且不校验上下文
```

### 6.5 模板化要求

本规范是后续独立项目基础框架模板的一部分。生成或复制新解决方案模板时必须携带：

```text
docs/aicrm_desktop_event_communication_standard.md
template/skills/aicrm-solution/SKILL.md
template/skills/aicrm-solution/references/event-communication.md
```

当前仓库中的模板源文件位于 `template/docs/aicrm_desktop_event_communication_standard.md`；初始化新独立项目后应落到项目根目录的 `docs/` 下。

要求：

1. 修改桌面桥、IPC、Web 事件总线、订阅/消费模式前，必须先阅读解决方案级 skill 和本规范。
2. 模板中的 skill 必须显式关联本通信规范，并说明何时加载 `references/event-communication.md`。
3. 若本规范调整了订阅、消费、事件 envelope、channel 命名或安全边界，必须同步更新模板 skill 的通信引用。
4. 新项目初始化后，通信规范文档应保留在 `docs/` 下，作为架构评审和代码评审的固定输入。

---

## 7. Web 进程内事件规范

### 7.1 使用边界

以下事件属于 Web 业务事件，不应默认进入 Electron 主进程：

```text
auth.loginSucceeded
auth.loggedOut
auth.tokenRefreshed
auth.sessionExpired
workspace.changed
workspace.identityChanged
permission.changed
theme.changed
lock.locked
lock.unlocked
notification.unreadCountChanged
```

这些事件用于 Web 内部模块解耦，例如顶部栏、路由守卫、插件、请求客户端、锁屏层之间同步状态。

只有当原生能力需要参与时，才通过 bridge 转换成 IPC，例如：

1. 登录成功后保存本地 session。
2. 登出后清理本地 session。
3. 锁屏后需要阻止窗口关闭或触发系统层能力。
4. 全屏、置顶、网络日志等需要 Electron 能力。

### 7.2 推荐本地事件总线

后续建议在 `apps/ky-admin-host/src` 增加轻量事件总线，例如：

```ts
type AppEventName =
  | "auth.loginSucceeded"
  | "auth.loggedOut"
  | "workspace.changed"
  | "lock.locked"
  | "lock.unlocked"
  | "theme.changed";

type AppEventHandler<T> = (payload: T) => void;

interface AppEventBus {
  emit<T>(name: AppEventName, payload: T): void;
  on<T>(name: AppEventName, handler: AppEventHandler<T>): () => void;
}
```

要求：

1. 业务模块之间只订阅语义事件，不互相调用页面组件方法。
2. `on` 必须返回释放函数。
3. 事件名称必须集中定义。
4. 禁止把 token、密码、完整用户敏感资料作为事件 payload 广播。

---

## 8. 登录、会话、工作区事件治理

### 8.1 登录流程边界

当前客户端登录采用纯 Web 登录 + 桌面壳能力。标准流程应保持：

```text
用户提交登录
  │
  ▼
Web API 登录请求
  │  附加 X-AiCRM-Client-Mode / clientMode
  ▼
服务端返回 token / bootstrap
  │
  ├── Web 更新登录态、用户、工作区
  ├── Web 触发 auth.loginSucceeded 本地事件
  └── 如需要持久化，再调用 window.aicrm.session.save()
```

要求：

1. 登录成功与否由 Web/API 决定，主进程不参与账号密码校验。
2. 主进程最多保存必要 session，不保存密码。
3. 客户端模式标识继续由请求头和登录 payload 注入，不通过隐藏 IPC 传递。
4. 服务端需要知道客户端能力时，通过 API capability 字段或 headers 处理。

### 8.2 登出流程

标准流程：

```text
Web 发起登出
  │
  ├── 清理 Web session / Query cache / 工作区上下文
  ├── 调用 window.aicrm.session.clear()
  ├── 触发 auth.loggedOut 本地事件
  └── 跳转登录页
```

要求：

1. 本地 session 清理失败不能让 UI 停在半登出状态，但必须记录错误。
2. 登出事件可以被通知、锁屏、网络日志入口订阅，用于清理 UI。
3. 登出不应由主进程主动跳转页面，除非后续设计了统一导航 command。

### 8.3 工作区切换

工作区切换是 Web 业务状态：

```text
workspace.changed
  payload:
    previousWorkspaceId
    workspaceId
    workspaceType
    displayName
```

要求：

1. 菜单、面包屑、权限、列表查询上下文通过 Web 状态更新。
2. 主进程默认不感知 workspace。
3. 如果后续需要按工作区隔离本地缓存，必须新增明确的 `workspace:changed` IPC 事件或 command，不允许主进程从 URL 猜测。

### 8.4 锁屏

锁屏属于 Web UI 安全态，窗口控制属于原生能力：

```text
lock.locked / lock.unlocked      Web Local Event
window:minimize / window:close   Native Command
```

要求：

1. 锁屏覆盖 UI 不应覆盖原生窗口控制按钮。
2. 解锁失败只提示密码错误，不跳登录页。
3. 锁屏背景拖拽窗口属于 preload/window chrome 能力，不把拖拽细节暴露给业务模块。
4. 锁屏事件 payload 不允许包含明文密码。

---

## 9. 网络日志事件规范

当前网络日志只支持快照与清空：

```text
network-log:snapshot
network-log:clear
```

后续建议补充订阅：

```text
network-log:entry-added
network-log:cleared
network-log:enabled-changed
```

规则：

1. 网络日志默认不记录 Authorization、Cookie、Set-Cookie、请求体中的密码/token。
2. UI 展示日志时以快照为准，订阅事件只做增量刷新。
3. 清空日志必须同步发出 `network-log:cleared`，避免面板状态不一致。
4. 生产环境是否开放网络日志入口由运行模式和权限共同控制。

---

## 10. 安全规范

### 10.1 preload 安全桥

必须保持：

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
不暴露 ipcRenderer 原始对象
只暴露 window.aicrm 白名单能力
```

禁止：

1. `contextBridge.exposeInMainWorld("ipcRenderer", ipcRenderer)`。
2. Web 页面传入任意 channel 名称由 preload 转发。
3. Web 页面传入任意本机路径让 main 读取。
4. 生产模式开放 devtools、view-source、任意外部跳转。

### 10.2 敏感信息

以下数据禁止进入广播事件和网络日志：

```text
明文密码
验证码
完整 token
Authorization / Cookie
用户私钥或后续本地密钥
未脱敏手机号 / 邮箱批量列表
```

如必须定位问题，使用脱敏字段：

```text
tokenPrefix
maskedPhone
maskedEmail
requestId
userId
workspaceId
```

v9.1 的 command ticket、claim/proof/receipt、设备签名、App Server 原始输出、路径、DOM、截图和二维码原文还必须满足第 17 节的专用信任平面规则。

---

## 11. 版本与兼容

### 11.1 Bridge 能力检测

Web 调用桌面能力前必须做能力检测：

```ts
const bridge = getDesktopBridge();
if (bridge?.window?.setFullScreen) {
  await bridge.window.setFullScreen(true);
}
```

后续建议增加：

```ts
window.aicrm.app.getCapabilities(): Promise<DesktopCapabilities>
```

示例：

```ts
export interface DesktopCapabilities {
  bridgeVersion: 1;
  platform: string;
  supportsFullScreen: boolean;
  supportsAlwaysOnTop: boolean;
  supportsNetworkLog: boolean;
  supportsSecureSession: boolean;
}
```

### 11.2 兼容策略

1. 已发布 bridge 方法不直接删除，至少保留一个中间版本。
2. 新增参数必须可选或新增方法，不破坏旧调用。
3. 事件 payload 新增字段可以兼容，重命名/删除字段必须升版本。
4. Web 必须能在非桌面浏览器环境正常运行。
5. v9.1 Bridge v2 与 legacy Bridge 的兼容窗口、结构化失败和移除条件按第 17 节执行，不能把保留旧 ABI 理解为允许继续执行不可信授权或状态回写。

---

## 12. 新增通讯能力落地流程

新增一个 IPC 能力时，按以下顺序执行：

```text
1. shared/constants.ts 增加 IPC_CHANNELS 常量
2. shared/types.ts 或 shared/events.ts 增加 payload/result 类型
3. main/ipc/<domain>-ipc.ts 实现 ipcMain.handle 或事件发送
4. main/index.ts 注册 handler
5. preload/types.ts 扩展 bridge 类型
6. preload/bridge.ts 暴露安全方法或 onXxx 订阅
7. apps/ky-admin-host/src/desktop-client.ts 增加 Web adapter 类型和能力检测
8. 页面或 store 只调用 Web adapter，不直接访问 window.aicrm
9. 为订阅类能力补充释放逻辑和基础测试
10. 更新本文档或对应模块设计文档
```

订阅类能力必须额外检查：

```text
是否返回 unsubscribe
React useEffect 是否 cleanup
是否有 getSnapshot/getState
是否避免敏感 payload
主进程窗口销毁后是否停止 send
```

---

## 13. 推荐目录演进

当前目录可以继续使用。后续能力增多后建议演进为：

```text
apps/aicrm-desktop/src/shared/
  constants.ts
  types.ts
  events.ts              # 统一事件 envelope 和事件 payload
  bridge-contract.ts     # bridge 版本、能力、公共结果类型

apps/aicrm-desktop/src/main/ipc/
  app-ipc.ts
  auth-ipc.ts
  network-ipc.ts
  window-ipc.ts
  workspace-ipc.ts       # 仅当主进程确实需要感知工作区

apps/aicrm-desktop/src/preload/
  bridge.ts
  types.ts
  safe-listener.ts       # 统一 on/off 包装、异常隔离
  window-chrome.ts

apps/ky-admin-host/src/
  desktop-client.ts      # Web 侧桌面能力 adapter
  app-event-bus.ts       # Web 本地事件总线
```

---

## 14. 阶段性落地建议

### Phase A：规范当前 IPC

1. 保持现有 `api/app/session/window/network` 域。
2. 给 `preload/bridge.ts` 增加统一 listener 包装，捕获 listener 异常。
3. 将 Web 侧所有桌面能力调用收敛到 `desktop-client.ts`。
4. 补充 `DesktopCapabilities`。

### Phase B：补充 Web 本地事件总线

1. 增加 `app-event-bus.ts`。
2. 登录、登出、工作区切换、锁屏、主题切换先走本地事件。
3. 顶部栏、插件、请求客户端只订阅事件，不互相耦合。

### Phase C：补充网络日志订阅

1. 增加 `network-log:entry-added`、`network-log:cleared`。
2. 网络日志面板采用快照 + 增量事件。
3. 增加敏感字段脱敏检查。

### Phase D：登录复杂化前治理 session

1. 明确 session 存储是否继续使用文件，或切换 Electron safeStorage。
2. 明确 refresh token 是否允许进入本地存储。
3. 增加 `auth.sessionChanged` 本地事件。
4. 只有确有必要时，才增加 `auth:session-changed` Native Event。

---

## 15. 评审清单

后续每新增一个客户端通讯能力，评审时必须回答：

```text
这是 Command、Query、Native Event 还是 Web Local Event？
是否必须经过 Electron 主进程？
channel 是否集中定义？
payload/result 是否有类型？
是否有敏感信息？
订阅是否返回 unsubscribe？
React 是否 cleanup？
是否有快照接口？
是否支持非桌面 Web 降级？
生产模式是否安全？
是否影响登录、工作区、权限边界？
```

---

## 16. 当前明确决策

1. 客户端登录继续以 Web 登录为主，Electron 不直接校验账号密码。
2. 主进程不维护工作区、角色、权限等业务上下文。
3. `window.aicrm` 是唯一桌面安全桥入口，Web 业务层通过 adapter 使用。
4. 订阅事件必须返回释放函数。
5. 新增复杂事件优先使用 envelope。
6. 纯 Web 业务联动优先使用 Web Local Event。
7. 网络日志和调试能力必须遵守生产模式与敏感信息脱敏规则。
8. Matrix Account、Agent Executor、App Server、SSE 与 NATS 扩展必须满足第 17 节，Renderer 不得成为可信结果中继或服务端事件消费者。

---

## 17. Post-Phase1 v9.1 Desktop、SSE 与 NATS 扩展

### 17.1 四个通信平面

| 平面 | 所有者与用途 | 禁止 |
| --- | --- | --- |
| Desktop IPC Bridge | Main/Preload/Host adapter；执行本地 Command、Query 和 Native Event | Plugin 直连 `window.aicrm`、任意 channel、任意路径 |
| Host authenticated SSE | Host request client；消费 LoginAttempt、authorization session、generation run 和 task 持久事件 | URL/query token、Plugin 自建连接、Native Event 代替业务真相 |
| Server internal API | Matrix 与 Agent Executor 的受控同步决策/任务接口 | 公共 Nginx 暴露、普通 Bearer 模拟 internal caller |
| Server NATS | transactional outbox 发布的 at-least-once 安全引用 | Renderer 消费、携带凭据/DOM/截图/原始输出、代替数据库状态 |

四个平面不得混用。数据库与服务端资源是业务真相；Native Event 只表达本地临时态，NATS 只负责服务间唤醒和安全引用传递。

### 17.2 Bridge v2 Command Ticket

- 有副作用的本地操作必须由服务端签发单次 command/claim ticket，至少绑定 `audience`、`purpose`、`operationId`、`deviceId`、目标 runtime/resource revision、expiry 与 nonce。
- Main 必须在执行前验签、校验目标仍是当前 revision 并原子消费；过期、重复、跨设备、跨 purpose 或 stale target 一律拒绝。
- 完成 ACK/PoP 由 Main 直接提交到对应受信端点，并以设备 Ed25519 签名覆盖完整 HTTP 请求；Renderer/Plugin 不得转发 proof、receipt、Cookie、Storage 或原始执行结果。
- Renderer 仅提供裸 executorId、attemptId、webSpaceId、路径或本地布尔值，不能触发授权提升、credential 删除、Vault seal/restore/cleanup 或其他本地写操作。
- Desktop-side App Server 只由 Main 通过父子进程 stdio 管理；server-side App Server 由 Agent Executor 管理。不得向 Plugin 暴露原始 JSON-RPC、socket、进程命令、CODEX_HOME 或文件路径。Desktop flow 的授权 URL 只留在 Main；server device-code 的发起人可经 `/user-action` 安全投影查看 `verificationUrl/userCode/sessionDeadlineAt`，响应必须 no-store 且不得持久化，不能来自 Desktop bridge 或原始 App Server 输出。

### 17.3 Native Event 一致性

- Port/Bridge 新订阅必须返回 `unsubscribe`，Host 保持单一主订阅，React/store cleanup 必须释放 listener、timer、reader 与 AbortController。
- 非持久事件固定使用“先订阅并缓冲 → 读取带 sequence 的 snapshot → 按 sequence 排空”流程；gap、buffer overflow 或 runtime epoch 变化时重新读取 snapshot。
- Envelope 必须版本化并携带 `operationId`、runtime session/epoch、单调 `nativeSequence` 和 opaque scope；不得携带业务 `nextActions`、binding decision、receipt、二维码 data URL、DOM、截图、凭据或账号原文。唯一已锁定例外是 `codex.authorization.changed`：它投影 Main 持久 session 而非一次 operation，固定使用 `correlationId=sessionId`、`payload.sequence=durable nativeSequence`，跨进程重启继续单调，不重复增加 operationId 或 runtime epoch。
- Main 只维护原生 operation journal，不维护 Attempt phase、角色、权限、workspace rollout 或业务绑定决策。

### 17.4 持久 SSE

- Host authenticated request client 建立 SSE 并注入 Authorization/workspace Header；Plugin 只消费注入的 Port/store，不接触 token 或底层 reader。
- 页面先读取服务端 snapshot，再以 snapshot sequence 读取 history/SSE；`Last-Event-ID` 优先于 `after`，每个持久事件占唯一 sequence，15 秒无 id heartbeat。
- 断线、切 workspace、路由卸载或权限失效必须 abort reader 并释放订阅；重连按 cursor 补齐，不能以轮询结果倒退状态机。
- 终端 ANSI projection 与结构化事件来自同一脱敏 task event source；xterm.js 只读展示，不形成 PTY/TUI 或第二控制通道。

### 17.5 NATS 与 outbox

- 发布方在业务事务内写 outbox，dispatcher 事务后发送；消费者按 `eventId` 和资源 ID 幂等，成功物化本地状态后才 ACK。
- Payload 只包含事件 ID、opaque 资源 ID、workspace type/id、状态与时间等安全引用；消费者需要结果时再调用受控 internal API。
- NATS 丢失、重复、乱序或消费者崩溃由数据库状态、request registry 与 reconciler 收敛。Renderer、Preload 与 Plugin 永不连接 NATS。

### 17.6 兼容与移除

legacy Bridge 最多保留一个明确的平台发布版本，只能返回结构化兼容错误或只读安全投影；不得在兼容名义下继续探测全局凭据、启动旧授权命令或接受 Renderer 状态回写。Bridge v2、Host adapter、设备签名和对应 E2E 全部通过后，下一版本删除 legacy channel/DTO/handler，并保留墓碑测试防止恢复。
