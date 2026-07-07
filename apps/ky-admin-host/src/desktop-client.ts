const DESKTOP_CLIENT_MODE = "desktop";
const DESKTOP_CLIENT_NAME = "aicrm-desktop";

export interface DesktopBridgeLike {
  app?: {
    getVersion?: () => Promise<string>;
  };
  window?: {
    getState?: () => Promise<DesktopWindowState>;
    setFullScreen?: (enabled: boolean) => Promise<DesktopWindowState>;
    setAlwaysOnTop?: (enabled: boolean) => Promise<DesktopWindowState>;
    openDevTools?: () => Promise<DesktopOpenDevToolsResult>;
    onStateChanged?: (listener: (state: DesktopWindowState) => void) => () => void;
  };
  network?: {
    getSnapshot?: () => Promise<DesktopNetworkLogSnapshot>;
    clear?: () => Promise<DesktopNetworkLogSnapshot>;
  };
}

export interface DesktopWindowState {
  platform: string;
  isMaximized: boolean;
  isMinimized: boolean;
  isFullScreen: boolean;
  isFocused: boolean;
  isAlwaysOnTop?: boolean;
}

export interface DesktopOpenDevToolsResult {
  opened: boolean;
  reason?: "production" | "unavailable";
}

export interface DesktopNetworkLogEntry {
  id: string;
  status: "completed" | "failed";
  method: string;
  url: string;
  resourceType: string;
  statusCode?: number;
  error?: string;
  startedAt: string;
  completedAt: string;
  durationMs?: number;
}

export interface DesktopNetworkLogSnapshot {
  enabled: boolean;
  maxEntries: number;
  entries: DesktopNetworkLogEntry[];
}

declare global {
  interface Window {
    aicrm?: DesktopBridgeLike;
  }
}

export function isDesktopClientMode(): boolean {
  return typeof window !== "undefined" && typeof window.aicrm?.app?.getVersion === "function";
}

export function getDesktopBridge(): DesktopBridgeLike | null {
  if (!isDesktopClientMode()) return null;
  return window.aicrm ?? null;
}

export function desktopClientHeaders(): Record<string, string> {
  if (!isDesktopClientMode()) return {};
  return {
    "X-AiCRM-Client-Mode": DESKTOP_CLIENT_MODE,
    "X-AiCRM-Client-Name": DESKTOP_CLIENT_NAME
  };
}

export function withDesktopClientLoginPayload<T extends object>(
  payload: T
): T & { clientMode?: string; clientName?: string } {
  if (!isDesktopClientMode()) return payload;
  return {
    ...payload,
    clientMode: DESKTOP_CLIENT_MODE,
    clientName: DESKTOP_CLIENT_NAME
  };
}

export {};
