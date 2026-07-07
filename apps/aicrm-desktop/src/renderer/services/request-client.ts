import type { ApiEnvelope, DesktopConfig, DesktopSession } from "../../shared/types";
import { getDesktopBridge } from "./desktop-bridge";

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
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

export async function request<T>(
  config: DesktopConfig,
  session: DesktopSession | null,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  void config;
  const response = await getDesktopBridge().api.request<T>({
    path,
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
    token: session?.token
  });

  const envelope = response.envelope as ApiEnvelope<T>;
  if (!response.ok || response.envelope.error) {
    throw new ApiError(
      envelope.error?.message || `请求失败(${response.status})`,
      envelope.error?.code || "request_failed",
      envelope.requestId,
      envelope.error?.details
    );
  }

  return envelope.data as T;
}
