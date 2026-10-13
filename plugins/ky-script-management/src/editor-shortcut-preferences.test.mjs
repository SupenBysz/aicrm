import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultEditorShortcuts,
  displayEditorShortcut,
  editorShortcutActions,
  normalizeEditorShortcut,
  normalizeEditorShortcutPreferences,
  shortcutKeyCodeName,
  shortcutKeyFromEvent,
  shortcutPlatform,
  validateEditorShortcuts
} from "./editor-shortcut-preferences.ts";

test("查找快捷键按平台采用 VS Code 默认值并规范化显示", () => {
  assert.deepEqual(defaultEditorShortcuts("mac"), { completion: "", find: "Mod+F", replace: "Mod+Alt+F" });
  assert.deepEqual(defaultEditorShortcuts("other"), { completion: "", find: "Mod+F", replace: "Mod+H" });
  assert.equal(shortcutPlatform("MacIntel"), "mac");
  assert.equal(shortcutPlatform("Win32"), "other");
  assert.equal(displayEditorShortcut("Mod+Alt+F", "mac"), "⌘⌥F");
  assert.equal(displayEditorShortcut("Mod+H", "other"), "Ctrl+H");
});

test("自定义组合键与旧 shortcut 字段规范化并迁移为补全快捷键", () => {
  assert.equal(normalizeEditorShortcut("Ctrl + alt + f"), "Mod+Alt+F");
  assert.equal(shortcutKeyCodeName("Mod+Alt+F"), "KeyF");
  assert.equal(shortcutKeyCodeName("Mod+ArrowUp"), "UpArrow");
  assert.deepEqual(normalizeEditorShortcutPreferences({ enabled: true, shortcut: "Ctrl+Space" }, "other"), {
    completion: "Mod+Space", find: "Mod+F", replace: "Mod+H"
  });
  assert.deepEqual(normalizeEditorShortcutPreferences({ completionShortcut: "Mod+J", findShortcut: "", replaceShortcut: "" }, "mac"), {
    completion: "Mod+J", find: "", replace: ""
  });
  assert.equal(shortcutKeyFromEvent({ key: "f", code: "KeyF", ctrlKey: true, metaKey: false, shiftKey: false, altKey: true }), "Mod+Alt+F");
});

test("只允许查找使用 Mod+F，且三项快捷键不能重复", () => {
  assert.equal(validateEditorShortcuts({ completion: "Mod+J", find: "Mod+F", replace: "Mod+H" }), null);
  assert.match(validateEditorShortcuts({ completion: "Mod+F", find: "Mod+G", replace: "Mod+H" }) ?? "", /Mod\+F/);
  assert.match(validateEditorShortcuts({ completion: "Mod+J", find: "Ctrl+J", replace: "Mod+H" }) ?? "", /冲突/);
  assert.ok(validateEditorShortcuts({ completion: "Mod+J", find: "Mod+G", replace: "Mod+G" }));
});

test("清除快捷键后不注册拦截动作；只读编辑器不注册替换动作", () => {
  assert.deepEqual(editorShortcutActions({ completion: "", find: "", replace: "" }, "other", false), []);
  assert.deepEqual(editorShortcutActions({ completion: "Mod+K", find: "Mod+F", replace: "Mod+H" }, "other", true), [
    { command: "completion", shortcut: "Mod+K" },
    { command: "find", shortcut: "Mod+F" }
  ]);
});
