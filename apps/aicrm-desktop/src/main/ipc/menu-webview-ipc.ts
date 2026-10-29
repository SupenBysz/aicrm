import {isHostScreenLocked,onHostScreenLock} from "../host-screen-lock";
import {restoreHostOverlayOrder} from "../host-overlay";
import { createHash, randomUUID } from "node:crypto";
import { BrowserWindow, WebContentsView, session as electronSession, type IpcMainInvokeEvent, type Session, type WebContents } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
  DesktopCommandResult,
  MenuWebViewBoundsInput,
  MenuWebViewCloseInput,
  MenuWebViewNavigateInput,
  MenuWebViewOpenInput,
  MenuWebViewOpenResult,
  MenuWebViewState,
  MenuWebViewStateChanged
} from "../../shared/types";
import { loadDesktopConfig } from "../config";
import { authorized, scopedIpc } from "../guarded-ipc";
import { loadSession } from "../session-store";
import {
  createMenuRuntimeSchedule,
  menuRuntimeAssetKey,
  menuRuntimeAssetSource,
  menuRuntimeLifecycleBootstrap,
  menuWebViewUrlAllowed,
  validMenuWebViewBounds,
  validMenuWebViewClose,
  validMenuWebViewCommand,
  validMenuWebViewOpenInput
} from "../menu-webview-runtime-core.mjs";

type RuntimeAsset = {
  id: string;
  identifier: string;
  version: string;
  runAt: string;
  priority: number;
  assetType: "script" | "style";
  sourceContent: string;
  sourceBytes: number;
  sourceSha256: string;
  publicDependency?: boolean;
};
type RuntimeMenuConfig = {
  name: string;
  menuKey: string;
  directoryType: "management" | "workbench";
  platform: string;
  defaultUrl: string;
  openMode: "embedded" | "window";
  navigationProtocols: string[];
  scheduleMode: "page_first" | "strict_document_start";
  revision: number;
};
type RuntimeResponse = {
  menu: RuntimeMenuConfig;
  url: string;
  assets: RuntimeAsset[];
  public: Array<{ identifier: string; version: string; source: string; sourceBytes: number; sourceSha256: string }>;
  publicStyles: Array<{ identifier: string; version: string; sourceContent: string; sourceBytes: number; sourceSha256: string; runAt: string; priority: number }>;
};
type Instance = {
  activationId:string;
  boundsSequence:number;
  id: string;
  opener: WebContents;
  hostWindow: BrowserWindow;
  view: WebContentsView;
  contents: WebContents;
  mode: "embedded" | "window";
  stableKey: string;
  identityKey: string;
  active: boolean;
  touchedAt: number;
  workspaceType: MenuWebViewOpenInput["workspaceType"];
  workspaceId: string;
  directoryType: MenuWebViewOpenInput["directoryType"];
  menuKey: string;
  config: RuntimeMenuConfig;
  data: RuntimeResponse;
  generation: number;
  allowedNextNavigation: string | null;
  registrations: string[];
  ran: Set<string>;
  state: MenuWebViewState;
  bounds: MenuWebViewBoundsInput | null;
  pendingNavigation: Set<string>;
  historyEntries: string[];
  historyIndex: number;
  pendingHistoryIndex: number | null;
  assetErrors: Set<string>;
  ownerDispose?: () => void;
};

const openGenerations=new Map<number,number>();
const instances = new Map<string, Instance>();
const instancesByStableKey = new Map<string, Instance>();
const activeEmbeddedByOwner = new Map<number, string>();
const sessionPartitions = new Map<string, Session>();
const maxResponseBytes = 8 * 1024 * 1024;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ok<T>(data: T): DesktopCommandResult<T> { return { ok: true, data }; }
function fail(code: string, message: string): DesktopCommandResult<never> { return { ok: false, error: { code, message } }; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function safePageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
function safeDisplayedUrl(raw: string): string {
  try { const u = new URL(raw); return `${u.origin}${u.pathname}`.slice(0, 1024); } catch { return ""; }
}
function sessionIdentity(token: string): string {
  if (typeof token !== "string" || token.length === 0) return "";
  try {
    const payload = object(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    const subject = typeof payload.sub === "string" ? payload.sub : typeof payload.userId === "string" ? payload.userId : "";
    if (subject) return subject;
  } catch { /* opaque token */ }
  return createHash("sha256").update(token).digest("hex");
}
function stableViewKey(input: MenuWebViewOpenInput, identity: string, ownerId: number): string {
  return createHash("sha256").update([identity, input.workspaceType, input.workspaceId, input.directoryType, input.menuKey, ownerId].join("\0")).digest("hex");
}
function sessionPartition(input: MenuWebViewOpenInput, token: string): string {
  const scope = [sessionIdentity(token), input.workspaceType, input.workspaceId, input.directoryType, input.menuKey].join("\0");
  return `persist:ky-menu-${createHash("sha256").update(scope).digest("hex").slice(0, 40)}`;
}
function getPartitionSession(input: MenuWebViewOpenInput, token: string): Session {
  const partition = sessionPartition(input, token);
  const cached = sessionPartitions.get(partition);
  if (cached) return cached;
  const created = electronSession.fromPartition(partition);
  created.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  created.setPermissionCheckHandler(() => false);
  created.on("will-download", (event) => event.preventDefault());
  sessionPartitions.set(partition, created);
  return created;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const headerLength = Number(response.headers.get("content-length") || 0);
  if (headerLength > maxResponseBytes) { await response.body?.cancel(); throw new Error("runtime_response_too_large"); }
  if (!response.body) throw new Error("runtime_response_invalid");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) { await reader.cancel(); throw new Error("runtime_response_too_large"); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally { reader.releaseLock(); }
}

async function resolveRuntime(input: MenuWebViewOpenInput, url: string, expectedToken?: string): Promise<RuntimeResponse> {
  const desktopSession = await loadSession();
  if (!desktopSession?.token) throw new Error("desktop_session_unavailable");
  if (expectedToken && desktopSession.token !== expectedToken) throw new Error("auth_context_changed");
  const config = loadDesktopConfig();
  const base = new URL(config.apiBaseUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) throw new Error("api_base_invalid");
  const endpoint = `${base.href.replace(/\/$/, "")}/api/v1/menu-webviews/${input.directoryType}/${encodeURIComponent(input.menuKey)}/runtime-resolve`;
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${desktopSession.token}`,
      "Content-Type": "application/json",
      "X-KY-Workspace-Type": input.workspaceType,
      "X-KY-Workspace-Id": input.workspaceId
    },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(12_000)
  });
  const text = await readBoundedResponse(response);
  const latestSession = await loadSession();
  if (!latestSession?.token || latestSession.token !== desktopSession.token) throw new Error("auth_context_changed");
  let envelope: Record<string, unknown>;
  try { envelope = object(JSON.parse(text)); } catch { throw new Error("runtime_response_invalid"); }
  if (!response.ok) {
    const error = object(envelope.error);
    throw new Error(typeof error.code === "string" ? error.code : `runtime_http_${response.status}`);
  }
  const raw = object(envelope.data);
  const menu = object(raw.menu) as unknown as RuntimeMenuConfig;
  const normalizedUrl = safePageUrl(raw.url);
  if (!menu || menu.menuKey !== input.menuKey || menu.directoryType !== input.directoryType
    || !["embedded", "window"].includes(menu.openMode)
    || !Array.isArray(menu.navigationProtocols)
    || !normalizedUrl || !menuWebViewUrlAllowed(normalizedUrl, menu.navigationProtocols)) throw new Error("runtime_config_invalid");
  const assets = Array.isArray(raw.assets) ? raw.assets as RuntimeAsset[] : [];
  const publicScripts = Array.isArray(raw.public) ? raw.public as RuntimeResponse["public"] : [];
  const publicStyles = Array.isArray(raw.publicStyles) ? raw.publicStyles as RuntimeResponse["publicStyles"] : [];
  if (assets.length + publicScripts.length + publicStyles.length > 64) throw new Error("runtime_asset_limit");
  const allContent = [
    ...assets.map((item) => ({ source: item.sourceContent, bytes: item.sourceBytes, sha256: item.sourceSha256 })),
    ...publicScripts.map((item) => ({ source: item.source, bytes: item.sourceBytes, sha256: item.sourceSha256 })),
    ...publicStyles.map((item) => ({ source: item.sourceContent, bytes: item.sourceBytes, sha256: item.sourceSha256 }))
  ];
  for (const item of allContent) {
    if (typeof item.source !== "string" || Buffer.byteLength(item.source, "utf8") !== item.bytes
      || createHash("sha256").update(item.source, "utf8").digest("hex") !== item.sha256) throw new Error("runtime_asset_integrity_failed");
  }
  return { menu, url: normalizedUrl, assets, public: publicScripts, publicStyles };
}

function emit(instance: Instance, status: MenuWebViewState["status"], errorCode?: string): void {
  if (instance.contents.isDestroyed() || instance.opener.isDestroyed()) return;
  instance.state = {
    instanceId: instance.id,
    sequence: (instance.state.sequence ?? 0) + 1,
    status,
    title: instance.state.title || instance.config.name || instance.menuKey,
    url: safeDisplayedUrl(instance.contents.getURL() || instance.data.url),
    errorCode
  };
  const event: MenuWebViewStateChanged = { instanceId: instance.id, state: instance.state };
  instance.opener.send(IPC_CHANNELS.menuWebViewChanged, event);
}

async function sendCdp(instance: Instance, method: string, params?: Record<string, unknown>): Promise<any> {
  if(isHostScreenLocked(instance.opener.id))throw Error("screen_locked");
  const debuggerApi = instance.contents.debugger;
  if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
  return debuggerApi.sendCommand(method, params);
}

function buildScript(asset: RuntimeAsset): string {
  const source = menuRuntimeAssetSource(asset);
  if (asset.assetType === "style") return source;
  const error = JSON.stringify({ identifier: asset.identifier, version: asset.version });
  return `(()=>{try{\n${source}\n}catch(e){console.error("__KY_MENU_ASSET_ERROR__"+${error})}})()`;
}

async function installDocumentStart(instance: Instance, data: RuntimeResponse): Promise<void> {
  if (instance.contents.isDestroyed()) throw new Error("webcontents_destroyed");
  await sendCdp(instance, "Page.enable");
  for (const identifier of instance.registrations.splice(0)) {
    try { await sendCdp(instance, "Page.removeScriptToEvaluateOnNewDocument", { identifier }); } catch { /* navigation cleanup may already have detached CDP */ }
  }
  const plan = createMenuRuntimeSchedule(data);
  const sources = [
    menuRuntimeLifecycleBootstrap(),
    ...plan.byRunAt("document_start").map(buildScript),
    `window.__KY_MENU_RUNTIME__?.lifecycle.__dispatch("documentStart",{url:location.href})`
  ];
  for (const source of sources) {
    const result = await sendCdp(instance, "Page.addScriptToEvaluateOnNewDocument", { source });
    if (!result?.identifier || typeof result.identifier !== "string") throw new Error("cdp_registration_failed");
    instance.registrations.push(result.identifier);
  }
}

async function injectAt(instance: Instance, runAt: string, url: string, generation = instance.generation): Promise<void> {
  if (instance.contents.isDestroyed() || generation !== instance.generation) return;
  const plan = createMenuRuntimeSchedule(instance.data);
  for (const asset of plan.byRunAt(runAt)) {
    if (generation !== instance.generation || instance.contents.isDestroyed()) return;
    const key = `${generation}|${url}|${runAt}|${menuRuntimeAssetKey(asset)}`;
    if (instance.ran.has(key)) continue;
    instance.ran.add(key);
    try { await instance.contents.executeJavaScript(buildScript(asset), true); }
    catch {
      instance.assetErrors.add(asset.identifier);
      // A resource failure is isolated; it must not hide the successfully loaded page.
    }
    if (generation !== instance.generation || instance.contents.isDestroyed()) return;
  }
}

async function dispatchLifecycle(instance: Instance, name: string, detail: string | { url: string; actionId?: string }): Promise<void> {
  if (instance.contents.isDestroyed()) return;
  const payload = typeof detail === "string" ? { url: detail } : detail;
  const code = `window.__KY_MENU_RUNTIME__?.lifecycle.__dispatch(${JSON.stringify(name)},${JSON.stringify(payload)})`;
  try { await instance.contents.executeJavaScript(code, true); } catch { /* lifecycle listeners are isolated */ }
}

async function refreshSpaRoute(instance: Instance, url: string): Promise<void> {
  if (instance.contents.isDestroyed()) return;
  const generation = ++instance.generation;
  const normalizedNow = safePageUrl(instance.contents.getURL());
  try {
    const data = await resolveRuntime({ directoryType: instance.directoryType, menuKey: instance.menuKey, workspaceType: instance.workspaceType, workspaceId: instance.workspaceId }, url);
    if (generation !== instance.generation || instance.contents.isDestroyed() || safePageUrl(instance.contents.getURL()) !== normalizedNow || normalizedNow !== url) return;
    if (!menuWebViewUrlAllowed(url, data.menu.navigationProtocols)) throw new Error("navigation_protocol_denied");
    instance.data = data;
    instance.config = data.menu;
    const currentIndex = instance.historyIndex;
    if (currentIndex < 0 || instance.historyEntries[currentIndex] !== url) {
      instance.historyEntries = instance.historyEntries.slice(0, currentIndex + 1);
      instance.historyEntries.push(url);
      instance.historyIndex = instance.historyEntries.length - 1;
    }
    await injectAt(instance, "spa_route_change", url, generation);
    if (generation !== instance.generation || instance.contents.isDestroyed() || safePageUrl(instance.contents.getURL()) !== url) return;
    await dispatchLifecycle(instance, "routeChange", url);
    emit(instance, "ready", instance.assetErrors.size ? "resource_injection_failed" : undefined);
  } catch (error) {
    if (generation === instance.generation && !instance.contents.isDestroyed()) {
      instance.view.setVisible(false);
      emit(instance, "failed", error instanceof Error ? error.message : "runtime_resolve_failed");
    }
  }
}

async function resolveAndNavigate(instance: Instance, rawUrl: string, resolved?: RuntimeResponse, historyIndex: number | null = null): Promise<boolean> {
  if(isHostScreenLocked(instance.opener.id))return false;
  const url = safePageUrl(rawUrl);
  if (!url) {
    instance.view.setVisible(false);
    emit(instance, "failed", "navigation_protocol_denied");
    return false;
  }
  if (instance.pendingNavigation.has(url)) return false;
  instance.pendingNavigation.add(url);
  const generation = ++instance.generation;
  instance.state.status = "loading";
  emit(instance, "loading");
  try {
    const data = resolved ?? await resolveRuntime({ directoryType: instance.directoryType, menuKey: instance.menuKey, workspaceType: instance.workspaceType, workspaceId: instance.workspaceId }, url);
    if (generation !== instance.generation || instance.contents.isDestroyed() || isHostScreenLocked(instance.opener.id)) return false;
    if (!menuWebViewUrlAllowed(data.url, data.menu.navigationProtocols) || data.url !== url) throw new Error("navigation_protocol_denied");
    instance.pendingHistoryIndex = historyIndex;
    instance.data = data;
    instance.config = data.menu;
    instance.ran.clear();
    instance.assetErrors.clear();
    await installDocumentStart(instance, data);
    if (generation !== instance.generation || instance.contents.isDestroyed() || isHostScreenLocked(instance.opener.id)) return false;
    instance.allowedNextNavigation = data.url;
    await instance.contents.loadURL(data.url);
    return true;
  } catch (error) {
    if (generation === instance.generation && !instance.contents.isDestroyed()) {
      instance.view.setVisible(false);
      instance.pendingHistoryIndex = null;
      emit(instance, "failed", error instanceof Error ? error.message : "runtime_resolve_failed");
    }
    return false;
  } finally {
    instance.pendingNavigation.delete(url);
  }
}

function detach(instance: Instance): void {
  if (instances.get(instance.id) !== instance) return;
  instances.delete(instance.id);
  if (instancesByStableKey.get(instance.stableKey) === instance) instancesByStableKey.delete(instance.stableKey);
  if (activeEmbeddedByOwner.get(instance.hostWindow.id) === instance.id) activeEmbeddedByOwner.delete(instance.hostWindow.id);
  instance.ownerDispose?.();
  instance.ownerDispose = undefined;
  for (const identifier of instance.registrations.splice(0)) {
    void sendCdp(instance, "Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => undefined);
  }
  const browser = instance.hostWindow;
  try {
    if (!browser.isDestroyed() && browser.contentView.children.includes(instance.view)) browser.contentView.removeChildView(instance.view);
  } catch { /* view may be destroyed with its host window */ }
  if (!instance.contents.isDestroyed()) instance.contents.close();
  if (instance.mode === "window" && !browser.isDestroyed()) browser.close();
  if (!instance.opener.isDestroyed()) instance.opener.send(IPC_CHANNELS.menuWebViewChanged, { instanceId: instance.id, state: { ...instance.state, status: "closed" } });
}

function attachInstance(instance: Instance): void {
  const contents = instance.contents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
    if (!isMainFrame || inPlace) return;
    if (url === instance.allowedNextNavigation || url === instance.data.url) return;
    const normalized = safePageUrl(url);
    instance.view.setVisible(false);
    if (normalized && !instance.pendingNavigation.has(normalized)) void resolveAndNavigate(instance, normalized);
  });
  contents.on("will-navigate", (event, url) => {
    if (instance.allowedNextNavigation === url) {
      instance.allowedNextNavigation = null;
      return;
    }
    event.preventDefault();
    void resolveAndNavigate(instance, url);
  });
  contents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    event.preventDefault();
    void resolveAndNavigate(instance, url);
  });
  contents.on("dom-ready", () => {
    const generation = instance.generation;
    const url = safePageUrl(contents.getURL());
    if (!url) return;
    void injectAt(instance, "dom_content_loaded", url, generation)
      .then(() => generation === instance.generation ? dispatchLifecycle(instance, "domReady", url) : undefined);
  });
  contents.on("did-finish-load", () => {
    const generation = instance.generation;
    const url = safePageUrl(contents.getURL());
    if (!url) return;
    void injectAt(instance, "load", url, generation)
      .then(() => injectAt(instance, "document_idle", url, generation))
      .then(() => generation === instance.generation ? dispatchLifecycle(instance, "pageLoad", url) : undefined)
      .then(() => { if (generation === instance.generation && instance.active && instance.mode === "embedded" && instance.bounds?.visible) instance.view.setVisible(true); if (generation === instance.generation) emit(instance, "ready", instance.assetErrors.size ? "resource_injection_failed" : undefined); });
  });
  contents.on("did-navigate", (_event, url, _code, _text) => {
    const normalized = safePageUrl(url);
    if (!normalized) return;
    if (instance.pendingHistoryIndex !== null && instance.historyEntries[instance.pendingHistoryIndex] === normalized) {
      instance.historyIndex = instance.pendingHistoryIndex;
      instance.pendingHistoryIndex = null;
    } else if (instance.historyEntries[instance.historyIndex] !== normalized) {
      instance.historyEntries = instance.historyEntries.slice(0, instance.historyIndex + 1);
      instance.historyEntries.push(normalized);
      instance.historyIndex = instance.historyEntries.length - 1;
    }
  });
  contents.on("did-navigate-in-page", (_event, url) => {
    const normalized = safePageUrl(url);
    if (!normalized) return;
    void refreshSpaRoute(instance, normalized);
  });
  contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { instance.view.setVisible(false); instance.pendingHistoryIndex = null; emit(instance, "failed", "page_load_failed"); }
  });
  contents.on("render-process-gone", () => detach(instance));
  contents.on("console-message", (_event, _level, message) => {
    if (message.startsWith("__KY_MENU_ASSET_ERROR__")) {
      instance.assetErrors.add(message.slice("__KY_MENU_ASSET_ERROR__".length));
      emit(instance, "ready", "resource_injection_failed");
    }
  });
  contents.on("page-title-updated", (_event, title) => {
    instance.state.title = title.slice(0, 160) || instance.config.name || instance.menuKey;
    emit(instance, instance.state.status, instance.state.errorCode);
  });
  contents.once("destroyed", () => detach(instance));
}

function getInstance(id: string): Instance | undefined { return instances.get(id); }

function runtimeFingerprint(data: RuntimeResponse): string {
  const rows = [
    ...data.public.map((item) => ["public", item.identifier, item.version, item.sourceSha256]),
    ...data.publicStyles.map((item) => ["public-style", item.identifier, item.version, item.runAt, item.priority, item.sourceSha256]),
    ...data.assets.map((item) => [item.assetType, item.identifier, item.id, item.version, item.runAt, item.priority, item.sourceSha256])
  ];
  return JSON.stringify([data.menu, data.url, rows]);
}

function activateEmbedded(instance: Instance): void {
  restoreHostOverlayOrder(instance.hostWindow);
  const ownerId = instance.hostWindow.id;
  for (const other of instances.values()) {
    if (other !== instance && other.mode === "embedded" && other.hostWindow.id === ownerId) {
      other.active = false;
      if (!other.view.webContents.isDestroyed()) other.view.setVisible(false);
    }
  }
  instance.active = true;
  instance.touchedAt = Date.now();
  activeEmbeddedByOwner.set(ownerId, instance.id);
  if (instance.bounds?.visible && !instance.hostWindow.isMinimized() && instance.state.status !== "failed") instance.view.setVisible(true);
}

function trimOwnerCache(ownerId: number): void {
  const ownerInstances = [...instances.values()].filter((item) => item.opener.id === ownerId && item.mode === "embedded");
  const excess = ownerInstances.length - 8;
  if (excess <= 0) return;
  ownerInstances.sort((a, b) => a.touchedAt - b.touchedAt);
  for (const item of ownerInstances.slice(0, excess)) detach(item);
}

export function disposeMenuWebViewsForOwner(owner: WebContents): void {
  for (const instance of [...instances.values()]) if (instance.opener === owner) detach(instance);
}

export function disposeMenuWebViewsForIdentity(identity: string): void {
  if (!identity) return;
  for (const instance of [...instances.values()]) if (instance.identityKey === identity) detach(instance);
}

export function disposeAllMenuWebViews(): void {
  for (const instance of [...instances.values()]) detach(instance);
}

export function menuWebViewIdentityFromToken(token: string): string {
  return sessionIdentity(token);
}

async function openMenu(event: IpcMainInvokeEvent, input: MenuWebViewOpenInput): Promise<DesktopCommandResult<MenuWebViewOpenResult>> {
  if(isHostScreenLocked(event.sender.id))return fail("screen_locked","屏幕已锁定");
  if (!validMenuWebViewOpenInput(input)) return fail("validation_error", "菜单 WebView 参数无效");
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return fail("permission_denied", "仅管理端主页面可以打开菜单 WebView");
  const openGeneration=(openGenerations.get(event.sender.id)??0)+1;openGenerations.set(event.sender.id,openGeneration);
  const assertCurrent=()=>{if(isHostScreenLocked(event.sender.id))throw new Error("screen_locked");if(openGenerations.get(event.sender.id)!==openGeneration)throw new Error("open_superseded");};
  let pendingView: WebContentsView | undefined;
  let pendingWindow: BrowserWindow | undefined;
  let cached: Instance | undefined;
  try {
    const desktopSession = await loadSession();
    if (!desktopSession?.token) return fail("auth_context_missing", "桌面登录状态不可用，请重新登录");
    const identityKey = sessionIdentity(desktopSession.token);
    const stableKey = stableViewKey(input, identityKey, event.sender.id);
    cached = instancesByStableKey.get(stableKey);
    const cachedUrl = cached && !cached.contents.isDestroyed() ? safePageUrl(cached.contents.getURL()) : null;
    const runtimeResponse = await resolveRuntime(input, cachedUrl || "", desktopSession.token);
    assertCurrent();
    if (!authorized(event, ["main"]) || owner.isDestroyed()) throw new Error("owner_context_changed");
    const latestSession = await loadSession();
    if (!latestSession?.token || sessionIdentity(latestSession.token) !== identityKey || latestSession.token !== desktopSession.token) throw new Error("auth_context_changed");
    assertCurrent();
    if (cached && cached.opener === event.sender && cached.mode === runtimeResponse.menu.openMode && !cached.contents.isDestroyed()) {
      cached.activationId=randomUUID();cached.boundsSequence=0;cached.bounds=null;
      if (cached.mode === "embedded") activateEmbedded(cached);
      cached.touchedAt = Date.now();
      if (cached.mode === "window" && !cached.hostWindow.isDestroyed()) { cached.hostWindow.show(); cached.hostWindow.focus(); }
      if (cached.state.status === "loading" && cached.pendingNavigation.size > 0) {
        event.sender.send(IPC_CHANNELS.menuWebViewChanged, { instanceId: cached.id, state: cached.state });
        return ok({ instanceId: cached.id, openMode: cached.mode, title: runtimeResponse.menu.name || input.menuKey, activationId:cached.activationId, protocolVersion: 2, stateSnapshot: { ...cached.state } });
      }
      const needsReload = cached.state.status === "failed" || !cachedUrl || cachedUrl !== runtimeResponse.url
        || runtimeFingerprint(cached.data) !== runtimeFingerprint(runtimeResponse);
      if (needsReload) {
        const moved = await resolveAndNavigate(cached, runtimeResponse.url, runtimeResponse);
        assertCurrent();
        if (!moved) throw new Error(cached.state.errorCode || "runtime_resolve_failed");
      } else {
        cached.data = runtimeResponse;
        cached.config = runtimeResponse.menu;
        cached.state.url = safeDisplayedUrl(cachedUrl || runtimeResponse.url);
        event.sender.send(IPC_CHANNELS.menuWebViewChanged, { instanceId: cached.id, state: cached.state });
      }
      return ok({ instanceId: cached.id, openMode: cached.mode, title: runtimeResponse.menu.name || input.menuKey, activationId:cached.activationId, protocolVersion: 2, stateSnapshot: { ...cached.state } });
    }
    if (cached) detach(cached);
    pendingView = new WebContentsView({
      webPreferences: {
        session: getPartitionSession(input, desktopSession.token),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        webviewTag: false,
        devTools: false
      }
    });
    let hostWindow = owner;
    if (runtimeResponse.menu.openMode === "window") {
      pendingWindow = new BrowserWindow({ width: 1180, height: 760, minWidth: 720, minHeight: 480, show: false, autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } });
      await pendingWindow.loadURL("about:blank");
      hostWindow = pendingWindow;
      if (!authorized(event, ["main"]) || owner.isDestroyed()) throw new Error("owner_context_changed");
      const confirmed = await loadSession();
      if (!confirmed?.token || confirmed.token !== desktopSession.token) throw new Error("auth_context_changed");
    }
    const id = randomUUID();
    const state: MenuWebViewState = { instanceId: id, status: "loading", title: runtimeResponse.menu.name || input.menuKey, url: safeDisplayedUrl(runtimeResponse.url) };
    const instance: Instance = {
      activationId:randomUUID(), boundsSequence:0,
      id, opener: event.sender, hostWindow, view: pendingView, contents: pendingView.webContents,
      mode: runtimeResponse.menu.openMode, stableKey, identityKey, active: false, touchedAt: Date.now(),
      workspaceType: input.workspaceType, workspaceId: input.workspaceId,
      directoryType: input.directoryType, menuKey: input.menuKey, config: runtimeResponse.menu, data: runtimeResponse,
      generation: 0, allowedNextNavigation: null, registrations: [], ran: new Set(), state,
      bounds: null, pendingNavigation: new Set(), historyEntries: [], historyIndex: -1, pendingHistoryIndex: null, assetErrors: new Set()
    };
    instances.set(id, instance);
    instancesByStableKey.set(stableKey, instance);
    hostWindow.contentView.addChildView(pendingView);
    restoreHostOverlayOrder(hostWindow);
    attachInstance(instance);
    const ownerNavigation = (_event: unknown, _url: string, inPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame && !inPlace) detach(instance);
    };
    const ownerDestroyed = () => detach(instance);
    event.sender.on("did-start-navigation", ownerNavigation);
    event.sender.once("destroyed", ownerDestroyed);
    const disposers: Array<() => void> = [
      () => event.sender.removeListener("did-start-navigation", ownerNavigation),
      () => event.sender.removeListener("destroyed", ownerDestroyed)
    ];
    if (instance.mode === "embedded") {
      const hide = () => instance.view.setVisible(false);
      const show = () => { if (instance.active && instance.bounds?.visible && instance.state.status !== "failed") instance.view.setVisible(true); };
      hostWindow.on("minimize", hide);
      hostWindow.on("restore", show);
      disposers.push(() => { hostWindow.removeListener("minimize", hide); hostWindow.removeListener("restore", show); });
      hostWindow.once("closed", () => detach(instance));
      activateEmbedded(instance);
    } else {
      const resize = () => {
        if (hostWindow.isDestroyed()) return;
        const bounds = hostWindow.getContentBounds();
        instance.view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
      };
      hostWindow.on("resize", resize);
      disposers.push(() => hostWindow.removeListener("resize", resize));
      hostWindow.once("closed", () => detach(instance));
      resize();
    }
    instance.ownerDispose = () => { for (const dispose of disposers) dispose(); };
    pendingView = undefined;
    pendingWindow = undefined;
    trimOwnerCache(event.sender.id);
    const moved = await resolveAndNavigate(instance, runtimeResponse.url, runtimeResponse);
    assertCurrent();
    if (!moved) { detach(instance); throw new Error(instance.state.errorCode || "runtime_resolve_failed"); }
    if (instance.mode === "window" && !instance.hostWindow.isDestroyed()) instance.hostWindow.show();
    return ok({ instanceId: id, openMode: instance.mode, title: runtimeResponse.menu.name || input.menuKey, activationId:instance.activationId, protocolVersion: 2, stateSnapshot: { ...instance.state } });
  } catch (error) {
    if (cached && !cached.contents.isDestroyed() && !(error instanceof Error && error.message==="open_superseded")) {
      cached.active = false;
      cached.view.setVisible(false);
      if (cached.state.status === "failed" || error instanceof Error && ["not_found", "menu_config_invalid", "auth_context_changed", "owner_context_changed"].includes(error.message)) detach(cached);
    }
    if (pendingView && !pendingView.webContents.isDestroyed()) pendingView.webContents.close();
    if (pendingWindow && !pendingWindow.isDestroyed()) pendingWindow.close();
    const code = error instanceof Error ? error.message : "menu_webview_open_failed";
    return fail(code, code === "desktop_session_unavailable" ? "桌面登录状态不可用，请重新登录" : "菜单权限、工作区配置或页面解析失败，未打开页面");
  }
}

// The shared native lock controller covers every application window.
// Menu instances require fresh authorization before being exposed again.
onHostScreenLock((ownerId,locked)=>{for(const instance of instances.values()){if(instance.opener.id!==ownerId)continue;instance.active=false;if(!locked)instance.view.setVisible(false);}});

const menuWebViewIpc = scopedIpc(["main"], (args) => args.length === 1 && Buffer.byteLength(JSON.stringify(args)) <= 64 * 1024);
export function registerMenuWebViewIpc(): void {
  menuWebViewIpc.handle(IPC_CHANNELS.menuWebViewOpen, (event, input: MenuWebViewOpenInput) => openMenu(event, input));
  menuWebViewIpc.handle(IPC_CHANNELS.menuWebViewSetBounds, (event, input: MenuWebViewBoundsInput) => {
    if(isHostScreenLocked(event.sender.id))return ok({updated:false});
    if (!validMenuWebViewBounds(input)) return fail("validation_error", "菜单 WebView 区域无效");
    const instance = getInstance(input.instanceId);
    if (!instance || instance.opener !== event.sender || instance.mode !== "embedded") return fail("permission_denied", "无权控制该菜单 WebView");
    if(input.activationId!==instance.activationId || !Number.isSafeInteger(input.boundsSequence) || input.boundsSequence<=instance.boundsSequence) return ok({updated:false});
    if(input.visible && activeEmbeddedByOwner.get(instance.hostWindow.id)!==instance.id)return ok({updated:false});
    instance.boundsSequence=input.boundsSequence;
    const content = instance.hostWindow.getContentBounds();
    const zoom = Math.max(0.5, Math.min(3, instance.hostWindow.webContents.getZoomFactor()));
    const left = Math.max(0, Math.round(input.x * zoom));
    const top = Math.max(0, Math.round(input.y * zoom));
    const right = Math.min(content.width, Math.round((input.x + input.width) * zoom));
    const bottom = Math.min(content.height, Math.round((input.y + input.height) * zoom));
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    instance.view.setBounds({ x: left, y: top, width, height });
    instance.bounds = { ...input, x: left, y: top, width, height, visible: input.visible && width > 0 && height > 0 };
    instance.active = instance.bounds.visible;
    instance.touchedAt = Date.now();
    instance.view.setVisible(instance.active && instance.state.status !== "failed" && !instance.hostWindow.isMinimized());
    return ok({ updated: true });
  });
  menuWebViewIpc.handle(IPC_CHANNELS.menuWebViewNavigate, async (event, input: MenuWebViewNavigateInput) => {
    if(isHostScreenLocked(event.sender.id))return fail("screen_locked","屏幕已锁定");
    if (!validMenuWebViewCommand(input)) return fail("validation_error", "菜单 WebView 导航参数无效");
    const instance = getInstance(input.instanceId);
    if (!instance || instance.opener !== event.sender || input.activationId!==instance.activationId) return fail("permission_denied", "无权控制该菜单 WebView");
    const currentUrl = safePageUrl(instance.contents.getURL());
    if (!currentUrl || instance.contents.isDestroyed()) return fail("not_ready", "菜单页面尚未就绪");
    try {
      // Re-authorize the currently displayed page before running user_action assets.
      const currentData = await resolveRuntime({ directoryType: instance.directoryType, menuKey: instance.menuKey, workspaceType: instance.workspaceType, workspaceId: instance.workspaceId }, currentUrl);
      if (isHostScreenLocked(event.sender.id) || !authorized(event, ["main"]) || instance.contents.isDestroyed() || safePageUrl(instance.contents.getURL()) !== currentUrl) throw new Error("owner_context_changed");
      instance.data = currentData;
      instance.config = currentData.menu;
      await injectAt(instance, "user_action", currentUrl);
      await dispatchLifecycle(instance, "userAction", { url: currentUrl, actionId: `menu_webview.${input.command}` });
      let targetIndex = instance.historyIndex;
      let targetUrl = currentUrl;
      if (input.command === "back") { targetIndex -= 1; targetUrl = instance.historyEntries[targetIndex] || ""; }
      if (input.command === "forward") { targetIndex += 1; targetUrl = instance.historyEntries[targetIndex] || ""; }
      if (!targetUrl) return ok({ navigated: false });
      const targetData = targetUrl === currentUrl ? currentData : await resolveRuntime({ directoryType: instance.directoryType, menuKey: instance.menuKey, workspaceType: instance.workspaceType, workspaceId: instance.workspaceId }, targetUrl);
      if (!authorized(event, ["main"]) || instance.contents.isDestroyed()) throw new Error("owner_context_changed");
      const moved = await resolveAndNavigate(instance, targetData.url, targetData, targetIndex);
      if (!moved) throw new Error(instance.state.errorCode || "navigation_denied");
      return ok({ navigated: true });
    } catch (error) {
      instance.view.setVisible(false);
      emit(instance, "failed", error instanceof Error ? error.message : "navigation_authorization_failed");
      return fail(error instanceof Error ? error.message : "navigation_authorization_failed", "菜单页面导航未通过服务端授权校验");
    }
  });
  menuWebViewIpc.handle(IPC_CHANNELS.menuWebViewClose, (event, input: MenuWebViewCloseInput) => {
    if(isHostScreenLocked(event.sender.id))return fail("screen_locked","屏幕已锁定");
    if (!validMenuWebViewClose(input)) return fail("validation_error", "菜单 WebView 标识无效");
    const instance = getInstance(input.instanceId);
    if (!instance || instance.opener !== event.sender || input.activationId!==instance.activationId) return fail("permission_denied", "无权关闭该菜单 WebView");
    detach(instance);
    return ok({ closed: true });
  });
}
