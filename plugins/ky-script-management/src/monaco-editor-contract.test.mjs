import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = await readFile(resolve(root, "components/monaco-source-editor.tsx"), "utf8");

assert.match(source, /monaco\.editor\.create\(/);
assert.match(source, /onDidChangeCursorSelection/);
assert.match(source, /onDidChangeModelContent/);
assert.match(source, /automaticLayout:\s*true/);
assert.match(source, /editor\.worker\.js\?worker/);
assert.match(source, /ts\.worker\.js\?worker/);
assert.match(source, /registerCompletionItemProvider/);
assert.match(source, /contrib\/find\/browser\/findController\.js/, "native Monaco find contribution is loaded");
assert.match(source, /getAction\("editor\.actions\.findWithArgs"\)/, "find opens through Monaco's native find widget action");
assert.match(source, /editor\.action\.startFindReplaceAction/, "native replace shortcut is explicitly controlled");
assert.match(source, /editor\.TextFocus|editorTextFocus/, "user shortcut bindings are limited to editor text focus");
assert.match(source, /if \(replace && !editable\) return false/, "read-only previews cannot execute replace");
assert.match(source, /onDidChangeModelContent\(\(\) =>/, "native replace edits flow through Monaco's existing change listener");

const javascriptStart = source.indexOf('setMonarchTokensProvider("javascript"');
const cssStart = source.indexOf('setMonarchTokensProvider("css"', javascriptStart);
assert.notEqual(javascriptStart, -1, "JavaScript Monarch tokenizer must be registered");
assert.notEqual(cssStart, -1, "CSS Monarch tokenizer must be registered");
const javascriptTokenizer = source.slice(javascriptStart, cssStart);
const cssTokenizer = source.slice(cssStart, source.indexOf("languageSupportReady = true", cssStart));
const assertMultilineCommentState = (tokenizer, language) => {
  assert.ok(tokenizer.includes(String.raw`[/\/\*/, { token: "comment", next: "@comment" }]`), `${language} must enter a persistent comment state at /*`);
  assert.ok(tokenizer.includes(String.raw`comment: [[/[^*]+/, "comment"], [/\*\//, { token: "comment", next: "@pop" }], [/\*/, "comment"]]`), `${language} must color comment text and return to the previous state at */`);
};

assertMultilineCommentState(javascriptTokenizer, "JavaScript");
assertMultilineCommentState(cssTokenizer, "CSS");
assert.equal(javascriptTokenizer.includes(String.raw`/\/\*[\s\S]*?\*\//`), false, "JavaScript must not rely on a cross-line complete-comment regex");
assert.equal(cssTokenizer.includes(String.raw`/\/\*.*\*\//`), false, "CSS must not rely on a single-line complete-comment regex");
