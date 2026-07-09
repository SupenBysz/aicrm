import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { DesktopOpenDevToolsResult, DesktopWindowState } from "../../shared/types";
import { isDesktopProductionMode } from "../runtime-mode";

function fallbackWindowState(): DesktopWindowState {
  return {
    platform: process.platform,
    isMaximized: false,
    isMinimized: false,
    isFullScreen: false,
    isFocused: false,
    isAlwaysOnTop: false
  };
}

function getSenderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

export function buildWindowState(window: BrowserWindow): DesktopWindowState {
  return {
    platform: process.platform,
    isMaximized: window.isMaximized(),
    isMinimized: window.isMinimized(),
    isFullScreen: window.isFullScreen(),
    isFocused: window.isFocused(),
    isAlwaysOnTop: window.isAlwaysOnTop()
  };
}

export function emitWindowState(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send(IPC_CHANNELS.windowStateChanged, buildWindowState(window));
}

export function registerWindowIpc(): void {
  ipcMain.handle(IPC_CHANNELS.windowGetState, (event) => {
    const window = getSenderWindow(event);
    if (!window || window.isDestroyed()) return fallbackWindowState();
    return buildWindowState(window);
  });

  ipcMain.handle(IPC_CHANNELS.windowMinimize, (event) => {
    const window = getSenderWindow(event);
    if (!window || window.isDestroyed()) return fallbackWindowState();
    window.minimize();
    return buildWindowState(window);
  });

  ipcMain.handle(IPC_CHANNELS.windowToggleMaximize, (event) => {
    const window = getSenderWindow(event);
    if (!window || window.isDestroyed()) return fallbackWindowState();

    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }

    return buildWindowState(window);
  });

  ipcMain.handle(IPC_CHANNELS.windowSetFullScreen, (event, enabled: boolean) => {
    const window = getSenderWindow(event);
    if (!window || window.isDestroyed()) return fallbackWindowState();
    window.setFullScreen(Boolean(enabled));
    emitWindowState(window);
    return buildWindowState(window);
  });

  ipcMain.handle(IPC_CHANNELS.windowSetAlwaysOnTop, (event, enabled: boolean) => {
    const window = getSenderWindow(event);
    if (!window || window.isDestroyed()) return fallbackWindowState();
    window.setAlwaysOnTop(Boolean(enabled));
    emitWindowState(window);
    return buildWindowState(window);
  });

  ipcMain.on(IPC_CHANNELS.windowMoveBy, (event, deltaX: number, deltaY: number) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed() || window.isFullScreen() || window.isMaximized()) return;
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    const [x, y] = window.getPosition();
    window.setPosition(Math.round(x + deltaX), Math.round(y + deltaY), false);
  });

  ipcMain.handle(IPC_CHANNELS.windowOpenDevTools, (event): DesktopOpenDevToolsResult => {
    const window = getSenderWindow(event);
    if (!window || window.isDestroyed()) return { opened: false, reason: "unavailable" };
    if (isDesktopProductionMode()) return { opened: false, reason: "production" };
    window.webContents.openDevTools({ mode: "detach" });
    return { opened: true };
  });

  ipcMain.handle(IPC_CHANNELS.windowClose, (event) => {
    const window = getSenderWindow(event);
    if (!window || window.isDestroyed()) return false;
    window.close();
    return true;
  });
}
