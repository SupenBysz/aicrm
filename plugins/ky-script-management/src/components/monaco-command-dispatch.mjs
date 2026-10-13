const commandIds = new Set([
  "undo",
  "redo",
  "editor.action.clipboardCutAction",
  "editor.action.clipboardCopyAction",
  "editor.action.clipboardPasteAction",
  "editor.action.selectAll"
]);

/**
 * 按 Monaco 的实际注册类型分发编辑命令：EditorAction 通过 getAction，
 * CommandsRegistry 命令通过 editor.trigger，避免把命令误当成 EditorAction。
 */
export function dispatchMonacoCommand(editor, id, notice) {
  const action = editor.getAction(id);
  if (action) {
    void action.run();
    return true;
  }
  if (commandIds.has(id)) {
    editor.trigger("ky.native", id, undefined);
    return true;
  }
  notice?.("error", `编辑器命令不可用：${id}`);
  return false;
}
