import { classicVariables } from "./classic-tokens";
export type AppearanceMode = "light" | "dark" | "system";
export type ThemeId = "classic-gold" | "business-blue" | "jade-green" | "graphite-cyan";
export interface AppearanceValue {
    schemaVersion: 1;
    source: "personal" | "platform";
    themeId: ThemeId | "";
    mode: AppearanceMode | "";
    revision: number;
}
export const DEFAULT_APPEARANCE: AppearanceValue = { schemaVersion: 1, source: "platform", themeId: "classic-gold", mode: "system", revision: 0 };
export const APPEARANCE_SNAPSHOT_KEY = "ky.admin.appearance.snapshot.v1";
export const THEMES = [
    { id: "classic-gold", name: "经典金", light: "#d49a3d", dark: "#ffd47d" },
    { id: "business-blue", name: "商务蓝", light: "#2563c4", dark: "#8bb8ff" },
    { id: "jade-green", name: "翡翠绿", light: "#167554", dark: "#76d4ae" },
    { id: "graphite-cyan", name: "石墨青", light: "#087f8c", dark: "#35d1db" }
] as const;
export function validAppearance(value: unknown, personal = false): value is AppearanceValue {
    if (!value || typeof value !== "object")
        return false;
    const v = value as AppearanceValue;
    if (v.schemaVersion !== 1 || !Number.isSafeInteger(v.revision) || v.revision < 0)
        return false;
    if (personal && v.source === "platform")
        return v.themeId === "" && v.mode === "";
    return v.source === (personal ? "personal" : "platform") && THEMES.some(t => t.id === v.themeId) && ["light", "dark", "system"].includes(v.mode);
}
export function themeColors(themeId: string, dark: boolean) {
    const preset = THEMES.find(t => t.id === themeId) ?? THEMES[0];
    if (preset.id === "graphite-cyan") return {
        primary: dark ? preset.dark : preset.light,
        bg: dark ? "#181818" : "#f3f5f6",
        nav: dark ? "#202020" : "#fafbfc",
        surface: dark ? "#262626" : "#ffffff",
        soft: dark ? "#353535" : "#edf1f3",
        text: dark ? "#f3f3f3" : "#202428",
        muted: dark ? "#ababab" : "#667078",
        selectedText: dark ? preset.dark : preset.light
    };
    const gold = preset.id === "classic-gold";
    const green = preset.id === "jade-green";
    return {
        primary: dark ? preset.dark : preset.light,
        bg: dark ? (gold ? "#050505" : green ? "#091711" : "#0a1220") : gold ? "#f7efe4" : green ? "#eef6f1" : "#eff4fb",
        nav: dark ? (gold ? "#050505" : green ? "#0d1d16" : "#101d31") : gold ? "#fffcf7" : green ? "#f8fcf9" : "#f9fbff",
        surface: dark ? (gold ? "#111111" : green ? "#13271d" : "#16253c") : gold ? "#fffaf3" : green ? "#fbfefa" : "#ffffff",
        soft: dark ? (gold ? "#161616" : green ? "#1a3024" : "#203149") : gold ? "#fcf6ed" : green ? "#e8f2eb" : "#e7eef9",
        text: dark ? "#ffffff" : gold ? "#34281a" : green ? "#193b2c" : "#20324e",
        muted: dark ? "rgba(255,255,255,.70)" : gold ? "rgba(79,59,36,.72)" : green ? "#526d5c" : "#586b85",
        selectedText: dark ? preset.dark : gold ? "#7a541b" : green ? "#10553c" : "#1b4f9c"
    };
}
export function themeVariables(themeId: string, dark: boolean): Record<string, string> {
    if(!THEMES.some(t=>t.id===themeId))themeId="classic-gold";
    const c = themeColors(themeId, dark);
    const mix = (n: number) => `color-mix(in srgb, ${c.primary} ${n}%, transparent)`;
    const v: Record<string, string> = {
        "--admin-accent": c.primary, "--admin-accent-soft": mix(14), "--admin-divider": mix(18), "--admin-stroke": mix(24),
        "--admin-header-bg": c.bg, "--admin-nav-bg": c.nav, "--admin-right-shell-bg": c.bg, "--admin-content-bg": c.bg,
        "--admin-surface": c.surface, "--admin-surface-solid": c.nav, "--admin-surface-soft": c.soft,
        "--admin-text": c.text, "--admin-text-muted": c.muted, "--admin-text-subtle": dark ? "rgba(255,255,255,.50)" : c.muted,
        "--admin-shadow-soft": dark ? "none" : `0 20px 38px ${mix(10)}`, "--admin-scrollbar-thumb-bg": mix(28),
        "--admin-content-top-gradient-bg": dark ? c.bg : mix(28), "--admin-toolbar-bg": mix(dark ? 8 : 16),
        "--admin-toolbar-fg": c.muted, "--admin-toolbar-hover": mix(22), "--admin-toolbar-border": mix(24),
        "--admin-segmented-bg": mix(16), "--admin-segmented-border": mix(24), "--admin-segmented-text": c.muted,
        "--admin-segmented-selected-bg": dark ? c.soft : c.nav, "--admin-segmented-selected-text": c.selectedText, "--admin-segmented-hover-bg": mix(14),
        "--admin-focus-ring": c.primary,
        "--admin-syntax-comment":dark?"#a6b3bb":"#5d6874",
        "--admin-syntax-string":dark?"#e6bb83":"#965100",
        "--admin-syntax-number":dark?"#c9a9fa":"#7840c8",
        "--admin-syntax-keyword":dark?"#8cbcff":"#1859a9",
        "--admin-syntax-property":dark?"#9dcaff":"#14559c",
        "--admin-syntax-selector":dark?"#e3ad87":"#8a3908",
        "--admin-accent-rgb": c.primary.slice(1).match(/../g)!.map(x => parseInt(x, 16)).join(", "),
        "--admin-on-primary": themeId==="classic-gold"?"#34281a":dark ? "#13201a" : "#ffffff",
        "--admin-code-bg":c.soft,
        "--admin-primary": c.primary, "--admin-primary-soft": mix(14), "--admin-primary-border": mix(24),
        "--admin-bg-color": c.bg, "--admin-bg-container": c.surface, "--admin-bg-elevated": c.surface,
        "--admin-border-color": mix(24), "--admin-text-secondary": c.muted, "--admin-text-tertiary": c.muted
    };
    for (const mode of ["light", "dark"] as const) {
        const p = themeColors(themeId, mode === "dark");
        const prefix = `--admin-shell-${mode}-`;
        Object.assign(v, { [prefix + "base"]: p.bg, [prefix + "nav"]: p.nav, [prefix + "right"]: p.bg, [prefix + "divider"]: `color-mix(in srgb, ${p.primary} 18%, transparent)`, [prefix + "toolbar"]: `color-mix(in srgb, ${p.primary} 16%, transparent)`, [prefix + "toolbar-text"]: p.muted, [prefix + "toolbar-border"]: `color-mix(in srgb, ${p.primary} 24%, transparent)`, [prefix + "selected"]: mode === "dark" ? p.soft : p.nav, [prefix + "selected-text"]: p.selectedText });
    }
    if (themeId === "graphite-cyan") {
        // Neutral chrome is deliberate: cyan indicates actions and selection only.
        Object.assign(v, {
            "--admin-divider": dark ? "#333333" : "#e4e8ea",
            "--admin-stroke": dark ? "#3a3a3a" : "#dce2e5",
            "--admin-border-color": dark ? "#3a3a3a" : "#dce2e5",
            "--admin-bg-elevated": dark ? "#303030" : "#ffffff",
            "--admin-shadow-soft": dark ? "0 12px 32px #0006" : "0 12px 32px #14202b14",
            "--admin-scrollbar-thumb-bg": dark ? "#575757" : "#b9c2c7",
            "--admin-content-top-gradient-bg": c.bg,
            "--admin-toolbar-bg": c.nav, "--admin-toolbar-border": dark ? "#3a3a3a" : "#dce2e5",
            "--admin-toolbar-hover": c.soft,
            "--admin-segmented-bg": c.bg, "--admin-segmented-border": dark ? "#3a3a3a" : "#dce2e5",
            "--admin-segmented-selected-bg": c.surface,
            "--admin-text-subtle": dark ? "#969696" : "#667078",
            "--admin-on-primary": dark ? "#102629" : "#ffffff"
        });
        for (const mode of ["light", "dark"] as const) {
            const isDark = mode === "dark";
            const p = themeColors(themeId, isDark);
            const prefix = `--admin-shell-${mode}-`;
            Object.assign(v, {
                [prefix + "divider"]: isDark ? "#333333" : "#e4e8ea",
                [prefix + "toolbar"]: p.nav,
                [prefix + "toolbar-border"]: isDark ? "#3a3a3a" : "#dce2e5",
                [prefix + "selected"]: `color-mix(in srgb, ${p.primary} 14%, ${p.nav})`
            });
        }
    }
    if (themeId === "classic-gold")
        Object.assign(v, classicVariables[dark ? "dark" : "light"]);
    return v;
}
export function applyAppearance(themeId: string, mode: string) {
    if(!THEMES.some(t=>t.id===themeId))themeId="classic-gold";
    const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    const root = document.documentElement;
    root.dataset.adminTheme = dark ? "dark" : "light";
    root.dataset.adminPalette = themeId;
    root.style.colorScheme = dark ? "dark" : "light";
    for (const [name, value] of Object.entries(themeVariables(themeId, dark)))
        root.style.setProperty(name, value);
    root.style.color = "var(--admin-text)";
    root.style.background = "var(--admin-content-bg)";
    return dark;
}
// Forward compatibility: a removed palette falls back without losing a valid mode.
export function normalizeAppearance(value: unknown, personal = false): AppearanceValue | null {
    if (validAppearance(value, personal))
        return value;
    if (!value || typeof value !== "object")
        return null;
    const v = value as AppearanceValue;
    if (v.schemaVersion !== 1 || typeof v.themeId !== "string" || !["light", "dark", "system"].includes(v.mode))
        return null;
    const fallback = { ...v, themeId: "classic-gold" as const };
    return validAppearance(fallback, personal) ? fallback : null;
}

/** Reconcile a lost write response without overwriting a newer different value. */
export function appearanceRetryOutcome(remote: AppearanceValue, desired: AppearanceValue, baseRevision: number): "retry" | "saved" | "conflict" {
    if(remote.revision===baseRevision)return "retry";
    if(remote.revision>baseRevision&&remote.source===desired.source&&remote.themeId===desired.themeId&&remote.mode===desired.mode)return "saved";
    return "conflict";
}
