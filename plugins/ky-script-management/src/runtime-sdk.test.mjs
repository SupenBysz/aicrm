import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("浏览器 SDK 提供分层能力并对宿主能力明确降级", async () => {
  const source = await readFile(new URL("./runtime-sdk.ts", import.meta.url), "utf8");
  assert.match(source, /installBrowserPageSdk/);
  assert.match(source, /HOST_CAPABILITY_UNAVAILABLE/);
  assert.match(source, /publicApi/);
  assert.match(source, /lifecycle/);
  assert.match(source, /lifecycleState\.set\(event, detail\)/);
  for (const method of ["subscribeRequest", "subscribeResponse", "waitForRequest", "waitForResponse", "interceptRequest", "interceptResponse"]) {
    assert.match(source, new RegExp(method));
  }
});

test("浏览器 fallback 暴露店铺 SDK 形状并明确拒绝宿主写入能力", async () => {
  const source = await readFile(new URL("./runtime-sdk.ts", import.meta.url), "utf8");
  assert.match(source, /const host = \{[^\n]*upload: \(\) => unavailable/);
  assert.match(source, /const store = \{ getStoreInfo: \(\) => unavailable<unknown>\(\), setStoreInfo: \(\) => unavailable<unknown>\(\) \}/);
  assert.match(source, /const sdk = \{ version: "1", host, store,/);
});
