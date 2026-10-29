import { APPEARANCE_SNAPSHOT_KEY, applyAppearance } from "../../../packages/ky-admin-core/src/theme/tokens";
try {
    if (import.meta.env.VITE_APPEARANCE_DISABLED === "1")
        throw new Error("appearance disabled");
    const value = JSON.parse(localStorage.getItem(APPEARANCE_SNAPSHOT_KEY) ?? "null");
    const palette = ["classic-gold", "business-blue", "jade-green", "graphite-cyan"].includes(value?.themeId) ? value.themeId : "classic-gold";
    const mode = ["light", "dark", "system"].includes(value?.mode) ? value.mode : (localStorage.getItem("ky.admin.colorScheme.v1") ?? "system");
    applyAppearance(palette, mode);
}
catch {
    applyAppearance("classic-gold", "system");
}
