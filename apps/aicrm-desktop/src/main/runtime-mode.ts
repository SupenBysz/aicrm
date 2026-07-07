import { app } from "electron";

export function isDesktopDebugMode(): boolean {
  return process.env.AICRM_DESKTOP_DEBUG === "1" || !app.isPackaged;
}

export function isDesktopProductionMode(): boolean {
  return !isDesktopDebugMode();
}
