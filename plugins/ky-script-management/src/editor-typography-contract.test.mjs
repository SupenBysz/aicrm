import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("源码编辑器保持字体、行高、行号与内边距", async () => {
  const editor = await readFile(new URL("./components/monaco-source-editor.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../../apps/ky-admin-host/src/styles.css", import.meta.url), "utf8");

  assert.match(editor, /lineNumbers:\s*"on"/);
  assert.match(editor, /fontFamily:\s*"ui-monospace, SFMono-Regular, Menlo, monospace"/);
  assert.match(editor, /fontSize:\s*13/);
  assert.match(editor, /lineHeight:\s*22/);
  assert.match(editor, /padding:\s*\{ top: 8, bottom: 8 \}/);
  assert.match(styles, /\.monaco-source-editor-root/);
  assert.match(styles, /\.monaco-source-editor \.monaco-editor/);
});
