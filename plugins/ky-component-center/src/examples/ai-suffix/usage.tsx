import { BrandAISuffix } from "@ky/admin-core";
export default function Example({ label = "AI品牌后缀", showAI = true }: { label?: string; showAI?: boolean } = {}) {
return <div style={{fontSize:32,display:"flex",alignItems:"center"}}>{label}<BrandAISuffix visible={showAI} height="1em"/></div>;
}
