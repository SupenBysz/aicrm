import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMenuRuntimeSchedule, menuRuntimeAssetSource, menuWebViewUrlAllowed, validMenuWebViewBounds, validMenuWebViewOpenInput } from "./menu-webview-runtime-core.mjs";

const menuWebViewIpcSource = await readFile(new URL("./ipc/menu-webview-ipc.ts", import.meta.url), "utf8");

test("menu WebView IPC validators reject malformed or off-origin input", () => {
  assert.equal(validMenuWebViewOpenInput({ directoryType: "management", menuKey: "catalog.home", workspaceType: "platform", workspaceId: "platform_root" }), true);
  assert.equal(validMenuWebViewOpenInput({ directoryType: "management", menuKey: "../outside", workspaceType: "platform", workspaceId: "platform_root" }), false);
  assert.equal(validMenuWebViewBounds({ instanceId: "i", x: 0, y: 0, width: 0, height: 100, visible: true }), false);
  assert.equal(menuWebViewUrlAllowed("javascript:alert(1)", ["https", "javascript"]), false);
  assert.equal(menuWebViewUrlAllowed("https://user:pass@example.com", ["https"]), false);
  assert.equal(menuWebViewUrlAllowed("https://example.com/path", ["https"]), true);
});

test("menu navigation sets loading only before loadURL and cannot regress a completed navigation", () => {
  const start = menuWebViewIpcSource.indexOf("async function resolveAndNavigate(");
  const end = menuWebViewIpcSource.indexOf("\nfunction detach(", start);
  assert.notEqual(start, -1, "resolveAndNavigate should exist");
  assert.notEqual(end, -1, "resolveAndNavigate boundary should exist");
  const implementation = menuWebViewIpcSource.slice(start, end);
  const loadingEvents = [...implementation.matchAll(/emit\(instance, "loading"\)/g)];
  const loadUrl = implementation.indexOf("await instance.contents.loadURL(data.url)");
  assert.equal(loadingEvents.length, 1, "only navigation start emits loading");
  assert.ok(loadingEvents[0].index < loadUrl, "loading must be emitted before awaiting loadURL");
  assert.match(menuWebViewIpcSource, /contents\.on\("did-finish-load"[\s\S]*?emit\(instance, "ready"/);
});

test("bound styles precede scripts and each configured runAt is scheduled once", () => {
  const plan = createMenuRuntimeSchedule({
    public: [{ identifier: "COMMON", version: "1.0.0", source: "register()", sourceBytes: 10, sourceSha256: "hash" }],
    publicStyles: [{ identifier: "RESET", version: "1", sourceContent: "body{}", sourceBytes: 6, sourceSha256: "hash", runAt: "document_start", priority: 0 }],
    assets: [
      { id: "js2", identifier: "B", version: "1.0.0", assetType: "script", runAt: "dom_content_loaded", priority: 2, sourceContent: "b()", sourceBytes: 3, sourceSha256: "hash" },
      { id: "css1", identifier: "A_STYLE", version: "1.0.0", assetType: "style", runAt: "document_start", priority: 1, sourceContent: "a{}", sourceBytes: 3, sourceSha256: "hash" },
      { id: "js1", identifier: "A", version: "1.0.0", assetType: "script", runAt: "document_start", priority: 1, sourceContent: "a()", sourceBytes: 3, sourceSha256: "hash" }
    ]
  });
  const early = plan.byRunAt("document_start");
  assert.deepEqual(early.map((x) => x.identifier), ["RESET", "A_STYLE", "COMMON", "A"]);
  assert.deepEqual(plan.byRunAt("dom_content_loaded").map((x) => x.identifier), ["B"]);
  assert.equal(plan.byRunAt("load").length, 0);
  assert.match(menuRuntimeAssetSource(early[0]), /data-ky-menu-runtime-id/);
  assert.match(menuRuntimeAssetSource(early[0]), /createElement\("style"\)/);
  const samePhase = createMenuRuntimeSchedule({assets:[
    {id:"z",identifier:"Z",assetType:"script",runAt:"document_idle",priority:5},
    {id:"a",identifier:"A",assetType:"script",runAt:"document_idle",priority:1}
  ]});
  assert.deepEqual(samePhase.byRunAt("document_idle").map(item=>item.identifier),["A","Z"]);
});
