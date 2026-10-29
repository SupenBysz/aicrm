import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/constants";
import type { HostOverlayAction, HostOverlayPresentation } from "../shared/host-overlay";
contextBridge.exposeInMainWorld("kyHostOverlay", {
    async get(): Promise<HostOverlayPresentation> { const result = await ipcRenderer.invoke(IPC_CHANNELS.hostOverlayGet); if (!result?.ok)
        throw Error("overlay_unavailable"); return result.data; },
    async dispatch(action: HostOverlayAction) { const result = await ipcRenderer.invoke(IPC_CHANNELS.hostOverlayDispatch, action); return result?.ok === true && result.data === true; },
    onProjection(listener: (projection: HostOverlayPresentation) => void) { const handler = (_event: Electron.IpcRendererEvent, value: HostOverlayPresentation) => listener(value); ipcRenderer.on(IPC_CHANNELS.hostOverlayProjection, handler); return () => ipcRenderer.removeListener(IPC_CHANNELS.hostOverlayProjection, handler); }
});
