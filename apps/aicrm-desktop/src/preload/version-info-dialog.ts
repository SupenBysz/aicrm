import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/constants";
import type { VersionDialogInfo } from "../shared/types";

const api = {
  async getInfo(): Promise<VersionDialogInfo> {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.versionDialogGetInfo) as { ok?: boolean; data?: VersionDialogInfo };
    if (!result?.ok || !result.data) throw new Error("version_info_unavailable");
    return result.data;
  },
  async close(): Promise<boolean> {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.versionDialogClose) as { ok?: boolean; data?: boolean };
    return result?.ok === true && result.data === true;
  }
};
contextBridge.exposeInMainWorld("kyVersionDialog", api);
const applyTheme = (value: unknown) => { if (value === "light" || value === "dark") document.documentElement.dataset.theme = value; };
ipcRenderer.on(IPC_CHANNELS.versionDialogThemeChanged, (_event, value: unknown) => applyTheme(value));
window.addEventListener("DOMContentLoaded", () => {
  document.querySelector("[data-close]")?.addEventListener("click", () => { void api.close(); });
  const veil = document.querySelector("[data-veil]");
  veil?.addEventListener("click", (event) => { if (event.target === veil) void api.close(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); void api.close(); } });
  void api.getInfo().then((info) => {
    applyTheme(info.theme);
    for (const [id, value] of [["client", info.clientVersion], ["plugin", info.pluginVersion], ["phase", info.runtimePhase]] as const) {
      const target = document.getElementById(id); if (target) target.textContent = value;
    }
  }).catch(() => { const error = document.getElementById("error"); if (error) { error.textContent = "版本信息暂不可用"; error.style.display = "block"; } });
});
