import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/constants";
import type { DesktopSession, DesktopWindowState } from "../shared/types";
import type { AiCrmDesktopBridge } from "./types";

const bridge: AiCrmDesktopBridge = {
  api: {
    request: (request) => ipcRenderer.invoke(IPC_CHANNELS.apiRequest, request)
  },
  app: {
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.appGetConfig),
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appGetVersion)
  },
  session: {
    load: () => ipcRenderer.invoke(IPC_CHANNELS.sessionLoad),
    save: (session: DesktopSession) => ipcRenderer.invoke(IPC_CHANNELS.sessionSave, session),
    clear: () => ipcRenderer.invoke(IPC_CHANNELS.sessionClear)
  },
  window: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.windowGetState),
    minimize: () => ipcRenderer.invoke(IPC_CHANNELS.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC_CHANNELS.windowToggleMaximize),
    setFullScreen: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.windowSetFullScreen, enabled),
    setAlwaysOnTop: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.windowSetAlwaysOnTop, enabled),
    openDevTools: () => ipcRenderer.invoke(IPC_CHANNELS.windowOpenDevTools),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.windowClose),
    onStateChanged: (listener: (state: DesktopWindowState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: DesktopWindowState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.windowStateChanged, handler);
      return () => ipcRenderer.off(IPC_CHANNELS.windowStateChanged, handler);
    }
  },
  network: {
    getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.networkLogSnapshot),
    clear: () => ipcRenderer.invoke(IPC_CHANNELS.networkLogClear)
  },
  aiExecutor: {
    openTerminalWindow: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiExecutorOpenTerminalWindow, input),
    bindDevice: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiExecutorBindDevice, input)
  },
  codex: {
    authorize: (...args: unknown[]) => ipcRenderer.invoke(IPC_CHANNELS.codexExecutorAuthorize, ...args),
    getAuthStatus: (...args: unknown[]) => ipcRenderer.invoke(IPC_CHANNELS.codexExecutorGetAuthStatus, ...args),
    authorization: {
      getCapabilities: () => ipcRenderer.invoke(IPC_CHANNELS.codexAuthorizationGetCapabilities),
      start: (input) => ipcRenderer.invoke(IPC_CHANNELS.codexAuthorizationStart, input),
      getSnapshot: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.codexAuthorizationGetSnapshot, sessionId),
      cancel: (input) => ipcRenderer.invoke(IPC_CHANNELS.codexAuthorizationCancel, input),
      reopen: (input) => ipcRenderer.invoke(IPC_CHANNELS.codexAuthorizationReopen, input),
      verify: (input) => ipcRenderer.invoke(IPC_CHANNELS.codexAuthorizationVerify, input),
      checkReadiness: (input) => ipcRenderer.invoke(IPC_CHANNELS.codexAuthorizationCheckReadiness, input),
      getModelCatalog: (executorId) => ipcRenderer.invoke(IPC_CHANNELS.codexAuthorizationGetModelCatalog, executorId),
      refreshModelCatalog: (input) => ipcRenderer.invoke(IPC_CHANNELS.codexAuthorizationRefreshModelCatalog, input),
      logout: (input) => ipcRenderer.invoke(IPC_CHANNELS.codexAuthorizationLogout, input),
      onChanged: (listener) => {
        const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => {
          try {
            listener(payload);
          } catch {
            // A renderer listener must not break later native event delivery.
          }
        };
        ipcRenderer.on(IPC_CHANNELS.codexAuthorizationChanged, handler);
        return () => ipcRenderer.off(IPC_CHANNELS.codexAuthorizationChanged, handler);
      }
    }
  },
  desktopDevice: {
    getIdentity: () => ipcRenderer.invoke(IPC_CHANNELS.desktopDeviceGetIdentity),
    ensureRegistration: () => ipcRenderer.invoke(IPC_CHANNELS.desktopDeviceEnsureRegistration),
    getRegistrationState: () => ipcRenderer.invoke(IPC_CHANNELS.desktopDeviceGetRegistrationState),
    resetRegistrationRecovery: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopDeviceResetRegistrationRecovery, input)
  },
  matrixAccount: {
    getCapabilities: () => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountGetCapabilities),
    startLogin: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountStartLogin, input),
    openAccount: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountOpenAccount, input),
    checkSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountCheckSession, input),
    clearProfile: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountClearProfile, input),
    onLoginStateChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
      ipcRenderer.on(IPC_CHANNELS.matrixAccountLoginStateChanged, handler);
      return () => ipcRenderer.off(IPC_CHANNELS.matrixAccountLoginStateChanged, handler);
    },
    createWebSpaceLogin: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountCreateWebSpaceLogin, input),
    openWebSpace: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountOpenWebSpace, input),
    detectWebSpaceAccount: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountDetectWebSpaceAccount, input),
    clearWebSpace: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountClearWebSpace, input),
    captureWebSpaceSnapshot: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountCaptureWebSpaceSnapshot, input),
    runWebSpaceLoginScript: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountRunWebSpaceLoginScript, input),
    onWebSpaceStateChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
      ipcRenderer.on(IPC_CHANNELS.matrixAccountWebSpaceStateChanged, handler);
      return () => ipcRenderer.off(IPC_CHANNELS.matrixAccountWebSpaceStateChanged, handler);
    },
    startAccountOnboarding: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountStartOnboarding, input),
    getAccountOnboarding: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountGetOnboarding, input),
    getLoginQrCode: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountGetOnboardingQrCode, input),
    refreshLoginQrCode: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountRefreshOnboardingQrCode, input),
    cancelAccountOnboarding: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountCancelOnboarding, input),
    sealSessionSnapshot: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountSealSessionSnapshot, input),
    verifySessionSnapshot: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountVerifySessionSnapshot, input),
    restoreSessionSnapshot: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountRestoreSessionSnapshot, input),
    cleanupSessionWebSpace: (input) => ipcRenderer.invoke(IPC_CHANNELS.matrixAccountCleanupSessionWebSpace, input),
    onAccountOnboardingEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
      ipcRenderer.on(IPC_CHANNELS.matrixAccountOnboardingEvent, handler);
      return () => ipcRenderer.off(IPC_CHANNELS.matrixAccountOnboardingEvent, handler);
    }
  }
};

export function exposeBridge() {
  contextBridge.exposeInMainWorld("aicrm", bridge);
}
