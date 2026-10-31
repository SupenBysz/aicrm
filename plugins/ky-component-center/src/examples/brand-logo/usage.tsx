import { BrandLogo } from "@ky/admin-core";
export default function Example({ showAI = true }: { showAI?: boolean } = {}) {
const artwork="data:image/svg+xml,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><text x="2" y="46" font-family="sans-serif" font-size="48" font-weight="700" fill="#888">Ky Demo</text></svg>');
return <div style={{paddingInline:16,width:"100%",maxWidth:300,boxSizing:"border-box",border:"1px dashed var(--admin-stroke)"}}><BrandLogo brand={{name:"虚构品牌示例",wordmark:{url:artwork},showAiIcon:showAI}} dark={false} maxHeight={40} compactInset={6}/></div>;
}
