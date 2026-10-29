import {localCredentialStorage as safeStorage,localCredentialRoot} from "./local-credential-storage";
import { app } from "electron";
import type { DesktopSession } from "../shared/types";
import { DesktopSessionStore } from "./desktop-session-store";

let store: DesktopSessionStore | null = null;

export function getDesktopSessionStore(): DesktopSessionStore {
  if (!store) {
    store = new DesktopSessionStore({ root: localCredentialRoot(), safeStorage });
  }
  return store;
}

export function loadSession(): Promise<DesktopSession | null> {
  return getDesktopSessionStore().load();
}

export function saveSession(session: DesktopSession): Promise<void> {
  return getDesktopSessionStore().save(session);
}

export function clearSession(): Promise<void> {
  return getDesktopSessionStore().clear();
}
