import { join } from "node:path";
import { BrowserWindow, Menu, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
  AiExecutorTerminalWindowInput,
  AiExecutorTerminalWindowResult,
  DesktopCommandResult
} from "../../shared/types";
import { isDesktopDebugMode, isDesktopProductionMode } from "../runtime-mode";

const terminalWindows = new Map<string, BrowserWindow>();
const TERMINAL_WINDOW_DEFAULT_WIDTH = 1180;
const TERMINAL_WINDOW_DEFAULT_HEIGHT = 760;

export function registerAiExecutorWindowIpc(): void {
  ipcMain.handle(IPC_CHANNELS.aiExecutorOpenTerminalWindow, (event, input: AiExecutorTerminalWindowInput) => {
    return openTerminalWindow(event, input);
  });
}

function openTerminalWindow(
  event: IpcMainInvokeEvent,
  input: AiExecutorTerminalWindowInput
): DesktopCommandResult<AiExecutorTerminalWindowResult> {
  const validated = validateInput(event, input);
  if (!validated.ok) return validated;

  const existing = terminalWindows.get(input.taskId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return ok({
      taskId: input.taskId,
      opened: true,
      focusedExisting: true
    });
  }

  const window = new BrowserWindow({
    width: TERMINAL_WINDOW_DEFAULT_WIDTH,
    height: TERMINAL_WINDOW_DEFAULT_HEIGHT,
    minWidth: TERMINAL_WINDOW_DEFAULT_WIDTH,
    minHeight: 520,
    title: input.title || "执行器仿真终端",
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#050806" : "#f7efe4",
    frame: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      devTools: isDesktopDebugMode(),
      nodeIntegration: false,
      sandbox: true,
      session: event.sender.session
    }
  });

  terminalWindows.set(input.taskId, window);
  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });
  window.on("closed", () => {
    terminalWindows.delete(input.taskId);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("context-menu", (_event, params) => {
    showContextMenu(window, params);
  });
  window.webContents.on("devtools-opened", () => {
    if (isDesktopProductionMode()) window.webContents.closeDevTools();
  });
  window.webContents.on("will-navigate", (navigateEvent, url) => {
    if (sameOrigin(url, input.url)) return;
    navigateEvent.preventDefault();
    void shell.openExternal(url);
  });

  void window.loadURL(input.url);
  return ok({
    taskId: input.taskId,
    opened: true,
    focusedExisting: false
  });
}

function validateInput(
  event: IpcMainInvokeEvent,
  input: AiExecutorTerminalWindowInput
): DesktopCommandResult<AiExecutorTerminalWindowResult> {
  if (!input?.taskId?.trim()) {
    return fail("invalid_task_id", "缺少执行器任务 ID");
  }
  if (!input?.url?.trim()) {
    return fail("invalid_url", "缺少终端窗口 URL");
  }
  const senderUrl = event.sender.getURL();
  if (!sameOrigin(input.url, senderUrl)) {
    return fail("url_origin_not_allowed", "终端窗口 URL 必须和当前后台页面同源");
  }
  return ok({
    taskId: input.taskId,
    opened: false,
    focusedExisting: false
  });
}

function showContextMenu(window: BrowserWindow, params: Electron.ContextMenuParams): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "刷新",
      accelerator: "CmdOrCtrl+R",
      click: () => {
        window.webContents.reloadIgnoringCache();
      }
    },
    { type: "separator" as const },
    ...(params.linkURL
      ? [
          {
            label: "打开链接",
            click: () => {
              void shell.openExternal(params.linkURL);
            }
          },
          { type: "separator" as const }
        ]
      : []),
    { role: "copy", label: "复制", enabled: params.editFlags.canCopy || Boolean(params.selectionText) },
    { role: "selectAll", label: "全选", enabled: params.editFlags.canSelectAll }
  ]);

  menu.popup({ window });
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function ok<T>(data: T): DesktopCommandResult<T> {
  return { ok: true, data };
}

function fail<T>(code: string, message: string): DesktopCommandResult<T> {
  return {
    ok: false,
    error: {
      code,
      message
    }
  };
}
