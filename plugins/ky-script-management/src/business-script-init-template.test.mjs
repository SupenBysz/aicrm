import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";
import {
  canInsertBusinessScriptTemplate,
  createBusinessScriptInitTemplate,
  planBusinessScriptTemplateInsertion
} from "./business-script-init-template.ts";

test("模板仅允许可编辑的业务 JavaScript 脚本上下文", () => {
  assert.equal(canInsertBusinessScriptTemplate({ language: "JavaScript", editable: true, scriptId: "script-1" }), true);
  assert.equal(canInsertBusinessScriptTemplate({ language: "JavaScript", editable: false, scriptId: "script-1" }), false);
  assert.equal(canInsertBusinessScriptTemplate({ language: "CSS", editable: true, scriptId: "script-1" }), false);
  assert.equal(canInsertBusinessScriptTemplate({ language: "JavaScript", editable: true }), false);
  assert.equal(canInsertBusinessScriptTemplate({ language: "JavaScript", editable: true, scriptId: " " }), false);
});

test("模板默认无依赖，并提供服务端可解析的多公共模块声明示例", () => {
  const first = createBusinessScriptInitTemplate("script-a");
  const second = createBusinessScriptInitTemplate("script-b");
  assert.notEqual(first.registryKey, second.registryKey);
  assert.match(first.text, /^const KWW_PUBLIC_DEPENDENCIES = \[\];[\s\S]*^\(async \(\) => \{[\s\S]*\}\)\(\);$/m);
  assert.match(first.text, /const jssdk = window\.jssdk/);
  assert.match(first.text, /if \(!jssdk\)/);
  assert.match(first.text, /const instanceKey = Symbol\.for\("kww\.business-script\.script-a"\)/);
  assert.match(second.text, /const instanceKey = Symbol\.for\("kww\.business-script\.script-b"\)/);
  assert.match(first.text, /if \(window\[instanceKey\]\) return/);
  assert.match(first.text, /window\[instanceKey\] = true/);
  assert.match(first.text, /instanceMarked = true/);
  assert.match(first.text, /if \(instanceMarked\) delete window\[instanceKey\]/);
  assert.match(first.text, /TODO: 在此编写业务逻辑/);
  assert.match(first.text, /catch \(error\)/);
  assert.match(first.text, /error instanceof Error \? error\.message : "UNKNOWN"/);
  assert.doesNotMatch(first.text, /console\.error\([^\n]*, error\)/);
  assert.match(first.text, /手动复制到其他业务脚本时，请检查并修改此注册表键/);
  assert.match(first.text, /jssdk\.public\?\.get === "function" \? jssdk\.public\.get\(identifier\)/);
  assert.match(first.text, /公共脚本依赖未就绪：\$\{identifier\}/);
  assert.match(first.text, /公共脚本方法未导出：\$\{identifier\}\.\$\{String\(method\)\}/);
  assert.match(first.text, /COMMON_FUN/);
  assert.match(first.text, /COMMON_DOUYIN/);
  assert.match(first.text, /将第一行空数组替换为所需的一行声明/);
  assert.match(first.text, /COMMON_DOUYIN 是抖店通用公共脚本/);
  assert.match(first.text, /yourDouyinHelper/);
  assert.doesNotMatch(first.text, /clickEmailLoginTab|ensurePolicyAccepted|selectStoreByName/);
  assert.equal(first.text.split("\n")[0], "const KWW_PUBLIC_DEPENDENCIES = [];");
  assert.ok(first.text.split("\n").filter((line) => line.includes("const KWW_PUBLIC_DEPENDENCIES = [")).every((line) => line.trimStart().startsWith("//") || line.endsWith("= [];")), "依赖示例应注释保持关闭");
  assert.doesNotMatch(first.text, /jssdk\.public\?\.\[/, "不能使用未经支持的属性下标 API");
  assert.doesNotMatch(first.text, /ORDER_HELPERS|jinritemai|querySelector|fetch\s*\(/i);
  const syntax = spawnSync(process.execPath, ["--check"], { input: first.text, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("特殊脚本 ID 作为安全 JavaScript 字符串序列化并保持语法有效", () => {
  const scriptId = 'quoted"\\line\nseparator\u2028paragraph\u2029';
  const template = createBusinessScriptInitTemplate(scriptId);
  const expectedRegistryKey = `kww.business-script.${scriptId}`;
  const expectedSymbolKey = JSON.stringify(expectedRegistryKey).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  assert.equal(template.registryKey, expectedRegistryKey);
  assert.ok(template.text.includes(`Symbol.for(${expectedSymbolKey})`));
  assert.match(template.text, /window\[instanceKey\] = true/);
  const syntax = spawnSync(process.execPath, ["--check"], { input: template.text, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("空文档、光标插入和选区替换都只改当前范围并把光标放到 TODO 空行", () => {
  const template = createBusinessScriptInitTemplate("script-selection");
  const empty = planBusinessScriptTemplateInsertion("", 0, 0, template);
  assert.equal(empty.resultingValue, template.text);
  assert.equal(empty.cursorOffset, template.cursorOffset);

  const cursorSource = "prefixsuffix";
  const cursor = "prefix".length;
  const atCursor = planBusinessScriptTemplateInsertion(cursorSource, cursor, cursor, template);
  assert.equal(atCursor.resultingValue, `prefix${template.text}suffix`);
  assert.equal(atCursor.resultingValue.slice(0, cursor), "prefix");
  assert.equal(atCursor.resultingValue.slice(atCursor.cursorOffset - 4, atCursor.cursorOffset), "    ");
  assert.equal(atCursor.resultingValue[atCursor.cursorOffset], "\n");

  const selectedSource = "before selected text after";
  const start = selectedSource.indexOf("selected");
  const end = start + "selected text".length;
  const selected = planBusinessScriptTemplateInsertion(selectedSource, start, end, template);
  assert.equal(selected.resultingValue, `before ${template.text} after`);
  assert.equal(selected.resultingValue.slice(0, start), "before ");
  assert.equal(selected.resultingValue.slice(selected.cursorOffset - 4, selected.cursorOffset), "    ");
  assert.equal(selected.resultingValue[selected.cursorOffset], "\n");
  assert.ok(selected.cursorOffset > start && selected.cursorOffset < start + template.text.length);
});

test("无效插入范围与空脚本 ID 被拒绝", () => {
  const template = createBusinessScriptInitTemplate("script-valid");
  assert.throws(() => createBusinessScriptInitTemplate("  "), /ID 不能为空/);
  assert.throws(() => planBusinessScriptTemplateInsertion("abc", 2, 1, template), /选区无效/);
  assert.throws(() => planBusinessScriptTemplateInsertion("abc", 0, 4, template), /选区无效/);
});

test("公共模块或方法缺失时不半初始化，业务初始化失败后可重试", () => {
  const template = createBusinessScriptInitTemplate("script-retry");
  const dependencySource = template.text.replace(
    "const KWW_PUBLIC_DEPENDENCIES = [];",
    'const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"COMMON_FUN","methods":["format"]}];'
  );
  const window = {};
  const logs = [];
  const modules = new Map();
  window.jssdk = { public: { get: (identifier) => modules.get(identifier) } };
  const sandbox = {
    window,
    console: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    Map,
    Symbol,
  };
  const execute = (source) => vm.runInNewContext(`{\n${source}\n}`, sandbox);

  execute(dependencySource);
  assert.equal(window[Symbol.for(template.registryKey)], undefined, "缺失模块不得写单例标记");
  assert.ok(logs.some((args) => args.join(" ").includes("公共脚本依赖未就绪：COMMON_FUN")));

  modules.set("COMMON_FUN", Object.freeze({}));
  execute(dependencySource);
  assert.equal(window[Symbol.for(template.registryKey)], undefined, "缺失导出方法不得半初始化");
  assert.ok(logs.some((args) => args.join(" ").includes("COMMON_FUN.format")));

  modules.set("COMMON_FUN", Object.freeze({ format: () => "ok" }));
  execute(dependencySource);
  assert.equal(window[Symbol.for(template.registryKey)], true, "修复依赖后同一脚本可重试成功");

  const failingInitialization = dependencySource.replace("// TODO: 在此编写业务逻辑", 'throw new Error("business failure");');
  delete window[Symbol.for(template.registryKey)];
  execute(failingInitialization);
  assert.equal(window[Symbol.for(template.registryKey)], undefined, "业务初始化失败必须释放单例标记");
  execute(dependencySource);
  assert.equal(window[Symbol.for(template.registryKey)], true, "业务初始化修复后可以再次运行");
});
