import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("JavaScript 编辑器提供五种生命周期代码片段并折叠为二级菜单", async () => {
  const source = await readFile(new URL("./pages/script-management-page.tsx", import.meta.url), "utf8");
  const editor = await readFile(new URL("./components/monaco-source-editor.tsx", import.meta.url), "utf8");
  for (const event of ["documentStart", "domReady", "pageLoad", "routeChange", "userAction"]) {
    assert.match(source, new RegExp(`jssdk\\.lifecycle\\.on\\(\\"${event}\\"`));
  }
  assert.match(editor, /title: "插入生命周期"/);
  assert.match(editor, /submenu: KWW_LIFECYCLE_SUBMENU/);
  assert.match(editor, /MenuRegistry\.appendMenuItem\(submenu/);
  for (const description of ["文档开始解析时执行", "DOM 结构构建完成后执行", "页面资源加载完成后执行", "单页应用路由发生变化时执行", "用户明确操作后执行"]) {
    assert.match(source, new RegExp(description));
  }
  assert.match(source, /注入优先级/);
  assert.doesNotMatch(source, /label="执行时机"/);
});

test("JavaScript 编辑器提供网络事件关键词和二级菜单代码片段", async () => {
  const source = await readFile(new URL("./pages/script-management-page.tsx", import.meta.url), "utf8");
  const editor = await readFile(new URL("./components/monaco-source-editor.tsx", import.meta.url), "utf8");
  for (const method of ["subscribeRequest", "subscribeResponse", "interceptRequest", "interceptResponse", "waitForRequest", "waitForResponse"]) {
    assert.match(source, new RegExp(`jssdk\\.net\\.${method}`));
  }
  assert.match(editor, /title: "网络事件"/);
  assert.match(editor, /submenu: KWW_NETWORK_SUBMENU/);
  assert.match(editor, /CommandsRegistry\.registerCommand/);
  assert.match(source, /description:"拦截并修改请求"/);
  for (const description of ["观察匹配的请求", "观察匹配的响应", "拦截并修改请求", "拦截并改写响应", "等待一次匹配请求", "等待一次匹配响应"]) {
    assert.match(source, new RegExp(description));
  }
});

test("JavaScript 编辑器按实际 JSSDK 命名空间分层提供代码提示", async () => {
  const source = await readFile(new URL("./pages/script-management-page.tsx", import.meta.url), "utf8");
  const editor = await readFile(new URL("./components/monaco-source-editor.tsx", import.meta.url), "utf8");
  const reference = await readFile(new URL("./jssdk-reference.ts", import.meta.url), "utf8");
  const preload = await readFile(new URL("../../../apps/aicrm-desktop/src/preload/web-window.ts", import.meta.url), "utf8");
  const exposedApi = preload;
  for (const token of ["jssdk", "jssdk.lifecycle", "jssdk.net", "jssdk.host.getStoreInfo", "jssdk.host.getCurrentUser", "jssdk.window.setHeaderTitle", "jssdk.public.get"]) {
    assert.match(reference, new RegExp(`label: "${token.replaceAll(".", "\\.")}"`));
  }
  for (const method of ["jssdk.host.updateLoginSpaceInfo", "jssdk.window.addActionButton"]) {
    assert.ok(reference.includes(`label: "${method}"`), `缺少当前桌面契约补全：${method}`);
  }
  assert.match(reference, /label: "jssdk\.ui"/);
  const uiMethods = [
    "message.success", "message.info", "message.warning", "message.error", "message.loading",
    "notification.success", "notification.info", "notification.warning", "notification.error",
    "modal.confirm", "modal.info", "modal.success", "modal.warning", "modal.error",
  ];
  for (const method of uiMethods) {
    assert.ok(reference.includes(`label: "jssdk.ui.${method}"`), `缺少 UI 方法级补全：jssdk.ui.${method}`);
  }
  assert.equal(uiMethods.length, 14, "UI 门面补全应覆盖全部 14 个方法");
  assert.match(reference, /jssdk\.ui\.modal\.confirm[\s\S]{0,280}const confirmed = await/);
  assert.match(reference, /纯文本 message、可选 description 和 durationMs/);
  assert.match(reference, /纯文本 title\/content/);
  assert.doesNotMatch(reference, /label: "jssdk\.ui\.(message|notification)"/);
  for (const marker of [
    'label: "jssdk.host.updateLoginSpaceInfo（仅名称）"',
    'label: "jssdk.host.updateLoginSpaceInfo（仅登录状态）"',
    'label: "jssdk.host.updateLoginSpaceInfo（名称与状态）"',
    'loginStatus: "${1:logged_in}"',
    'label: "jssdk.window.addActionButton (Iconfont font-class)"',
    'label: "jssdk.window.addActionButton (Iconfont unicode)"',
    'label: "jssdk.window.addActionButton (Iconfont symbol)"',
    'stylesheetUrl: "https://at.alicdn.com/t/c/font_123456_abc.css", className: "iconfont icon-refresh"',
    'codePoint: "e600"',
    'symbolId: "icon-refresh"',
    'provider: "antd", name:',
    'jssdk.ui.notification.info',
    'jssdk.ui.modal.confirm',
  ]) assert.ok(reference.includes(marker), `补全示例/图标来源缺失：${marker}`);
  assert.match(reference, /provider: "antd"/);
  for (const mode of ["font-class", "unicode", "symbol"]) assert.ok(reference.includes(`mode: "${mode}"`), `缺少 Iconfont ${mode} 配置`);
  assert.doesNotMatch(reference, /icon:\s*\/\*\s*placeholder/);
  assert.match(reference, /label: "jssdk\.store"/);
  assert.match(reference, /label: "jssdk\.store\.getStoreInfo"/);
  assert.match(reference, /label: "jssdk\.store\.setStoreInfo"/);
  assert.doesNotMatch(reference, /label: "jssdk\.user(?:\.|\")/);
  const suggestions = [...reference.matchAll(/label: "(jssdk(?:\.[A-Za-z]+)*)"/g)].map((match) => match[1]);
  for (const suggestion of suggestions) {
    if (suggestion === "jssdk") continue;
    const member = suggestion.split(".").at(-1);
    const currentClientContract = ["updateLoginSpaceInfo", "addActionButton", "ui", "message", "notification", "modal", "success", "info", "warning", "error", "loading", "confirm"];
    assert.ok(currentClientContract.includes(member) || exposedApi.includes(`${member}(`) || exposedApi.includes(`${member}:`) || exposedApi.includes(member), `补全项不在已交付桌面契约/本地 preload 中：${suggestion}`);
  }
  assert.match(source, /jssdkCompletionItems/);
  assert.match(source, /completionTokenAt/);
  assert.match(source, /\\\.\?\$\/\)\?\.\[0\]/);
  assert.match(source, /completionScopeFor/);
  assert.match(editor, /registerCompletionItemProvider/);
  assert.match(editor, /completionItems\.filter/);
  assert.match(source, /jssdk\.lifecycle\.on/);
  assert.match(source, /用户明确操作后执行/);
  const runtime = await readFile(new URL("../../../apps/aicrm-desktop/src/main/script-runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /async dispatchUserAction\(webContents: WebContents, actionId: string\)/);
  assert.match(runtime, /execute\(webContents, "user_action", url\)/);
  assert.match(runtime, /dispatchLifecycleEvent\(webContents, "userAction", \{ actionId, url \}\)/);
  assert.match(editor, /onMouseEnter=\{\(\) => setInlineSuggestions/);
  assert.match(editor, /KeyCode\.Tab \|\| event\.keyCode === monaco\.KeyCode\.Enter/);
  assert.match(editor, /editor\.setSelection\(new monaco\.Selection/);
});

test("生命周期和网络菜单使用 Monaco 原生 submenu，不再渲染受控 HTML 菜单", async () => {
  const page = await readFile(new URL("./pages/script-management-page.tsx", import.meta.url), "utf8");
  const editor = await readFile(new URL("./components/monaco-source-editor.tsx", import.meta.url), "utf8");
  assert.match(editor, /contextmenu: true/);
  assert.match(editor, /MenuRegistry\.appendMenuItem\(MenuId\.EditorContext, \{ submenu:/);
  assert.match(editor, /CommandsRegistry\.registerCommand/);
  assert.match(editor, /MenuRegistry\.appendMenuItem\(submenu/);
  assert.doesNotMatch(page, /script-editor-context-menu/);
  assert.doesNotMatch(page, /setSubmenu|onMouseDown=\{event=>event\.stopPropagation\(\)\}/);
});

test("原生编辑动作注册快捷键提示且保持 F1", async () => {
  const editor = await readFile(new URL("./components/monaco-source-editor.tsx", import.meta.url), "utf8");
  for (const [id, key] of [["ky.native.undo", "KeyZ"], ["ky.native.cut", "KeyX"], ["ky.native.copy", "KeyC"], ["ky.native.paste", "KeyV"], ["ky.native.selectAll", "KeyA"]]) {
    assert.match(editor, new RegExp(`id: \\\"${id}\\\"[\\s\\S]{0,260}keybindings: \\[\\s*monaco\\.KeyMod\\.CtrlCmd \\| monaco\\.KeyCode\\.${key}`));
  }
  assert.match(editor, /id: "ky\.native\.redo"[\s\S]{0,260}keybindings: \[\s*monaco\.KeyMod\.CtrlCmd \| monaco\.KeyMod\.Shift \| monaco\.KeyCode\.KeyZ,\s*monaco\.KeyMod\.CtrlCmd \| monaco\.KeyCode\.KeyY/);
  assert.match(editor, /keybindings: \[monaco\.KeyCode\.F1\]/);
  assert.match(editor, /const tooltip = snippet\.description \? `\$\{snippet\.label\}：\$\{snippet\.description\}`/);
});
