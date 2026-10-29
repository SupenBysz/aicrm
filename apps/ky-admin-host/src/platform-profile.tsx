import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react";
import type { CopyrightStyle } from "@ky/admin-core";

export interface PlatformProfile {
  companyName: string;
  copyrightStyle: CopyrightStyle;
  brandLogoTextLong: string;
  brandLogoTextShort: string;
  longLogoFontSize: number;
  longLogoFontFamily: "system" | "sans" | "serif" | "mono";
  longLogoFontWeight: 400 | 500 | 600 | 700;
  shortLogoFontSize: number;
  shortLogoFontFamily: "system" | "sans" | "serif" | "mono";
  shortLogoFontWeight: 400 | 500 | 600 | 700;
  icpRecord: string;
}

export const DEFAULT_PLATFORM_NAME = "KyCRM";
const STORAGE_KEY = "ky.platform.profile.v1";
// Components can dispatch this after editing 基础信息 to refresh the brand immediately.
export const PLATFORM_PROFILE_UPDATED_EVENT = "ky:platform-profile-updated";

interface PlatformProfileContextValue extends PlatformProfile {
  /** Effective company/platform name: companyName or the default fallback. */
  name: string;
  /** Effective expanded text logo. */
  logoTextLong: string;
  /** Effective collapsed text logo. */
  logoTextShort: string;
  logoTextLongStyle: LogoTextStyle;
  logoTextShortStyle: LogoTextStyle;
  ready:boolean;
  error:boolean;
  refresh: () => void;
}

export interface LogoTextStyle {
  fontSize: number;
  fontFamily: string;
  fontWeight: 400 | 500 | 600 | 700;
}

const FONT_FAMILY_MAP: Record<PlatformProfile["longLogoFontFamily"], string> = {
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  sans: "Arial, 'Helvetica Neue', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace"
};

function compactLogoText(value: string): string {
  const normalized = value.trim() || DEFAULT_PLATFORM_NAME;
  const hanChars = Array.from(normalized.matchAll(/\p{Script=Han}/gu), (match) => match[0]);
  if (hanChars.length > 0) return hanChars.slice(0, 2).join("");
  return Array.from(normalized.replace(/\s+/g, "")).slice(0, 6).join("") || DEFAULT_PLATFORM_NAME;
}

function normalizeProfile(value: Partial<PlatformProfile> | null | undefined): PlatformProfile {
  return {
    companyName: value?.companyName ?? "",
    copyrightStyle: value?.copyrightStyle === "full" || value?.copyrightStyle === "chinese" ? value.copyrightStyle : "standard",
    brandLogoTextLong: value?.brandLogoTextLong ?? "",
    brandLogoTextShort: value?.brandLogoTextShort ?? "",
    longLogoFontSize: value?.longLogoFontSize && value.longLogoFontSize >= 8 && value.longLogoFontSize <= 72 ? value.longLogoFontSize : 16,
    longLogoFontFamily: value?.longLogoFontFamily && value.longLogoFontFamily in FONT_FAMILY_MAP ? value.longLogoFontFamily : "system",
    longLogoFontWeight: value?.longLogoFontWeight && [400, 500, 600, 700].includes(value.longLogoFontWeight) ? value.longLogoFontWeight : 600,
    shortLogoFontSize: value?.shortLogoFontSize && value.shortLogoFontSize >= 8 && value.shortLogoFontSize <= 72 ? value.shortLogoFontSize : 14,
    shortLogoFontFamily: value?.shortLogoFontFamily && value.shortLogoFontFamily in FONT_FAMILY_MAP ? value.shortLogoFontFamily : "system",
    shortLogoFontWeight: value?.shortLogoFontWeight && [400, 500, 600, 700].includes(value.shortLogoFontWeight) ? value.shortLogoFontWeight : 600,
    icpRecord: value?.icpRecord ?? ""
  };
}

function resolveProfile(profile: PlatformProfile) {
  const name = profile.companyName.trim() || DEFAULT_PLATFORM_NAME;
  const logoTextLong = profile.brandLogoTextLong.trim() || name;
  const logoTextShort = profile.brandLogoTextShort.trim() || compactLogoText(logoTextLong || name);
  const logoTextLongStyle: LogoTextStyle = {
    fontSize: profile.longLogoFontSize,
    fontFamily: FONT_FAMILY_MAP[profile.longLogoFontFamily],
    fontWeight: profile.longLogoFontWeight
  };
  const logoTextShortStyle: LogoTextStyle = {
    fontSize: profile.shortLogoFontSize,
    fontFamily: FONT_FAMILY_MAP[profile.shortLogoFontFamily],
    fontWeight: profile.shortLogoFontWeight
  };
  return { logoTextLong, logoTextShort, logoTextLongStyle, logoTextShortStyle, name };
}

const defaultProfile = normalizeProfile(null);
const defaultResolved = resolveProfile(defaultProfile);

const PlatformProfileContext = createContext<PlatformProfileContextValue>({
  ...defaultProfile,
  ...defaultResolved,
  ready:false,
  error:false,
  refresh: () => {}
});

function readCache(): PlatformProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeProfile(JSON.parse(raw) as Partial<PlatformProfile>);
  } catch {
    // ignore
  }
  return normalizeProfile(null);
}

export function PlatformProfileProvider({ children }: PropsWithChildren) {
  const [profile, setProfile] = useState<PlatformProfile>(readCache);
  const refreshGeneration = useRef(0);
 const [ready,setReady]=useState(false),[error,setError]=useState(false);

  const refresh = useCallback(() => {
    const generation = ++refreshGeneration.current;
    // Public, no-auth endpoint: usable on the login page before sign-in.
    fetch("/api/v1/public/platform-profile")
      .then((r) => {if(!r.ok)throw new Error("profile unavailable");return r.json()})
      .then((body) => {
        const data = body?.data;
 if(!data || typeof data!=="object")throw new Error("profile unavailable");
        if (data && generation === refreshGeneration.current) {
          const next = normalizeProfile(data);
          setProfile(next);
 setReady(true);setError(false);
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          } catch {
            // ignore
          }
        }
      })
      .catch(() => {
        if(generation===refreshGeneration.current)setError(true);
      });
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener(PLATFORM_PROFILE_UPDATED_EVENT, handler);
    return () => {
      refreshGeneration.current += 1;
      window.removeEventListener(PLATFORM_PROFILE_UPDATED_EVENT, handler);
    };
  }, [refresh]);

  const resolved = resolveProfile(profile);


  return (
    <PlatformProfileContext.Provider value={{ ...profile, ...resolved, ready,error,refresh }}>
      {ready?children:<div role="status" style={{padding:24}}>{error?<button onClick={refresh}>品牌加载失败，重试</button>:"正在加载…"}</div>}
    </PlatformProfileContext.Provider>
  );
}

export function usePlatformProfile() {
  return useContext(PlatformProfileContext);
}
