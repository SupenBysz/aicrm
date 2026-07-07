import { session } from "electron";
import type { DesktopNetworkLogEntry, DesktopNetworkLogSnapshot } from "../shared/types";

const MAX_NETWORK_LOG_ENTRIES = 300;

let installed = false;
let enabled = true;
const entries: DesktopNetworkLogEntry[] = [];
const pendingRequests = new Map<number, { method: string; url: string; resourceType: string; startedAt: number }>();

function shouldCapture(url: string): boolean {
  if (!enabled) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function pushEntry(entry: DesktopNetworkLogEntry): void {
  entries.unshift(entry);
  if (entries.length > MAX_NETWORK_LOG_ENTRIES) {
    entries.length = MAX_NETWORK_LOG_ENTRIES;
  }
}

export function getNetworkLogSnapshot(): DesktopNetworkLogSnapshot {
  return {
    enabled,
    maxEntries: MAX_NETWORK_LOG_ENTRIES,
    entries: [...entries]
  };
}

export function clearNetworkLogs(): DesktopNetworkLogSnapshot {
  entries.length = 0;
  pendingRequests.clear();
  return getNetworkLogSnapshot();
}

export function setNetworkLogEnabled(nextEnabled: boolean): DesktopNetworkLogSnapshot {
  enabled = nextEnabled;
  if (!enabled) pendingRequests.clear();
  return getNetworkLogSnapshot();
}

export function installNetworkLogCapture(): void {
  if (installed) return;
  installed = true;

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (shouldCapture(details.url)) {
      pendingRequests.set(details.id, {
        method: details.method,
        url: details.url,
        resourceType: details.resourceType,
        startedAt: Date.now()
      });
    }
    callback({});
  });

  session.defaultSession.webRequest.onCompleted((details) => {
    const pending = pendingRequests.get(details.id);
    pendingRequests.delete(details.id);
    if (!pending && !shouldCapture(details.url)) return;

    const startedAt = pending?.startedAt ?? Date.now();
    const completedAt = Date.now();
    pushEntry({
      id: String(details.id),
      status: "completed",
      method: pending?.method ?? details.method,
      url: pending?.url ?? details.url,
      resourceType: pending?.resourceType ?? details.resourceType,
      statusCode: details.statusCode,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: Math.max(0, completedAt - startedAt)
    });
  });

  session.defaultSession.webRequest.onErrorOccurred((details) => {
    const pending = pendingRequests.get(details.id);
    pendingRequests.delete(details.id);
    if (!pending && !shouldCapture(details.url)) return;

    const startedAt = pending?.startedAt ?? Date.now();
    const completedAt = Date.now();
    pushEntry({
      id: String(details.id),
      status: "failed",
      method: pending?.method ?? details.method,
      url: pending?.url ?? details.url,
      resourceType: pending?.resourceType ?? details.resourceType,
      error: details.error,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: Math.max(0, completedAt - startedAt)
    });
  });
}
