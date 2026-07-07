import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import { clearNetworkLogs, getNetworkLogSnapshot } from "../network-log";

export function registerNetworkIpc(): void {
  ipcMain.handle(IPC_CHANNELS.networkLogSnapshot, () => getNetworkLogSnapshot());
  ipcMain.handle(IPC_CHANNELS.networkLogClear, () => clearNetworkLogs());
}
