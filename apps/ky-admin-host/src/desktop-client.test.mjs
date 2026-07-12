import assert from "node:assert/strict";
import test from "node:test";
import { aiExecutorDesktopPort } from "./desktop-client.ts";

function setWindow(value) {
  if (value === undefined) {
    delete globalThis.window;
    return;
  }
  globalThis.window = value;
}

test("Host returns no trust bridge outside Desktop or when either preload method is absent", () => {
  setWindow(undefined);
  assert.equal(aiExecutorDesktopPort.getTrustBridge(), null);

  setWindow({ aicrm: { app: { getVersion: async () => "0.1.0" } } });
  assert.equal(aiExecutorDesktopPort.getTrustBridge(), null);

  setWindow({
    aicrm: {
      app: { getVersion: async () => "0.1.0" },
      desktopDevice: { ensureRegistration: async () => ({ ok: true }) }
    }
  });
  assert.equal(aiExecutorDesktopPort.getTrustBridge(), null);

  setWindow({
    aicrm: {
      app: { getVersion: async () => "0.1.0" },
      aiExecutor: { bindDevice: async () => ({ ok: true }) }
    }
  });
  assert.equal(aiExecutorDesktopPort.getTrustBridge(), null);
  setWindow(undefined);
});

test("Host composes only registration and binding into the Core trust port", async (t) => {
  t.after(() => setWindow(undefined));
  const bindCalls = [];
  const registration = {
    ok: true,
    data: {
      status: "registered",
      deviceId: "a".repeat(64),
      registrationStatus: "registered",
      errorCode: null,
      updatedAt: "2026-07-13T11:00:00.000Z",
      backendRebindRequired: false,
      message: "设备已安全登记"
    }
  };
  const bound = {
    ok: true,
    data: {
      binding: {
        executorId: "executor_1",
        deviceId: "a".repeat(64),
        status: "active",
        revision: 1,
        force: false,
        updatedAt: "2026-07-13T11:00:01.000Z"
      },
      replayed: false
    }
  };
  setWindow({
    aicrm: {
      app: { getVersion: async () => "0.1.0" },
      desktopDevice: {
        ensureRegistration: async () => registration,
        getIdentity: async () => ({ privateKey: "must-not-be-reachable" })
      },
      aiExecutor: {
        bindDevice: async (input) => {
          bindCalls.push(input);
          return bound;
        },
        authorizationToken: "Bearer must-not-be-reachable",
        apiBaseUrl: "https://must-not-be-reachable.invalid"
      }
    }
  });

  const bridge = aiExecutorDesktopPort.getTrustBridge();
  assert.deepEqual(Object.keys(bridge).sort(), ["bindExecutorDevice", "ensureRegistration"]);
  assert.equal(await bridge.ensureRegistration(), registration);
  assert.equal(
    await bridge.bindExecutorDevice({ executorId: "executor_1", expectedRevision: 0 }),
    bound
  );
  assert.deepEqual(bindCalls, [{ executorId: "executor_1", expectedRevision: 0 }]);
  const projection = JSON.stringify(Object.keys(bridge));
  for (const canary of ["privateKey", "Bearer", "apiBaseUrl", "must-not-be-reachable"]) {
    assert.equal(projection.includes(canary), false);
  }
});
