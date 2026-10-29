import { useLayoutEffect, useRef, type ReactNode } from "react";
/** Optional brand suffix; never baked into uploaded or generated wordmark images. */
export function BrandAISuffix({ visible, height = "1em" }: { visible: boolean; height?: number | string }) {
  if (!visible) return null;
  return <span role="img" aria-label="AI" style={{display:"inline-flex",alignItems:"center",gap:"0.16em",flexShrink:0,marginLeft:"0.16em",fontSize:height,lineHeight:1}}>
    <span aria-hidden="true" style={{width:"0.09em",height:"0.09em",borderRadius:"50%",background:"currentColor"}} />
    <svg style={{width:"1.364em",height:"1em",flexShrink:0}}   viewBox="100 250 1050 770" aria-hidden="true"><g fill="currentColor"><path d="M486 274H657C677 274 690 286 696 306L881 973C885 986 877 994 864 994H725C714 994 707 987 704 976L568 473C567 467 563 466 560 472L308 978C302 989 295 994 282 994H131C118 994 112 984 118 972L462 291C467 280 475 274 486 274Z"/><path d="M465 826H624C632 826 635 830 631 838L552 979C547 989 540 994 529 994H367C361 994 359 990 362 984L443 840C448 831 455 826 465 826Z"/><path d="M910 274H1087C1100 274 1107 283 1102 295L1064 395C1060 406 1052 411 1040 411H959C947 411 940 406 935 395L896 295C891 283 898 274 910 274Z"/><path d="M956 435H1046C1055 435 1060 440 1062 449L1130 867C1131 873 1128 876 1124 880L1015 994C1011 999 1007 999 1002 994L884 878C880 874 878 871 879 865L940 449C941 440 947 435 956 435Z"/></g></svg>
  </span>;
}

/** Fit the complete brand lockup; both artwork and suffix share one height. */
export function BrandLogoLockup({ children, showAIIcon, maxHeight = 32, className }: {
  children: ReactNode; showAIIcon: boolean; maxHeight?: number; className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const resize = () => {
      const image = el.querySelector("img");
      if (!image?.naturalWidth || !image.naturalHeight) return;
      const ratio = image.naturalWidth / image.naturalHeight;
      const suffixRatio = showAIIcon ? 1.364 + .16 + .09 + .16 : 0;
      const height = Math.min(maxHeight, el.clientWidth / (ratio + suffixRatio));
      el.style.setProperty("--brand-lockup-height", `${height}px`);
      image.style.height = `${height}px`;
      image.style.width = `${height * ratio}px`;
      image.style.maxWidth = "none";
      image.style.flexShrink = "0";
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    el.addEventListener("load", resize, true);
    resize();
    return () => { observer.disconnect(); el.removeEventListener("load", resize, true); };
  }, [children, showAIIcon, maxHeight]);
  return <span ref={ref} className={className} style={{display:"inline-flex",alignItems:"center",width:"100%",minWidth:0,lineHeight:1}}>
    {children}<BrandAISuffix visible={showAIIcon} height="var(--brand-lockup-height,1em)" />
  </span>;
}
