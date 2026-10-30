import { useEffect, useState } from "react";
import { Space, Typography } from "antd";
interface Link {purpose:string;title:string;slug:string}
export function PublicDocumentLinks(){
 const [links,setLinks]=useState<Link[]>([]);
 useEffect(()=>{const controller=new AbortController();void fetch("/api/v1/public/document-links",{credentials:"omit",signal:controller.signal}).then(r=>{if(!r.ok)throw Error();return r.json()}).then(v=>setLinks(v.data.items)).catch(()=>{/* No fabricated link when no published binding is available. */});return()=>controller.abort()},[]);
 return <Space size={16} wrap>{links.filter(l=>/^[a-z0-9]+(-[a-z0-9]+)*$/.test(l.slug)).map(l=><Typography.Link key={l.purpose} href={`/legal/${l.slug}`} target="_blank" rel="noopener noreferrer" style={{fontSize:12}}>{l.purpose==="privacy_policy"?"隐私政策":"服务协议"}</Typography.Link>)}</Space>;
}
