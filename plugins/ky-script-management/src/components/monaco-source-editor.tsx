import { themeColors } from "@ky/admin-core";
import { useEffect, useRef, useState } from "react";
import * as monaco from "../../node_modules/monaco-editor/esm/vs/editor/editor.api.js";
import { dispatchMonacoCommand } from "./monaco-command-dispatch.mjs";
import { defaultEditorShortcuts, editorShortcutActions, shortcutKeyCodeName, shortcutPlatform, type EditorShortcutPreferences } from "../editor-shortcut-preferences";
// editor.api 只提供编辑器 API，不会自动注册右键菜单贡献；显式引入后才会安装 ContextMenuController。
import "../../node_modules/monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js";
// editor.api 不会自动注册独立编辑器的命令面板动作；显式加载 quickCommand 才能让 F1 和命令面板动作可用。
import "../../node_modules/monaco-editor/esm/vs/features/quickCommand/register.js";
// 原生菜单项的图标通过 command.icon 传入 ThemeIcon/Codicon。
// @ts-ignore Monaco 内部 Codicon 没有对外暴露 TypeScript 声明。
import { Codicon } from "../../node_modules/monaco-editor/esm/vs/base/common/codicons.js";
// Monaco 的原生 EditorContext 菜单注册接口没有在 editor.api 导出，按 package-format 直接复用原生注册入口。
// @ts-ignore Monaco internal menu declarations are not shipped with the browser API typings.
import { MenuId, MenuRegistry } from "../../node_modules/monaco-editor/esm/vs/platform/actions/common/actions.js";
// @ts-ignore Monaco internal command declarations are not shipped with the browser API typings.
import { CommandsRegistry } from "../../node_modules/monaco-editor/esm/vs/platform/commands/common/commands.js";
// @ts-ignore Monaco internal keybinding declarations are not shipped with the browser API typings.
import { KeybindingsRegistry } from "../../node_modules/monaco-editor/esm/vs/platform/keybinding/common/keybindingsRegistry.js";
// @ts-ignore Monaco internal context declarations are not shipped with the browser API typings.
import { ContextKeyExpr } from "../../node_modules/monaco-editor/esm/vs/platform/contextkey/common/contextkey.js";
import { canInsertBusinessScriptTemplate, createBusinessScriptInitTemplate, planBusinessScriptTemplateInsertion } from "../business-script-init-template";
// Vite transforms these imports into worker chunks. The package intentionally
// exposes the runtime files without TypeScript declarations for the `?worker`
// suffix, so the declarations are supplied in the plugin shim.
// @ts-ignore Vite virtual worker module
import editorWorker from "../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
// @ts-ignore Vite virtual worker module
import tsWorker from "../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js?worker";
// @ts-ignore Vite resolves package CSS assets at build time
import "../../node_modules/monaco-editor/min/vs/editor/editor.main.css";
// @ts-ignore Monaco contribution exposes runtime language-service exports without package declarations.
import { javascriptDefaults, ModuleKind, ModuleResolutionKind, ScriptTarget } from "../../node_modules/monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import "../../node_modules/monaco-editor/esm/vs/language/css/monaco.contribution.js";

export type MonacoCompletionItem = {
  label: string;
  description: string;
  insertText?: string;
  scope?: string;
};

type MonacoSourceEditorProps = {
  value: string;
  onChange: (value: string) => void;
  language: "JavaScript" | "CSS";
  version?: string | null;
  scriptName?: string | null;
  editable?: boolean;
  completionItems?: MonacoCompletionItem[];
  onOpenHelp?: () => void;
  onOpenScriptProperties?: () => void;
  onOpenStyleProperties?: () => void;
  businessScriptId?: string | null;
  onFormat?: (source: string) => string;
  notice?: (type: "warning" | "error", text: string) => void;
  contextSnippets?: Array<{ id: string; label: string; description?: string; insertText: string }>;
  shortcuts?: EditorShortcutPreferences;
};

type MonacoEnvironmentWithWorker = typeof globalThis & {
  MonacoEnvironment?: { getWorker: (_moduleId: string, label: string) => Worker };
};

const environment = globalThis as MonacoEnvironmentWithWorker;
if (!environment.MonacoEnvironment) {
  environment.MonacoEnvironment = {
    getWorker: (_moduleId, label) => label === "typescript" || label === "javascript" ? new tsWorker() : new editorWorker()
  };
}

const languageId = (language: MonacoSourceEditorProps["language"]) => language === "CSS" ? "css" : "javascript";

const KWW_EDITOR_THEME = "kww-script-editor";
let languageSupportReady = false;
const KWW_LIFECYCLE_SUBMENU = new MenuId("KWW_LIFECYCLE_SUBMENU");
const KWW_NETWORK_SUBMENU = new MenuId("KWW_NETWORK_SUBMENU");
let nativeSubmenuRegistered = false;
let nativeMenuFilterRegistered = false;
let nativeFindContribution: Promise<void> | null = null;
let nativeFindCommandsRegistered = false;
let nativeActiveEditor: { editor: monaco.editor.IStandaloneCodeEditor; snippets: Array<{ id: string; label: string; description?: string; insertText: string }>; editable: boolean; businessScriptId: string | null; language: "JavaScript" | "CSS"; openCompletion: () => void } | null = null;

function invokeNativeFind(editor: monaco.editor.IStandaloneCodeEditor, editable: boolean, replace: boolean): boolean {
  if (replace && !editable) return false;
  const action = editor.getAction("editor.actions.findWithArgs");
  const model = editor.getModel();
  if (!action || !model) return false;
  const position = editor.getPosition();
  const word = position ? model.getWordAtPosition(position)?.word ?? "" : "";
  const searchString = selectedText(editor) || word;
  void action.run({ searchString, ...(replace ? { replaceString: "" } : {}) }).catch(() => undefined);
  return true;
}

function registerNativeFindCommands() {
  if (nativeFindCommandsRegistered) return;
  nativeFindCommandsRegistered = true;
  const addCommand = (id: string, title: string, order: number, run: (current: NonNullable<typeof nativeActiveEditor>) => void, when: unknown = ContextKeyExpr.has("editorIsOpen")) => {
    CommandsRegistry.registerCommand(id, () => {
      const current = nativeActiveEditor;
      if (current && !current.editor.getModel()?.isDisposed()) run(current);
    });
    MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
      command: { id, title },
      when,
      group: "navigation",
      order
    });
  };
  addCommand("ky.script-management.find", "查找", 1, current => { invokeNativeFind(current.editor, current.editable, false); });
  addCommand("ky.script-management.find-replace", "查找并替换", 2, current => { invokeNativeFind(current.editor, current.editable, true); }, ContextKeyExpr.and(ContextKeyExpr.has("editorIsOpen"), ContextKeyExpr.not("editorReadonly")));
  addCommand("ky.script-management.completion", "唤出补全候选", 3, current => { if (current.editable) current.openCompletion(); });
}

function ensureNativeFindContribution(): Promise<void> {
  if (nativeFindContribution) return nativeFindContribution;
  const registry = KeybindingsRegistry as unknown as {
    registerKeybindingRule: (rule: { id: string; when?: unknown; [key: string]: unknown }) => unknown;
  };
  const originalRegister = registry.registerKeybindingRule;
  registry.registerKeybindingRule = function(rule) {
    if (rule.id === "actions.find" || rule.id === "editor.action.startFindReplaceAction") {
      return originalRegister.call(this, {
        ...rule,
        // Monaco's standalone defaults use editorIsOpen and can steal Mod+F/Mod+H
        // from unrelated inputs. All editor find shortcuts are installed below
        // with the narrower editorTextFocus context instead.
        when: ContextKeyExpr.and(rule.when, ContextKeyExpr.has("kyNativeFindShortcutManagedByHost"))
      });
    }
    return originalRegister.call(this, rule);
  };
  // @ts-ignore Monaco ships this contribution without standalone declaration files.
  nativeFindContribution = import("../../node_modules/monaco-editor/esm/vs/editor/contrib/find/browser/findController.js")
    .then(() => { registerNativeFindCommands(); })
    .finally(() => { registry.registerKeybindingRule = originalRegister; });
  return nativeFindContribution;
}

function registerNativeMenuFilter() {
  if (nativeMenuFilterRegistered) return;
  nativeMenuFilterRegistered = true;
  const originalGetMenuItems = MenuRegistry.getMenuItems.bind(MenuRegistry);
  const allowedCommandIds = new Set([
    "ky.native.undo", "ky.native.redo", "ky.native.cut", "ky.native.copy", "ky.native.paste", "ky.native.selectAll",
    "ky.native.commandPalette", "ky.script.help", "ky.script.initializationTemplate", "ky.script.properties", "ky.style.properties", "ky.script.format"
  ]);
  const nativeMenuIcons = new Map([
    ["ky.native.undo", Codicon.history],
    ["ky.native.redo", Codicon.redo],
    ["ky.native.cut", Codicon.screenCut],
    ["ky.native.copy", Codicon.copy],
    ["ky.native.paste", Codicon.insert],
    ["ky.native.selectAll", Codicon.selection]
  ]);
  const allowedSubmenus = new Set([KWW_LIFECYCLE_SUBMENU, KWW_NETWORK_SUBMENU]);
  (MenuRegistry as unknown as { getMenuItems: (menuId: unknown) => unknown[] }).getMenuItems = (menuId: unknown) => {
    const items = originalGetMenuItems(menuId as typeof MenuId.EditorContext);
    if (menuId !== MenuId.EditorContext) return items;
    const filtered = items.filter((item: any) => {
      const commandId = item?.command?.id;
      const isAllowedCommand = typeof commandId === "string" && [...allowedCommandIds].some(id => commandId === id || commandId.endsWith(`:${id}`) || commandId.endsWith(`/${id}`));
      const isInitializationTemplate = typeof commandId === "string" && (commandId === "ky.script.initializationTemplate" || commandId.endsWith(":ky.script.initializationTemplate") || commandId.endsWith("/ky.script.initializationTemplate"));
      const activeEditor = nativeActiveEditor;
      const mayInsertTemplate = Boolean(activeEditor && canInsertBusinessScriptTemplate({
        language: activeEditor.language,
        editable: activeEditor.editable,
        scriptId: activeEditor.businessScriptId
      }) && activeEditor.editor.getModel()?.getLanguageId() === "javascript");
      if (isInitializationTemplate && !mayInsertTemplate) return false;
      return isAllowedCommand || allowedSubmenus.has(item?.submenu);
    });
    const withIcons = filtered.map((item: any) => {
      const commandId = item?.command?.id;
      const iconEntry = typeof commandId === "string"
        ? [...nativeMenuIcons].find(([id]) => commandId === id || commandId.endsWith(`:${id}`) || commandId.endsWith(`/${id}`))
        : undefined;
      return iconEntry ? { ...item, command: { ...item.command, icon: iconEntry[1] } } : item;
    });
    const groupRank = new Map([["1_modification", 1], ["2_kww", 2], ["9_kww", 3]]);
    const sorted = withIcons.sort((left: any, right: any) => {
      const leftGroup = groupRank.get(left?.group) ?? 99;
      const rightGroup = groupRank.get(right?.group) ?? 99;
      return leftGroup - rightGroup || Number(left?.order ?? 0) - Number(right?.order ?? 0);
    });
    return sorted;
  };
}

function registerNativeSubmenu(snippets: Array<{ id: string; label: string; description?: string; insertText: string }>) {
  if (nativeSubmenuRegistered) return;
  nativeSubmenuRegistered = true;
  MenuRegistry.appendMenuItem(MenuId.EditorContext, { submenu: KWW_LIFECYCLE_SUBMENU, title: "插入生命周期", group: "2_kww", order: 3 });
  MenuRegistry.appendMenuItem(MenuId.EditorContext, { submenu: KWW_NETWORK_SUBMENU, title: "网络事件", group: "2_kww", order: 4 });
  snippets.forEach(snippet => {
    const kind = ["documentStart", "domReady", "pageLoad", "routeChange", "userAction"].includes(snippet.id) ? "lifecycle" : "network";
    const submenu = kind === "lifecycle" ? KWW_LIFECYCLE_SUBMENU : KWW_NETWORK_SUBMENU;
    const commandId = `ky.script.native.${kind}.${snippet.id}`;
    CommandsRegistry.registerCommand(commandId, () => {
      const current = nativeActiveEditor;
      const selected = current?.snippets.find(item => item.id === snippet.id);
      const selection = current?.editor.getSelection();
      if (!current || !selected || !selection) return;
      current.editor.executeEdits("ky-native-context-snippet", [{ range: selection, text: selected.insertText }]);
      current.editor.focus();
    });
    const tooltip = snippet.description ? `${snippet.label}：${snippet.description}` : snippet.label;
    MenuRegistry.appendMenuItem(submenu, { command: { id: commandId, title: snippet.label, tooltip }, group: "navigation", order: 1 });
  });
}

function updateEditorTheme() {
 const dark=document.documentElement.dataset.adminTheme==="dark";
 const c=themeColors(document.documentElement.dataset.adminPalette??"classic-gold",dark);
 monaco.editor.defineTheme(KWW_EDITOR_THEME,{base:dark?"vs-dark":"vs",inherit:true,
 rules:[{token:"comment",foreground:dark?"9cafb7":"64748b",fontStyle:"italic"}],
 colors:{"editor.background":c.surface,"editor.foreground":c.text,"editorLineNumber.foreground":dark?"#9cafb7":"#687789","editorLineNumber.activeForeground":c.primary,"editorCursor.foreground":c.primary,"editor.selectionBackground":c.primary+"44"}});
 monaco.editor.setTheme(KWW_EDITOR_THEME);
}

function ensureLanguageSupport() {
  if (languageSupportReady) return;
  const registeredLanguages = new Set(monaco.languages.getLanguages().map(language => language.id));
  if (!registeredLanguages.has("javascript")) {
    monaco.languages.register({ id: "javascript", extensions: [".js", ".jsx", ".mjs", ".cjs"], aliases: ["JavaScript", "javascript"] });
  }
  if (!registeredLanguages.has("css")) {
    monaco.languages.register({ id: "css", extensions: [".css"], aliases: ["CSS", "css"] });
  }
  // Monaco 的语言贡献负责 tokenization；这里显式打开 JavaScript 语言服务的
  // 文档同步和常用 ECMAScript 目标，避免仅加载 editor.api 时退化成纯文本。
  javascriptDefaults.setEagerModelSync(true);
  javascriptDefaults.setCompilerOptions({
    allowJs: true,
    allowNonTsExtensions: true,
    target: ScriptTarget.ESNext,
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.NodeJs,
    checkJs: false
  });
  updateEditorTheme();

  // 语言服务加载前先提供轻量词法兜底，保证首屏就有稳定的语法着色。
  monaco.languages.setMonarchTokensProvider("javascript", {
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@comment" }],
        [/["'`]/, { token: "string.quote", next: "@string" }],
        [/\b(?:const|let|var|function|return|if|else|for|of|in|while|try|catch|throw|new|class|extends|async|await|import|export|from|true|false|null|undefined|typeof|instanceof)\b/, "keyword"],
        [/[A-Za-z_$][\w$]*(?=\s*\()/, "function"],
        [/[A-Za-z_$][\w$]*/, "identifier"],
        [/\b\d+(?:\.\d+)?\b/, "number"],
        [/\./, { token: "delimiter", next: "@member" }],
        [/[{}()[\],;:]/, "delimiter"],
        [/[=+\-*\/!<>?&|]+/, "operator"]
      ],
      comment: [[/[^*]+/, "comment"], [/\*\//, { token: "comment", next: "@pop" }], [/\*/, "comment"]],
      string: [[/[^\\"'`]+/, "string"], [/\\./, "string.escape"], [/['"`]/, { token: "string.quote", next: "@pop" }]],
      member: [[/[A-Za-z_$][\w$]*(?=\s*\()/, "function"], [/[A-Za-z_$][\w$]*/, "type"], [/\./, "delimiter"], [/./, { token: "", next: "@pop" }]]
    }
  });
  monaco.languages.setMonarchTokensProvider("css", {
    tokenizer: {
      root: [
        [/\/\*/, { token: "comment", next: "@comment" }],
        [/[.#]?[A-Za-z_-][\w-]*/, "tag"],
        [/[A-Za-z-]+(?=\s*:)/, "attribute.name"],
        [/[.#]?[A-Za-z_-][\w-]*(?=\s*[{,>+~])/, "type"],
        [/[{}:;]/, "delimiter"],
        [/#[0-9a-fA-F]{3,8}\b/, "number"],
        [/\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms)?\b/, "number"],
        [/#[0-9a-fA-F]{3,8}\b/, "number"],
        [/["']/, { token: "string.quote", next: "@string" }]
      ],
      comment: [[/[^*]+/, "comment"], [/\*\//, { token: "comment", next: "@pop" }], [/\*/, "comment"]],
      string: [[/[^\\"']+/, "string"], [/\\./, "string.escape"], [/['"]/, { token: "string.quote", next: "@pop" }]]
    }
  });
  languageSupportReady = true;
}

function completionSnippet(source: string): string {
  return source || "";
}

function expandCompletionSnippet(source: string): { text: string; placeholders: Array<{ index: number; start: number; end: number }> } {
  let text = "";
  const placeholders: Array<{ index: number; start: number; end: number }> = [];
  const pattern = /\$\{(\d+)(?::([^}]*))?\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    text += source.slice(lastIndex, match.index);
    const value = match[2] ?? "";
    const start = text.length;
    text += value;
    placeholders.push({ index: Number(match[1]), start, end: text.length });
    lastIndex = match.index + match[0].length;
  }
  text += source.slice(lastIndex);
  return { text, placeholders };
}

function selectedText(editor: monaco.editor.IStandaloneCodeEditor): string {
  const model = editor.getModel();
  const selection = editor.getSelection();
  return model && selection ? model.getValueInRange(selection) : "";
}

export function MonacoSourceEditor({ value, onChange, language, version, scriptName, editable = true, completionItems = [], onOpenHelp, onOpenScriptProperties, onOpenStyleProperties, businessScriptId, onFormat, notice, contextSnippets = [], shortcuts }: MonacoSourceEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const completionRef = useRef<monaco.IDisposable | null>(null);
  const shortcutDisposablesRef = useRef<monaco.IDisposable[]>([]);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const completionItemsRef = useRef(completionItems);
  const editableRef = useRef(editable);
  const businessScriptIdRef = useRef<string | null>(businessScriptId ?? null);
  const openCompletionRef = useRef<() => void>(() => undefined);
  const [stats, setStats] = useState({ line: 1, column: 1, characters: 0, lines: 0 });
  const [editorMountVersion, setEditorMountVersion] = useState(0);
  const [inlineSuggestions, setInlineSuggestions] = useState<{ items: MonacoCompletionItem[]; top: number; left: number; prefix: string; index: number } | null>(null);
  const inlineSuggestionsRef = useRef(inlineSuggestions);
  inlineSuggestionsRef.current = inlineSuggestions;

  valueRef.current = value;
  onChangeRef.current = onChange;
  completionItemsRef.current = completionItems;
  editableRef.current = editable;
  businessScriptIdRef.current = businessScriptId ?? null;

 useEffect(()=>{const observer=new MutationObserver(updateEditorTheme);observer.observe(document.documentElement,{attributes:true,attributeFilter:["data-admin-theme","data-admin-palette"]});updateEditorTheme();return()=>observer.disconnect()},[]);

  useEffect(() => {
    let cancelled = false;
    let disposeEditor: (() => void) | undefined;
    void ensureNativeFindContribution().then(() => {
      if (cancelled || !hostRef.current) return;
      const createEditor = () => {
    ensureLanguageSupport();
    const model = monaco.editor.createModel(value, languageId(language));
    const editor = monaco.editor.create(hostRef.current!, {
      model,
      automaticLayout: true,
      readOnly: !editable,
      domReadOnly: !editable,
      // Monaco 默认提示为英文；预览/历史版本编辑器统一使用中文提示。
      readOnlyMessage: { value: "当前为只读编辑器，无法编辑" },
      minimap: { enabled: false },
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      folding: false,
      glyphMargin: false,
      padding: { top: 8, bottom: 8 },
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 22,
      fontLigatures: false,
      wordWrap: "on",
      scrollBeyondLastLine: false,
      // 使用 Monaco 原生 VS Code 风格菜单；生命周期/网络事件通过 MenuRegistry 注册。
      contextmenu: true,
      theme: KWW_EDITOR_THEME,
      // 补全列表由下方受控弹层统一渲染，关闭 Monaco 原生 suggest widget，避免两套列表叠加导致点击后显示错误候选。
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      suggest: { showWords: false, showMethods: false, showFunctions: false, showVariables: false, showProperties: false },
      wordBasedSuggestions: "off",
      renderWhitespace: "selection",
      tabSize: 2,
      insertSpaces: true,
      fixedOverflowWidgets: true,
      // 原生右键菜单需要与宿主局部样式共享文档树；菜单仍由 Monaco ContextMenuController 生成。
      useShadowDOM: false,
      overviewRulerLanes: 0
    });
    editorRef.current = editor;
    modelRef.current = model;
    setEditorMountVersion(current => current + 1);

    const updateStats = () => {
      const position = editor.getPosition();
      const selection = editor.getSelection();
      const selected = selectedText(editor);
      setStats({
        line: position?.lineNumber ?? 1,
        column: position?.column ?? 1,
        characters: Array.from(selected).length,
        lines: selected ? selected.split("\n").length : 0
      });
    };
    const refreshInlineSuggestions = (force = false) => {
      const position = editor.getPosition();
      const currentCompletionItems = completionItemsRef.current;
      if (!position || !currentCompletionItems.length) { setInlineSuggestions(null); return; }
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const prefix = line.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.?$/)?.[0] ?? "";
      if (!prefix && !force) { setInlineSuggestions(null); return; }
      const normalizedPrefix = prefix.toLowerCase();
      const items = (prefix ? currentCompletionItems.filter(item => item.label.toLowerCase().startsWith(normalizedPrefix)) : currentCompletionItems).slice(0, 10);
      const visible = editor.getScrolledVisiblePosition(position);
      const layout = editor.getLayoutInfo();
      if (!items.length || !visible || !layout) { setInlineSuggestions(null); return; }
      const popupHeight = Math.min(280, Math.max(42, items.length * 34 + 2));
      const popupWidth = Math.min(560, Math.max(280, layout.width - 24));
      const belowTop = visible.top + visible.height + 4;
      const aboveTop = visible.top - popupHeight - 4;
      const canShowBelow = belowTop + popupHeight <= layout.height - 4;
      const top = canShowBelow ? belowTop : Math.max(4, aboveTop);
      const left = Math.min(Math.max(8, visible.left), Math.max(8, layout.width - popupWidth - 8));
      setInlineSuggestions(current => current?.prefix === prefix && current.items.length === items.length
        ? { ...current, items, top, left, index: Math.min(current.index, items.length - 1) }
        : { items, prefix, top, left, index: 0 });
    };
    const contentSubscription = editor.onDidChangeModelContent(() => {
      const next = model.getValue();
      valueRef.current = next;
      onChangeRef.current(next);
      updateStats();
      refreshInlineSuggestions();
    });
    const contextSubscription = editor.onContextMenu(() => {
      nativeActiveEditor = { editor, snippets: contextSnippets, editable: editableRef.current, businessScriptId: businessScriptIdRef.current, language, openCompletion: () => refreshInlineSuggestions(true) };
    });
    const cursorSubscription = editor.onDidChangeCursorPosition(() => refreshInlineSuggestions());
    const selectionSubscription = editor.onDidChangeCursorSelection(updateStats);
    updateStats();

    const focusSubscription = editor.onDidFocusEditorText(() => {
      nativeActiveEditor = { editor, snippets: contextSnippets, editable: editableRef.current, businessScriptId: businessScriptIdRef.current, language, openCompletion: () => refreshInlineSuggestions(true) };
      refreshInlineSuggestions();
    });
    openCompletionRef.current = () => refreshInlineSuggestions(true);
    if (language === "JavaScript" && contextSnippets.length) registerNativeSubmenu(contextSnippets);
    const runBuiltin = (id: string) => { dispatchMonacoCommand(editor, id, notice); };
    const subscriptions = [
      editor.addAction({ id: "ky.native.undo", label: "撤销", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ], keybindingContext: "editorTextFocus", contextMenuGroupId: "1_modification", contextMenuOrder: 1, run: () => runBuiltin("undo") }),
      editor.addAction({ id: "ky.native.redo", label: "重做", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY], keybindingContext: "editorTextFocus", contextMenuGroupId: "1_modification", contextMenuOrder: 2, run: () => runBuiltin("redo") }),
      editor.addAction({ id: "ky.native.cut", label: "剪切", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX], keybindingContext: "editorTextFocus", contextMenuGroupId: "1_modification", contextMenuOrder: 3, run: () => runBuiltin("editor.action.clipboardCutAction") }),
      editor.addAction({ id: "ky.native.copy", label: "复制", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC], keybindingContext: "editorTextFocus", contextMenuGroupId: "1_modification", contextMenuOrder: 4, run: () => runBuiltin("editor.action.clipboardCopyAction") }),
      editor.addAction({ id: "ky.native.paste", label: "粘贴", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV], keybindingContext: "editorTextFocus", contextMenuGroupId: "1_modification", contextMenuOrder: 5, run: () => runBuiltin("editor.action.clipboardPasteAction") }),
      editor.addAction({ id: "ky.native.selectAll", label: "全选", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyA], keybindingContext: "editorTextFocus", contextMenuGroupId: "1_modification", contextMenuOrder: 6, run: () => runBuiltin("editor.action.selectAll") }),
      editor.addAction({ id: "ky.script.help", label: "脚本编写帮助", contextMenuGroupId: "2_kww", contextMenuOrder: 1, run: () => onOpenHelp?.() }),
      ...(language === "JavaScript" ? [editor.addAction({ id: "ky.script.initializationTemplate", label: "插入初始化模板", contextMenuGroupId: "2_kww", contextMenuOrder: 2, run: () => {
        const scriptId = businessScriptIdRef.current;
        if (typeof scriptId !== "string" || !canInsertBusinessScriptTemplate({ language, editable: editableRef.current, scriptId })) return;
        const currentModel = editor.getModel();
        const selection = editor.getSelection();
        if (!currentModel || !selection) return;
        const template = createBusinessScriptInitTemplate(scriptId);
        const startOffset = currentModel.getOffsetAt(selection.getStartPosition());
        const endOffset = currentModel.getOffsetAt(selection.getEndPosition());
        const plan = planBusinessScriptTemplateInsertion(currentModel.getValue(), startOffset, endOffset, template);
        if (!editor.executeEdits("ky-business-script-init-template", [{ range: selection, text: plan.text }])) return;
        const updatedModel = editor.getModel();
        if (!updatedModel) return;
        editor.setPosition(updatedModel.getPositionAt(plan.cursorOffset));
        editor.focus();
      } })] : []),
      ...(onOpenScriptProperties ? [editor.addAction({ id: "ky.script.properties", label: "脚本属性", contextMenuGroupId: "2_kww", contextMenuOrder: 5, run: () => onOpenScriptProperties() })] : []),
      ...(onOpenStyleProperties ? [editor.addAction({ id: "ky.style.properties", label: "样式属性", contextMenuGroupId: "2_kww", contextMenuOrder: 5, run: () => onOpenStyleProperties() })] : []),
      ...(onFormat && language === "JavaScript" ? [editor.addAction({ id: "ky.script.format", label: "格式化脚本", contextMenuGroupId: "2_kww", contextMenuOrder: 6, run: () => {
        try {
          const source = selectedText(editor) || model.getValue();
          const formatted = onFormat(source);
          const selection = editor.getSelection();
          if (selection && selectedText(editor)) editor.executeEdits("ky-format", [{ range: selection, text: formatted }]);
          else editor.executeEdits("ky-format", [{ range: model.getFullModelRange(), text: formatted }]);
        } catch { notice?.("error", "脚本格式化失败，请检查语法后重试"); }
      } })] : []),
      editor.addAction({ id: "ky.native.commandPalette", label: "命令面板（F1）", keybindings: [monaco.KeyCode.F1], contextMenuGroupId: "9_kww", contextMenuOrder: 1, run: () => runBuiltin("editor.action.quickCommand") })
    ];
    // 动作和二级菜单完成注册后再接管 EditorContext，避免初始空快照覆盖 Monaco 菜单。
    registerNativeMenuFilter();
    const triggerSuggest = editor.onKeyDown(event => {
      const currentSuggestions = inlineSuggestionsRef.current;
      if (currentSuggestions && currentSuggestions.items.length > 0) {
        if (event.keyCode === monaco.KeyCode.DownArrow || event.keyCode === monaco.KeyCode.UpArrow) {
          event.preventDefault();
          event.stopPropagation();
          const delta = event.keyCode === monaco.KeyCode.DownArrow ? 1 : -1;
          setInlineSuggestions(current => current ? { ...current, index: (current.index + delta + current.items.length) % current.items.length } : current);
          return;
        }
        if (event.keyCode === monaco.KeyCode.Tab || event.keyCode === monaco.KeyCode.Enter) {
          event.preventDefault();
          event.stopPropagation();
          acceptInlineSuggestion(currentSuggestions.items[currentSuggestions.index]);
          return;
        }
        if (event.keyCode === monaco.KeyCode.Escape) {
          event.preventDefault();
          setInlineSuggestions(null);
          return;
        }
      }
    });

    return () => {
      completionRef.current?.dispose();
      completionRef.current = null;
      shortcutDisposablesRef.current.forEach(disposable => disposable.dispose());
      shortcutDisposablesRef.current = [];
      subscriptions.forEach(subscription => subscription.dispose());
      contentSubscription.dispose();
      contextSubscription.dispose();
      cursorSubscription.dispose();
      focusSubscription.dispose();
      selectionSubscription.dispose();
      triggerSuggest.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
      if (nativeActiveEditor?.editor === editor) nativeActiveEditor = null;
      openCompletionRef.current = () => undefined;
      setInlineSuggestions(null);
    };
      };
      disposeEditor = createEditor();
    }).catch(() => notice?.("error", "Monaco 查找功能加载失败，请重试"));
    return () => { cancelled = true; disposeEditor?.(); };
  }, [language]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({ readOnly: !editable, domReadOnly: !editable });
    if (nativeActiveEditor?.editor === editor) nativeActiveEditor = { ...nativeActiveEditor, editable, businessScriptId: businessScriptIdRef.current, language };
  }, [editable, businessScriptId, language, editorMountVersion]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    shortcutDisposablesRef.current.forEach(disposable => disposable.dispose());
    shortcutDisposablesRef.current = [];
    const platform = shortcutPlatform(typeof navigator === "undefined" ? "" : navigator.platform);
    const preferences = shortcuts ?? defaultEditorShortcuts(platform);
    const actions = editorShortcutActions(preferences, platform, !editable);
    for (const action of actions) {
      const codeName = shortcutKeyCodeName(action.shortcut);
      const keyCode = codeName ? (monaco.KeyCode as unknown as Record<string, number>)[codeName] : undefined;
      if (typeof keyCode !== "number") continue;
      const modifiers = action.shortcut.split("+");
      let keybinding = keyCode;
      if (modifiers.includes("Mod")) keybinding |= monaco.KeyMod.CtrlCmd;
      if (modifiers.includes("Shift")) keybinding |= monaco.KeyMod.Shift;
      if (modifiers.includes("Alt")) keybinding |= monaco.KeyMod.Alt;
      shortcutDisposablesRef.current.push(editor.addAction({
        id: `ky.shortcut.${action.command}`,
        label: action.command === "completion" ? "唤出补全候选" : action.command === "find" ? "查找" : "查找并替换",
        keybindings: [keybinding],
        keybindingContext: "editorTextFocus",
        run: () => {
          if (action.command === "completion") openCompletionRef.current();
          else if (action.command === "find") invokeNativeFind(editor, editableRef.current, false);
          else if (action.command === "replace") invokeNativeFind(editor, editableRef.current, true);
        }
      }));
    }
    return () => {
      shortcutDisposablesRef.current.forEach(disposable => disposable.dispose());
      shortcutDisposablesRef.current = [];
    };
  }, [editorMountVersion, shortcuts?.completion, shortcuts?.find, shortcuts?.replace, editable]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = modelRef.current;
    if (!editor || !model) return;
    if (model.getValue() !== value) {
      const selection = editor.getSelection();
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => selection ? [selection] : null);
    }
    editor.updateOptions({ readOnly: !editable, domReadOnly: !editable });
  }, [value, editable]);

  useEffect(() => {
    completionRef.current?.dispose();
    completionRef.current = null;
    if (!editorRef.current) return;
    completionRef.current = monaco.languages.registerCompletionItemProvider(languageId(language), {
      triggerCharacters: [".", " ", "(", "{", ":"],
      provideCompletionItems: (model, position) => {
        const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const prefix = line.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.?$/)?.[0] ?? "";
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, Math.max(1, position.column - prefix.length), position.lineNumber, position.column);
        const normalizedPrefix = prefix.toLowerCase();
        const normalizedWord = word.word.toLowerCase();
        const items = completionItems.filter(item => {
          const label = item.label.toLowerCase();
          const tail = label.includes(".") ? label.slice(label.lastIndexOf(".") + 1) : label;
          return !prefix || label.startsWith(normalizedPrefix) || tail.startsWith(normalizedPrefix.split(".").pop() ?? normalizedWord) || label.startsWith(normalizedWord);
        });
        return {
          suggestions: items.map(item => ({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Function,
            detail: item.description,
            documentation: item.description,
            filterText: item.label,
            insertText: completionSnippet(item.insertText ?? item.label),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range
          }))
        };
      }
    });
    return () => { completionRef.current?.dispose(); completionRef.current = null; };
  }, [completionItems, language]);

  const acceptInlineSuggestion = (item: MonacoCompletionItem) => {
    const editor = editorRef.current;
    const model = modelRef.current;
    const currentSuggestions = inlineSuggestionsRef.current;
    if (!editor || !model || !currentSuggestions) return;
    const position = editor.getPosition();
    if (!position) return;
    const start = Math.max(1, position.column - currentSuggestions.prefix.length);
    const snippet = expandCompletionSnippet(completionSnippet(item.insertText ?? item.label));
    const startOffset = model.getOffsetAt({ lineNumber: position.lineNumber, column: start });
    editor.executeEdits("ky-inline-completion", [{ range: new monaco.Range(position.lineNumber, start, position.lineNumber, position.column), text: snippet.text }]);
    const tabStop = snippet.placeholders.filter(placeholder => placeholder.index > 0).sort((a, b) => a.index - b.index)[0]
      ?? snippet.placeholders.find(placeholder => placeholder.index === 0);
    const selectionStart = startOffset + (tabStop?.start ?? snippet.text.length);
    const selectionEnd = startOffset + (tabStop?.end ?? snippet.text.length);
    const selectionStartPosition = model.getPositionAt(selectionStart);
    const selectionEndPosition = model.getPositionAt(selectionEnd);
    editor.setSelection(new monaco.Selection(selectionStartPosition.lineNumber, selectionStartPosition.column, selectionEndPosition.lineNumber, selectionEndPosition.column));
    setInlineSuggestions(null);
    editor.focus();
  };

  return <div className="monaco-source-editor-root">
    <div className="monaco-source-editor" ref={hostRef} data-script-name={scriptName ?? ""} data-version={version ?? ""} aria-label={`${language}源码编辑器`} />
    {inlineSuggestions && <div className="script-editor-completion-popup" style={{ position: "absolute", zIndex: 20, top: inlineSuggestions.top, left: inlineSuggestions.left, width: "min(560px, calc(100% - 16px))", maxHeight: 280, overflowY: "auto", background: "var(--admin-surface)", border: "1px solid var(--admin-stroke)", boxShadow: "0 4px 14px rgba(52,40,26,.18)" }}>{inlineSuggestions.items.map((item, index) => <button key={item.label} type="button" onMouseEnter={() => setInlineSuggestions(current => current ? { ...current, index } : current)} onMouseDown={event => { event.preventDefault(); acceptInlineSuggestion(item); }} style={{ display: "flex", width: "100%", gap: 12, padding: "7px 10px", border: 0, background: index === inlineSuggestions.index ? "var(--admin-accent-soft)" : "transparent", color: "var(--admin-text)", textAlign: "left", cursor: "pointer", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}><span>{item.label}</span><small style={{ marginLeft: "auto", color: "var(--admin-text-muted)" }}>{item.description}</small></button>)}</div>}
    <div className="script-editor-status-bar">
      <div className="script-editor-status-left"><span>脚本名称：{scriptName?.trim() || "未命名"} · 版本：{version?.trim() || "未生成"}</span></div>
      <div className="script-editor-status-center"><span>行 {stats.line}，列 {stats.column}</span></div>
      <div className="script-editor-status-right"><span>共 {Array.from(value).length} 个字符</span>{stats.characters > 0 && <span>已选 {stats.characters} 个字符，{stats.lines} 行</span>}</div>
    </div>
  </div>;
}
