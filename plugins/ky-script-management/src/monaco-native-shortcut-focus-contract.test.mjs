import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceDir = fileURLToPath(new URL(".", import.meta.url));
const editorSource = await readFile(resolve(sourceDir, "components/monaco-source-editor.tsx"), "utf8");
const monacoDir = resolve(sourceDir, "../node_modules/monaco-editor/esm/vs/editor");
const findWidget = await readFile(resolve(monacoDir, "contrib/find/browser/findWidget.js"), "utf8");
const codeEditorWidget = await readFile(resolve(monacoDir, "browser/widget/codeEditor/codeEditorWidget.js"), "utf8");
const standaloneCodeEditor = await readFile(resolve(monacoDir, "standalone/browser/standaloneCodeEditor.js"), "utf8");

test("Find 和 Replace 获得焦点时，编辑器原生快捷键不接管粘贴等按键", () => {
  const nativeActionIds = [
    "ky.native.undo",
    "ky.native.redo",
    "ky.native.cut",
    "ky.native.copy",
    "ky.native.paste",
    "ky.native.selectAll"
  ];

  for (const id of nativeActionIds) {
    const actionStart = editorSource.indexOf(`id: "${id}"`);
    assert.notEqual(actionStart, -1, `${id} remains registered`);
    const actionEnd = editorSource.indexOf("}),", actionStart);
    assert.notEqual(actionEnd, -1, `${id} action descriptor is complete`);
    const descriptor = editorSource.slice(actionStart, actionEnd);
    assert.match(descriptor, /keybindingContext: "editorTextFocus"/, `${id} only handles keys while editor text has focus`);
  }

  assert.match(findWidget, /CONTEXT_FIND_INPUT_FOCUSED\.bindTo\(contextKeyService\)/);
  assert.match(findWidget, /CONTEXT_REPLACE_INPUT_FOCUSED\.bindTo\(contextKeyService\)/);
  assert.match(findWidget, /this\._findInputFocused\.set\(true\)/);
  assert.match(findWidget, /this\._replaceInputFocused\.set\(true\)/);
  assert.match(codeEditorWidget, /this\._editor\.onDidBlurEditorText\(\(\) => this\._updateFromFocus\(\)\)/);
  assert.match(codeEditorWidget, /this\._editorTextFocus\.set\(this\._editor\.hasTextFocus\(\) && !this\._editor\.isSimpleWidget\)/);
  assert.match(standaloneCodeEditor, /ContextKeyExpr\.deserialize\(_descriptor\.keybindingContext\)/);
});

test("收窄键盘上下文不隐藏原生编辑器右键菜单动作", () => {
  for (const id of ["ky.native.undo", "ky.native.redo", "ky.native.cut", "ky.native.copy", "ky.native.paste", "ky.native.selectAll"]) {
    const actionStart = editorSource.indexOf(`id: "${id}"`);
    const actionEnd = editorSource.indexOf("}),", actionStart);
    const descriptor = editorSource.slice(actionStart, actionEnd);
    assert.match(descriptor, /contextMenuGroupId: "1_modification"/);
  }
});
