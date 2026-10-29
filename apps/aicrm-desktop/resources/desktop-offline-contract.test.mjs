import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("./desktop-offline.html", import.meta.url), "utf8");

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
});
