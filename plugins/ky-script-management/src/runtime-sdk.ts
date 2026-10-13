export type BrowserSdkErrorCode = "HOST_CAPABILITY_UNAVAILABLE" | "PUBLIC_REGISTRATION_INVALID" | "PUBLIC_REGISTRATION_CONFLICT";
export type BrowserLifecycleEvent = "documentStart" | "domReady" | "pageLoad" | "routeChange" | "userAction";
export type BrowserNetworkKind = "request" | "response";
export type BrowserNetworkDecision = { action: "continue" | "abort" | "redirect" | "fulfill"; url?: string; method?: string; headers?: Record<string, string>; body?: string; status?: number; responseHeaders?: Record<string, string> };
export type BrowserNetworkMatch = { url?: string | string[]; method?: string | string[] };
export type BrowserNetworkOptions = { match?: BrowserNetworkMatch; includeBody?: boolean; timeoutMs?: number };
export type BrowserNetworkEvent = { kind: BrowserNetworkKind; stage: "beforeRequest" | "responseHeaders"; requestId: string; url: string; method: string; status?: number; headers?: Record<string, string>; body?: string };
export type BrowserNetworkHandler = (event: BrowserNetworkEvent & { continue: (decision?: BrowserNetworkDecision) => Promise<void>; abort: () => Promise<void>; redirect: (url: string) => Promise<void>; fulfill: (body: string, status?: number, headers?: Record<string, string>) => Promise<void> }) => unknown;
export type BrowserActionIcon =
  | { provider: "antd"; name: string }
  | { provider: "iconfont"; mode: "font-class"; stylesheetUrl: string; className: string }
  | { provider: "iconfont"; mode: "unicode"; stylesheetUrl: string; className: string; codePoint: string }
  | { provider: "iconfont"; mode: "symbol"; symbolId: string };
export type BrowserActionButtonOptions = { id?: string; title?: string; icon: BrowserActionIcon; onClick: (context: { url: string; navigationGeneration: number }) => unknown };
export type BrowserUiTextOptions = { durationMs?: number };
export type BrowserUiModalOptions = { title: string; content: string; okText?: string; cancelText?: string };

function unavailable<T>(): Promise<T> { const error = new Error("HOST_CAPABILITY_UNAVAILABLE") as Error & { code?: BrowserSdkErrorCode }; error.code = "HOST_CAPABILITY_UNAVAILABLE"; return Promise.reject(error); }
function matches(value: string, expected?: string | string[]): boolean { if (!expected) return true; return (Array.isArray(expected) ? expected : [expected]).some(pattern => { const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"); return new RegExp(`^${escaped}$`, "i").test(value); }); }

export function createBrowserPageSdk(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>) {
  const listeners = new Map<BrowserLifecycleEvent, Set<{ handler: (detail: Record<string, unknown>) => unknown; once: boolean }>>();
  const lifecycleState = new Map<BrowserLifecycleEvent, Record<string, unknown>>();
  const namespaces = new Map<string, Readonly<Record<string, unknown>>>();
  const network = new Map<string, { kind: BrowserNetworkKind; options: BrowserNetworkOptions; handler: BrowserNetworkHandler }>();
  const originalFetch = typeof target.fetch === "function" ? target.fetch as typeof fetch : undefined;
  let fetchInstalled = false;
  let sequence = 0;
  const lifecycle = {
    on(event: BrowserLifecycleEvent, handler: (detail: Record<string, unknown>) => unknown) { const entries = listeners.get(event) ?? new Set(); const entry = { handler, once: false }; entries.add(entry); listeners.set(event, entries); if (lifecycleState.has(event)) queueMicrotask(() => { try { void handler(lifecycleState.get(event) ?? {}); } catch { /* 页面回调隔离 */ } }); return () => entries.delete(entry); },
    once(event: BrowserLifecycleEvent, handler: (detail: Record<string, unknown>) => unknown) { const entries = listeners.get(event) ?? new Set(); const entry = { handler, once: true }; entries.add(entry); listeners.set(event, entries); if (lifecycleState.has(event)) { entries.delete(entry); queueMicrotask(() => { try { void handler(lifecycleState.get(event) ?? {}); } catch { /* 页面回调隔离 */ } }); } return () => entries.delete(entry); },
    off(event: BrowserLifecycleEvent, handler?: unknown) { const entries = listeners.get(event); if (!entries) return; for (const entry of entries) if (!handler || entry.handler === handler) entries.delete(entry); },
    dispatch(event: BrowserLifecycleEvent, detail: Record<string, unknown> = {}) { lifecycleState.set(event, detail); const entries = listeners.get(event); if (!entries) return; for (const entry of [...entries]) { if (entry.once) entries.delete(entry); try { void entry.handler(detail); } catch { /* 页面回调隔离 */ } } }
  };
  const publicApi = {
    register(definition: { identifier?: string; factory?: (input: { jssdk: unknown }) => Record<string, unknown> }) {
    const id = definition?.identifier ?? "";
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(id) || typeof definition.factory !== "function") throw new Error("PUBLIC_REGISTRATION_INVALID");
    if (["HOST", "PUBLIC", "LIFECYCLE", "VERSION", "CAPABILITIES", "REGISTER"].includes(id)) throw new Error("PUBLIC_REGISTRATION_CONFLICT");
    // 重复加载时保留首次注册结果；消费者通过 get() 读取稳定命名空间。
    if (namespaces.has(id)) return false;
    const exports = definition.factory({ jssdk: sdk });
    if (!exports || typeof exports !== "object" || Array.isArray(exports)) throw new Error("PUBLIC_REGISTRATION_EXPORTS_INVALID");
    // Mirror contextBridge's plain-object payload contract in browser fallback.
    const frozen = Object.freeze({ ...exports });
    namespaces.set(id, frozen);
    // 浏览器 fallback 不经过 contextBridge，可以同时提供便捷属性访问。
    Object.defineProperty(publicApi, id, { value: frozen, enumerable: true });
    return true;
  },
    get(identifier: string) { return namespaces.get(identifier); },
    has(identifier: string) { return namespaces.has(identifier); }
  } as { register: (definition: { identifier?: string; factory?: (input: { jssdk: unknown }) => Record<string, unknown> }) => boolean; get: (identifier: string) => Readonly<Record<string, unknown>> | undefined; has: (identifier: string) => boolean } & Record<string, unknown>;

  async function runNetworkHandlers(kind: BrowserNetworkKind, event: BrowserNetworkEvent): Promise<BrowserNetworkDecision> {
    let decision: BrowserNetworkDecision = { action: "continue" };
    const matched = [...network.entries()].filter(([, item]) => item.kind === kind && matches(event.url, item.options.match?.url) && matches(event.method, item.options.match?.method));
    for (const [id, item] of matched) {
      let decided = false;
      const decide = async (next: BrowserNetworkDecision = { action: "continue" }) => { if (!decided) { decided = true; decision = next; } };
      try { await Promise.resolve(item.handler({ ...event, continue: decide, abort: () => decide({ action: "abort" }), redirect: (url) => decide({ action: "redirect", url }), fulfill: (body, status, headers) => decide({ action: "fulfill", body, status, responseHeaders: headers }) })); } catch { /* 单个订阅异常不影响请求 */ }
      if (decision.action !== "continue") break;
      if (id.startsWith("wait:")) network.delete(id);
    }
    return decision;
  }
  function installFetch(): void {
    if (fetchInstalled || !originalFetch) return;
    fetchInstalled = true;
    target.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); const requestId = `browser:${++sequence}`;
      const requestEvent: BrowserNetworkEvent = { kind: "request", stage: "beforeRequest", requestId, url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()) };
      const requestDecision = await runNetworkHandlers("request", requestEvent);
      if (requestDecision.action === "abort") throw new Error("NETWORK_ABORTED");
      const nextInit: RequestInit = { ...init };
      const nextUrl = requestDecision.url ?? request.url;
      if (requestDecision.method) nextInit.method = requestDecision.method;
      if (requestDecision.headers) nextInit.headers = requestDecision.headers;
      if (requestDecision.body !== undefined) nextInit.body = requestDecision.body;
      const response = await originalFetch.call(target, nextUrl, nextInit);
      const responseBody = [...network.values()].some(item => item.kind === "response" && item.options.includeBody) ? await response.clone().text().catch(() => undefined) : undefined;
      const responseEvent: BrowserNetworkEvent = { kind: "response", stage: "responseHeaders", requestId, url: response.url || nextUrl, method: request.method, status: response.status, headers: Object.fromEntries(response.headers.entries()), body: responseBody };
      const responseDecision = await runNetworkHandlers("response", responseEvent);
      if (responseDecision.action === "abort") throw new Error("NETWORK_ABORTED");
      if (responseDecision.action === "fulfill") return new Response(responseDecision.body ?? "", { status: responseDecision.status ?? 200, headers: responseDecision.responseHeaders });
      return response;
    }) as typeof fetch;
  }
  function subscribe(kind: BrowserNetworkKind, options: BrowserNetworkOptions, handler: BrowserNetworkHandler, prefix = "observe"): () => void { installFetch(); const id = `${prefix}:${++sequence}`; network.set(id, { kind, options, handler }); return () => network.delete(id); }
  const net = {
    subscribeRequest: (options: BrowserNetworkOptions, handler: BrowserNetworkHandler) => Promise.resolve(subscribe("request", options, handler)),
    subscribeResponse: (options: BrowserNetworkOptions, handler: BrowserNetworkHandler) => Promise.resolve(subscribe("response", options, handler)),
    interceptRequest: (options: BrowserNetworkOptions, handler: BrowserNetworkHandler) => Promise.resolve(subscribe("request", options, handler, "intercept")),
    interceptResponse: (options: BrowserNetworkOptions, handler: BrowserNetworkHandler) => Promise.resolve(subscribe("response", options, handler, "intercept")),
    waitForRequest: (options: BrowserNetworkOptions) => new Promise<BrowserNetworkEvent>((resolve, reject) => { let off: (() => void) | undefined; off = subscribe("request", options, event => { resolve(event); off?.(); }); setTimeout(() => { off?.(); reject(new Error("NETWORK_WAIT_TIMEOUT")); }, options.timeoutMs ?? 10000); }),
    waitForResponse: (options: BrowserNetworkOptions) => new Promise<BrowserNetworkEvent>((resolve, reject) => { let off: (() => void) | undefined; off = subscribe("response", options, event => { resolve(event); off?.(); }); setTimeout(() => { off?.(); reject(new Error("NETWORK_WAIT_TIMEOUT")); }, options.timeoutMs ?? 10000); })
  };
  const host = { getStoreInfo: () => unavailable<unknown>(), upload: () => unavailable<unknown>(), updateLoginSpaceInfo: () => unavailable<never>(), getCurrentUser: () => unavailable<unknown>(), getShopAccount: () => unavailable<string>(), getPlatform: () => unavailable<string>(), getCapabilities: () => Promise.resolve(["lifecycle", "public", "net.subscribeRequest", "net.subscribeResponse", "net.waitForRequest", "net.waitForResponse", "net.interceptRequest", "net.interceptResponse"]), fillLoginForm: () => unavailable<never>() };
  const store = { getStoreInfo: () => unavailable<unknown>(), setStoreInfo: () => unavailable<unknown>() };
  const windowApi = {
    addActionButton: (_options: BrowserActionButtonOptions) => unavailable<never>(),
  };
  const ui = {
    message: {
      success: (_text: string, _options?: BrowserUiTextOptions) => unavailable<void>(),
      info: (_text: string, _options?: BrowserUiTextOptions) => unavailable<void>(),
      warning: (_text: string, _options?: BrowserUiTextOptions) => unavailable<void>(),
      error: (_text: string, _options?: BrowserUiTextOptions) => unavailable<void>(),
      loading: (_text: string, _options?: BrowserUiTextOptions) => unavailable<void>(),
    },
    notification: {
      success: (_options: { message: string; description?: string; durationMs?: number }) => unavailable<void>(),
      info: (_options: { message: string; description?: string; durationMs?: number }) => unavailable<void>(),
      warning: (_options: { message: string; description?: string; durationMs?: number }) => unavailable<void>(),
      error: (_options: { message: string; description?: string; durationMs?: number }) => unavailable<void>(),
    },
    modal: {
      confirm: (_options: BrowserUiModalOptions) => unavailable<boolean>(),
      info: (_options: BrowserUiModalOptions) => unavailable<void>(),
      success: (_options: BrowserUiModalOptions) => unavailable<void>(),
      warning: (_options: BrowserUiModalOptions) => unavailable<void>(),
      error: (_options: BrowserUiModalOptions) => unavailable<void>(),
    },
  };
  const sdk = { version: "1", host, store, window: windowApi, ui, public: publicApi, lifecycle, net };
  return sdk;
}

export function installBrowserPageSdk(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>) { const sdk = createBrowserPageSdk(target); target.jssdk = sdk; return sdk; }
