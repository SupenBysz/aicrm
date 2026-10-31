import { createContext, useContext, useState, type PropsWithChildren } from "react";
import { BrandLogoLockup } from "./brand-ai-suffix";

/** Host supplies the effective platform/workspace brand. Core never fetches business APIs. */
export interface BrandIdentity {
  name: string;
  applicationName?: string;
  iconText?: string;
  showAiIcon?: boolean;
  icon?: { url: string };
  iconDark?: { url: string };
  iconGenerated?: boolean;
  iconDarkGenerated?: boolean;
  wordmarkGenerated?: boolean;
  wordmarkDarkGenerated?: boolean;
  wordmark?: { url: string };
  wordmarkDark?: { url: string };
}
const BrandContext = createContext<BrandIdentity | null>(null);
export function BrandIdentityProvider({ brand, children }: PropsWithChildren<{ brand: BrandIdentity | null }>) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}
export function useBrandIdentity() { return useContext(BrandContext); }

/** Full configured wordmark plus the optional shared vector AI suffix; never literal "AI". */
export function BrandLogo({ brand, dark, maxHeight = 32, compactInset = 0, className }: {
  brand: BrandIdentity; dark: boolean; maxHeight?: number; compactInset?: number; className?: string;
}) {
  const [broken, setBroken] = useState("");
  const url = (dark ? brand.wordmarkDarkGenerated : brand.wordmarkGenerated) ? undefined : (dark ? brand.wordmarkDark : brand.wordmark)?.url;
  return <BrandLogoLockup fitText className={className} compactInset={compactInset} maxHeight={maxHeight} showAIIcon={brand.showAiIcon === true}>
    {url && url !== broken ? <img src={url} alt={brand.name} style={{ maxHeight, maxWidth: "100%", objectFit: "contain" }} onError={() => setBroken(url)} /> : brand.name}
  </BrandLogoLockup>;
}

/** Uploaded application artwork or directly fitted text, without nested bitmap padding. */
export function BrandIcon({brand,dark=false,size=48}:{brand:BrandIdentity;dark?:boolean;size?:number}) {
 const [broken,setBroken]=useState("");
 const text=brand.iconText?.trim()||Array.from(brand.name).slice(0,2).join("");
 const url=(dark?brand.iconDarkGenerated:brand.iconGenerated)?undefined:(dark?brand.iconDark:brand.icon)?.url;
 return <span aria-label={`${brand.name}应用图标`} style={{display:"inline-flex",width:size,height:size,alignItems:"center",justifyContent:"center",flexShrink:0,overflow:"hidden"}}>
  {url&&url!==broken?<img src={url} alt={brand.name} style={{width:"100%",height:"100%",objectFit:"contain"}} onError={()=>setBroken(url)}/>:<BrandLogoLockup fitText maxHeight={32} className="brand-icon-text" showAIIcon={false}><span>{text}</span></BrandLogoLockup>}
 </span>;
}
