import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { DesktopSession } from "../../shared/types";
import type { DesktopDeviceTrustRuntime } from "../desktop-device-trust-runtime";
import { clearSession, loadSession, saveSession } from "../session-store";

export function registerAuthIpc(trustRuntime: DesktopDeviceTrustRuntime) {
  ipcMain.handle(IPC_CHANNELS.sessionLoad, () => loadSession());
  ipcMain.handle(IPC_CHANNELS.sessionSave, async (_event, session: DesktopSession) => {
    await saveSession(session);
    trustRuntime.notifySessionSaved();
    return true;
  });
  ipcMain.handle(IPC_CHANNELS.sessionClear, async () => {
    trustRuntime.cancelAutomaticRegistration();
    await clearSession();
    return true;
  });
}
