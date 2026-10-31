import { BrandLogo, BrandIcon, BrandNavigationPreview } from "@ky/admin-core";
export default function Example({ showAI = true }: { showAI?: boolean } = {}) {
 const art=(dark:boolean)=>"data:image/svg+xml,"+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><text x="2" y="46" font-family="sans-serif" font-size="48" font-weight="700" fill="${dark?'white':'#20324e'}">Ky Demo</text></svg>`);
 const icon="data:image/svg+xml,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="12" fill="#2563c4"/><text x="12" y="54" font-family="sans-serif" font-size="40" fill="white">Ky</text></svg>');
 const brand={name:"虚构品牌示例",icon:{url:icon},iconDark:{url:icon},wordmark:{url:art(false)},wordmarkDark:{url:art(true)},showAiIcon:showAI};
 return <BrandNavigationPreview themeId="business-blue" renderLogo={(dark,collapsed)=>collapsed?<BrandIcon brand={brand} dark={dark}/>:<BrandLogo brand={brand} dark={dark} maxHeight={40}/>}/>;
}
