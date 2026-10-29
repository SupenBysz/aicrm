import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("./brand-presentation.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { formatCopyright } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
test("styles and explicit year boundary", () => {
  const instant = new Date("2026-12-31T23:30:00Z");
  assert.equal(formatCopyright(" Example ", "standard", instant, "UTC"), "© 2026 Example");
  assert.equal(formatCopyright("Example", "full", instant, "Asia/Shanghai"), "Copyright © 2027 Example. All rights reserved.");
  assert.equal(formatCopyright("Example", "chinese", instant, "UTC"), "© 2026 Example 版权所有");
  assert.equal(formatCopyright("   ", "full", instant), "");
});
