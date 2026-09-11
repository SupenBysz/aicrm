import type { PluginInventoryItem, PluginInventoryPort, PluginInventoryQuery, PluginInventoryResult, PluginInventoryService, PluginInventorySource } from "@ky/admin-core";

const TTL = 90_000;
const MAX_ITEMS = 200;
type Dependencies = {
  admin: () => PluginInventoryItem[];
  desktop: (() => Promise<PluginInventoryItem[]>) | null;
  unsupportedReason: "browser_not_supported" | "client_upgrade_required";
  health: (signal: AbortSignal) => Promise<PluginInventoryService[]>;
  now?: () => number;
  utc?: () => string;
};
const emptySource = (): PluginInventorySource => ({ availability: "unknown", reason: null, lastSuccess: null, receivedAt: null });
const abortError = () => new DOMException("请求已取消", "AbortError");
const copy = <T,>(value: T): T => structuredClone(value);
const codeOf = (error: unknown): string => {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "source_unavailable";
};
const denied = (error: unknown) => ["unauthorized", "permission_denied", "workspace_forbidden"].includes(codeOf(error));

function bounded<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (ok) resolve(value as T); else reject(value);
    };
    const onAbort = () => finish(false, abortError());
    const timer = setTimeout(() => finish(false, Object.assign(new Error("状态采集超时"), { code: "source_timeout" })), ms);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(value => finish(true, value), error => finish(false, error));
    if (signal.aborted) onAbort();
  });
}

/** 无 Electron、React 或网络全局依赖，便于验证竞态、过期和部分来源失败。 */
export function createInventoryModel(deps: Dependencies): PluginInventoryPort {
  const now = deps.now ?? (() => performance.now());
  const utc = deps.utc ?? (() => new Date().toISOString());
  let rows: PluginInventoryItem[] = [];
  let health: PluginInventoryService[] = [];
  let generation = 0;
  let initialized = false;
  let disposed = false;
  let active: AbortController | null = null;
  let sources: PluginInventoryResult["sources"] = { admin: emptySource(), desktop: emptySource(), health: emptySource() };
  let sourceError: PluginInventoryResult["sourceError"];

  const succeeded = (): PluginInventorySource => ({ availability: "supported", reason: null, lastSuccess: utc(), receivedAt: now() });
  const failed = (previous: PluginInventorySource, error: unknown): PluginInventorySource => ({ ...previous, availability: "unknown", reason: codeOf(error) === "source_timeout" ? "source_timeout" : "source_unavailable" });
  const stale = (source: PluginInventorySource) => source.receivedAt === null || now() - source.receivedAt >= TTL;

  function projection(): PluginInventoryItem[] {
    return rows.map(original => {
      const row = copy(original);
      const source = sources[row.type === "desktop" ? "desktop" : "admin"];
      if (source.availability === "unknown" || stale(source)) {
        row.freshness = "stale";
        row.availability = "unknown";
        row.loadState = "unknown";
        if (row.type === "desktop") row.runtimeState = "unknown";
        row.errorReason = source.reason ?? "source_stale";
      }
      row.services = row.services.map(dependency => {
        const observed = health.find(item => item.key === dependency.key);
        if (sources.health.availability !== "supported" || stale(sources.health)) {
          return { ...(observed ?? dependency), state: "unknown", reason: sources.health.reason ?? "source_stale" };
        }
        return copy(observed ?? { ...dependency, state: "unknown", reason: "invalid_response" });
      });
      return row;
    });
  }

  async function refresh(signal?: AbortSignal) {
    if (disposed || signal?.aborted) throw abortError();
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const run = ++generation;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const admin = deps.admin();
      const nativeWork = deps.desktop
        ? bounded(Promise.resolve().then(deps.desktop), 3000, controller.signal).then(value => ({ value, error: null as unknown }), error => ({ value: null, error }))
        : Promise.resolve({ value: [] as PluginInventoryItem[], error: null as unknown });
      const healthController = new AbortController();
      const stopHealth = () => healthController.abort();
      controller.signal.addEventListener("abort", stopHealth, { once: true });
      const healthWork = bounded(Promise.resolve().then(() => deps.health(healthController.signal)), 8000, controller.signal).then(
        value => ({ value, error: null as unknown }),
        error => { if (denied(error)) throw error; return { value: null, error }; }
      ).finally(() => { stopHealth(); controller.signal.removeEventListener("abort", stopHealth); });
      const [nativeResult, healthResult] = await Promise.all([nativeWork, healthWork]);
      if (run !== generation || controller.signal.aborted || disposed) throw abortError();
      let desktop = rows.filter(row => row.type === "desktop");
      sources.admin = succeeded();
      if (!deps.desktop) {
        desktop = [];
        sources.desktop = { ...emptySource(), availability: "not_supported", reason: deps.unsupportedReason };
      } else if (nativeResult.value !== null) {
        desktop = nativeResult.value;
        sources.desktop = succeeded();
      } else {
        sources.desktop = failed(sources.desktop, nativeResult.error);
      }
      if (healthResult.value !== null) {
        health = healthResult.value;
        sources.health = succeeded();
      } else sources.health = failed(sources.health, healthResult.error);
      if (admin.length > MAX_ITEMS || desktop.length > MAX_ITEMS || admin.length + desktop.length > MAX_ITEMS) {
        sourceError = { code: "source_error", message: "插件清单超过允许的 200 项，请检查宿主配置。" };
        rows = [];
      } else {
        sourceError = undefined;
        rows = [...admin, ...desktop];
      }
      initialized = true;
    } catch (error) {
      if (run !== generation || signal?.aborted || disposed) throw abortError();
      if (denied(error)) { controller.abort(); clear(); }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (active === controller) active = null;
    }
  }

  function clear() {
    generation++;
    active?.abort();
    active = null;
    rows = [];
    health = [];
    initialized = false;
    sourceError = undefined;
    sources = { admin: emptySource(), desktop: emptySource(), health: emptySource() };
  }
  const abnormal = (row: PluginInventoryItem) => row.freshness === "stale" || row.loadState === "failed" || row.runtimeState === "unresponsive" || row.runtimeState === "unknown" || row.services.some(item => item.state !== "healthy" && item.state !== "not_applicable");
  return {
    async list(query: PluginInventoryQuery = {}) {
      if (disposed || query.signal?.aborted) throw abortError();
      if (!initialized || query.refresh !== false) await refresh(query.signal);
      const needle = (query.keyword ?? "").trim().toLocaleLowerCase();
      const filtered = projection().filter(item => (!needle || (item.name + " " + item.id).toLocaleLowerCase().includes(needle)) && (!query.type || item.type === query.type) && (!query.loadState || item.loadState === query.loadState) && (!query.runtimeState || item.runtimeState === query.runtimeState));
      filtered.sort((a, b) => (query.sort === "abnormal_first" ? Number(abnormal(b)) - Number(abnormal(a)) : 0) || a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
      const positive = (value: number | undefined, fallback: number) => value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
      const page = positive(query.page, 1);
      const size = Math.min(100, positive(query.pageSize, 20));
      return { items: filtered.slice((page - 1) * size, page * size), total: filtered.length, generation, sources: copy(sources), ...(sourceError ? { sourceError: copy(sourceError) } : {}) };
    },
    async get(id, signal) {
      if (disposed || signal?.aborted) throw abortError();
      return projection().find(item => item.id === id) ?? null;
    },
    clear,
    dispose() { clear(); disposed = true; }
  };
}
