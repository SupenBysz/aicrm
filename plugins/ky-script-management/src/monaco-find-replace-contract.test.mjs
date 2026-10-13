import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const editor = await readFile(resolve(root, "components/monaco-source-editor.tsx"), "utf8");
const page = await readFile(resolve(root, "pages/script-management-page.tsx"), "utf8");
const preferences = await readFile(resolve(root, "editor-shortcut-preferences.ts"), "utf8");

assert.match(editor, /ensureNativeFindContribution\(\)/);
assert.match(editor, /rule\.id === "actions\.find" \|\| rule\.id === "editor\.action\.startFindReplaceAction"/);
assert.match(editor, /kyNativeFindShortcutManagedByHost/, "native defaults must be gated before user shortcuts are installed");
assert.match(editor, /registerNativeFindCommands\(\)/);
assert.match(editor, /addAction\(\{[\s\S]*?keybindingContext: "editorTextFocus"/);
assert.match(editor, /invokeNativeFind\(editor, editableRef\.current, false\)/);
assert.match(editor, /invokeNativeFind\(editor, editableRef\.current, true\)/);
assert.match(editor, /if \(replace && !editable\) return false/);
assert.match(editor, /selectedText\(editor\) \|\| word/);
assert.match(editor, /shortcutDisposablesRef\.current\.forEach\(disposable => disposable\.dispose\(\)\)/);

test("查找快捷键与所有源码编辑入口接线一致", () => {
  assert.match(page, /<PublicScriptsPanel[\s\S]*?shortcuts=\{editorPrefsShortcuts\(editorPrefs\.script\)\}/);
  assert.match(page, /<PublicStylesPanel[\s\S]*?shortcuts=\{editorPrefsShortcuts\(editorPrefs\.style\)\}/);
  assert.match(page, /shortcuts=\{editorPrefsShortcuts\(editorPrefs\[type\]\)\}/);
  assert.match(page, /shortcuts=\{editorPrefsShortcuts\(editorPrefs\[previewAsset\.assetType\]\)\}/);
  assert.match(page, /findShortcut/);
  assert.match(page, /replaceShortcut/);
  assert.match(page, /查找并替换/);
  assert.match(page, /open=\{previewOpen\}[\s\S]*?keyboard=\{false\}/, "read-only preview drawer must not close when Escape dismisses Monaco find");
  assert.match(preferences, /stored\.completionShortcut \?\? stored\.shortcut/);
  assert.match(preferences, /shortcuts\.completion === "Mod\+F" \|\| shortcuts\.replace === "Mod\+F"/);
});
