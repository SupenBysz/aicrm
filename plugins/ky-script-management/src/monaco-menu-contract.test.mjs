import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { MenuId, MenuRegistry } from "../node_modules/monaco-editor/esm/vs/platform/actions/common/actions.js";
import { MenuService } from "../node_modules/monaco-editor/esm/vs/platform/actions/common/menuService.js";
import { dispatchMonacoCommand } from "./components/monaco-command-dispatch.mjs";
import { canInsertBusinessScriptTemplate } from "./business-script-init-template.ts";

const source = fs.readFileSync(new URL("./components/monaco-source-editor.tsx", import.meta.url), "utf8");
const hostStyles = fs.readFileSync(new URL("../../../apps/ky-admin-host/src/styles.css", import.meta.url), "utf8");

const allowed = new Set([
  "ky.native.undo", "ky.native.redo", "ky.native.cut", "ky.native.copy", "ky.native.paste", "ky.native.selectAll",
  "ky.native.commandPalette", "ky.script.help", "ky.script.initializationTemplate", "ky.script.properties", "ky.style.properties", "ky.script.format"
]);
const submenuIds = new Set(["KWW_LIFECYCLE_SUBMENU", "KWW_NETWORK_SUBMENU"]);
const groupRank = new Map([["1_modification", 1], ["2_kww", 2], ["9_kww", 3]]);

function actionId(id) {
  return typeof id === "string" ? id.slice(id.lastIndexOf(":") + 1) : "";
}

function filterAndOrder(items, context) {
  return items.filter(item => {
    const id = actionId(item.command?.id);
    if (id === "ky.script.initializationTemplate" && !canInsertBusinessScriptTemplate(context ?? { language: "JavaScript", editable: false })) return false;
    return allowed.has(id) || submenuIds.has(item.submenu);
  })
    .sort((a, b) => (groupRank.get(a.group) ?? 99) - (groupRank.get(b.group) ?? 99) || (a.order ?? 0) - (b.order ?? 0));
}

test("Monaco EditorContext 只保留目标动作和原生 submenu，并按分组排序", () => {
  const items = [
    { command: { id: "editor:editor.action.revealDefinition", title: "Go to Definition" }, group: "navigation", order: 1 },
    { command: { id: "editor.action.clipboardCopyAction", title: "复制" }, group: "2_correction", order: 1 },
    { command: { id: "editor:ky.native.copy", title: "复制" }, group: "1_modification", order: 4 },
    { command: { id: "editor:ky.native.undo", title: "撤销" }, group: "1_modification", order: 1 },
    { command: { id: "editor:ky.script.help", title: "脚本编写帮助" }, group: "2_kww", order: 1 },
    { command: { id: "editor:ky.script.initializationTemplate", title: "插入初始化模板" }, group: "2_kww", order: 2 },
    { submenu: "KWW_LIFECYCLE_SUBMENU", group: "2_kww", order: 3 },
    { submenu: "KWW_NETWORK_SUBMENU", group: "2_kww", order: 4 },
    { command: { id: "editor:ky.native.commandPalette", title: "命令面板（F1）" }, group: "9_kww", order: 1 }
  ];
  assert.deepEqual(filterAndOrder(items).map(item => item.command?.title ?? item.submenu), ["撤销", "复制", "脚本编写帮助", "KWW_LIFECYCLE_SUBMENU", "KWW_NETWORK_SUBMENU", "命令面板（F1）"]);
  assert.deepEqual(filterAndOrder(items, { language: "JavaScript", editable: true, scriptId: "business-1" }).map(item => item.command?.title ?? item.submenu), ["撤销", "复制", "脚本编写帮助", "插入初始化模板", "KWW_LIFECYCLE_SUBMENU", "KWW_NETWORK_SUBMENU", "命令面板（F1）"]);
  for (const context of [
    { language: "JavaScript", editable: true },
    { language: "CSS", editable: true, scriptId: "business-1" },
    { language: "JavaScript", editable: false, scriptId: "business-1" }
  ]) assert.equal(filterAndOrder(items, context).some(item => actionId(item.command?.id) === "ky.script.initializationTemplate"), false);
  assert.equal(filterAndOrder(items).some(item => item.command?.title === "Go to Definition"), false);
  assert.equal(filterAndOrder(items).filter(item => item.command?.title === "复制").length, 1);
});

test("活动脚本页使用 Monaco 原生编辑器路径而非自绘菜单入口", () => {
  const page = fs.readFileSync(new URL("./pages/script-management-page.tsx", import.meta.url), "utf8");
  assert.match(page, /import \{ MonacoSourceEditor \}/);
  assert.match(page, /<MonacoSourceEditor[\s\S]*contextSnippets=/);
  assert.doesNotMatch(page, /script-editor-context-menu/);
  assert.match(source, /contextmenu: true/);
  assert.match(source, /MenuRegistry\.appendMenuItem\(MenuId\.EditorContext/);
  assert.match(source, /submenu: KWW_LIFECYCLE_SUBMENU/);
  assert.match(source, /submenu: KWW_NETWORK_SUBMENU/);
  assert.match(source, /CommandsRegistry\.registerCommand/);
  assert.match(source, /MenuRegistry\.appendMenuItem\(submenu/);
  assert.match(source, /id: "ky\.script\.initializationTemplate", label: "插入初始化模板"/);
  assert.match(source, /planBusinessScriptTemplateInsertion\(currentModel\.getValue\(\), startOffset, endOffset, template\)/);
  assert.match(source, /editor\.executeEdits\("ky-business-script-init-template", \[\{ range: selection, text: plan\.text \}\]\)/);
  assert.match(source, /editor\.setPosition\(updatedModel\.getPositionAt\(plan\.cursorOffset\)\)/);
});

test("公共脚本和公共样式编辑器都贯通原生帮助动作到现有帮助抽屉", () => {
  const page = fs.readFileSync(new URL("./pages/script-management-page.tsx", import.meta.url), "utf8");
  const scriptsStart = page.indexOf("function PublicScriptsPanel(");
  const stylesStart = page.indexOf("function PublicStylesPanel(", scriptsStart);
  const managementStart = page.indexOf("export function ScriptManagementPage(", stylesStart);
  assert.ok(scriptsStart >= 0 && stylesStart > scriptsStart && managementStart > stylesStart, "公共资源面板边界缺失");
  const scriptsPanel = page.slice(scriptsStart, stylesStart);
  const stylesPanel = page.slice(stylesStart, managementStart);
  const management = page.slice(managementStart);

  assert.match(scriptsPanel, /function PublicScriptsPanel\(\{[^}]*onOpenHelp[^}]*\}:[\s\S]*?onOpenHelp:\(\)=>void/);
  assert.match(scriptsPanel, /<MonacoSourceEditor[\s\S]*?onOpenHelp=\{onOpenHelp\}/, "公共脚本编辑器未接收帮助回调");
  assert.match(stylesPanel, /function PublicStylesPanel\(\{[^}]*onOpenHelp[^}]*\}:[\s\S]*?onOpenHelp:\(\)=>void/);
  assert.match(stylesPanel, /<MonacoSourceEditor[\s\S]*?onOpenHelp=\{onOpenHelp\}/, "公共样式编辑器未接收帮助回调");

  assert.match(management, /const openScriptWritingHelp=\(\)=>\{setHelpSection\("start"\);setHelpOpen\(true\)\}/, "帮助动作未将既有抽屉打开到起始章节");
  assert.match(management, /<PublicScriptsPanel[\s\S]*?onOpenHelp=\{openScriptWritingHelp\}/, "公共脚本面板未收到外层帮助回调");
  assert.match(management, /<PublicStylesPanel[\s\S]*?onOpenHelp=\{openScriptWritingHelp\}/, "公共样式面板未收到外层帮助回调");
  assert.match(management, /className=\{`script-writing-help-drawer[\s\S]*?open=\{helpOpen\}/, "回调未复用现有脚本编写帮助抽屉");
  assert.match(management, /const assetEditor=\(type:AssetType\)=>[\s\S]*?businessScriptId=\{type==="script"&&activeAsset\.status==="draft"&&can\(perm\.update\)\?selected\?\.id:null\}/,
    "只有可编辑的业务脚本草稿才能将稳定 ID 传给初始化模板入口");
  assert.doesNotMatch(scriptsPanel, /businessScriptId=/, "公共脚本不能获得业务初始化模板入口");
  assert.doesNotMatch(stylesPanel, /businessScriptId=/, "公共样式不能获得业务初始化模板入口");
  assert.match(management, /<MonacoSourceEditor value=\{previewContent\}[\s\S]*?editable=\{false\}/, "历史版本仍为只读预览");
});

test("原生快捷键和二级菜单说明覆盖完整契约", () => {
  for (const shortcut of ["KeyZ", "KeyY", "KeyX", "KeyC", "KeyV", "KeyA"]) {
    assert.match(source, new RegExp(`KeyMod\\.CtrlCmd \\| monaco\\.KeyCode\\.${shortcut}`));
  }
  assert.match(source, /const tooltip = snippet\.description \? `\$\{snippet\.label\}：\$\{snippet\.description\}`/);
  const page = fs.readFileSync(new URL("./pages/script-management-page.tsx", import.meta.url), "utf8");
  for (const text of [
    "documentStart", "文档开始解析时执行", "domReady", "DOM 结构构建完成后执行",
    "pageLoad", "页面资源加载完成后执行", "routeChange", "单页应用路由发生变化时执行",
    "userAction", "用户明确操作后执行", "subscribeRequest", "观察匹配的请求",
    "subscribeResponse", "观察匹配的响应", "interceptRequest", "拦截并修改请求",
    "interceptResponse", "拦截并改写响应", "waitForRequest", "等待一次匹配请求",
    "waitForResponse", "等待一次匹配响应"
  ]) assert.match(page, new RegExp(text));
});

test("重做优先显示 macOS 常用快捷键并保留兼容绑定", () => {
  assert.match(source, /id: "ky\.native\.redo"[\s\S]{0,260}keybindings: \[\s*monaco\.KeyMod\.CtrlCmd \| monaco\.KeyMod\.Shift \| monaco\.KeyCode\.KeyZ,\s*monaco\.KeyMod\.CtrlCmd \| monaco\.KeyCode\.KeyY/);
});

test("原生菜单在动作和 submenu 注册后再安装过滤器", () => {
  assert.doesNotMatch(source, /return sorted\.length > 0 \? sorted : items/);
  assert.match(source, /editor\.addAction\(\{ id: "ky\.native\.commandPalette"[\s\S]*?\n    \];[\s\S]*?registerNativeMenuFilter\(\);/);
});

test("editor.api 之外显式注册 Monaco 原生 ContextMenuController", () => {
  assert.match(source, /import "\.\.\/\.\.\/node_modules\/monaco-editor\/esm\/vs\/editor\/contrib\/contextmenu\/browser\/contextmenu\.js";/);
  assert.match(source, /import "\.\.\/\.\.\/node_modules\/monaco-editor\/esm\/vs\/features\/quickCommand\/register\.js";/);
  assert.match(source, /useShadowDOM: false/);
});

test("命令面板使用 Monaco 独立 quickCommand 动作且缺失时可见提示", () => {
  assert.match(source, /id: "ky\.native\.commandPalette"[\s\S]*?run: \(\) => runBuiltin\("editor\.action\.quickCommand"\)/);
  assert.match(source, /dispatchMonacoCommand\(editor, id, notice\)/);
  assert.match(fs.readFileSync(new URL("./components/monaco-command-dispatch.mjs", import.meta.url), "utf8"), /editor\.trigger\("ky\.native", id, undefined\)/);
});

test("CommandsRegistry 动作通过 editor.trigger 分发，至少可执行全选", () => {
  const calls = [];
  const editor = {
    getAction: () => null,
    trigger: (...args) => calls.push(args)
  };
  assert.equal(dispatchMonacoCommand(editor, "editor.action.selectAll"), true);
  assert.deepEqual(calls, [["ky.native", "editor.action.selectAll", undefined]]);
});

test("未知编辑器命令给出准确失败提示而非命令面板误报", () => {
  const notices = [];
  const editor = { getAction: () => null, trigger: () => { throw new Error("不应分发"); } };
  assert.equal(dispatchMonacoCommand(editor, "editor.action.unknown", (type, text) => notices.push([type, text])), false);
  assert.deepEqual(notices, [["error", "编辑器命令不可用：editor.action.unknown"]]);
});

test("常规编辑动作使用统一 Codicon 且快捷键列仅在编辑器菜单内收紧", () => {
  for (const icon of ["Codicon.history", "Codicon.redo", "Codicon.screenCut", "Codicon.copy", "Codicon.insert", "Codicon.selection"]) {
    assert.match(source, new RegExp(icon.replace(".", "\\.")));
  }
       assert.match(hostStyles, /body:has\(\.monaco-source-editor\) \.context-view\.monaco-menu-container \.monaco-menu \.monaco-action-bar\.vertical \.keybinding[\s\S]*?flex: 0 0 auto[\s\S]*?margin-left: auto/);
       assert.match(hostStyles, /body:has\(\.monaco-source-editor\) \.context-view\.monaco-menu-container \.monaco-menu \.monaco-action-bar\.vertical \.action-label:not\(\.separator\)/);
       for (const label of ["撤销", "重做", "剪切", "复制", "粘贴", "全选"]) {
         assert.match(hostStyles, new RegExp(`action-label\\[aria-label\\^=\\"${label}\\"]::before`));
       }
       assert.match(hostStyles, /action-label\[aria-label\^="撤销"\]::before \{ content: "\\ea82"; \}/);
       assert.doesNotMatch(hostStyles, /content: "\\\\ea82"/);
       assert.match(hostStyles, /\.action-menu-item[\s\S]*?width: 100%[\s\S]*?min-width: 0/);
       assert.match(source, /command: \{ id: commandId, title: snippet\.label, tooltip \}/);
       for (const label of ["documentStart", "domReady", "pageLoad", "routeChange", "userAction", "waitForRequest", "waitForResponse", "interceptRequest", "interceptResponse", "subscribeRequest", "subscribeResponse"]) {
         assert.match(hostStyles, new RegExp(`action-label\\[aria-label\\^=\\"${label}\\"\\]`));
       }
       for (const description of ["拦截并修改请求", "拦截并改写响应", "观察匹配的请求", "观察匹配的响应"]) {
         assert.match(hostStyles, new RegExp(`content: \\"${description}\\"`));
       }
});

test("真实 Monaco MenuService 能生成白名单顶层菜单和二级菜单", () => {
  const storage = { get: () => "{}", onDidChangeValue: () => () => {}, store: () => {} };
  const service = new MenuService({ executeCommand: () => {} }, { lookupKeybinding: () => undefined }, storage);
  const context = { contextMatchesRules: () => true, onDidChangeContext: () => () => {} };
  const lifecycle = new MenuId("KWW_TEST_LIFECYCLE_SUBMENU");
  const network = new MenuId("KWW_TEST_NETWORK_SUBMENU");
  const allowed = new Set(["ky.native.undo", "ky.script.help"]);
  const originalGetMenuItems = MenuRegistry.getMenuItems.bind(MenuRegistry);
  MenuRegistry.getMenuItems = (id) => {
    const items = originalGetMenuItems(id);
    if (id !== MenuId.EditorContext) return items;
    const filtered = items.filter(item => {
      const commandId = item?.command?.id;
      return (typeof commandId === "string" && [...allowed].some(value => commandId === value || commandId.endsWith(`:${value}`))) || item?.submenu === lifecycle || item?.submenu === network;
    });
    return filtered.sort((left, right) => Number(left?.order ?? 0) - Number(right?.order ?? 0));
  };
  const disposables = [
    MenuRegistry.appendMenuItem(MenuId.EditorContext, { command: { id: "editor-test:ky.native.undo", title: "撤销" }, group: "1_modification", order: 1 }),
    MenuRegistry.appendMenuItem(MenuId.EditorContext, { command: { id: "editor-test:ky.script.help", title: "脚本编写帮助" }, group: "2_kww", order: 1 }),
    MenuRegistry.appendMenuItem(MenuId.EditorContext, { submenu: lifecycle, title: "插入生命周期", group: "2_kww", order: 2 }),
    MenuRegistry.appendMenuItem(MenuId.EditorContext, { submenu: network, title: "网络事件", group: "2_kww", order: 3 }),
    MenuRegistry.appendMenuItem(lifecycle, { command: { id: "ky.test.documentStart", title: "documentStart（文档开始解析时执行）" }, group: "navigation", order: 1 }),
    MenuRegistry.appendMenuItem(network, { command: { id: "ky.test.waitForResponse", title: "waitForResponse（等待一次匹配响应）" }, group: "navigation", order: 1 })
  ];
  const menu = service.createMenu(MenuId.EditorContext, context);
  const groups = menu.getActions({}).flatMap(([, actions]) => actions.map(action => action.label));
  assert.deepEqual(groups, ["撤销", "脚本编写帮助", "插入生命周期", "网络事件"]);
  for (const disposable of disposables) disposable.dispose();
  menu.dispose();
  service.dispose();
  MenuRegistry.getMenuItems = originalGetMenuItems;
});
