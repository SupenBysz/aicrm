import type { PluginInventoryItem, PluginInventoryService, RequestClient } from "@ky/admin-core";
import { getDesktopBridge, isDesktopClientMode } from "./desktop-client";
import { localPlugins } from "./local-plugin-manifest";
import { adminPluginBuild } from "./plugin-build-manifest";
import { createInventoryModel } from "./plugin-inventory-model";

const metadata: Record<string, { name: string; services: string[] }> = {
  "ky-identity-management": { name: "身份管理", services: ["auth", "membership"] },
  "ky-organization-management": { name: "组织管理", services: ["org"] },
  "ky-access-management": { name: "权限中心", services: ["membership"] },
  "ky-audit-management": { name: "审计管理", services: ["membership"] },
  "ky-notification": { name: "通知管理", services: ["membership"] },
  "ky-matrix-account": { name: "矩阵账号", services: ["matrix"] },
  "ky-ai-configuration": { name: "AI 配置", services: ["ai-model"] },
  "ky-system-settings": { name: "系统设置", services: ["org"] }
};
const serviceKeys = new Set(["auth", "org", "membership", "matrix", "ai-model"]);
const invalid = () => Object.assign(new Error("状态来源返回了无效数据"), { code: "invalid_response" });
const safeText = (value: unknown, limit = 256): string | null => typeof value === "string" && value.length <= limit ? value : null;
const choice = <T extends string>(value: unknown, values: readonly T[], fallback: T): T => values.includes(value as T) ? value as T : fallback;
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const empty = (id: string, name: string): PluginInventoryItem => ({
  id, name, description: null, type: "admin", version: null, buildId: null, location: "admin_host", provider: null,
  capabilities: [], compatibleHost: null, pluginApi: null, uiApi: null, candidateVersion: null, rollbackVersion: null,
  availability: "supported", enabledState: "not_applicable", loadState: "loaded", runtimeState: "not_applicable",
  uiConfirmationState: "not_applicable", updatePhase: null, signatureState: "not_applicable", services: [],
  sampledAtUtc: null, freshness: "fresh", errorReason: null, lastSuccess: null, lastUpdateResult: null, lastRollbackResult: null
});

export function createPluginInventoryPort(requestClient: RequestClient) {
  const bridge = getDesktopBridge();
  const inventory = bridge?.desktopPlugins?.inventory;
  return createInventoryModel({
    unsupportedReason: isDesktopClientMode() ? "client_upgrade_required" : "browser_not_supported",
    admin: () => localPlugins.map(plugin => {
      const meta = metadata[plugin.name];
      const row = empty(plugin.name, meta?.name ?? plugin.navGroup ?? plugin.name);
      return { ...row, description: `${row.name}后台业务功能`, version: adminPluginBuild.versions[plugin.name] ?? null,
        buildId: adminPluginBuild.buildId, provider: "项目内置", sampledAtUtc: new Date().toISOString(),
        capabilities: [plugin.routes?.length ? "页面路由" : "", plugin.menus?.length ? "管理导航" : "", plugin.workbenchContributions?.length ? "工作台" : ""].filter(Boolean),
        services: (meta?.services ?? []).map(key => ({ key, state: "unknown" as const, reason: "not_sampled", checkedAtUtc: null, version: null })) };
    }),
    desktop: typeof inventory !== "function" ? null : async () => {
      const data: unknown = await inventory({});
      if (!Array.isArray(data) || data.length > 200) throw invalid();
      const ids = new Set<string>();
      return data.map((raw: Record<string, unknown>) => {
        if (!raw || typeof raw !== "object" || !safeText(raw.id) || ids.has(String(raw.id))) throw invalid();
        ids.add(String(raw.id));
        const id = String(raw.id);
        const row = empty(id, id === "com.kww.status-bar" || id.includes("status-bar") ? "客户端状态栏" : safeText(raw.name) ?? id);
        return { ...row, type: "desktop", location: "current_client", description: safeText(raw.description, 1024),
          version: safeText(raw.version), buildId: safeText(raw.buildId), provider: safeText(raw.provider),
          capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.filter((x): x is string => typeof x === "string" && x.length < 128).slice(0, 64) : [],
          compatibleHost: safeText(raw.compatibleHost), pluginApi: safeText(raw.pluginApi), uiApi: safeText(raw.uiApi),
          candidateVersion: safeText(raw.candidateVersion), rollbackVersion: safeText(raw.rollbackVersion),
          enabledState: choice(raw.enabledState, ["enabled", "disabled", "unknown"] as const, raw.active === true ? "enabled" : "unknown"),
          loadState: choice(raw.loadState, ["loaded", "not_loaded", "loading", "failed", "unknown"] as const, "unknown"),
          runtimeState: choice(raw.runtimeState, ["running", "unresponsive", "stopped", "unknown"] as const, "unknown"),
          uiConfirmationState: choice(raw.uiConfirmationState, ["confirmed", "unconfirmed", "not_applicable", "unknown"] as const, "unknown"),
          updatePhase: safeText(raw.updatePhase ?? raw.phase),
          signatureState: choice(raw.signatureState, ["verified", "builtin_trusted", "unverified", "unknown"] as const, "unknown"),
          sampledAtUtc: timestamp(raw.sampledAtUtc), errorReason: safeText(raw.errorReason),
          lastSuccess: safeResult(raw.lastSuccess), lastUpdateResult: safeResult(raw.lastUpdateResult), lastRollbackResult: safeResult(raw.lastRollbackResult)
        } satisfies PluginInventoryItem;
      });
    },
    health: async signal => {
      const data = await requestClient.request<{ services: PluginInventoryService[] }>("/api/v1/platform/plugin-management/service-health", { signal });
      if (!data || !Array.isArray(data.services) || data.services.length !== 5) throw invalid();
      const seen = new Set<string>();
      return data.services.map(raw => {
        if (!raw || !serviceKeys.has(raw.key) || seen.has(raw.key)) throw invalid();
        seen.add(raw.key);
        return { key: raw.key, state: choice(raw.state, ["healthy", "unhealthy", "timeout", "unknown"] as const, "unknown"),
          reason: safeText(raw.reason), checkedAtUtc: timestamp(raw.checkedAtUtc), version: null };
      });
    }
  });
}

function safeResult(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const code = safeText(record.code);
  // 只显示既定结果码，禁止传播底层异常正文或路径。
  return code ? { code, message: "", ...(typeof record.count === "number" ? { count: record.count } : {}) } : null;
}
