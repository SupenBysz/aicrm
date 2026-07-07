import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { DesktopSession } from "../../shared/types";
import { clearSession, loadSession, saveSession } from "../session-store";

export function registerAuthIpc() {
  ipcMain.handle(IPC_CHANNELS.sessionLoad, () => loadSession());
  ipcMain.handle(IPC_CHANNELS.sessionSave, async (_event, session: DesktopSession) => {
    await saveSession(session);
    return true;
  });
  ipcMain.handle(IPC_CHANNELS.sessionClear, async () => {
    await clearSession();
    return true;
  });
}
