import { createContext, useContext } from "react";
import type { AppearanceValue, AppearanceMode, ThemeId } from "./tokens";
export type AppearanceSyncState = "loading"|"idle"|"pending"|"saving"|"saved"|"offline"|"conflict"|"reading";
export interface AppearanceContextValue {
    origin:"platform"|"personal"|"legacy";
    syncState:AppearanceSyncState;
    canReload:boolean;
    enabled: boolean;
    preference: AppearanceValue;
    platform: AppearanceValue;
    themeId: ThemeId;
    mode: AppearanceMode;
    dark: boolean;
    status: string;
    dirty: boolean;
    loading: boolean;
    choose: (themeId: ThemeId, mode: AppearanceMode) => void;
    followPlatform: () => void;
    retry: () => void;
    refresh: () => Promise<void>;
    /** Temporary page preview; null restores the actual account/platform appearance. */
    previewPlatform?: (value: AppearanceValue | null) => void;
    reloadPlatform: (saved?: AppearanceValue) => Promise<void>;
}
export const AppearanceContext = createContext<AppearanceContextValue | null>(null);
export function useAppearance() { const value = useContext(AppearanceContext); if (!value)
    throw new Error("AppearanceProvider missing"); return value; }
