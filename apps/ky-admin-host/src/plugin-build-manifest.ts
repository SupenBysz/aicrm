declare const __KWW_ADMIN_PLUGIN_BUILD__: { buildId: string; versions: Record<string, string> };
/** Vite 在构建时读取实际包版本注入，运行时不伪造版本。 */
export const adminPluginBuild = typeof __KWW_ADMIN_PLUGIN_BUILD__ === "undefined"
  ? { buildId: null, versions: {} as Record<string, string> }
  : __KWW_ADMIN_PLUGIN_BUILD__;
