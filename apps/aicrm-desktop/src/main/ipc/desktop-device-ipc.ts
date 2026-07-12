import path from "node:path";
import { app, ipcMain, safeStorage } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { DesktopCommandResult, DesktopDeviceIdentityProjection } from "../../shared/types";
import { DesktopDeviceIdentityStore } from "../desktop-device-identity";

let identityStore: DesktopDeviceIdentityStore | null = null;

function getIdentityStore(): DesktopDeviceIdentityStore {
  if (!identityStore) {
    identityStore = new DesktopDeviceIdentityStore({
      root: path.join(app.getPath("userData"), "desktop-device-identity"),
      safeStorage
    });
  }
  return identityStore;
}

export function registerDesktopDeviceIpc(): void {
  ipcMain.handle(IPC_CHANNELS.desktopDeviceGetIdentity, async (_event, ...args: unknown[]) => {
    if (args.length !== 0) {
      return failure("validation_error", "设备身份查询参数无效");
    }
    try {
      const data = await getIdentityStore().getIdentity();
      return { ok: true, data } satisfies DesktopCommandResult<DesktopDeviceIdentityProjection>;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "desktop_device_identity_unavailable")
          : "desktop_device_identity_unavailable";
      return failure(code, "设备安全身份不可用");
    }
  });
}

function failure(code: string, message: string): DesktopCommandResult<DesktopDeviceIdentityProjection> {
  return { ok: false, error: { code, message } };
}
