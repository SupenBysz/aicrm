/** 客户端插件契约：不依赖 Electron、业务 Core 或 Node。 */
export const PLUGIN_ID = "cn.org.kww.desktop.status-bar";
export const SOURCE = "http://127.0.0.1:18180/desktop-plugin-releases/dev/";
export const CAPABILITIES = ["host.app.version.read", "host.ui.statusBar.publish", "host.ui.statusBar.action", "host.runtime.lifecycle"] as const;
export const PLUGIN_API = "1.0.0";
export const UI_API = "1.0.0";
export type Item = { id: string; type: "text" | "button"; text: string; title?: string; tone: "muted" | "normal"; actionId?: string };
export type Projection = { items: Item[] };
export type Manifest = { schemaVersion: 1; kind: "desktop-host-plugin"; id: string; version: string; entry: string; engines: { host: string; pluginApi: string; uiApi: string }; platforms: string[]; capabilities: string[]; contributes: { slot: "statusBar.right"; actions: string[] }; data: { mode: "none"; schemaVersion: 0 } };
export type PublicKey = { schemaVersion: 1; purpose: "kww-desktop-plugin-signing"; channel: "dev"; algorithm: "Ed25519"; publicKeyFormat: "raw-ed25519-base64"; publicKey: string; fingerprint: string; keyId: string };
export type BuildPolicy = { schemaVersion: 1; kind: "desktop-plugin-build-policy"; channel: "dev"; enabled: true; productionEnabled: false; updateBaseUrl: string; allowLoopbackHttp: true; publicKey: PublicKey; pluginId: string; capabilities: string[]; platforms: string[]; policyFile: "policy.json"; indexFile: "index.json" };
export function ensure(value: unknown, message = "插件数据不符合合同"): asserts value { if (!value) throw new Error(message); }
export function object(value: unknown, required: string[], optional: string[] = []): Record<string, any> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value));
  const o = value as Record<string, any>;
  ensure(required.every(k => Object.hasOwn(o, k)) && Object.keys(o).every(k => [...required, ...optional].includes(k)));
  return o;
}
export function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { ensure(Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max); return v as number; }
export function string(v: unknown, max = 160): string { ensure(typeof v === "string" && v.length <= max && v.length > 0 && !/[\u0000-\u0008\u000b-\u001f]/.test(v)); return v; }
export function digest(v: unknown): string { ensure(typeof v === "string" && /^[a-f0-9]{64}$/.test(v)); return v; }
export function list(v: unknown, max: number): unknown[] { ensure(Array.isArray(v) && v.length <= max); return v; }
export function uniqueStrings(v: unknown, max: number): string[] { const a = list(v, max).map(x => string(x)); ensure(new Set(a).size === a.length); return a; }
export function semver(v: unknown): [number,number,number] { ensure(typeof v === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)); const a = v.split('.').map(Number); a.forEach(x => integer(x)); return a as [number,number,number]; }
function compare(a: number[], b: number[]) { for(let i=0;i<3;i++) if(a[i]!==b[i]) return Math.sign(a[i]-b[i]); return 0; }
export function satisfies(version: string, range: string) { const m = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(range); ensure(m); const lo=semver(m[1]), hi=semver(m[2]), v=semver(version); ensure(compare(lo,hi)<0); return compare(v,lo)>=0 && compare(v,hi)<0; }
export function pathName(v: unknown): string {
  const p=string(v,128); const parts=p.split('/');
  ensure(parts.length<=3 && parts.every(x=>/^[a-z0-9_-][a-z0-9._-]*$/.test(x) && !x.endsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/.test(x)) && /\.(js|json)$/.test(p)); return p;
}
export function manifest(value: unknown): Manifest {
  const o=object(value,['schemaVersion','kind','id','version','entry','engines','platforms','capabilities','contributes','data']);
  ensure(o.schemaVersion===1 && o.kind==='desktop-host-plugin' && o.id===PLUGIN_ID); semver(o.version); pathName(o.entry); ensure(o.entry.endsWith('.js'));
  const e=object(o.engines,['host','pluginApi','uiApi']); for(const k of Object.keys(e)) { string(e[k]); satisfies('1.0.0',e[k]); }
  ensure(uniqueStrings(o.platforms,1).join()==='darwin'); ensure(uniqueStrings(o.capabilities,4).every(x=>(CAPABILITIES as readonly string[]).includes(x)));
  const c=object(o.contributes,['slot','actions']); ensure(c.slot==='statusBar.right'); uniqueStrings(c.actions,4).forEach(x=>ensure(/^[a-z][a-z0-9-]{0,31}$/.test(x)));
  const d=object(o.data,['mode','schemaVersion']); ensure(d.mode==='none' && d.schemaVersion===0); return o as Manifest;
}
export function projection(value: unknown, actions: string[]): Projection {
  const o=object(value,['items']); const ids=new Set<string>();
  list(o.items,4).forEach(v=>{ const i=object(v,['id','type','text','tone'],['title','actionId']); string(i.id,40); ensure(!ids.has(i.id));ids.add(i.id); string(i.text,80);if(i.title!==undefined)string(i.title,160);ensure(['text','button'].includes(i.type)&&['muted','normal'].includes(i.tone)); if(i.type==='button')ensure(actions.includes(i.actionId));else ensure(i.actionId===undefined); }); return o as Projection;
}
/** 严格 JSON：先限制字节的调用方，再拒绝重复键、非法 UTF-8、深度与尾部内容。 */
export function strictJson(text: string): any {
 let i=0; const ws=()=>{while(/[\t\r\n ]/.test(text[i]??'!'))i++;};
 function str():string { const start=i++;while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i++]==='"')return JSON.parse(text.slice(start,i));}throw new Error('JSON 字符串未结束'); }
 function val(depth:number):any { ensure(depth<=16);ws();const c=text[i];if(c==='"')return str();if(c==='{'||c==='['){i++;const arr=c==='[',out:any=arr?[]:Object.create(null),keys=new Set<string>();ws();if(text[i]===(arr?']':'}')){i++;return out;}while(true){ws();if(arr)out.push(val(depth+1));else{ensure(text[i]==='"');const k=str();ensure(!keys.has(k));keys.add(k);ws();ensure(text[i++]===':');out[k]=val(depth+1);}ws();const end=text[i++];if(end===(arr?']':'}'))return out;ensure(end===',');}}const m=/^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));ensure(m);i+=m[0].length;return JSON.parse(m[0]); }
 const result=val(0);ws();ensure(i===text.length);return result;
}
