import type {
  AiExecutorDesktopPort,
  AiExecutorDesktopBridgeContract,
  CodexAuthorizationDesktopBridgeContract,
  MatrixAccountDesktopBridgeContract,
  MatrixAccountDesktopPort
} from "@ky/admin-core";

const DESKTOP_CLIENT_MODE = "desktop";
const DESKTOP_CLIENT_NAME = "aicrm-desktop";

export interface DesktopBridgeLike {
  app?: {
    getVersion?: () => Promise<string>;
    getConfig?: () => Promise<{ debugMode?: boolean }>;
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
  matrixAccount?: MatrixAccountDesktopBridgeContract;
  aiExecutor?: AiExecutorDesktopBridgeContract;
  codex?: {
    authorization?: CodexAuthorizationDesktopBridgeContract;
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

/** The sole Host adapter from the preload bridge into plugin-facing Core APIs. */
export const matrixAccountDesktopPort: MatrixAccountDesktopPort = {
  isDesktopRuntime: isDesktopClientMode,
  async getDebugMode() {
    const config = await getDesktopBridge()?.app?.getConfig?.();
    return Boolean(config?.debugMode);
  },
  getMatrixAccountBridge() {
    return getDesktopBridge()?.matrixAccount ?? null;
  },
  getAiExecutorBridge() {
    return getDesktopBridge()?.aiExecutor ?? null;
  }
};

/** Host-only resolver for the ticket-bound Bridge v2 authorization surface. */
export const aiExecutorDesktopPort: AiExecutorDesktopPort = {
  isDesktopRuntime: isDesktopClientMode,
  getAuthorizationBridge() {
    return getDesktopBridge()?.codex?.authorization ?? null;
  }
};

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
