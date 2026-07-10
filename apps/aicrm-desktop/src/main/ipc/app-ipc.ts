import { app, ipcMain } from "electron";
import { DESKTOP_APPLICATION_NAME, IPC_CHANNELS } from "../../shared/constants";
import { loadDesktopConfig } from "../config";

interface PublicPlatformProfileEnvelope {
  data?: {
    brandLogoTextLong?: string;
    companyName?: string;
  };
}

async function loadProgramTitle(): Promise<string> {
  const config = loadDesktopConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(new URL("/api/v1/public/platform-profile", config.webUrl), {
      signal: controller.signal
    });
    if (!response.ok) return DESKTOP_APPLICATION_NAME;
    const body = (await response.json()) as PublicPlatformProfileEnvelope;
    return body.data?.brandLogoTextLong?.trim() || body.data?.companyName?.trim() || DESKTOP_APPLICATION_NAME;
  } catch {
    return DESKTOP_APPLICATION_NAME;
  } finally {
    clearTimeout(timeout);
  }
}

export function registerAppIpc() {
  ipcMain.handle(IPC_CHANNELS.appGetConfig, async () => ({
    ...loadDesktopConfig(),
    programTitle: await loadProgramTitle()
  }));
  ipcMain.handle(IPC_CHANNELS.appGetVersion, () => app.getVersion());
}
