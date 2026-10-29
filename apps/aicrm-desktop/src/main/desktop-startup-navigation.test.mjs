import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopStartupNavigationController } from "./desktop-startup-navigation.ts";

function harness() {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const loads = [];
  const diagnostics = [];
  let shown = 0;
  const controller = createDesktopStartupNavigationController({
    webUrl: "https://console.example.test/login?secret=do-not-log",
    offlineUrl: "kww-offline://local/",
    loadUrl: (url) => loads.push(url),
    showWindow: () => { shown += 1; },
    isWebUrl: (url) => {
      try { return new URL(url).origin === "https://console.example.test"; } catch { return false; }
    },
    log: (diagnostic) => diagnostics.push(diagnostic),
    setTimer: (callback, delayMs) => {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delayMs });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    shellDelayMs: 5_000,
    navigationTimeoutMs: 30_000
  });
  function advance(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = end;
  }
  return { controller, loads, diagnostics, advance, get shown() { return shown; } };
}

test("五秒显示窗口但不打断仍在加载的导航", () => {
  const h = harness();
  h.controller.start();
  h.advance(5_000);
  assert.equal(h.shown, 1);
  assert.equal(h.controller.phase, "loading");
  assert.equal(h.controller.onMainFrameFinished("https://console.example.test/workbench"), true);
  h.advance(60_000);
  assert.equal(h.controller.phase, "ready");
  assert.equal(h.loads.length, 1);
  assert.deepEqual(h.diagnostics, []);
});

test("主框架失败进入离线页，重试后可恢复且日志不含完整 URL", () => {
  const h = harness();
  h.controller.start();
  assert.equal(h.controller.onMainFrameFailed(-3, "https://console.example.test/login", true), false);
  assert.equal(h.controller.onMainFrameFailed(-105, "https://console.example.test/login?token=private", false), false);
  assert.equal(h.controller.onMainFrameFailed(-105, "https://console.example.test/login?token=private", true), true);
  assert.equal(h.controller.phase, "offline");
  assert.equal(h.loads.at(-1), "kww-offline://local/");
  assert.deepEqual(h.diagnostics, [{ event: "startup_navigation_failed", host: "console.example.test", errorCode: -105 }]);
  assert.equal(JSON.stringify(h.diagnostics).includes("private"), false);
  assert.equal(h.controller.retry(), true);
  assert.equal(h.controller.onMainFrameFinished("https://console.example.test/workbench"), true);
  assert.equal(h.controller.phase, "ready");
});

test("导航超时可进入离线页，销毁后清理计时器", () => {
  const h = harness();
  h.controller.start();
  h.advance(30_000);
  assert.equal(h.controller.phase, "offline");
  assert.equal(h.loads.at(-1), "kww-offline://local/");
  assert.deepEqual(h.diagnostics.at(-1), { event: "startup_navigation_timeout", host: "console.example.test", errorCode: null });
  assert.equal(h.controller.retry(), true);
  h.controller.dispose();
  const loadCount = h.loads.length;
  h.advance(60_000);
  assert.equal(h.loads.length, loadCount);
  assert.equal(h.controller.phase, "disposed");
});

test("loadURL promise 拒绝时进入离线页", async () => {
  const loads = [];
  const diagnostics = [];
  const controller = createDesktopStartupNavigationController({
    webUrl: "https://console.example.test/",
    offlineUrl: "kww-offline://local/",
    loadUrl: (url) => {
      loads.push(url);
      if (url.startsWith("https:")) return Promise.reject(new Error("navigation rejected"));
    },
    showWindow: () => undefined,
    isWebUrl: (url) => url.startsWith("https://console.example.test/"),
    log: (diagnostic) => diagnostics.push(diagnostic),
    setTimer: () => 1,
    clearTimer: () => undefined
  });
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.phase, "offline");
  assert.deepEqual(loads, ["https://console.example.test/", "kww-offline://local/"]);
  assert.deepEqual(diagnostics, [{ event: "startup_navigation_failed", host: "console.example.test", errorCode: null }]);
  controller.dispose();
});
