import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { DesktopCommandResult } from "../../shared/types";
import type { DesktopDeviceTrustRuntime } from "../desktop-device-trust-runtime";

export function registerDesktopDeviceIpc(runtime: DesktopDeviceTrustRuntime): void {
  ipcMain.handle(IPC_CHANNELS.desktopDeviceGetIdentity, async (_event, ...args: unknown[]) => {
    if (args.length !== 0) return failure("validation_error", "设备身份查询参数无效");
    try {
      return success(await runtime.getIdentity());
    } catch (error) {
      return safeFailure(error, "desktop_device_identity_unavailable", "设备安全身份不可用");
    }
  });

  ipcMain.handle(IPC_CHANNELS.desktopDeviceEnsureRegistration, async (_event, ...args: unknown[]) => {
    if (args.length !== 0) return failure("validation_error", "设备登记命令不接受参数");
    try {
      return success(await runtime.ensureRegistration());
    } catch (error) {
      return safeFailure(error, "desktop_device_registration_failed", "设备自动登记失败");
    }
  });

  ipcMain.handle(IPC_CHANNELS.desktopDeviceGetRegistrationState, async (_event, ...args: unknown[]) => {
    if (args.length !== 0) return failure("validation_error", "设备登记状态查询参数无效");
    try {
      return success(await runtime.getRegistrationState());
    } catch (error) {
      return safeFailure(error, "desktop_device_registration_failed", "设备登记状态不可用");
    }
  });

  ipcMain.handle(IPC_CHANNELS.desktopDeviceResetRegistrationRecovery, async (_event, ...args: unknown[]) => {
    if (args.length !== 1) return failure("validation_error", "设备登记恢复参数无效");
    try {
      return success(await runtime.resetRegistrationRecovery(args[0]));
    } catch (error) {
      return safeFailure(error, "desktop_device_registration_reset_forbidden", "设备登记恢复重置被拒绝");
    }
  });
}

function success<T>(data: T): DesktopCommandResult<T> {
  return { ok: true, data };
}

function safeFailure<T>(error: unknown, fallbackCode: string, message: string): DesktopCommandResult<T> {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? fallbackCode)
      : fallbackCode;
  return failure(/^[a-z][a-z0-9_]{0,127}$/.test(code) ? code : fallbackCode, message);
}

function failure<T>(code: string, message: string): DesktopCommandResult<T> {
  return { ok: false, error: { code, message } };
}
