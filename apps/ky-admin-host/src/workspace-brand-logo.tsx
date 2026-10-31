import { BrandIdentityProvider, BrandLogo, BrandLogoLockup, useAppearance, useBrandIdentity, type BrandIdentity } from "@ky/admin-core";
import { createContext, useContext, useEffect, useLayoutEffect, useState, type PropsWithChildren } from "react";
import { requestClient } from "./remote-api";
import { usePlatformProfile } from "./platform-profile";
type Workspace = {id:string;type:string;membershipId:string};
const BrandStatus = createContext<{error:boolean;retry:()=>void}>({error:false,retry:()=>{}});
/** One effective identity supplies both the real header and all theme previews. */
export function WorkspaceBrandProvider({workspace,children}:PropsWithChildren<{workspace:Workspace}>) {
  const platform=useBrandIdentity();
  const key=`${workspace.type}:${workspace.id}:${workspace.membershipId}`;
  const [resolved,setResolved]=useState<{key:string;brand?:BrandIdentity;error?:boolean}>();
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const refresh=()=>setRetry(x=>x+1);
    window.addEventListener("ky:agency-branding-updated",refresh);
    window.addEventListener("ky:platform-profile-updated",refresh);
    return()=>{window.removeEventListener("ky:agency-branding-updated",refresh);window.removeEventListener("ky:platform-profile-updated",refresh)};
  },[]);
  useEffect(()=>{
    if(workspace.type==="platform")return;
    let active=true;
    void requestClient.request<{brand:BrandIdentity}>("/api/v1/organizations/current/branding")
      .then(v=>{if(active)setResolved({key,brand:v.brand})})
      .catch(()=>{if(active)setResolved({key,error:true})});
    return()=>{active=false};
  },[key,retry,workspace.type]);
  const brand=workspace.type==="platform"?platform:resolved?.key===key?resolved.brand??null:null;
  return <BrandStatus.Provider value={{error:resolved?.key===key&&resolved.error===true,retry:()=>setRetry(x=>x+1)}}>
    <BrandIdentityProvider brand={brand}>{children}</BrandIdentityProvider>
  </BrandStatus.Provider>;
}
export function WorkspaceBrandLogo({workspace,collapsed}:{workspace:Workspace;collapsed:boolean}) {
  const brand=useBrandIdentity(),p=usePlatformProfile(),{dark}=useAppearance(),status=useContext(BrandStatus);
  useLayoutEffect(()=>{
    document.title=brand?`${brand.applicationName||brand.name} 后台`:"管理后台";
    return()=>{document.title="管理后台"};
  },[brand?.name,brand?.applicationName,workspace.id]);
  if(!brand)return <span role="status">{status.error?<button onClick={status.retry}>重试加载品牌</button>:"加载中"}</span>;
  if(collapsed)return <BrandLogoLockup className="brand-short-lockup" fitText maxHeight={32} showAIIcon={false}><span>{workspace.type==="platform"?p.logoTextShort:brand.iconText||Array.from(brand.name).slice(0,2).join("")}</span></BrandLogoLockup>;
  return <BrandLogo brand={brand} dark={dark} maxHeight={40} compactInset={6}/>;
}
