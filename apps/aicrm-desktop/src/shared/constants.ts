export const DEFAULT_API_BASE_URL = "http://127.0.0.1:16178";
export const DEFAULT_WEB_URL = "https://kyaicrm.entai.im";

export const IPC_CHANNELS = {
  apiRequest: "api:request",
  appGetConfig: "app:get-config",
  appGetVersion: "app:get-version",
  sessionLoad: "session:load",
  sessionSave: "session:save",
  sessionClear: "session:clear",
  windowGetState: "window:get-state",
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggle-maximize",
  windowSetFullScreen: "window:set-full-screen",
  windowSetAlwaysOnTop: "window:set-always-on-top",
  windowOpenDevTools: "window:open-devtools",
  windowClose: "window:close",
  windowStateChanged: "window:state-changed",
  networkLogSnapshot: "network-log:snapshot",
  networkLogClear: "network-log:clear"
} as const;
