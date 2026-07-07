import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import { loadDesktopConfig } from "../config";

export function registerAppIpc() {
  ipcMain.handle(IPC_CHANNELS.appGetConfig, () => loadDesktopConfig());
  ipcMain.handle(IPC_CHANNELS.appGetVersion, () => app.getVersion());
}
