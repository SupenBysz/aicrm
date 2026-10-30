import { useLayoutEffect, useRef, type ReactNode } from "react";
/** Optional brand suffix; never baked into uploaded or generated wordmark images. */
export function BrandAISuffix({ visible, height = "1em" }: { visible: boolean; height?: number | string }) {
  if (!visible) return null;
  return <span role="img" aria-label="AI" style={{color:"var(--admin-accent, currentColor)",display:"inline-flex",alignItems:"center",gap:"0.16em",flexShrink:0,marginLeft:"0.16em",fontSize:height,lineHeight:1,transform:"translateY(var(--brand-ink-offset,0px))"}}>
    <span aria-hidden="true" style={{width:"0.20em",height:"0.20em",borderRadius:"50%",background:"currentColor"}} />
    <svg style={{width:"1.407em",height:"1em",flexShrink:0}}   viewBox="112 274 1020 725" aria-hidden="true"><g fill="currentColor"><path d="M486 274H657C677 274 690 286 696 306L881 973C885 986 877 994 864 994H725C714 994 707 987 704 976L568 473C567 467 563 466 560 472L308 978C302 989 295 994 282 994H131C118 994 112 984 118 972L462 291C467 280 475 274 486 274Z"/><path d="M465 826H624C632 826 635 830 631 838L552 979C547 989 540 994 529 994H367C361 994 359 990 362 984L443 840C448 831 455 826 465 826Z"/><path d="M910 274H1087C1100 274 1107 283 1102 295L1064 395C1060 406 1052 411 1040 411H959C947 411 940 406 935 395L896 295C891 283 898 274 910 274Z"/><path d="M956 435H1046C1055 435 1060 440 1062 449L1130 867C1131 873 1128 876 1124 880L1015 994C1011 999 1007 999 1002 994L884 878C880 874 878 871 879 865L940 449C941 440 947 435 956 435Z"/></g></svg>
  </span>;
}

// Cache per image/source so resizing does not repeatedly scan transparent pixels.
const inkCache = new WeakMap<HTMLImageElement, { src: string; fraction: number; offset: number }>();
function imageInk(image: HTMLImageElement) {
  const cached = inkCache.get(image);
  if (cached?.src === image.currentSrc) return cached;
  let fraction = 1, offset = 0;
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let top = canvas.height, bottom = -1;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (pixels[(y * canvas.width + x) * 4 + 3] > 8) {
            top = Math.min(top, y); bottom = y; break;
          }
        }
      }
      if (bottom >= top) {
        fraction = (bottom - top + 1) / canvas.height;
        offset = (top + bottom + 1) / (2 * canvas.height) - .5;
      }
    }
  } catch { /* Cross-origin artwork keeps its safe intrinsic box fallback. */ }
  const metrics = { src: image.currentSrc, fraction, offset };
  inkCache.set(image, metrics);
  return metrics;
}

/** Fit the lockup by visible artwork, excluding transparent wordmark padding. */
export function BrandLogoLockup({ children, showAIIcon, maxHeight = 32, compactInset = 0, className, fitText = false }: {
  children: ReactNode; showAIIcon: boolean; maxHeight?: number; compactInset?: number; className?: string; fitText?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const resize = () => {
      const image = el.querySelector("img");
      if (!image) {
        // CSS font-size is an em box, not the visible glyph height.
        const nodes = Array.from(el.childNodes).filter(node => !(node instanceof HTMLElement && node.getAttribute("aria-label") === "AI"));
        const text = nodes.map(node => node.textContent ?? "").join("");
        const source = nodes.find(node => node instanceof HTMLElement) as HTMLElement | undefined;
        const style = getComputedStyle(source ?? el);
        const context = document.createElement("canvas").getContext("2d");
        if (!context || !text.trim()) return;
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        let metrics = context.measureText(text);
        if (fitText && !source && el.clientWidth > 0) {
          const suffixWidth = showAIIcon ? (1.407 + .20 + .16 + .16) * .92 * (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) : 0;
          const width = metrics.width + suffixWidth;
          if (width > 0) {
            const size = parseFloat(style.fontSize) * Math.max(1, el.clientWidth - 2) / width;
            el.style.fontSize = `${size}px`;
            context.font = `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`;
            metrics = context.measureText(text);
          }
        }
        const inkHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
        if (!Number.isFinite(inkHeight) || inkHeight <= 0) return;
        const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
        const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
        const offset = (ascent - descent - metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) / 2;
        el.style.setProperty("--brand-lockup-height", `${inkHeight}px`);
        el.style.setProperty("--brand-ink-offset", `${offset}px`);
        return;
      }
      if (!image.naturalWidth || !image.naturalHeight) return;
      const ratio = image.naturalWidth / image.naturalHeight;
      const ink = imageInk(image);
      const suffixRatio = showAIIcon ? (1.407 + .20 + .16 + .16) * .92 * ink.fraction : 0;
      const height = Math.min(maxHeight, el.clientWidth / (ratio + suffixRatio));
      el.style.setProperty("--brand-lockup-height", `${height * ink.fraction}px`);
      el.style.setProperty("--brand-ink-offset", `${height * ink.offset}px`);
      // Keep compact logos left aligned; width-limited lockups fill the brand
      // area and center within its symmetric insets, including subpixel slack.
      const totalWidth = height * (ratio + suffixRatio);
      const centered = totalWidth >= el.clientWidth - compactInset - 1;
      el.style.justifyContent = centered ? "center" : "flex-start";
      el.style.transform = centered ? "none" : `translateX(${compactInset}px)`;
      image.style.height = `${height}px`;
      image.style.width = `${height * ratio}px`;
      image.style.maxWidth = "none";
      image.style.flexShrink = "0";
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    el.addEventListener("load", resize, true);
    let active = true;
    const fontResize = () => { if (active) resize(); };
    document.fonts?.addEventListener("loadingdone", fontResize);
    void document.fonts?.ready.then(fontResize);
    resize();
    return () => { active = false; observer.disconnect(); el.removeEventListener("load", resize, true); document.fonts?.removeEventListener("loadingdone", fontResize); };
  }, [children, showAIIcon, maxHeight, compactInset, fitText]);
  return <span ref={ref} className={className} style={{display:"inline-flex",alignItems:"center",width:"100%",minWidth:0,lineHeight:1,transform:`translateX(${compactInset}px)`}}>
    {children}<BrandAISuffix visible={showAIIcon} height="calc(var(--brand-lockup-height,1em) * .92)" />
  </span>;
}
