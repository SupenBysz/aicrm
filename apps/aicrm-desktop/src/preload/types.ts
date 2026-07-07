import type {
  DesktopApiRequest,
  DesktopApiResponse,
  DesktopConfig,
  DesktopNetworkLogSnapshot,
  DesktopOpenDevToolsResult,
  DesktopSession,
  DesktopWindowState
} from "../shared/types";

export interface AiCrmDesktopBridge {
  api: {
    request: <T = unknown>(request: DesktopApiRequest) => Promise<DesktopApiResponse<T>>;
  };
  app: {
    getConfig: () => Promise<DesktopConfig>;
    getVersion: () => Promise<string>;
  };
  session: {
    load: () => Promise<DesktopSession | null>;
    save: (session: DesktopSession) => Promise<boolean>;
    clear: () => Promise<boolean>;
  };
  window: {
    getState: () => Promise<DesktopWindowState>;
    minimize: () => Promise<DesktopWindowState>;
    toggleMaximize: () => Promise<DesktopWindowState>;
    setFullScreen: (enabled: boolean) => Promise<DesktopWindowState>;
    setAlwaysOnTop: (enabled: boolean) => Promise<DesktopWindowState>;
    openDevTools: () => Promise<DesktopOpenDevToolsResult>;
    close: () => Promise<boolean>;
    onStateChanged: (listener: (state: DesktopWindowState) => void) => () => void;
  };
  network: {
    getSnapshot: () => Promise<DesktopNetworkLogSnapshot>;
    clear: () => Promise<DesktopNetworkLogSnapshot>;
  };
}
