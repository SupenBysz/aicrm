import { createContext, useCallback, useContext, useEffect, useState, type PropsWithChildren } from "react";

export interface PlatformProfile {
  companyName: string;
  brandLogoTextLong: string;
  brandLogoTextShort: string;
  icpRecord: string;
}

export const DEFAULT_PLATFORM_NAME = "AiCRM";
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
  refresh: () => void;
}

function compactLogoText(value: string): string {
  const normalized = value.trim() || DEFAULT_PLATFORM_NAME;
  const hanChars = Array.from(normalized.matchAll(/\p{Script=Han}/gu), (match) => match[0]);
  if (hanChars.length > 0) return hanChars.slice(0, 2).join("");
  return Array.from(normalized.replace(/\s+/g, "")).slice(0, 6).join("") || DEFAULT_PLATFORM_NAME;
}

function normalizeProfile(value: Partial<PlatformProfile> | null | undefined): PlatformProfile {
  return {
    companyName: value?.companyName ?? "",
    brandLogoTextLong: value?.brandLogoTextLong ?? "",
    brandLogoTextShort: value?.brandLogoTextShort ?? "",
    icpRecord: value?.icpRecord ?? ""
  };
}

function resolveProfile(profile: PlatformProfile) {
  const name = profile.companyName.trim() || DEFAULT_PLATFORM_NAME;
  const logoTextLong = profile.brandLogoTextLong.trim() || name;
  const logoTextShort = profile.brandLogoTextShort.trim() || compactLogoText(logoTextLong || name);
  return { logoTextLong, logoTextShort, name };
}

const defaultProfile = normalizeProfile(null);
const defaultResolved = resolveProfile(defaultProfile);

const PlatformProfileContext = createContext<PlatformProfileContextValue>({
  ...defaultProfile,
  ...defaultResolved,
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

  const refresh = useCallback(() => {
    // Public, no-auth endpoint: usable on the login page before sign-in.
    fetch("/api/v1/public/platform-profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const data = body?.data;
        if (data) {
          const next = normalizeProfile(data);
          setProfile(next);
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          } catch {
            // ignore
          }
        }
      })
      .catch(() => {
        // keep cached / default
      });
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener(PLATFORM_PROFILE_UPDATED_EVENT, handler);
    return () => window.removeEventListener(PLATFORM_PROFILE_UPDATED_EVENT, handler);
  }, [refresh]);

  const resolved = resolveProfile(profile);

  // Keep the browser tab title in sync with the brand logo text.
  useEffect(() => {
    document.title = `${resolved.logoTextLong} 后台`;
  }, [resolved.logoTextLong]);

  return (
    <PlatformProfileContext.Provider value={{ ...profile, ...resolved, refresh }}>
      {children}
    </PlatformProfileContext.Provider>
  );
}

export function usePlatformProfile() {
  return useContext(PlatformProfileContext);
}
