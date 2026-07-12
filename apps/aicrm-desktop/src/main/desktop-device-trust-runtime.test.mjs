import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DesktopDeviceTrustRuntime } from "./desktop-device-trust-runtime.ts";

const oldIdentity = {
  deviceId: "1".repeat(64),
  publicKey: "old-public-key",
  keyGeneration: 1,
  registrationStatus: "unregistered",
  createdAt: "2026-07-13T00:00:00.000Z",
  registeredAt: null
};

const registeredIdentity = {
  ...oldIdentity,
  registrationStatus: "registered",
  registeredAt: "2026-07-13T00:01:00.000Z"
};

class FakeIdentityStore {
  constructor(identity = oldIdentity) {
    this.identity = { ...identity };
    this.resetCalls = 0;
  }

  async getIdentity() {
    return { ...this.identity };
  }

  async resetRegistrationRecovery(expectedDeviceId, clearPending) {
    this.resetCalls += 1;
    if (this.identity.registrationStatus !== "unregistered") {
      const error = new Error("registered reset forbidden");
      error.code = "desktop_device_identity_reset_forbidden";
      throw error;
    }
    assert.equal(expectedDeviceId, this.identity.deviceId);
    await clearPending();
    this.identity = {
      ...oldIdentity,
      deviceId: "2".repeat(64),
      publicKey: "replacement-public-key"
    };
    return { ...this.identity };
  }
}

class FakePendingStore {
  constructor(pending = null) {
    this.pending = pending;
    this.clearCalls = [];
  }

  async load() {
    return this.pending ? { ...this.pending } : null;
  }

  async clearRegistrationRecovery(deviceId) {
    this.clearCalls.push(deviceId);
    this.pending = null;
  }
}

class FakeRegistrationClient {
  constructor(result = registeredIdentity) {
    this.result = result;
    this.calls = 0;
    this.cancelCalls = 0;
    this.deferred = null;
  }

  async register() {
    this.calls += 1;
    if (this.deferred) return this.deferred;
    if (this.result instanceof Error) throw this.result;
    return { ...this.result };
  }

  cancel() {
    this.cancelCalls += 1;
  }
}

class FakeHeartbeatClient {
  constructor() {
    this.startCalls = 0;
    this.stopCalls = 0;
  }

  start() {
    this.startCalls += 1;
  }

  stop() {
    this.stopCalls += 1;
  }
}

function runtimeFixture({ identity = oldIdentity, pending = null, result = registeredIdentity, session = null } = {}) {
  const identityStore = new FakeIdentityStore(identity);
  const pendingStore = new FakePendingStore(pending);
  const client = new FakeRegistrationClient(result);
  const heartbeatClient = new FakeHeartbeatClient();
  const runtime = new DesktopDeviceTrustRuntime({
    identityStore,
    pendingRegistrationStore: pendingStore,
    registrationClient: client,
    heartbeatClient,
    loadHostSession: async () => session,
    now: () => new Date("2026-07-13T00:05:00.000Z")
  });
  return { runtime, identityStore, pendingStore, client, heartbeatClient };
}

test("session-save notification and concurrent ensure share one Main registration operation", async () => {
  const current = runtimeFixture();
  let resolve;
  current.client.deferred = new Promise((done) => {
    resolve = done;
  });
  current.runtime.notifySessionSaved();
  const calls = Array.from({ length: 24 }, () => current.runtime.ensureRegistration());
  await new Promise((done) => setImmediate(done));
  assert.equal(current.client.calls, 1);
  resolve(registeredIdentity);
  const states = await Promise.all(calls);
  assert.equal(states.every((state) => state.status === "registered"), true);
  assert.equal(current.heartbeatClient.startCalls, 1);
});

test("restart resumes only when the encrypted Main session exists", async () => {
  const withSession = runtimeFixture({
    session: { token: "host-session", expiresAt: "2026-07-13T01:00:00.000Z" }
  });
  assert.equal((await withSession.runtime.resumeAfterStartup()).status, "registered");
  assert.equal(withSession.client.calls, 1);

  const withoutSession = runtimeFixture();
  assert.equal((await withoutSession.runtime.resumeAfterStartup()).status, "idle");
  assert.equal(withoutSession.client.calls, 0);
});

test("session clear cancels in-flight and fences its late completion", async () => {
  const current = runtimeFixture();
  let resolve;
  current.client.deferred = new Promise((done) => {
    resolve = done;
  });
  const operation = current.runtime.ensureRegistration();
  await new Promise((done) => setImmediate(done));
  const cancelled = current.runtime.cancelAutomaticRegistration();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(current.client.cancelCalls, 1);
  assert.equal(current.heartbeatClient.stopCalls, 1);
  resolve(registeredIdentity);
  assert.equal((await operation).status, "cancelled");
  assert.equal((await current.runtime.getRegistrationState()).status, "cancelled");
});

test("Bearer-change recovery requires explicit reset, rotates local identity, and reports backend rebind", async () => {
  const recovery = new Error("Bearer changed");
  recovery.code = "desktop_device_registration_recovery_required";
  const pending = { deviceId: oldIdentity.deviceId, requestHash: "a".repeat(64) };
  const current = runtimeFixture({ pending, result: recovery });
  assert.equal((await current.runtime.ensureRegistration()).status, "recovery_required");
  await assert.rejects(current.runtime.resetRegistrationRecovery({ confirm: false }), {
    code: "desktop_device_registration_reset_confirmation_required"
  });
  current.client.result = { ...registeredIdentity, deviceId: "2".repeat(64), publicKey: "replacement-public-key" };
  const reset = await current.runtime.resetRegistrationRecovery({ confirm: true });
  assert.equal(current.identityStore.resetCalls, 1);
  assert.deepEqual(current.pendingStore.clearCalls, [oldIdentity.deviceId]);
  assert.equal(reset.status, "registered");
  assert.equal(reset.deviceId, "2".repeat(64));
  assert.equal(reset.backendRebindRequired, true);
  assert.match(reset.message, /后台执行 rebind/);
});

test("registered identity can never be reset through recovery IPC semantics", async () => {
  const recovery = new Error("forged recovery state");
  recovery.code = "desktop_device_registration_recovery_required";
  const current = runtimeFixture({ identity: registeredIdentity, result: recovery });
  await current.runtime.ensureRegistration();
  assert.equal((await current.runtime.getRegistrationState()).status, "registered");
  await assert.rejects(current.runtime.resetRegistrationRecovery({ confirm: true }), {
    code: "desktop_device_registration_reset_forbidden"
  });
  assert.equal(current.identityStore.resetCalls, 0);
});

test("Main wiring owns one signer and session save triggers registration without enabling Codex Bridge", async () => {
  const [main, trustMain, authIpc, deviceIpc, codexPolicy] = await Promise.all([
    readFile(new URL("./index.ts", import.meta.url), "utf8"),
    readFile(new URL("./desktop-device-trust-main.ts", import.meta.url), "utf8"),
    readFile(new URL("./ipc/auth-ipc.ts", import.meta.url), "utf8"),
    readFile(new URL("./ipc/desktop-device-ipc.ts", import.meta.url), "utf8"),
    readFile(new URL("./codex-authorization-bridge-v2-policy.ts", import.meta.url), "utf8")
  ]);
  assert.equal((trustMain.match(/new DesktopDeviceIdentityStore/g) ?? []).length, 1);
  assert.equal((trustMain.match(/new DesktopDevicePendingRegistrationStore/g) ?? []).length, 1);
  assert.equal((trustMain.match(/new DesktopDeviceRegistrationClient/g) ?? []).length, 1);
  assert.equal((trustMain.match(/new DesktopDeviceHeartbeatClient/g) ?? []).length, 1);
  assert.equal((trustMain.match(/new DesktopDeviceRequestLane/g) ?? []).length, 1);
  assert.equal((trustMain.match(/new DesktopDeviceRequestJournalStore/g) ?? []).length, 1);
  assert.equal((trustMain.match(/new DesktopExecutorDeviceBindingClient/g) ?? []).length, 1);
  assert.match(trustMain, /app\.whenReady\(\)\.then\(\(\) =>[\s\S]*restoreDesktopDeviceRequestJournalPin/);
  assert.match(trustMain, /requestFenceReady\.then\(\(\) => this\.requestLane\.waitUntilUnpinned\(\)\)/);
  assert.match(trustMain, /restoreDesktopDeviceRequestJournalPin\([\s\S]*requestJournal,[\s\S]*requestLane/);
  assert.ok(
    trustMain.indexOf("restoreDesktopDeviceRequestJournalPin") <
      trustMain.indexOf("new DesktopDeviceHeartbeatClient")
  );
  assert.equal(deviceIpc.includes("new DesktopDeviceIdentityStore"), false);
  assert.equal((main.match(/getDesktopDeviceTrustMainServices\(\)/g) ?? []).length, 1);
  assert.match(
    main,
    /const desktopDeviceTrustRuntime = desktopDeviceTrustServices\.runtime/
  );
  assert.match(main, /registerAuthIpc\(desktopDeviceTrustRuntime\)/);
  assert.match(main, /registerDesktopDeviceIpc\(desktopDeviceTrustRuntime\)/);
  assert.match(
    main,
    /registerDesktopExecutorDeviceBindingIpc\([\s\S]*desktopDeviceTrustServices\.executorDeviceBindingClient/
  );
  assert.match(main, /resumeAfterStartup\(\)/);
  assert.match(authIpc, /await saveSession\(session\)[\s\S]*trustRuntime\.notifySessionSaved\(\)/);
  assert.match(authIpc, /trustRuntime\.cancelAutomaticRegistration\(\)[\s\S]*await clearSession\(\)/);
  assert.match(codexPolicy, /CODEX_AUTHORIZATION_RUNTIME_UNAVAILABLE_ERROR/);
  assert.equal(codexPolicy.includes("DesktopDeviceTrustRuntime"), false);
});
