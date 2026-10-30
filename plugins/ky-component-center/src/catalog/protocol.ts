import { catalog, categories } from "./metadata";
export const themes = ["classic-gold", "business-blue", "jade-green", "graphite-cyan"] as const;
export type DemoArgs = { label: string; count: number; disabled: boolean; showAI: boolean; state: string };
export interface PreviewConfig { version: 1; kind: "config"; generation: string; componentId: string; exampleId: string; themeId: typeof themes[number]; mode: "light"|"dark"|"system"; systemDark: boolean; reset: number; args: DemoArgs }
export const findComponent = (id: string) => catalog.find(item => item.id === id);
export function defaultsFor(id: string, exampleId?: string): DemoArgs { const item=findComponent(id); return {...(item?.defaults ?? {label:"演示",count:12,disabled:false,showAI:true}),state:exampleId || "default"}; }
export function record(value: unknown): value is Record<string,unknown> { return !!value && typeof value==="object" && !Array.isArray(value); }
const exactKeys=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
export function validGeneration(value: unknown): value is string { return typeof value==="string" && /^cc_[a-z0-9_]{1,80}$/.test(value); }
export function validConfig(value: unknown): value is PreviewConfig {
 if(!record(value)||!exactKeys(value,["version","kind","generation","componentId","exampleId","themeId","mode","systemDark","reset","args"])||value.version!==1||value.kind!=="config"||!validGeneration(value.generation))return false;
 const item=findComponent(String(value.componentId));const a=value.args;
 return !!item && item.examples.some(e=>e.id===value.exampleId) && themes.includes(value.themeId as typeof themes[number]) && ["light","dark","system"].includes(String(value.mode)) && typeof value.systemDark==="boolean" && Number.isSafeInteger(value.reset) && Number(value.reset)>=0 && Number(value.reset)<=1e6 && record(a) && exactKeys(a,["label","count","disabled","showAI","state"]) && typeof a.label==="string" && a.label.length<=80 && Number.isSafeInteger(a.count) && Number(a.count)>=0 && Number(a.count)<=50 && typeof a.disabled==="boolean" && typeof a.showAI==="boolean" && a.state===value.exampleId;
}
export function validReply(value:unknown,generation:string): value is {version:1;kind:"ready"|"applied"|"error";generation:string;code?:string} {
 return record(value) && value.version===1 && value.generation===generation && ["ready","applied","error"].includes(String(value.kind)) && Object.keys(value).every(k=>["version","kind","generation","code"].includes(k)) && (value.code===undefined||["render_failed","load_failed","timeout"].includes(String(value.code)));
}
export function normalizeQuery(params: URLSearchParams, id?:string) {
 const p=new URLSearchParams();const q=(params.get("q")||"").slice(0,80);if(q)p.set("q",q);
 const cat=params.get("category");if(cat&&Object.hasOwn(categories,cat))p.set("category",cat);
 const status=params.get("status");if(status&&["experimental","stable","deprecated"].includes(status))p.set("status",status);
 const item=id?findComponent(id):undefined;const example=params.get("example");if(item)p.set("example",item.examples.some(e=>e.id===example)?example!:item.examples[0].id);
 const theme=params.get("previewTheme");p.set("previewTheme",themes.includes(theme as typeof themes[number])?theme!:"classic-gold");
 const mode=params.get("previewMode");p.set("previewMode",["light","dark","system"].includes(mode||"")?mode!:"light");
 p.set("viewport",["narrow","desktop","wide","auto"].includes(params.get("viewport")||"")?params.get("viewport")!:"auto");return p;
}
export function filterCatalog(q:string,category?:string,status?:string) {const needle=q.toLocaleLowerCase();return catalog.filter(item=>(!category||item.category===category)&&(!status||item.status===status)&&[item.title,item.summary,...item.aliases,...item.keywords].join(" ").toLocaleLowerCase().includes(needle));}
