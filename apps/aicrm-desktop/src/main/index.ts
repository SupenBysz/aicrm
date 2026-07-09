import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./app-window";
import { installApplicationMenu } from "./app-menu";
import { registerApiIpc } from "./ipc/api-ipc";
import { registerAiExecutorWindowIpc } from "./ipc/ai-executor-window-ipc";
import { registerAppIpc } from "./ipc/app-ipc";
import { registerAuthIpc } from "./ipc/auth-ipc";
import { registerCodexExecutorIpc } from "./ipc/codex-executor-ipc";
import { registerMatrixAccountIpc } from "./ipc/matrix-account-ipc";
import { registerNetworkIpc } from "./ipc/network-ipc";
import { registerWindowIpc } from "./ipc/window-ipc";
import { installNetworkLogCapture } from "./network-log";

app.setName("AiCRM Desktop");

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

registerApiIpc();
registerAiExecutorWindowIpc();
registerAppIpc();
registerAuthIpc();
registerCodexExecutorIpc();
registerMatrixAccountIpc();
registerNetworkIpc();
registerWindowIpc();

app.whenReady().then(() => {
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
