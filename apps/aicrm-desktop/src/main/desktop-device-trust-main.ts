import path from "node:path";
import { app, safeStorage } from "electron";
import { DESKTOP_APPLICATION_NAME } from "../shared/constants";
import { loadDesktopConfig } from "./config";
import { DesktopDeviceHeartbeatClient } from "./desktop-device-heartbeat-client";
import { DesktopDeviceIdentityStore } from "./desktop-device-identity";
import { DesktopDeviceRegistrationClient } from "./desktop-device-registration-client";
import { DesktopDevicePendingRegistrationStore } from "./desktop-device-registration-pending";
import {
  DesktopDeviceRequestJournalStore,
  restoreDesktopDeviceRequestJournalPin
} from "./desktop-device-request-journal";
import { DesktopDeviceRequestLane } from "./desktop-device-request-lane";
import { DesktopDeviceTrustRuntime } from "./desktop-device-trust-runtime";
import { DesktopExecutorDeviceBindingClient } from "./desktop-executor-device-binding-client";
import { loadSession } from "./session-store";

export interface DesktopDeviceTrustMainServices {
  identityStore: DesktopDeviceIdentityStore;
  requestLane: DesktopDeviceRequestLane;
  requestJournal: DesktopDeviceRequestJournalStore;
  executorDeviceBindingClient: DesktopExecutorDeviceBindingClient;
  requestFenceReady: Promise<string | null>;
  runtime: DesktopDeviceTrustRuntime;
}

let trustServices: DesktopDeviceTrustMainServices | null = null;

class StartupFencedHeartbeatClient {
  private desiredRunning = false;
  private generation = 0;

  constructor(
    private readonly delegate: DesktopDeviceHeartbeatClient,
    private readonly requestFenceReady: Promise<string | null>,
    private readonly requestLane: DesktopDeviceRequestLane
  ) {}

  start(): void {
    if (this.desiredRunning) return;
    this.desiredRunning = true;
    const generation = ++this.generation;
    void this.requestFenceReady.then(() => this.requestLane.waitUntilUnpinned()).then(
      () => {
        if (this.desiredRunning && this.generation === generation) this.delegate.start();
      },
      () => {
        // Multiple/corrupt pending heads are a hard startup fence. The
        // rejected promise remains exposed to other Main-only services while
        // heartbeat stays stopped and cannot allocate a later sequence.
      }
    );
  }

  stop(): void {
    this.desiredRunning = false;
    this.generation += 1;
    this.delegate.stop();
  }
}

/** Owns the one signer, request lane and encrypted journal used by Main. */
export function getDesktopDeviceTrustMainServices(): DesktopDeviceTrustMainServices {
  if (trustServices) return trustServices;
  const userDataRoot = app.getPath("userData");
  const root = path.join(userDataRoot, "desktop-device-identity");
  const requestJournal = new DesktopDeviceRequestJournalStore({
    root: path.join(userDataRoot, "desktop-device-request-journal"),
    safeStorage
  });
  const requestLane = new DesktopDeviceRequestLane();
  // Electron safeStorage is not a supported bootstrap dependency before the
  // app ready boundary. Start journal recovery only after that boundary, but
  // keep every heartbeat/binding call waiting on the same one-shot promise.
  const requestFenceReady = app.whenReady().then(() =>
    restoreDesktopDeviceRequestJournalPin(requestJournal, requestLane)
  );
  // Attach a rejection observer immediately; callers still receive the same
  // rejected promise and no unsafe background unhandled rejection is emitted.
  void requestFenceReady.catch(() => undefined);
  const identityStore = new DesktopDeviceIdentityStore({ root, safeStorage });
  const pendingRegistrationStore = new DesktopDevicePendingRegistrationStore({
    root,
    safeStorage
  });
  const loadTrustedApiBaseUrl = async () => (await loadDesktopConfig()).apiBaseUrl;
  const registrationClient = new DesktopDeviceRegistrationClient({
    identityStore,
    pendingRegistrationStore,
    deviceLabel: DESKTOP_APPLICATION_NAME,
    appVersion: app.getVersion(),
    loadHostSession: loadSession,
    loadTrustedApiBaseUrl
  });
  const heartbeatTransport = new DesktopDeviceHeartbeatClient({
    identityStore,
    requestLane,
    appVersion: app.getVersion(),
    loadTrustedApiBaseUrl
  });
  const heartbeatClient = new StartupFencedHeartbeatClient(
    heartbeatTransport,
    requestFenceReady,
    requestLane
  );
  const executorDeviceBindingClient = new DesktopExecutorDeviceBindingClient({
    identityStore,
    requestLane,
    requestJournal,
    loadHostSession: loadSession,
    loadTrustedApiBaseUrl,
    waitForRequestFence: async () => {
      await requestFenceReady;
    }
  });
  const runtime = new DesktopDeviceTrustRuntime({
    identityStore,
    pendingRegistrationStore,
    registrationClient,
    heartbeatClient,
    loadHostSession: loadSession
  });
  trustServices = {
    identityStore,
    requestLane,
    requestJournal,
    executorDeviceBindingClient,
    requestFenceReady,
    runtime
  };
  return trustServices;
}

/** The only Main-process owner of the device signer and sequence allocator. */
export function getDesktopDeviceTrustRuntime(): DesktopDeviceTrustRuntime {
  return getDesktopDeviceTrustMainServices().runtime;
}
