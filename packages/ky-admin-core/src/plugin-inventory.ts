export type PluginInventoryAvailability = "supported" | "not_supported" | "unknown";
export type PluginInventoryState = "enabled" | "disabled" | "not_applicable" | "unknown";
export type PluginInventoryLoadState = "loaded" | "not_loaded" | "loading" | "failed" | "unknown" | "not_applicable";
export type PluginInventoryRuntimeState = "running" | "unresponsive" | "stopped" | "unknown" | "not_applicable";
export interface PluginInventoryService {
  key: string;
  state: "healthy" | "unhealthy" | "timeout" | "unknown" | "not_applicable";
  reason: string | null;
  checkedAtUtc: string | null;
  version: string | null;
}
export interface PluginInventorySafeResult { code: string; message: string; count?: number }
export interface PluginInventoryItem {
  id: string;
  name: string;
  description: string | null;
  type: "admin" | "desktop";
  version: string | null;
  buildId: string | null;
  location: string;
  provider: string | null;
  capabilities: string[];
  compatibleHost: string | null;
  pluginApi: string | null;
  uiApi: string | null;
  candidateVersion: string | null;
  rollbackVersion: string | null;
  availability: PluginInventoryAvailability;
  enabledState: PluginInventoryState;
  loadState: PluginInventoryLoadState;
  runtimeState: PluginInventoryRuntimeState;
  uiConfirmationState: "confirmed" | "unconfirmed" | "not_applicable" | "unknown";
  updatePhase: string | null;
  signatureState: "verified" | "builtin_trusted" | "unverified" | "unknown" | "not_applicable";
  services: PluginInventoryService[];
  sampledAtUtc: string | null;
  freshness: "fresh" | "stale";
  errorReason: string | null;
  lastSuccess: PluginInventorySafeResult | null;
  lastUpdateResult: PluginInventorySafeResult | null;
  lastRollbackResult: PluginInventorySafeResult | null;
}
export interface PluginInventorySource {
  availability: PluginInventoryAvailability;
  reason: string | null;
  lastSuccess: string | null;
  /** 仅供当前 Web 进程计算过期，不持久化或跨进程传输。 */
  receivedAt: number | null;
}
export interface PluginInventoryQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  type?: "admin" | "desktop";
  loadState?: PluginInventoryLoadState;
  runtimeState?: PluginInventoryRuntimeState;
  sort?: "abnormal_first" | "name_asc";
  signal?: AbortSignal;
  /** 分页和筛选读取同一快照；刷新时才重新采集。 */
  refresh?: boolean;
}
export interface PluginInventoryResult {
  items: PluginInventoryItem[];
  total: number;
  generation: number;
  sources: Record<"admin" | "desktop" | "health", PluginInventorySource>;
  sourceError?: PluginInventorySafeResult;
}
export interface PluginInventoryPort {
  list(query?: PluginInventoryQuery): Promise<PluginInventoryResult>;
  get(id: string, signal?: AbortSignal): Promise<PluginInventoryItem | null>;
  clear(): void;
  dispose(): void;
}
