import { DEFAULT_API_BASE_URL, DEFAULT_WEB_URL } from "../shared/constants";
import type { DesktopConfig } from "../shared/types";
import { isDesktopDebugMode } from "./runtime-mode";

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/\/+$/, "");
}

export function loadDesktopConfig(): DesktopConfig {
  return {
    apiBaseUrl: normalizeBaseUrl(process.env.AICRM_API_BASE_URL || process.env.KY_CONSOLE_URL, DEFAULT_API_BASE_URL),
    debugMode: isDesktopDebugMode(),
    webUrl: normalizeBaseUrl(process.env.AICRM_WEB_URL, DEFAULT_WEB_URL)
  };
}
