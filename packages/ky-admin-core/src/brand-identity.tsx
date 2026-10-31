import { createContext, useContext, useMemo, useState, type PropsWithChildren } from "react";
import { BrandLogoLockup } from "./brand-ai-suffix";
import { generatedBrandImage } from "./brand-image";

/** Host supplies the effective platform/workspace brand. Core never fetches business APIs. */
export interface BrandIdentity {
  name: string;
  applicationName?: string;
  iconText?: string;
  showAiIcon?: boolean;
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
  const configured = (dark ? brand.wordmarkDark : brand.wordmark)?.url;
  const generated = useMemo(() => typeof document === "undefined" ? undefined : generatedBrandImage(brand.name, "wordmark", dark), [brand.name, dark]);
  const url = configured && configured !== broken ? configured : generated;
  return <BrandLogoLockup fitText className={className} compactInset={compactInset} maxHeight={maxHeight} showAIIcon={brand.showAiIcon === true}>
    {url && url !== broken ? <img src={url} alt={brand.name} style={{ maxHeight, maxWidth: "100%", objectFit: "contain" }} onError={() => setBroken(url)} /> : brand.name}
  </BrandLogoLockup>;
}
