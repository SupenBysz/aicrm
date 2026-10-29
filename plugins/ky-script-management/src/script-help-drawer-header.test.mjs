import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./pages/script-management-page.tsx", import.meta.url), "utf8");

test("脚本帮助标题保持纯文本，全屏控件位于 Drawer extra", () => {
  assert.match(source, /const helpTitle\s*=\s*"脚本编写帮助"\s*;/);
  const drawerStart = source.indexOf('<Drawer className={`script-writing-help-drawer');
  const drawerEnd = source.indexOf("</Drawer>", drawerStart);
  assert.ok(drawerStart >= 0 && drawerEnd > drawerStart, "脚本帮助 Drawer 未找到");
  const drawer = source.slice(drawerStart, drawerEnd);
  assert.match(drawer, /title=\{helpTitle\}/);
  assert.match(drawer, /extra=\{<Tooltip title=\{helpFullscreen\?"退出全屏":"全屏显示"\}\><Button[\s\S]*?aria-label=\{helpFullscreen\?"退出全屏":"全屏显示"\}[\s\S]*?onClick=\{\(\)=>setHelpFullscreen\(current=>!current\)\}/);
  assert.doesNotMatch(source, /const helpTitle\s*=\s*<div className="script-writing-help-title"/);
});
