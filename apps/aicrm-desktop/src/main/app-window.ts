import { storedNativeBackground } from "./window-appearance";
import { registerSender, changeSenderRole } from "./guarded-ipc";
import { join } from "node:path";
import { BrowserWindow, Menu, nativeTheme, shell } from "electron";
import { DESKTOP_APPLICATION_NAME } from "../shared/constants";
import { loadDesktopConfig } from "./config";
import { emitWindowState } from "./ipc/window-ipc";
import { isDesktopDebugMode, isDesktopProductionMode } from "./runtime-mode";
import { createDesktopStartupNavigationController } from "./desktop-startup-navigation";

let startupNavigation: ReturnType<typeof createDesktopStartupNavigationController> | null = null;

export function retryMainWindowConnection(): boolean {
  return startupNavigation?.retry() ?? false;
}

function getUrlOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isAllowedNavigation(url: string, allowedOrigin: string | null): boolean {
  if (isDesktopProductionMode() && url.startsWith("view-source:")) return false;
  if (!allowedOrigin) return false;
  return getUrlOrigin(url) === allowedOrigin;
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
    { role: "undo", label: "撤销", enabled: params.editFlags.canUndo },
    { role: "redo", label: "重做", enabled: params.editFlags.canRedo },
    { type: "separator" },
    { role: "cut", label: "剪切", enabled: params.editFlags.canCut },
    { role: "copy", label: "复制", enabled: params.editFlags.canCopy || Boolean(params.selectionText) },
    { role: "paste", label: "粘贴", enabled: params.editFlags.canPaste },
    { role: "selectAll", label: "全选", enabled: params.editFlags.canSelectAll }
  ]);

  menu.popup({ window });
}

function getWindowBackgroundColor(): string {
  return storedNativeBackground() ?? (nativeTheme.shouldUseDarkColors ? "#050505" : "#f7efe4");
}

function bindWindowStateEvents(window: BrowserWindow): void {
  window.webContents.on("did-finish-load", () => emitWindowState(window));

  window.on("maximize", () => emitWindowState(window));
  window.on("unmaximize", () => emitWindowState(window));
  window.on("minimize", () => emitWindowState(window));
  window.on("restore", () => emitWindowState(window));
  window.on("enter-full-screen", () => emitWindowState(window));
  window.on("leave-full-screen", () => emitWindowState(window));
  window.on("focus", () => emitWindowState(window));
  window.on("blur", () => emitWindowState(window));
}

export function createMainWindow(): BrowserWindow {
  startupNavigation?.dispose();
  const config = loadDesktopConfig();
  const webOrigin = getUrlOrigin(config.webUrl);
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    title: DESKTOP_APPLICATION_NAME,
    autoHideMenuBar: true,
    backgroundColor: getWindowBackgroundColor(),
    frame: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      devTools: isDesktopDebugMode(),
      nodeIntegration: false,
      sandbox: true
    }
  });

  registerSender(window.webContents, "main", (url) => getUrlOrigin(url) === webOrigin || url === "kww-offline://local/");
  window.webContents.on("did-frame-navigate", (_event,url,_code,_text,main) => { if(main) changeSenderRole(window.webContents, url === "kww-offline://local/" ? "offline" : "main"); });
  startupNavigation = createDesktopStartupNavigationController({
    webUrl: config.webUrl,
    offlineUrl: "kww-offline://local/",
    loadUrl: (url) => window.loadURL(url),
    showWindow: () => {
      if (!window.isDestroyed()) {
        window.show();
        emitWindowState(window);
      }
    },
    isWebUrl: (url) => getUrlOrigin(url) === webOrigin,
    log: (diagnostic) => console.warn("桌面启动导航状态", diagnostic)
  });
  const navigation = startupNavigation;
  window.webContents.on("did-fail-load", (_event, code, _text, url, main) => {
    navigation.onMainFrameFailed(code, url, main);
  });
  window.webContents.on("did-finish-load", () => {
    navigation.onMainFrameFinished(window.webContents.getURL());
  });
  window.once("closed", () => {
    navigation.dispose();
    if (startupNavigation === navigation) startupNavigation = null;
  });
  bindWindowStateEvents(window);

  window.once("ready-to-show", () => {
    navigation.onReadyToShow();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("context-menu", (_event, params) => {
    showContextMenu(window, params);
  });

  window.webContents.on("devtools-opened", () => {
    if (isDesktopProductionMode()) {
      window.webContents.closeDevTools();
    }
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigation(url, webOrigin)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  navigation.start();

  return window;
}
