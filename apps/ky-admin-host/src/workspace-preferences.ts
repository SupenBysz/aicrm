import { useEffect, useState } from "react";
import { loadBootstrap } from "./app-store";

const KEY_PREFIX = "ky.admin.workspace-preferences.v1:";
const CHANGE_EVENT = "ky:workspace-preferences-changed";

export interface WorkspacePreferences {
  showBreadcrumb: boolean;
}

const DEFAULT_PREFERENCES: WorkspacePreferences = { showBreadcrumb: true };

function storageKey(userId?: string) {
  return `${KEY_PREFIX}${userId || "anonymous"}`;
}

function readPreferences(userId?: string): WorkspacePreferences {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return DEFAULT_PREFERENCES;
    const value = JSON.parse(raw) as Partial<WorkspacePreferences>;
    return { showBreadcrumb: typeof value.showBreadcrumb === "boolean" ? value.showBreadcrumb : true };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function accountId() {
  return loadBootstrap()?.user.id;
}

export function saveShowBreadcrumb(showBreadcrumb: boolean, userId = accountId()) {
  const next = { ...readPreferences(userId), showBreadcrumb };
  localStorage.setItem(storageKey(userId), JSON.stringify(next));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useWorkspacePreferences(userId = accountId()) {
  const [preferences, setPreferences] = useState(() => readPreferences(userId));

  useEffect(() => {
    const refresh = () => setPreferences(readPreferences(userId));
    refresh();
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("ky:session-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("ky:session-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [userId]);

  return {
    ...preferences,
    setShowBreadcrumb: (showBreadcrumb: boolean) => saveShowBreadcrumb(showBreadcrumb, userId)
  };
}
