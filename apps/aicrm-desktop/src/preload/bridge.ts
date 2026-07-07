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
  }
};

export function exposeBridge() {
  contextBridge.exposeInMainWorld("aicrm", bridge);
}
