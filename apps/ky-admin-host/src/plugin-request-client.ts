import type { RequestClient, RequestOptions, WorkspaceIdentity } from "@ky/admin-core";
import { ADMIN_SESSION_KEY } from "./app-store";
import { desktopClientHeaders } from "./desktop-client";

interface ApiEnvelope<T> {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

interface StoredSession {
  token: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly requestId?: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export class HostRequestClient implements RequestClient {
  constructor(private readonly getWorkspace?: () => WorkspaceIdentity | null) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.fetch(path, options);
    const requestId = response.requestId;
    const envelope = await readEnvelope<T>(response.response, requestId);
    if (!options.skipAuthRedirect && (response.response.status === 401 || envelope.error?.code === "unauthorized")) {
      handleSessionExpired();
    }
    if (!response.response.ok || envelope.error) {
      throw new ApiError(
        envelope.error?.message ?? `Request failed: ${response.response.status}`,
        envelope.error?.code ?? "request_failed",
        envelope.requestId,
        envelope.error?.details
      );
    }

    return envelope.data as T;
  }

  async stream(path: string, options: RequestOptions = {}): Promise<Response> {
    const { response } = await this.fetch(path, options);
    if (!options.skipAuthRedirect && response.status === 401) {
      handleSessionExpired();
    }
    if (!response.ok) {
      const envelope = await readEnvelope<unknown>(response, "");
      throw new ApiError(envelope.error?.message ?? `Request failed: ${response.status}`, envelope.error?.code ?? "request_failed");
    }
    return response;
  }

  private async fetch(path: string, options: RequestOptions): Promise<{ response: Response; requestId: string }> {
    const session = loadStoredSession();
    const workspace = this.getWorkspace?.();
    const requestId = crypto.randomUUID();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-KY-Request-Id": requestId,
      ...desktopClientHeaders(),
      ...(options.headers ?? {})
    };

    if (session?.token) {
      headers.Authorization = `Bearer ${session.token}`;
    }
    if (workspace) {
      headers["X-KY-Workspace-Id"] = workspace.id;
      headers["X-KY-Workspace-Type"] = workspace.type;
    }

    const response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    return { response, requestId };
  }
}

async function readEnvelope<T>(response: Response, fallbackRequestId: string): Promise<ApiEnvelope<T>> {
  const text = await response.text();
  if (!text) {
    return { data: undefined as T, requestId: fallbackRequestId };
  }
  try {
    return JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    return {
      error: {
        code: "invalid_response",
        message: normalizeInvalidResponseMessage(response, text)
      },
      requestId: fallbackRequestId
    };
  }
}

function normalizeInvalidResponseMessage(response: Response, text: string): string {
  const contentType = response.headers.get("content-type") ?? "";
  const lower = text.slice(0, 300).toLowerCase();
  if (response.status === 413 || lower.includes("too large body")) {
    return "请求内容过大，请稍后重试";
  }
  if (contentType.includes("text/html") || lower.includes("<html") || lower.includes("cloudflare")) {
    return "服务网关返回异常，请稍后重试";
  }
  return text.slice(0, 200) || "Invalid response";
}

function handleSessionExpired() {
  localStorage.removeItem(ADMIN_SESSION_KEY);
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.assign("/login");
  }
}

function loadStoredSession(): StoredSession | null {
  const raw = localStorage.getItem(ADMIN_SESSION_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}
