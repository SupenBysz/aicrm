import path from "node:path";
import { app, BrowserWindow, safeStorage, shell } from "electron";
import { DESKTOP_APPLICATION_NAME, IPC_CHANNELS } from "../shared/constants.ts";
import { CodexAppServerAuthClient } from "./codex-app-server-auth-client.ts";
import { loadDesktopConfig } from "./config.ts";
import { DesktopActivationLeaseController } from "./desktop-activation-lease-controller.ts";
import { DesktopActivationLeaseFenceStore } from "./desktop-activation-lease-fence-store.ts";
import { DesktopAuthorizationTransportClient } from "./desktop-authorization-transport-client.ts";
import { DesktopCodexAppServerSupervisor } from "./desktop-codex-app-server-supervisor.ts";
import { DesktopCodexAuthorizationEventBroadcaster } from "./desktop-codex-authorization-events.ts";
import {
  DesktopCodexAuthorizationMainLifecycle,
  type DesktopCodexAuthorizationMainLifecycleState
} from "./desktop-codex-authorization-main-lifecycle.ts";
import { DesktopCodexAuthorizationOrchestrator } from "./desktop-codex-authorization-orchestrator.ts";
import { DesktopCodexAuthorizationReconciler } from "./desktop-codex-authorization-reconciler.ts";
import { DesktopCodexAuthorizationRecoveryCoordinator } from "./desktop-codex-authorization-recovery-coordinator.ts";
import {
  DesktopCodexAuthorizationSessionStore,
  type DesktopCodexAuthorizationSessionRecord
} from "./desktop-codex-authorization-session-store.ts";
import { DesktopCodexExactRecoveryArtifactInspector } from "./desktop-codex-recovery-artifacts.ts";
import { getDesktopCredentialTreeManager } from "./desktop-credential-tree-main.ts";
import { getDesktopDeviceTrustMainServices } from "./desktop-device-trust-main.ts";
import { DesktopExecutorBindingStateStore } from "./desktop-executor-binding-state.ts";
import { DesktopTrustedTokenKeyringClient } from "./desktop-trusted-token-keyring.ts";
import {
  verifyDesktopAuthorizationHandoffToken,
  type DesktopAuthorizationHandoffTrustedFacts
} from "./desktop-trusted-token-verifier.ts";

const DEVICE_ID = /^[0-9a-f]{64}$/;
const SESSIONS_DIRECTORY = "codex-authorization-sessions";
const LEASES_DIRECTORY = "codex-activation-lease-fences";
const BINDINGS_DIRECTORY = "codex-executor-binding-state";
const KEYRING_DIRECTORY = "codex-trusted-token-keyring";

export interface DesktopCodexAuthorizationMainServices {
  readonly orchestrator: DesktopCodexAuthorizationOrchestrator;
  readonly sessions: DesktopCodexAuthorizationSessionStore;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  isReady(): boolean;
  getState(): DesktopCodexAuthorizationMainLifecycleState;
}

let singleton: DesktopCodexAuthorizationMainServices | null = null;

/** Builds the one Main-owned P2A graph. Bridge readiness remains independently gated. */
export function getDesktopCodexAuthorizationMainServices(): DesktopCodexAuthorizationMainServices {
  if (singleton) return singleton;
  if (!app.isReady()) throw mainUnavailable();

  const userDataRoot = app.getPath("userData");
  const trust = getDesktopDeviceTrustMainServices();
  const credentials = getDesktopCredentialTreeManager();
  const transport = new DesktopAuthorizationTransportClient({
    identityStore: trust.identityStore,
    requestLane: trust.requestLane,
    requestJournal: trust.requestJournal,
    loadTrustedApiBaseUrl: () => loadDesktopConfig().apiBaseUrl
  });
  const leases = new DesktopActivationLeaseFenceStore({
    root: path.join(userDataRoot, LEASES_DIRECTORY),
    safeStorage
  });
  const bindings = new DesktopExecutorBindingStateStore({
    root: path.join(userDataRoot, BINDINGS_DIRECTORY),
    safeStorage
  });
  const keyring = new DesktopTrustedTokenKeyringClient({
    root: path.join(userDataRoot, KEYRING_DIRECTORY),
    safeStorage,
    loadTrustedWebUrl: () => loadDesktopConfig().webUrl
  });
  const events = new DesktopCodexAuthorizationEventBroadcaster({
    sink: (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.codexAuthorizationChanged, event);
        }
      }
    }
  });
  const supervisor = new DesktopCodexAppServerSupervisor({
    createClient: (binding) => new CodexAppServerAuthClient({
      codexHome: credentials.mainOnlyResolvePath({
        kind: "staging",
        executorId: binding.executorId,
        sessionId: binding.sessionId
      }),
      clientName: "aicrm-desktop",
      clientTitle: DESKTOP_APPLICATION_NAME,
      clientVersion: app.getVersion()
    }),
    openTrustedUrl: (authUrl) => shell.openExternal(authUrl)
  });
  const reconciler = new DesktopCodexAuthorizationReconciler({
    transport,
    credentials,
    appServer: startupAbsentAppServerRecovery()
  });
  const sessions = new DesktopCodexAuthorizationSessionStore({
    root: path.join(userDataRoot, SESSIONS_DIRECTORY),
    safeStorage,
    reconciler,
    activationLeaseFenceReader: leases
  });
  const artifacts = new DesktopCodexExactRecoveryArtifactInspector({
    requests: trust.requestJournal,
    credentials
  });
  const orchestrator = new DesktopCodexAuthorizationOrchestrator({
    identityRegistration: {
      async register() {
        const projection = await trust.runtime.ensureRegistration();
        if (
          projection.status !== "registered" ||
          projection.registrationStatus !== "registered" ||
          typeof projection.deviceId !== "string" ||
          !DEVICE_ID.test(projection.deviceId)
        ) {
          throw mainUnavailable();
        }
        return { deviceId: projection.deviceId, registrationStatus: "registered" };
      }
    },
    verifyHandoff: (input) => verifyHandoffWithRefresh(keyring, input),
    sessionStore: sessions,
    publishSnapshot: (snapshot) => events.broadcast(snapshot).then(() => undefined),
    transport,
    supervisor,
    credentialTree: credentials,
    bindingState: bindings,
    createLeaseRuntime: () => {
      const controller = new DesktopActivationLeaseController({ transport, fenceStore: leases });
      return {
        start: (target) => controller.start(target),
        stop: () => controller.stop(),
        stopAndRenewFresh: () => controller.stopAndRenewFresh(),
        clear: () => controller.clear(),
        readFence: (activationId) => leases.read(activationId),
        requireFresh: (expected) => leases.requireFresh(expected),
        remove: (expected) => leases.remove(expected)
      };
    },
    requireFreshSession: async (expected) => {
      const current = await sessions.read(expected.sessionId);
      if (
        current === null ||
        current.sessionId !== expected.sessionId ||
        current.executorId !== expected.executorId ||
        current.sessionRevision !== expected.sessionRevision ||
        current.generation !== expected.generation
      ) {
        throw mainUnavailable();
      }
    }
  });
  const recoveryCoordinator = new DesktopCodexAuthorizationRecoveryCoordinator({
    sessions,
    events,
    transport,
    credentials,
    bindings,
    leases,
    artifacts,
    resume: (record) => orchestrator.resume(record)
  });
  const lifecycle = new DesktopCodexAuthorizationMainLifecycle({
    waitForRequestFence: async () => {
      await trust.requestFenceReady;
    },
    initializeCredentials: () => credentials.initialize(),
    recoverOnStartup: () => recoveryCoordinator.recoverOnStartup(),
    shutdownRuntime: () => orchestrator.shutdown()
  });

  singleton = Object.freeze({
    orchestrator,
    sessions,
    initialize: () => lifecycle.initialize(),
    shutdown: () => lifecycle.shutdown(),
    isReady: () => lifecycle.isReady(),
    getState: () => lifecycle.getState()
  });
  return singleton;
}

async function verifyHandoffWithRefresh(
  keyring: DesktopTrustedTokenKeyringClient,
  input: Readonly<{
    token: string;
    registeredDeviceId: string;
    sessionId: string;
    executorId: string;
    handoffId: string;
  }>
): Promise<Readonly<DesktopAuthorizationHandoffTrustedFacts>> {
  let ring = await keyring.readCached();
  let refreshed = false;
  if (ring === null) {
    ring = await keyring.refresh();
    refreshed = true;
  }
  try {
    return verifyDesktopAuthorizationHandoffToken({
      token: input.token,
      keyring: ring,
      now: new Date(),
      registeredDeviceId: input.registeredDeviceId,
      sessionId: input.sessionId,
      executorId: input.executorId,
      handoffId: input.handoffId
    });
  } catch (error) {
    if (refreshed || !hasExactErrorCode(error, "desktop_trusted_token_unknown_key")) throw error;
    const replacement = await keyring.refresh();
    return verifyDesktopAuthorizationHandoffToken({
      token: input.token,
      keyring: replacement,
      now: new Date(),
      registeredDeviceId: input.registeredDeviceId,
      sessionId: input.sessionId,
      executorId: input.executorId,
      handoffId: input.handoffId
    });
  }
}

function startupAbsentAppServerRecovery() {
  return {
    async observe(record: Readonly<DesktopCodexAuthorizationSessionRecord>) {
      return Object.freeze({
        executorId: record.executorId,
        sessionId: record.sessionId,
        state: "absent" as const
      });
    },
    async stop(observation: Readonly<{ state: "ready" | "waiting_user" | "absent" }>) {
      if (observation.state !== "absent") throw mainUnavailable();
    }
  };
}

function hasExactErrorCode(error: unknown, expected: string): boolean {
  try {
    if (!error || typeof error !== "object") return false;
    const descriptor = Reflect.getOwnPropertyDescriptor(error, "code");
    return !!descriptor && "value" in descriptor && descriptor.value === expected;
  } catch {
    return false;
  }
}

function mainUnavailable(): Error & { code: string } {
  return Object.assign(new Error("Codex 授权 Main 运行时不可用"), {
    code: "desktop_codex_authorization_main_unavailable"
  });
}
