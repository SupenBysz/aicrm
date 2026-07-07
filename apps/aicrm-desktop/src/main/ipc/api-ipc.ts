import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { ApiEnvelope, DesktopApiRequest, DesktopApiResponse } from "../../shared/types";
import { loadDesktopConfig } from "../config";

function apiUrl(path: string): string {
  const config = loadDesktopConfig();
  return `${config.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function parseEnvelope(text: string): ApiEnvelope<unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as ApiEnvelope<unknown>;
  } catch {
    return {};
  }
}

export function registerApiIpc() {
  ipcMain.handle(IPC_CHANNELS.apiRequest, async (_event, request: DesktopApiRequest): Promise<DesktopApiResponse> => {
    const response = await fetch(apiUrl(request.path), {
      method: request.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(request.token ? { Authorization: `Bearer ${request.token}` } : {}),
        ...(request.headers ?? {})
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body)
    });
    const envelope = parseEnvelope(await response.text());
    return {
      ok: response.ok,
      status: response.status,
      envelope
    };
  });
}
