import { Button, Radio, Space, Typography } from "antd";
import { BrandLogoLockup } from "../brand-ai-suffix";
import type { CSSProperties } from "react";
import { THEMES, themeColors, themeVariables, type AppearanceMode, type ThemeId } from "./tokens";
export function AppearanceControls({ themeId, mode, onChange, disabled = false, label = "个人外观" }: {
    label?: string;
    themeId: ThemeId;
    mode: AppearanceMode;
    onChange: (themeId: ThemeId, mode: AppearanceMode) => void;
    disabled?: boolean;
}) {
    return <Space orientation="vertical" size={16} style={{ width: "100%" }}>
  <div><Typography.Text strong>外观模式</Typography.Text><div style={{ marginTop: 8 }}><Radio.Group aria-label={`${label}模式`} disabled={disabled} value={mode} onChange={event => onChange(themeId, event.target.value)} options={[{ label: "亮色", value: "light" }, { label: "暗色", value: "dark" }, { label: "跟随系统", value: "system" }]} optionType="button"/></div></div>
  <div><Typography.Text strong>配色主题</Typography.Text>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,280px),1fr))", gap: 12, marginTop: 8 }}>
      {THEMES.map(t => <Button aria-label={`${label}：${t.name}`} disabled={disabled} key={t.id} aria-pressed={themeId === t.id} onClick={() => onChange(t.id, mode)} style={{ height: "auto", width: "100%", minWidth: 0, padding: 12, display: "flex", flexDirection: "column", alignItems: "stretch", textAlign: "left", whiteSpace: "normal", gap: 10, opacity: disabled ? .6 : 1, borderColor: themeId === t.id ? "var(--admin-accent)" : undefined }}>
        <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span>{t.name}</span><span aria-hidden="true">{themeId === t.id ? "✓" : ""}</span></span>
        <span style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 8 }}>
          {[false, true].map(dark => { const colors = themeColors(t.id, dark); return <span key={String(dark)} aria-label={`${t.name}${dark ? "暗色" : "亮色"}预览`} style={{ ...themeVariables(t.id, dark), display: "block", minWidth: 0, background: colors.surface, color: colors.text, padding: 8, borderRadius: 8, overflow: "hidden" } as CSSProperties}>
            <span style={{display:"block",fontFamily:"system-ui,sans-serif",fontSize:20,fontStyle:"italic",fontWeight:700,lineHeight:1}}><BrandLogoLockup showAIIcon fitText maxHeight={20}>Kysion</BrandLogoLockup></span>
          </span>; })}
        </span>
      </Button>)}
    </div>
  </div>
 </Space>;
}
