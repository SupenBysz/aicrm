import type {CSSProperties,ReactNode} from "react";
import {themeVariables,type ThemeId} from "./theme/tokens";
import "./brand-form.css";
/** Presentation only: callers own draft artwork, requests and upload permissions. */
export function BrandNavigationPreview({themeId,renderLogo,actions}:{themeId:ThemeId;renderLogo:(dark:boolean,collapsed:boolean)=>ReactNode;actions?:(dark:boolean,collapsed:boolean)=>ReactNode}) {
 return <section className="agency-brand-previews" aria-label="应用 LOGO 四态预览">
  {[false,true].map(dark=><section key={String(dark)} className={`agency-brand-preview ${dark?"dark":"light"}`} style={themeVariables(themeId,dark) as CSSProperties}>
   <div className="brand-preview-heading"><span className="agency-brand-preview-label">{dark?"暗色":"亮色"}</span></div>
   <div className="brand-preview-states">{[false,true].map(collapsed=><div key={String(collapsed)}>
    <div className="brand-preview-heading"><span className="agency-brand-preview-label">{collapsed?"收起 · 应用图标":"展开 · 文字 LOGO"}</span><div className="brand-preview-actions">{actions?.(dark,collapsed)}</div></div>
    <div className="agency-brand-preview-scroll"><div className={`agency-brand-preview-header${collapsed?" brand-preview-collapsed":""}`} style={{"--admin-sidebar-width":collapsed?"80px":"177px"} as CSSProperties}>
     <div className="brand-preview-logo-slot">{renderLogo(dark,collapsed)}</div>
     <div className="agency-brand-preview-modes" aria-label="顶部导航位置参考"><span>工作台</span><span>管理中心</span></div>
    </div></div>
   </div>)}</div>
  </section>)}
 </section>;
}
