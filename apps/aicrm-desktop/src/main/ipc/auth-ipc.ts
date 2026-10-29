import {destroyHostLockProtectedWindows} from "../host-overlay";
import {isHostScreenLocked,clearAllHostScreenLocks,waitForHostUnlocks} from "../host-screen-lock";
import { guardedIpc as ipcMain } from "../guarded-ipc";
import { IPC_CHANNELS } from "../../shared/constants";
import type { DesktopSession } from "../../shared/types";
import type { DesktopDeviceTrustRuntime } from "../desktop-device-trust-runtime";
import { clearSession, loadSession, saveSession } from "../session-store";
import { disposeAllMenuWebViews, disposeMenuWebViewsForIdentity, menuWebViewIdentityFromToken } from "./menu-webview-ipc";

export function registerAuthIpc(trustRuntime: DesktopDeviceTrustRuntime) {
  ipcMain.handle(IPC_CHANNELS.sessionLoad, () => loadSession());
  ipcMain.handle(IPC_CHANNELS.sessionSave, async (_event, session: DesktopSession) => {
    if(isHostScreenLocked(_event.sender.id))throw Error("screen_locked");
    const previous = await loadSession();
    if (previous?.token && menuWebViewIdentityFromToken(previous.token) !== menuWebViewIdentityFromToken(session.token)) {
      disposeMenuWebViewsForIdentity(menuWebViewIdentityFromToken(previous.token));
    }
    await saveSession(session);
    trustRuntime.notifySessionSaved();
    return true;
  });
  ipcMain.handle(IPC_CHANNELS.sessionClear, async () => {
    disposeAllMenuWebViews();
    destroyHostLockProtectedWindows();
    clearAllHostScreenLocks();
    trustRuntime.cancelAutomaticRegistration();
    await waitForHostUnlocks();
    await clearSession();
    return true;
  });
}
