import { BrandLogo, THEMES, themeColors, themeVariables, type BrandIdentity } from "@ky/admin-core";
import type { CSSProperties } from "react";

const brand: BrandIdentity = { name: "示例品牌", showAiIcon: true };

export default function Example() {
  return <div>
    <p style={{ fontSize: 24, fontWeight: 600 }}>标题层级</p>
    <p>正文 / <span style={{ color: "var(--admin-text-muted)" }}>次要文字</span></p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16 }}>
      {THEMES.map(theme => <section key={theme.id} aria-label={`${theme.name}配色主题`} style={{ minWidth: 0, padding: 16, borderRadius: 16, border: "1px solid var(--admin-stroke)", background: "var(--admin-surface)", color: "var(--admin-text)" }}>
        <strong style={{ display: "block", fontSize: 20, marginBottom: 14 }}>{theme.name}</strong>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
          {[false, true].map(dark => {
            const colors = themeColors(theme.id, dark);
            return <div key={String(dark)} aria-label={`${theme.name}${dark ? "暗色" : "亮色"}`} style={{ ...themeVariables(theme.id, dark), minWidth: 0, minHeight: 88, display: "flex", alignItems: "center", padding: 12, borderRadius: 12, background: colors.surface, color: colors.text } as CSSProperties}>
              <BrandLogo brand={brand} dark={dark} maxHeight={36} />
            </div>;
          })}
        </div>
      </section>)}
    </div>
    <p style={{ marginTop: 16 }}>间距示例 8 / 12 / 16 / 24px；以具体组件合同为准，尚未统一的值不当作全局 Token。</p>
  </div>;
}
