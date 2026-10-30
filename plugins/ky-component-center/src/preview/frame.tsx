import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Space } from "antd";
import { validReply, type PreviewConfig } from "../catalog/protocol";
export function PreviewFrame({config,width,onRetry,background="var(--admin-content-bg)"}:{config:Omit<PreviewConfig,"generation">;width:string;onRetry:()=>void;background?:string}) {
 const timeout=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const frame=useRef<HTMLIFrameElement>(null);const generation=useMemo(()=>`cc_${crypto.randomUUID().replaceAll("-","")}`,[]);
 const [status,setStatus]=useState<"loading"|"ready"|"error">("loading"),[loaded,setLoaded]=useState(false);
 const latest=useRef({...config,generation});latest.current={...config,generation};
 const send=()=>frame.current?.contentWindow?.postMessage(latest.current,window.location.origin);
 useEffect(()=>{const receive=(e:MessageEvent)=>{if(e.origin!==window.location.origin||e.source!==frame.current?.contentWindow||!validReply(e.data,generation))return;if(e.data.kind==="ready")send();else {clearTimeout(timeout.current);setStatus(e.data.kind==="applied"?"ready":"error");}};window.addEventListener("message",receive);return ()=>window.removeEventListener("message",receive)},[generation]);
 useEffect(()=>{if(loaded){setStatus("loading");send();}timeout.current=setTimeout(()=>setStatus("error"),12000);return ()=>clearTimeout(timeout.current)},[config,loaded]);
 if(!["http:","https:"].includes(window.location.protocol))return <Alert type="warning" title="当前本地文件模式不支持隔离预览，请使用HTTP后台入口。"/>;
 return <><Space style={{marginBottom:8}}><span role="status">{status==="ready"?"预览已就绪":status==="error"?"预览失败或超时":"正在初始化预览…"}</span><Button size="small" onClick={onRetry}>重新初始化</Button></Space>{status==="error"&&<Alert type="error" title="预览未就绪，请重试；后台业务不受影响。" style={{marginBottom:8}}/>}<div style={{maxWidth:"100%",overflowX:"auto",border:"1px solid var(--admin-stroke)",borderRadius:12,position:"relative",background}}>{status!=="ready"&&<div role="status" style={{position:"absolute",inset:0,padding:16,color:"var(--admin-text-muted)"}}>{status==="error"?"预览未就绪，请重新初始化":"正在应用主题并初始化预览…"}</div>}<iframe ref={frame} title="组件隔离预览" src={`/component-preview.html?generation=${generation}`} referrerPolicy="no-referrer" onLoad={()=>{setLoaded(true);send()}} style={{display:"block",width,maxWidth:"100%",height:640,border:0,background,visibility:status==="ready"?"visible":"hidden"}}/></div></>;
}
