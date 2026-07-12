import path from "node:path";
import { app, safeStorage } from "electron";
import { DESKTOP_APPLICATION_NAME } from "../shared/constants";
import { loadDesktopConfig } from "./config";
import { DesktopDeviceIdentityStore } from "./desktop-device-identity";
import { DesktopDeviceRegistrationClient } from "./desktop-device-registration-client";
import { DesktopDevicePendingRegistrationStore } from "./desktop-device-registration-pending";
import { DesktopDeviceTrustRuntime } from "./desktop-device-trust-runtime";
import { loadSession } from "./session-store";

let trustRuntime: DesktopDeviceTrustRuntime | null = null;

/** The only Main-process owner of the device signer and sequence allocator. */
export function getDesktopDeviceTrustRuntime(): DesktopDeviceTrustRuntime {
  if (trustRuntime) return trustRuntime;
  const root = path.join(app.getPath("userData"), "desktop-device-identity");
  const identityStore = new DesktopDeviceIdentityStore({ root, safeStorage });
  const pendingRegistrationStore = new DesktopDevicePendingRegistrationStore({
    root,
    safeStorage
  });
  const registrationClient = new DesktopDeviceRegistrationClient({
    identityStore,
    pendingRegistrationStore,
    deviceLabel: DESKTOP_APPLICATION_NAME,
    appVersion: app.getVersion(),
    loadHostSession: loadSession,
    loadTrustedApiBaseUrl: async () => (await loadDesktopConfig()).apiBaseUrl
  });
  trustRuntime = new DesktopDeviceTrustRuntime({
    identityStore,
    pendingRegistrationStore,
    registrationClient,
    loadHostSession: loadSession
  });
  return trustRuntime;
}
