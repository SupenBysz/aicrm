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
]> = { "classic-gold": ["#f7efe4", "#050505"], "business-blue": ["#eff4fb", "#0a1220"], "jade-green": ["#eef6f1", "#091711"], "graphite-cyan": ["#f3f5f6", "#181818"] };
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

export function storedNativeThemeId(): "classic-gold" | "business-blue" | "jade-green" | "graphite-cyan" {
 try { const value=JSON.parse(readFileSync(join(app.getPath("userData"),"appearance.json"),"utf8")) as NativeAppearance;
 if(value.themeId==="business-blue"||value.themeId==="jade-green"||value.themeId==="graphite-cyan")return value.themeId;
 }catch{} return "classic-gold";
}
