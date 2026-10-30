import { useEffect, useState } from "react";
import { MarkdownReader } from "@ky/markdown";
import { themeVariables, themeColors, THEMES } from "@ky/admin-core/theme";
import type { CSSProperties } from "react";
type ThemeId = Parameters<typeof themeColors>[0];
interface PublicDocument {currentVersion:number;slug:string;version:number;title:string;markdown:string;note:string;publishedAt:string}
// Dedicated public entry: no router guards, requestClient, session or workspace bootstrap.
export function PublicDocumentsApp(){
 const [theme,setTheme]=useState<{id:ThemeId;mode:string}|null>(null);
 const [doc,setDoc]=useState<PublicDocument|null>(null),[error,setError]=useState(""),[dark,setDark]=useState(()=>matchMedia("(prefers-color-scheme: dark)").matches);
 useEffect(()=>{let alive=true;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);void fetch("/api/v1/public/appearance",{credentials:"omit",signal:controller.signal}).then(r=>{if(!r.ok)throw Error();return r.json()}).then(v=>{const id=THEMES.some(t=>t.id===v.data.themeId)?v.data.themeId:"classic-gold";if(alive)setTheme({id,mode:v.data.mode})}).catch(()=>{if(alive)setTheme({id:"classic-gold",mode:"system"})}).finally(()=>clearTimeout(timeout));return()=>{alive=false;clearTimeout(timeout);controller.abort()}},[]);
 useEffect(()=>{const media=matchMedia("(prefers-color-scheme: dark)");const changed=()=>setDark(media.matches);media.addEventListener("change",changed);return()=>media.removeEventListener("change",changed)},[]);
 useEffect(()=>{let alive=true;const parts=location.pathname.split("/").filter(Boolean);const valid=parts.length===2||parts.length===4&&parts[2]==="versions"&&/^[1-9][0-9]*$/.test(parts[3]);if(!valid||!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(parts[1]??"")){setError("文档不存在或已下线");return}
 const path=`/api/v1/public/documents/${parts[1]}${parts.length===4?`/versions/${parts[3]}`:""}`;
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);void fetch(path,{credentials:"omit",signal:controller.signal}).then(async r=>{if(!r.ok)throw Error(r.status===404?"文档不存在或已下线":"文档暂时无法读取，请刷新重试");return r.json()}).then(v=>{if(alive){setDoc(v.data);document.title=v.data.title}}).catch(e=>{if(alive)setError(e.name==="AbortError"?"读取超时，请刷新重试":e.message)}).finally(()=>clearTimeout(timeout));return()=>{alive=false;clearTimeout(timeout);controller.abort()}
 },[]);
 if(!theme)return <main style={{padding:32}} role="status">正在初始化文档…</main>;
 const resolvedDark=theme.mode==="dark"||theme.mode==="system"&&dark;
 const colors=themeColors(theme.id,resolvedDark);
 return <main style={{...themeVariables(theme.id,resolvedDark),background:colors.bg,color:colors.text,colorScheme:resolvedDark?"dark":"light",minHeight:"100vh",padding:"32px 16px"} as CSSProperties}><div style={{maxWidth:900,margin:"0 auto",padding:24,background:colors.surface,borderRadius:12}}>{error?<><h1>文档不可用</h1><p role="alert">{error}</p></>:doc?<><h1>{doc.title}</h1><p>版本 v{doc.version} · 生效时间 {new Date(doc.publishedAt).toLocaleString()}</p>{doc.note&&<p>{doc.note}</p>}<label>阅读版本 <select style={{background:colors.surface,color:colors.text,border:"1px solid var(--admin-stroke)",borderRadius:6,padding:"4px 8px"}} aria-label="阅读历史版本" value={doc.version} onChange={e=>{location.href=`/legal/${doc.slug}/versions/${e.target.value}`}}>{Array.from({length:doc.currentVersion},(_,i)=>i+1).reverse().map(n=><option key={n} value={n}>v{n}{n===doc.currentVersion?"（当前）":""}</option>)}</select></label><hr/><MarkdownReader markdown={doc.markdown}/><p><a href={`/legal/${doc.slug}/versions/${doc.version}`}>本版本固定链接</a></p></>:<p role="status">正在加载文档…</p>}</div></main>
}
