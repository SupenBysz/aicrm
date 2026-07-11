# AiCRM Desktop

AiCRM Desktop 是 KyaiCRM 的 Electron 桌面客户端工程，作为独立应用放在 `apps/aicrm-desktop`。

## 工程定位

- 不属于后台 Host + Plugin 体系。
- 不注册后台导航菜单。
- 通过现有 HTTP JSON API 复用账号、登录态、工作区和权限模型。
- 主窗口始终加载配置的远程后台页面，Electron 仅提供桌面窗口壳与受控原生能力；不存在本地 renderer 启动模式。

## 目录结构

```text
src/main/       Electron 主进程：窗口、菜单、配置、会话文件、IPC。
src/preload/    安全桥：通过 contextBridge 暴露受控 API。
src/shared/     主进程与预加载桥共享的类型与常量。
```

## 开发命令

```bash
pnpm --filter @ky/aicrm-desktop dev
pnpm --filter @ky/aicrm-desktop typecheck
pnpm --filter @ky/aicrm-desktop build
```

根目录快捷命令：

```bash
pnpm dev:desktop
pnpm typecheck:desktop
pnpm build:desktop
```

## 连接配置

默认 Web 入口：

```text
https://kyaicrm.entai.im
```

可通过环境变量覆盖：

```bash
AICRM_WEB_URL=https://kyaicrm.entai.im pnpm dev:desktop
```

默认 API 连接本机控制台：

```text
http://127.0.0.1:16178
```

可通过环境变量覆盖：

```bash
AICRM_API_BASE_URL=http://127.0.0.1:16178 pnpm dev:desktop
```

也兼容读取 `KY_CONSOLE_URL`。

## 安全边界

窗口默认配置：

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

渲染进程不能直接访问 Node API，只能通过 `window.aicrm` 调用 preload 暴露的受控能力。
