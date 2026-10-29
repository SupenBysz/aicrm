import { Button, Radio, Space, Typography } from "antd";
import { THEMES, themeColors, type AppearanceMode, type ThemeId } from "./tokens";
export function AppearanceControls({ themeId, mode, onChange, disabled = false, label = "个人外观" }: {
    label?: string;
    themeId: ThemeId;
    mode: AppearanceMode;
    onChange: (themeId: ThemeId, mode: AppearanceMode) => void;
    disabled?: boolean;
}) {
    return <Space orientation="vertical" size={16} style={{ width: "100%" }}>
  <div><Typography.Text strong>外观模式</Typography.Text><div style={{ marginTop: 8 }}><Radio.Group aria-label={`${label}模式`} disabled={disabled} value={mode} onChange={event => onChange(themeId, event.target.value)} options={[{ label: "亮色", value: "light" }, { label: "暗色", value: "dark" }, { label: "跟随系统", value: "system" }]} optionType="button"/></div></div>
  <div><Typography.Text strong>配色主题</Typography.Text><div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8 }}>{THEMES.map(t => <Button aria-label={`${label}：${t.name}`} disabled={disabled} key={t.id} aria-pressed={themeId === t.id} onClick={() => onChange(t.id, mode)} style={{ height: "auto", padding: 12, minWidth: 100, borderColor: themeId === t.id ? "var(--admin-accent)" : undefined }}><span style={{ display: "block" }}>{t.name}{themeId === t.id ? " ✓" : ""}</span><span style={{ display: "flex", gap: 4, marginTop: 8 }}>{[false, true].map(d => { const c = themeColors(t.id, d); return <span key={String(d)} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 44, height: 30, background: c.bg, color: c.primary, borderRadius: 4, border: `1px solid ${c.primary}` }}>Aa</span>; })}</span></Button>)}</div></div>
 </Space>;
}
