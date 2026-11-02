import { app, type BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
interface NativeAppearance {
    themeId: string;
    dark: boolean;
}
const backgrounds: Record<string, readonly [
    string,
    string
]> = { "classic-gold": ["#f7efe4", "#050505"], "business-blue": ["#eff4fb", "#0a1220"], "jade-green": ["#eef6f1", "#091711"], "graphite-cyan": ["#f3f5f6", "#181818"], "violet-dusk": ["#f5f3fb", "#15131c"], "terracotta": ["#faf3f0", "#1b1311"], "sky-mist": ["#f1f6fa", "#121a22"], "pine-forest": ["#f2f6f2", "#121a16"], "camellia-red": ["#f9f2f3", "#1c1216"], "slate-fog": ["#f1f4f7", "#121820"] };
export function storedNativeBackground(): string | undefined { try {
    const v = JSON.parse(readFileSync(join(app.getPath("userData"), "appearance.json"), "utf8")) as NativeAppearance;
    if (typeof v.dark !== "boolean")
        return;
    return backgrounds[v.themeId]?.[v.dark ? 1 : 0];
}
catch {
    return;
} }
export function storedNativeTheme(): "light" | "dark" {
    try {
        const value = JSON.parse(readFileSync(join(app.getPath("userData"), "appearance.json"), "utf8")) as NativeAppearance;
        return value.dark ? "dark" : "light";
    } catch { return "light"; }
}
export function applyNativeAppearance(window: BrowserWindow, value: NativeAppearance) { const color = backgrounds[value.themeId]?.[value.dark ? 1 : 0]; if (!color)
    return; window.setBackgroundColor(color); try {
    writeFileSync(join(app.getPath("userData"), "appearance.json"), JSON.stringify(value), { mode: 0o600 });
}
catch { /* Window theme still applies when preferences are read-only. */ } }

export function storedNativeThemeId(): "classic-gold" | "business-blue" | "jade-green" | "graphite-cyan" | "violet-dusk" | "terracotta" | "sky-mist" | "pine-forest" | "camellia-red" | "slate-fog" {
 try { const value=JSON.parse(readFileSync(join(app.getPath("userData"),"appearance.json"),"utf8")) as NativeAppearance;
 if(value.themeId==="business-blue"||value.themeId==="jade-green"||value.themeId==="graphite-cyan"||value.themeId==="violet-dusk"||value.themeId==="terracotta"||value.themeId==="sky-mist"||value.themeId==="pine-forest"||value.themeId==="camellia-red"||value.themeId==="slate-fog")return value.themeId;
 }catch{} return "classic-gold";
}
