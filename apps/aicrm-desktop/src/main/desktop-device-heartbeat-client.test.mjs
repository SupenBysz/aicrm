import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_DEVICE_HEARTBEAT_INTERVAL_MS,
  DesktopDeviceHeartbeatClient
} from "./desktop-device-heartbeat-client.ts";
import {
  buildDesktopDeviceProof,
  desktopDeviceKeyMaterialFromSeed
} from "./desktop-device-proof.ts";

const now = new Date("2026-07-13T08:00:00.000Z");
const key = desktopDeviceKeyMaterialFromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => index + 1)
);
const identity = {
  deviceId: key.deviceId,
  publicKey: key.publicKey,
  keyGeneration: 1,
  registrationStatus: "registered",
  createdAt: "2026-07-13T07:59:00.000Z",
  registeredAt: "2026-07-13T07:59:30.000Z"
};

class FakeIdentityStore {
  constructor() {
    this.identity = { ...identity };
    this.sequence = 0n;
    this.signed = [];
  }

  async getIdentity() {
    return { ...this.identity };
  }

  async signRequest(input) {
    this.sequence += 1n;
    const proof = buildDesktopDeviceProof({
      key,
      method: input.method,
      path: input.path,
      body: input.body,
      timestamp: now.getTime(),
      nonce: Buffer.alloc(16, Number(this.sequence)).toString("base64url"),
      sequence: this.sequence
    });
    this.signed.push({ ...input, body: Buffer.from(input.body), proof });
    return {
      ...proof,
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      keyGeneration: 1,
      sequence: this.sequence.toString(10)
    };
  }
}

function jsonResponse(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(value);
    }
  };
}

function success(sequence) {
  return jsonResponse(200, {
    data: {
      deviceId: identity.deviceId,
      sequence,
      acceptedAt: "2026-07-13T08:00:00.123456Z"
    },
    requestId: "heartbeat-request"
  });
}

function clientFixture(overrides = {}) {
  const identityStore = overrides.identityStore ?? new FakeIdentityStore();
  const requests = [];
  const client = new DesktopDeviceHeartbeatClient({
    identityStore,
    appVersion: "0.1.0",
    loadTrustedApiBaseUrl: () => "https://aicrm.example.test",
    now: () => now,
    requestIdFactory: () => "desktop-heartbeat-request",
    requestTimeoutMs: 5_000,
    fetch:
      overrides.fetch ??
      (async (url, init) => {
        requests.push({ url, init });
        return success(Number(identityStore.sequence));
      }),
    setTimer: overrides.setTimer,
    clearTimer: overrides.clearTimer
  });
  return { client, identityStore, requests };
}

test("heartbeat signs the exact device-only contract without Bearer, workspace, or Codex capability", async () => {
  const current = clientFixture();
  const result = await current.client.heartbeat();

  assert.equal(result.deviceId, identity.deviceId);
  assert.equal(result.sequence, 1);
  assert.equal(current.requests.length, 1);
  const request = current.requests[0];
  assert.equal(
    request.url,
    `https://aicrm.example.test/api/v1/ai-executor-devices/${identity.deviceId}/heartbeat`
  );
  assert.deepEqual(JSON.parse(request.init.body), {
    bridgeVersion: 2,
    appVersion: "0.1.0",
    capabilities: { supportsDeviceProof: true },
    occurredAt: now.toISOString()
  });
  for (const forbidden of [
    "Authorization",
    "X-KY-Workspace-Type",
    "X-KY-Workspace-Id",
    "Idempotency-Key"
  ]) {
    assert.equal(forbidden in request.init.headers, false);
  }
  assert.equal(request.init.headers["X-AiCRM-Device-Id"], identity.deviceId);
  assert.equal(request.init.headers["X-AiCRM-Device-Sequence"], "1");
  assert.equal(request.init.headers["X-KY-Request-Id"], "desktop-heartbeat-request");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.cache, "no-store");
  assert.equal(request.init.credentials, "omit");
  assert.equal(current.identityStore.signed[0].proof.authorizationTokenHash, "");
  assert.equal(request.init.body.includes("supportsAppServerAuth"), false);
  assert.equal(request.init.body.includes("scriptMaintenanceReady"), false);
});

test("concurrent heartbeat calls share one signed sequence and one transport", async () => {
  let resolveResponse;
  let fetchCalls = 0;
  const current = clientFixture({
    fetch: async () => {
      fetchCalls += 1;
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    }
  });
  const first = current.client.heartbeat();
  const second = current.client.heartbeat();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 1);
  assert.equal(current.identityStore.sequence, 1n);
  resolveResponse(success(1));
  assert.deepEqual(await first, await second);
});

test("response loss and Main restart recover with a fresh monotonically signed heartbeat", async () => {
  const identityStore = new FakeIdentityStore();
  const beforeRestart = clientFixture({
    identityStore,
    fetch: async () => {
      throw new Error("response lost after possible server commit");
    }
  });
  await assert.rejects(beforeRestart.client.heartbeat(), {
    code: "desktop_device_heartbeat_transport_failed"
  });
  assert.equal(identityStore.sequence, 1n);

  const requests = [];
  const afterRestart = clientFixture({
    identityStore,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return success(2);
    }
  });
  assert.equal((await afterRestart.client.heartbeat()).sequence, 2);
  assert.equal(identityStore.sequence, 2n);
  assert.equal(requests[0].init.headers["X-AiCRM-Device-Sequence"], "2");
});

test("start sends immediately, schedules only after completion, and stop aborts without rescheduling", async () => {
  const scheduled = [];
  const cleared = [];
  let signal;
  let fetchStarted;
  const started = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  const current = clientFixture({
    fetch: async (_url, init) => {
      signal = init.signal;
      fetchStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimer: (timer) => cleared.push(timer)
  });
  current.client.start();
  current.client.start();
  await started;
  assert.equal(current.identityStore.sequence, 1n);
  assert.equal(scheduled.length, 0);
  current.client.stop();
  assert.equal(signal.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 0);
  assert.equal(cleared.length, 0);
});

test("successful loop uses the locked 30 second interval and stop clears it", async () => {
  const scheduled = [];
  const cleared = [];
  const current = clientFixture({
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimer: (timer) => cleared.push(timer)
  });
  current.client.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, DESKTOP_DEVICE_HEARTBEAT_INTERVAL_MS);
  current.client.stop();
  assert.deepEqual(cleared, [scheduled[0]]);
});

test("a rapid session clear and relogin waits for abort then sends a fresh heartbeat immediately", async () => {
  let fetchCalls = 0;
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const scheduled = [];
  const current = clientFixture({
    fetch: async (_url, init) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        firstStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return success(2);
    },
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimer: () => undefined
  });
  current.client.start();
  await started;
  current.client.stop();
  current.client.start();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 2);
  assert.equal(current.identityStore.sequence, 2n);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, DESKTOP_DEVICE_HEARTBEAT_INTERVAL_MS);
  current.client.stop();
});

test("unregistered identity and unsafe response projections fail closed", async () => {
  const unregisteredStore = new FakeIdentityStore();
  unregisteredStore.identity.registrationStatus = "unregistered";
  const unregistered = clientFixture({ identityStore: unregisteredStore });
  await assert.rejects(unregistered.client.heartbeat(), { code: "desktop_device_not_registered" });
  assert.equal(unregisteredStore.sequence, 0n);

  const invalid = clientFixture({
    fetch: async () =>
      jsonResponse(200, {
        data: {
          deviceId: identity.deviceId,
          sequence: 1,
          acceptedAt: now.toISOString(),
          credentialPath: "/secret"
        }
      })
  });
  await assert.rejects(invalid.client.heartbeat(), {
    code: "desktop_device_heartbeat_response_invalid"
  });
});
