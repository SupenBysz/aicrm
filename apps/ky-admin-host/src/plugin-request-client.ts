import type {
  AuthenticatedSseEvent,
  EventStreamOptions,
  EventStreamSubscription,
  RequestClient,
  RequestOptions,
  WorkspaceIdentity
} from "@ky/admin-core";
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

  subscribe<T>(path: string, options: EventStreamOptions<T>): EventStreamSubscription {
    const controller = new AbortController();
    const close = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) close();
      else options.signal.addEventListener("abort", close, { once: true });
    }
    const done = this.consumeEventStream(path, options, controller.signal).finally(() => {
      options.signal?.removeEventListener("abort", close);
    });
    return { close, done };
  }

  private async consumeEventStream<T>(path: string, options: EventStreamOptions<T>, signal: AbortSignal): Promise<void> {
    let cursor = validCursor(options.after) ? options.after! : 0;
    const retryDelayMs = Math.max(250, options.retryDelayMs ?? 1000);
    const shouldClose = options.shouldClose ?? defaultShouldClose;

    while (!signal.aborted) {
      try {
        const response = await this.stream(withEventCursor(path, cursor), {
          headers: {
            Accept: "text/event-stream",
            "Last-Event-ID": String(cursor)
          },
          signal
        });
        options.onOpen?.();
        let terminal = false;
        await readAuthenticatedSse<T>(response, signal, (event) => {
          if (event.id != null) cursor = Math.max(cursor, event.id);
          try {
            options.onEvent(event);
          } catch (error) {
            options.onError?.(error);
          }
          if (shouldClose(event)) terminal = true;
        });
        if (terminal || signal.aborted) return;
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        options.onError?.(error);
        if (!isRetryableStreamError(error)) return;
      }
      await abortableDelay(retryDelayMs, signal);
    }
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
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
    return { response, requestId };
  }
}

function validCursor(value: number | undefined): boolean {
  return value == null || (Number.isSafeInteger(value) && value >= 0);
}

function withEventCursor(path: string, cursor: number): string {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error("event stream must use the current origin");
  url.searchParams.set("after", String(cursor));
  return `${url.pathname}${url.search}`;
}

function defaultShouldClose<T>(event: AuthenticatedSseEvent<T>): boolean {
  return event.event.endsWith(".stream.closed") || event.event.endsWith(".closed");
}

async function readAuthenticatedSse<T>(
  response: Response,
  signal: AbortSignal,
  onEvent: (event: AuthenticatedSseEvent<T>) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("event stream response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = parseSseFrame<T>(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frame) onEvent(frame);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseSseFrame<T>(frame: string): AuthenticatedSseEvent<T> | null {
  let id: number | undefined;
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "id") {
      if (!/^\d+$/.test(rawValue)) throw new Error("invalid persisted event id");
      const parsed = Number(rawValue);
      if (!Number.isSafeInteger(parsed)) throw new Error("persisted event id overflow");
      id = parsed;
    } else if (field === "event") {
      event = rawValue || "message";
    } else if (field === "data") {
      data.push(rawValue);
    }
  }
  if (data.length === 0) return null;
  const joined = data.join("\n");
  let parsed: unknown = joined;
  try {
    parsed = JSON.parse(joined);
  } catch {
    // Connection-level safety frames may be plain text; domain adapters decide
    // whether their payload is acceptable.
  }
  return { id, event, data: parsed as T };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRetryableStreamError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return ![
    "unauthorized",
    "permission_denied",
    "workspace_forbidden",
    "invalid_event_cursor",
    "not_found"
  ].includes(error.code);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
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
