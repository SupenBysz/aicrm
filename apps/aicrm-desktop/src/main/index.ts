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
import { registerMatrixAccountIpc } from "./ipc/matrix-account-ipc";
import { registerNetworkIpc } from "./ipc/network-ipc";
import { registerWindowIpc } from "./ipc/window-ipc";
import { installNetworkLogCapture } from "./network-log";

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

registerApiIpc();
registerAiExecutorWindowIpc();
registerAppIpc();
registerAuthIpc();
registerCodexExecutorIpc();
registerDesktopDeviceIpc();
registerMatrixAccountIpc();
registerNetworkIpc();
registerWindowIpc();

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: DESKTOP_APPLICATION_NAME,
    applicationVersion: app.getVersion()
  });
  installNetworkLogCapture();
  installApplicationMenu();
  const mainWindow = createMainWindow();

  app.on("second-instance", () => {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
