import { classicVariables } from "./classic-tokens";
export type AppearanceMode = "light" | "dark" | "system";
export type ThemeId = typeof THEMES[number]["id"];
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
    { id: "classic-gold", name: "经典金", light: "#d49a3d", dark: "#ffd47d", bg: ["#f7efe4", "#050505"], nav: ["#fffcf7", "#050505"], surface: ["#fffaf3", "#111111"], soft: ["#fcf6ed", "#161616"], text: ["#34281a", "#ffffff"], muted: ["#6f573a", "#b3b3b3"], selected: ["#f7ead4", "#24201a"], selectedText: ["#7a541b", "#ffd47d"], line: ["#ead9c5", "#39322a"], onPrimary: ["#34281a", "#34281a"] },
    { id: "business-blue", name: "商务蓝", light: "#2563c4", dark: "#8bb8ff", bg: ["#eff4fb", "#0a1220"], nav: ["#f9fbff", "#101d31"], surface: ["#ffffff", "#16253c"], soft: ["#e7eef9", "#203149"], text: ["#20324e", "#ffffff"], muted: ["#586b85", "#b0bfd3"], selected: ["#dce7f7", "#203149"], selectedText: ["#1b4f9c", "#8bb8ff"], line: ["#d4deec", "#30435e"], onPrimary: ["#ffffff", "#13201a"] },
    { id: "jade-green", name: "翡翠绿", light: "#167554", dark: "#76d4ae", bg: ["#eef6f1", "#091711"], nav: ["#f8fcf9", "#0d1d16"], surface: ["#fbfefa", "#13271d"], soft: ["#e8f2eb", "#1a3024"], text: ["#193b2c", "#f1fff6"], muted: ["#526d5c", "#afc7b8"], selected: ["#dcece1", "#1a3024"], selectedText: ["#10553c", "#76d4ae"], line: ["#d1e1d6", "#304e3c"], onPrimary: ["#ffffff", "#13201a"] },
    { id: "graphite-cyan", name: "石墨青", light: "#087f8c", dark: "#35d1db", bg: ["#f3f5f6", "#181818"], nav: ["#fafbfc", "#202020"], surface: ["#ffffff", "#262626"], soft: ["#edf1f3", "#353535"], text: ["#202428", "#f3f3f3"], muted: ["#667078", "#ababab"], selected: ["#e4f3f4", "#303030"], selectedText: ["#087482", "#35d1db"], line: ["#dce2e5", "#3a3a3a"], onPrimary: ["#ffffff", "#102629"] },
    { id: "violet-dusk", name: "暮云紫", light: "#6c56c8", dark: "#b5a3ff", bg: ["#f5f3fb", "#15131c"], nav: ["#fcfbfe", "#201d29"], surface: ["#ffffff", "#282432"], soft: ["#ece8f7", "#332e40"], text: ["#29243a", "#f4f0ff"], muted: ["#706a80", "#bcb5cd"], selected: ["#e9e4f5", "#30283f"], selectedText: ["#51409f", "#b5a3ff"], line: ["#ddd7eb", "#40394f"], onPrimary: ["#ffffff", "#211b34"] },
    { id: "terracotta", name: "赤陶橙", light: "#b7563e", dark: "#ff9d83", bg: ["#faf3f0", "#1b1311"], nav: ["#fffaf7", "#241916"], surface: ["#fffefd", "#2d1f1b"], soft: ["#f2e6e1", "#392923"], text: ["#34251f", "#fff1eb"], muted: ["#79645d", "#c8aaa0"], selected: ["#f2e4df", "#3a2923"], selectedText: ["#8d3f2e", "#ff9d83"], line: ["#ead8d1", "#50372f"], onPrimary: ["#ffffff", "#34201b"] },
    { id: "sky-mist", name: "天青蓝", light: "#347bac", dark: "#85bce8", bg: ["#f1f6fa", "#121a22"], nav: ["#fbfdff", "#19232d"], surface: ["#ffffff", "#222e39"], soft: ["#e7f0f7", "#2b3a47"], text: ["#243546", "#f0f6fb"], muted: ["#617487", "#aebdca"], selected: ["#e0edf6", "#263b4e"], selectedText: ["#285d88", "#85bce8"], line: ["#d6e2eb", "#364754"], onPrimary: ["#ffffff", "#172b3c"] },
    { id: "pine-forest", name: "松柏绿", light: "#467456", dark: "#91c7a2", bg: ["#f2f6f2", "#121a16"], nav: ["#fbfdfb", "#19241d"], surface: ["#ffffff", "#222f26"], soft: ["#e8f0e8", "#2b3a30"], text: ["#28392d", "#f0f7f0"], muted: ["#657769", "#b1c2b4"], selected: ["#e1ece2", "#293d30"], selectedText: ["#365c43", "#91c7a2"], line: ["#d8e3d9", "#394a3d"], onPrimary: ["#ffffff", "#1c3023"] },
    { id: "camellia-red", name: "山茶红", light: "#b14c5b", dark: "#f094a0", bg: ["#f9f2f3", "#1c1216"], nav: ["#fdf9fa", "#25191d"], surface: ["#ffffff", "#2e2025"], soft: ["#f2e5e7", "#3b2a30"], text: ["#39272b", "#fff0f1"], muted: ["#7b6569", "#c8aeb2"], selected: ["#f0e1e4", "#3b272e"], selectedText: ["#873b47", "#f094a0"], line: ["#e8d7da", "#4b363d"], onPrimary: ["#ffffff", "#351f24"] },
    { id: "slate-fog", name: "雾凇灰", light: "#5d7187", dark: "#afc3d8", bg: ["#f1f4f7", "#121820"], nav: ["#fbfcfd", "#1a222c"], surface: ["#ffffff", "#252f3a"], soft: ["#e7edf2", "#303d49"], text: ["#263341", "#f0f4f8"], muted: ["#66788a", "#b2bfcb"], selected: ["#dfe8ef", "#2c3b49"], selectedText: ["#45586b", "#afc3d8"], line: ["#d7e1e9", "#3a4a58"], onPrimary: ["#ffffff", "#1a2733"] }
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
    const i = dark ? 1 : 0;
    return {
        primary: dark ? preset.dark : preset.light,
        bg: preset.bg[i], nav: preset.nav[i], surface: preset.surface[i], soft: preset.soft[i],
        text: preset.text[i], muted: preset.muted[i], selected: preset.selected[i],
        selectedText: preset.selectedText[i], line: preset.line[i], onPrimary: preset.onPrimary[i]
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
        "--admin-segmented-selected-bg": c.selected, "--admin-segmented-selected-text": c.selectedText, "--admin-segmented-hover-bg": mix(14),
        "--admin-focus-ring": c.primary,
        "--admin-syntax-comment":dark?"#a6b3bb":"#5d6874",
        "--admin-syntax-string":dark?"#e6bb83":"#965100",
        "--admin-syntax-number":dark?"#c9a9fa":"#7840c8",
        "--admin-syntax-keyword":dark?"#8cbcff":"#1859a9",
        "--admin-syntax-property":dark?"#9dcaff":"#14559c",
        "--admin-syntax-selector":dark?"#e3ad87":"#8a3908",
        "--admin-accent-rgb": c.primary.slice(1).match(/../g)!.map(x => parseInt(x, 16)).join(", "),
        "--admin-on-primary": c.onPrimary,
        "--admin-code-bg":c.soft,
        "--admin-primary": c.primary, "--admin-primary-soft": mix(14), "--admin-primary-border": mix(24),
        "--admin-bg-color": c.bg, "--admin-bg-container": c.surface, "--admin-bg-elevated": c.surface,
        "--admin-border-color": mix(24), "--admin-text-secondary": c.muted, "--admin-text-tertiary": c.muted
    };
    for (const mode of ["light", "dark"] as const) {
        const p = themeColors(themeId, mode === "dark");
        const prefix = `--admin-shell-${mode}-`;
        Object.assign(v, { [prefix + "base"]: p.bg, [prefix + "nav"]: p.nav, [prefix + "right"]: p.bg, [prefix + "divider"]: `color-mix(in srgb, ${p.primary} 18%, transparent)`, [prefix + "toolbar"]: `color-mix(in srgb, ${p.primary} 16%, transparent)`, [prefix + "toolbar-text"]: p.muted, [prefix + "toolbar-border"]: `color-mix(in srgb, ${p.primary} 24%, transparent)`, [prefix + "selected"]: p.selected, [prefix + "selected-text"]: p.selectedText });
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
