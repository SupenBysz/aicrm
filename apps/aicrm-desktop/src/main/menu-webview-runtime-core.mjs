export const MENU_WEBVIEW_RUN_AT = [
  "document_start",
  "dom_content_loaded",
  "document_idle",
  "load",
  "spa_route_change",
  "user_action"
];

export function validMenuWebViewOpenInput(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && ["management", "workbench"].includes(value.directoryType)
    && typeof value.menuKey === "string" && /^[a-z][a-z0-9_.-]{0,127}$/.test(value.menuKey)
    && ["platform", "agency", "enterprise"].includes(value.workspaceType)
    && typeof value.workspaceId === "string" && value.workspaceId.length > 0 && value.workspaceId.length <= 128);
}

export function validMenuWebViewBounds(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof value.instanceId === "string" && value.instanceId.length > 0
    && [value.x, value.y, value.width, value.height].every(Number.isFinite)
    && typeof value.visible === "boolean"
    && (!value.visible || (value.x >= 0 && value.y >= 0 && value.width >= 1 && value.height >= 1))
    && value.x <= 10000 && value.y <= 10000 && value.width <= 10000 && value.height <= 10000);
}

export function validMenuWebViewCommand(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof value.instanceId === "string" && value.instanceId.length > 0
    && ["back", "forward", "reload"].includes(value.command));
}

export function validMenuWebViewClose(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof value.instanceId === "string" && value.instanceId.length > 0);
}

export function menuWebViewUrlAllowed(raw, protocols) {
  try {
    const value = new URL(raw);
    return ["http:", "https:"].includes(value.protocol)
      && Array.isArray(protocols) && protocols.includes(value.protocol.slice(0, -1))
      && Boolean(value.hostname) && !value.username && !value.password;
  } catch {
    return false;
  }
}

export function menuRuntimeAssetKey(asset) {
  return [asset.id, asset.identifier, asset.version, asset.sourceSha256].join(":");
}

export function createMenuRuntimeSchedule(data) {
  const publicStyles = Array.isArray(data.publicStyles) ? data.publicStyles.map((item) => ({
    id: `public-style:${item.identifier}:${item.version}`,
    identifier: item.identifier,
    version: item.version,
    runAt: item.runAt || "document_start",
    priority: Number(item.priority || 0),
    assetType: "style",
    sourceContent: item.sourceContent,
    sourceBytes: item.sourceBytes,
    sourceSha256: item.sourceSha256
  })) : [];
  const publicScripts = Array.isArray(data.public) ? data.public.map((item) => ({
    id: `public:${item.identifier}:${item.version}`,
    identifier: item.identifier,
    version: item.version,
    runAt: "document_start",
    priority: -100000,
    assetType: "script",
    sourceContent: item.source,
    sourceBytes: item.sourceBytes,
    sourceSha256: item.sourceSha256,
    publicDependency: true
  })) : [];
  const business = Array.isArray(data.assets) ? data.assets.map((item) => ({
    id: item.id,
    identifier: item.identifier,
    version: item.version,
    runAt: item.runAt,
    priority: item.priority,
    assetType: item.assetType || item.kind,
    sourceContent: item.sourceContent,
    sourceBytes: item.sourceBytes,
    sourceSha256: item.sourceSha256
  })) : [];
  const compare = (a, b) => Number(a.priority || 0) - Number(b.priority || 0)
    || (String(a.identifier) < String(b.identifier) ? -1 : String(a.identifier) > String(b.identifier) ? 1 : 0)
    || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  const styles = [...publicStyles, ...business.filter((asset) => asset.assetType === "style")].sort(compare);
  // Keep public scripts in server-provided dependency-topological order;
  // apply deterministic priority ordering only to independent menu assets.
  const scripts = [...publicScripts, ...business.filter((asset) => asset.assetType !== "style").sort(compare)];
  const byRunAt = (items, runAt) => items.filter((item) => item.runAt === runAt);
  return {
    styles,
    scripts,
    byRunAt(runAt) {
      const selected = [...byRunAt(styles, runAt), ...byRunAt(scripts, runAt)];
      return selected;
    }
  };
}

export function menuRuntimeAssetSource(asset) {
  if (asset.assetType === "style") {
    return `(()=>{const id=${JSON.stringify(asset.identifier)};const root=document.head||document.documentElement;if(!root)return;let style=document.querySelector('style[data-ky-menu-runtime-id="'+CSS.escape(id)+'"]');if(!style){style=document.createElement("style");style.dataset.kyMenuRuntimeId=id;root.appendChild(style)}style.dataset.kyMenuRuntimeVersion=${JSON.stringify(asset.version+":"+asset.sourceSha256)};style.textContent=${JSON.stringify(asset.sourceContent)};})()`;
  }
  return `${asset.sourceContent}\n//# sourceURL=ky-menu-runtime/${encodeURIComponent(asset.identifier)}@${encodeURIComponent(asset.version)}.js`;
}

export function menuRuntimeLifecycleBootstrap() {
  return `(()=>{if(window.__KY_MENU_RUNTIME__)return;const modules=new Map(),listeners=new Map(),state=new Map();const lifecycle={on(name,fn){if(typeof fn!=="function")return()=>{};let set=listeners.get(name);if(!set)listeners.set(name,set=new Set());const item={fn,once:false};set.add(item);if(state.has(name))queueMicrotask(()=>{if(set.has(item))try{fn(state.get(name))}catch{}});return()=>set.delete(item)},once(name,fn){if(typeof fn!=="function")return()=>{};let set=listeners.get(name);if(!set)listeners.set(name,set=new Set());const item={fn,once:true};set.add(item);if(state.has(name))queueMicrotask(()=>{if(set.delete(item))try{fn(state.get(name))}catch{}});return()=>set.delete(item)},off(name,fn){const set=listeners.get(name);if(set)for(const item of [...set])if(!fn||item.fn===fn)set.delete(item)},__dispatch(name,detail){state.set(name,detail);const set=listeners.get(name);if(set)for(const item of [...set]){if(item.once)set.delete(item);try{item.fn(detail)}catch{}}}};const publicApi={register(def){if(!def||typeof def.identifier!=="string"||!/^[A-Z][A-Z0-9_]{0,63}$/.test(def.identifier)||typeof def.factory!=="function")throw new Error("PUBLIC_REGISTRATION_INVALID");if(modules.has(def.identifier))return false;const value=def.factory({jssdk:api});if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("PUBLIC_REGISTRATION_EXPORTS_INVALID");modules.set(def.identifier,Object.freeze({...value}));return true},get(id){return modules.get(id)},has(id){return modules.has(id)}};const api={lifecycle,public:publicApi};Object.defineProperty(window,"__KY_MENU_RUNTIME__",{value:Object.freeze(api),configurable:false});if(!window.jssdk||typeof window.jssdk!=="object")Object.defineProperty(window,"jssdk",{value:api,configurable:false});else{try{if(!window.jssdk.public)Object.defineProperty(window.jssdk,"public",{value:publicApi,configurable:false});if(!window.jssdk.lifecycle)Object.defineProperty(window.jssdk,"lifecycle",{value:lifecycle,configurable:false})}catch{}}})();`;
}
