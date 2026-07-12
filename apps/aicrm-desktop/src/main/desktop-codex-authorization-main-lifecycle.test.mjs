import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopCodexAuthorizationMainLifecycle,
  DesktopCodexAuthorizationQuitFence
} from "./desktop-codex-authorization-main-lifecycle.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const calls = [];
  const lifecycle = new DesktopCodexAuthorizationMainLifecycle({
    async waitForRequestFence() {
      calls.push("request_fence");
      if (options.fenceGate) await options.fenceGate.promise;
      if (options.failAt === "request_fence") throw new Error("private fence failure");
    },
    async initializeCredentials() {
      calls.push("credentials");
      if (options.failAt === "credentials") throw new Error("private path failure");
    },
    async recoverOnStartup() {
      calls.push("recovery");
      if (options.failAt === "recovery") throw new Error("private token failure");
    },
    async shutdownRuntime() {
      calls.push("shutdown");
      if (options.failAt === "shutdown") throw new Error("private child failure");
    }
  });
  return { calls, lifecycle };
}

test("twenty initialize callers share the exact ordered one-shot readiness fence", async () => {
  const gate = deferred();
  const current = fixture({ fenceGate: gate });
  const operations = Array.from({ length: 20 }, () => current.lifecycle.initialize());
  assert.equal(current.lifecycle.getState(), "initializing");
  assert.deepEqual(current.calls, ["request_fence"]);
  gate.resolve();
  await Promise.all(operations);
  assert.equal(current.lifecycle.isReady(), true);
  assert.deepEqual(current.calls, ["request_fence", "credentials", "recovery"]);
  assert.equal(await current.lifecycle.initialize(), undefined);
  assert.deepEqual(current.calls, ["request_fence", "credentials", "recovery"]);
});

test("any startup failure is permanently fail-closed and sanitized", async () => {
  for (const failAt of ["request_fence", "credentials", "recovery"]) {
    const current = fixture({ failAt });
    await assert.rejects(current.lifecycle.initialize(), (error) => {
      assert.equal(error.code, "desktop_codex_authorization_main_unavailable");
      assert.equal(String(error).includes("private"), false);
      assert.equal(String(error.stack).includes("private"), false);
      return true;
    });
    assert.equal(current.lifecycle.getState(), "failed");
    await assert.rejects(current.lifecycle.initialize(), {
      code: "desktop_codex_authorization_main_unavailable"
    });
  }
});

test("shutdown is idempotent, waits for initialization, and closes admission", async () => {
  const gate = deferred();
  const current = fixture({ fenceGate: gate });
  const initialize = current.lifecycle.initialize();
  const stops = Array.from({ length: 20 }, () => current.lifecycle.shutdown());
  assert.equal(current.lifecycle.getState(), "stopping");
  assert.equal(current.calls.includes("shutdown"), false);
  gate.resolve();
  await initialize;
  await Promise.all(stops);
  assert.equal(current.lifecycle.getState(), "stopped");
  assert.equal(current.calls.filter((value) => value === "shutdown").length, 1);
  await assert.rejects(current.lifecycle.initialize(), {
    code: "desktop_codex_authorization_main_unavailable"
  });
  await current.lifecycle.shutdown();
  assert.equal(current.calls.filter((value) => value === "shutdown").length, 1);
});

test("shutdown failure remains one-shot and never leaks dependency details", async () => {
  const current = fixture({ failAt: "shutdown" });
  await current.lifecycle.initialize();
  await assert.rejects(current.lifecycle.shutdown(), (error) => {
    assert.equal(error.code, "desktop_codex_authorization_main_unavailable");
    assert.equal(String(error).includes("private"), false);
    return true;
  });
  assert.equal(current.lifecycle.getState(), "stopped");
  await assert.rejects(current.lifecycle.shutdown(), {
    code: "desktop_codex_authorization_main_unavailable"
  });
  assert.equal(current.calls.filter((value) => value === "shutdown").length, 1);
});

test("every repeated quit stays prevented until the exact shutdown fence settles", async () => {
  const gate = deferred();
  let shutdownCalls = 0;
  let quitCalls = 0;
  const fence = new DesktopCodexAuthorizationQuitFence({
    async shutdown() {
      shutdownCalls += 1;
      await gate.promise;
    },
    quit() {
      quitCalls += 1;
    }
  });
  const events = Array.from({ length: 20 }, () => ({ prevented: 0, preventDefault() {
    this.prevented += 1;
  } }));
  for (const event of events) fence.handleBeforeQuit(event);
  await Promise.resolve();
  assert.equal(shutdownCalls, 1);
  assert.equal(quitCalls, 0);
  assert.equal(events.every((event) => event.prevented === 1), true);
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitCalls, 1);
  const finalEvent = { prevented: 0, preventDefault() { this.prevented += 1; } };
  fence.handleBeforeQuit(finalEvent);
  assert.equal(finalEvent.prevented, 0);
  assert.equal(shutdownCalls, 1);
});
