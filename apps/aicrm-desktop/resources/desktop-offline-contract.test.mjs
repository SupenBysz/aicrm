import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("./desktop-offline.html", import.meta.url), "utf8");

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((channel) => parseInt(channel, 16) / 255).map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2
  );
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("离线页可读且重试入口准确，明暗主题有显式回退色", () => {
  assert.match(html, /<main\s+role="status">/);
  assert.match(html, /网络不可用/);
  assert.match(html, /仅显示本地客户端状态/);
  assert.match(html, /视图\s*→\s*重试后台连接/);
  assert.doesNotMatch(html, /light-dark\(/);
  assert.match(html, /background:\s*#[0-9a-f]{3,8}/i);
  assert.match(html, /color:\s*#[0-9a-f]{3,8}/i);
  assert.match(html, /prefers-color-scheme:\s*dark/);
  assert.match(html, /body\s*\{[^}]*background:\s*#[0-9a-f]{3,8}[^}]*color:\s*#[0-9a-f]{3,8}/is);
  assert.match(html, /footer\s*\{[^}]*background:\s*#[0-9a-f]{3,8}[^}]*color:\s*#[0-9a-f]{3,8}/is);
  for (const [foreground, background] of [["#34281a", "#fff8ef"], ["#574631", "#fff8ef"], ["#f2f2f2", "#141414"], ["#d0d0d0", "#141414"]]) {
    assert.ok(contrastRatio(foreground, background) >= 4.5, `offline foreground/background contrast is below 4.5:1`);
  }
});
