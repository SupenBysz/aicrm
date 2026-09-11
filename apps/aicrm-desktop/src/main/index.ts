import { registerPluginSchemes, startPluginHost, getPluginHost } from "./desktop-plugin-host/host";
import { guardedIpc as ipcMain } from "./guarded-ipc";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import {
  DESKTOP_APPLICATION_ID,
  DESKTOP_APPLICATION_NAME,
  LEGACY_DESKTOP_USER_DATA_DIRECTORY
} from "../shared/constants";
import { createMainWindow } from "./app-window";
import { installApplicationMenu } from "./app-menu";
import { registerApiIpc } from "./ipc/api-ipc";
import { registerAiExecutorWindowIpc } from "./ipc/ai-executor-window-ipc";
import { registerAppIpc } from "./ipc/app-ipc";
import { registerAuthIpc } from "./ipc/auth-ipc";
import { registerCodexExecutorIpc } from "./ipc/codex-executor-ipc";
import { registerDesktopDeviceIpc } from "./ipc/desktop-device-ipc";
import { registerDesktopExecutorDeviceBindingIpc } from "./ipc/desktop-executor-device-binding-ipc";
import { registerMatrixAccountIpc } from "./ipc/matrix-account-ipc";
import { registerNetworkIpc } from "./ipc/network-ipc";
import { registerWindowIpc } from "./ipc/window-ipc";
import { installNetworkLogCapture } from "./network-log";
import { getDesktopDeviceTrustMainServices } from "./desktop-device-trust-main";
import {
  getDesktopCodexAuthorizationMainServices,
  type DesktopCodexAuthorizationMainServices
} from "./desktop-codex-authorization-main";
import { DesktopCodexAuthorizationQuitFence } from "./desktop-codex-authorization-main-lifecycle";

registerPluginSchemes();

process.title = DESKTOP_APPLICATION_NAME;
app.setName(DESKTOP_APPLICATION_NAME);
const legacyUserDataPath = join(app.getPath("appData"), LEGACY_DESKTOP_USER_DATA_DIRECTORY);
const userDataPath = existsSync(legacyUserDataPath)
  ? legacyUserDataPath
  : join(app.getPath("appData"), DESKTOP_APPLICATION_NAME);
mkdirSync(userDataPath, { recursive: true });
app.setPath("userData", userDataPath);
app.setAppUserModelId(DESKTOP_APPLICATION_ID);

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

const desktopDeviceTrustServices = getDesktopDeviceTrustMainServices();
const desktopDeviceTrustRuntime = desktopDeviceTrustServices.runtime;
let desktopCodexAuthorizationServices: DesktopCodexAuthorizationMainServices | null = null;
let desktopCodexQuitFence: DesktopCodexAuthorizationQuitFence | null = null;

registerApiIpc();
registerAiExecutorWindowIpc();
registerAppIpc();
registerAuthIpc(desktopDeviceTrustRuntime);
registerCodexExecutorIpc();
registerDesktopDeviceIpc(desktopDeviceTrustRuntime);
registerDesktopExecutorDeviceBindingIpc(
  desktopDeviceTrustServices.executorDeviceBindingClient,
  ipcMain
);
registerMatrixAccountIpc();
registerNetworkIpc();
registerWindowIpc();

app.whenReady().then(async () => {
  void startPluginHost().catch(() => console.info("客户端插件已降级，主窗口继续启动"));
  desktopCodexAuthorizationServices = getDesktopCodexAuthorizationMainServices();
  desktopCodexQuitFence = new DesktopCodexAuthorizationQuitFence({
    shutdown: async () => {
      console.info("客户端退出清理：开始");
      await Promise.allSettled([
        desktopCodexAuthorizationServices!.shutdown().finally(() => console.info("客户端退出清理：授权运行时结束")),
        Promise.resolve(getPluginHost()?.shutdown()).finally(() => console.info("客户端退出清理：插件宿主结束"))
      ]);
      console.info("客户端退出清理：完成");
    },
    quit: () => app.quit()
  });
  void desktopCodexAuthorizationServices.initialize().catch(() => undefined);
  app.setAboutPanelOptions({
    applicationName: DESKTOP_APPLICATION_NAME,
    applicationVersion: app.getVersion()
  });
  installNetworkLogCapture();
  installApplicationMenu();
  void desktopDeviceTrustRuntime.resumeAfterStartup();
  let mainWindow = createMainWindow();

  app.on("second-instance", () => {
    if (mainWindow.isDestroyed()) mainWindow = createMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().filter(w => !getPluginHost()?.instances.has(w.webContents)).length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("before-quit", (event) => {
  desktopCodexQuitFence?.handleBeforeQuit(event);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => { console.info("客户端退出清理：will-quit"); });
