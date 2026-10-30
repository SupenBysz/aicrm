import { THEMES, themeColors } from "@ky/admin-core";
export default function Example() {
return <div><p style={{fontSize:24,fontWeight:600}}>标题层级</p><p>正文 / <span style={{color:"var(--admin-text-muted)"}}>次要文字</span></p><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12}}>{THEMES.flatMap(t=>[false,true].map(d=>{const c=themeColors(t.id,d);return <div key={t.id+String(d)} style={{background:c.surface,color:c.text,padding:16,borderRadius:10,border:`1px solid ${c.primary}`}}><strong>{t.name} · {d?"暗":"亮"}</strong><div style={{height:24,background:c.primary,marginTop:8}}/></div>}))}</div><p>间距示例 8 / 12 / 16 / 24px；以具体组件合同为准，尚未统一的值不当作全局Token。</p></div>;
}
