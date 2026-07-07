import type { AiCrmDesktopBridge } from "../preload/types";

declare global {
  interface Window {
    aicrm: AiCrmDesktopBridge;
  }
}

export {};
