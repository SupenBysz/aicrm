export function generatedBrandImage(name: string, kind: "icon" | "wordmark", dark = false) {
  const text = name.trim() || "KyCRM",
    canvas = document.createElement("canvas"),
    ctx = canvas.getContext("2d");
  if (!ctx) throw Error("无法生成品牌图标，请重试");
  const font = '"Hiragino Sans GB", "Heiti SC", "Microsoft YaHei", sans-serif';
  let size = kind === "icon" ? 96 : 160;
  ctx.font = `700 ${size}px ${font}`;
  if (kind === "icon") {
    while (ctx.measureText(text).width > 208 && size > 10) {
      size -= 2;
      ctx.font = `700 ${size}px ${font}`;
    }
  }
  if (kind === "wordmark") {
    while (ctx.measureText(text).width > 4064 && size > 10) {
      size -= 2;
      ctx.font = `700 ${size}px ${font}`;
    }
  }
  canvas.width =
    kind === "icon"
      ? 256
      : Math.min(4096, Math.ceil(ctx.measureText(text).width + 32));
  canvas.height = kind === "icon" ? 256 : 184;
  if (kind === "icon") {
    ctx.fillStyle = "#fffaf3";
    ctx.beginPath();
    ctx.roundRect(0, 0, 256, 256, 40);
    ctx.fill();
  }
  ctx.fillStyle = kind === "wordmark" && dark ? "#ffffff" : "#322718";
  ctx.font = `700 ${size}px ${font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.transform(1, 0, Math.tan((-5 * Math.PI) / 180), 1, 0, 0);
  ctx.fillText(text, 0, 0);
  return canvas.toDataURL("image/png");
}

