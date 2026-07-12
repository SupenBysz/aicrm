import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DESKTOP_DEVICE_REGISTRATION_CHALLENGE_PATH,
  DESKTOP_DEVICE_REGISTRATION_PATH,
  DesktopDeviceRegistrationClient
} from "./desktop-device-registration-client.ts";
import { DesktopDeviceIdentityStore } from "./desktop-device-identity.ts";
import { DesktopDevicePendingRegistrationStore } from "./desktop-device-registration-pending.ts";
import {
  buildDesktopDeviceProof,
  desktopDeviceKeyMaterialFromSeed,
  sha256Hex
} from "./desktop-device-proof.ts";

const deviceId = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const publicKey = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg";
const sessionToken = "host.session.token";
const now = new Date("2026-07-12T00:00:00.000Z");
const challenge = {
  challengeId: "challenge_1",
  challenge: "registration_challenge_value_1",
  expiresAt: "2026-07-12T00:02:00.000Z",
  algorithm: "Ed25519"
};
const fixedKey = desktopDeviceKeyMaterialFromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => index)
);

class FakeSafeStorage {
  isEncryptionAvailable() {
    return true;
  }

  getSelectedStorageBackend() {
    return "gnome_libsecret";
  }

  encryptString(value) {
    const source = Buffer.from(value, "utf8");
    return Buffer.concat([
      Buffer.from("TEST-ENCRYPTED\0"),
      Buffer.from(source.map((byte) => byte ^ 0xa5))
    ]);
  }

  decryptString(value) {
    const prefix = Buffer.from("TEST-ENCRYPTED\0");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("ciphertext invalid");
    return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0xa5)).toString("utf8");
  }
}

function durableStores(root, storage) {
  return {
    identityStore: new DesktopDeviceIdentityStore({
      root,
      safeStorage: storage,
      keyFactory: () => fixedKey,
      now: () => now
    }),
    pendingRegistrationStore: new DesktopDevicePendingRegistrationStore({ root, safeStorage: storage })
  };
}

function durableClient({ root, storage, fetch, token = sessionToken }) {
  const stores = durableStores(root, storage);
  const client = new DesktopDeviceRegistrationClient({
    ...stores,
    deviceLabel: "AiCRM Desktop",
    appVersion: "0.1.0",
    loadHostSession: async () => ({ token, expiresAt: "2026-07-12T01:00:00.000Z" }),
    loadTrustedApiBaseUrl: () => "https://aicrm.example.test",
    now: () => now,
    requestIdFactory: (() => {
      let sequence = 0;
      return () => `durable-request-${++sequence}`;
    })(),
    requestTimeoutMs: 5_000,
    fetch
  });
  return { ...stores, client };
}

async function ambiguousDurableState() {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-registration-replay-"));
  const root = path.join(base, "identity");
  const storage = new FakeSafeStorage();
  const initial = durableStores(root, storage);
  await initial.identityStore.getIdentity();
  const identityBefore = await readFile(path.join(root, "identity.sec"));
  const sequenceBefore = await readFile(path.join(root, "sequence.sec"));
  const requests = [];
  const runtime = durableClient({
    root,
    storage,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith(DESKTOP_DEVICE_REGISTRATION_CHALLENGE_PATH)) {
        return jsonResponse(201, { data: challenge });
      }
      throw new Error("response lost after server commit may have happened");
    }
  });
  await assert.rejects(runtime.client.register(), {
    code: "desktop_device_registration_transport_failed"
  });
  return {
    base,
    root,
    storage,
    requests,
    identityBefore,
    sequenceBefore,
    identityStore: runtime.identityStore,
    pendingRegistrationStore: runtime.pendingRegistrationStore
  };
}

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(data);
    }
  };
}

class FakeIdentityStore {
  constructor({ sequence = "1", status = "unregistered", tamperHeader = null } = {}) {
    this.sequence = sequence;
    this.tamperHeader = tamperHeader;
    this.identity = {
      deviceId,
      publicKey,
      keyGeneration: 1,
      registrationStatus: status,
      createdAt: now.toISOString(),
      registeredAt: null
    };
    this.signed = [];
    this.marked = [];
    this.repaired = [];
  }

  async getIdentity() {
    return { ...this.identity };
  }

  async signRequest(input) {
    this.signed.push({ ...input, body: Buffer.from(input.body) });
    const proof = buildDesktopDeviceProof({
      key: fixedKey,
      method: input.method,
      path: input.path,
      body: input.body,
      authorization: input.authorization,
      allowedAuthorizationSchemes: input.allowedAuthorizationSchemes,
      timestamp: now.getTime(),
      nonce: "AAECAwQFBgcICQoLDA0ODw",
      sequence: BigInt(this.sequence)
    });
    if (this.tamperHeader) proof.headers[this.tamperHeader] = "0".repeat(64);
    return {
      ...proof,
      deviceId,
      publicKey,
      keyGeneration: 1,
      sequence: this.sequence
    };
  }

  async prepareRegistrationRequest(input, persistPending) {
    const signed = await this.signRequest(input);
    await persistPending(signed);
    return signed;
  }

  async repairRegistrationSequence(fence) {
    this.repaired.push({ ...fence });
  }

  async markRegistration(status, expectedDeviceId) {
    this.marked.push({ status, expectedDeviceId });
    this.identity = {
      ...this.identity,
      registrationStatus: status,
      registeredAt: now.toISOString()
    };
    return { ...this.identity };
  }
}

class FakePendingRegistrationStore {
  constructor(value = null) {
    this.value = value;
    this.created = [];
    this.cleared = [];
  }

  async load() {
    return this.value ? structuredClone(this.value) : null;
  }

  async create(value) {
    this.created.push(structuredClone(value));
    if (this.value && JSON.stringify(this.value) !== JSON.stringify(value)) {
      const error = new Error("pending conflict");
      error.code = "desktop_device_registration_recovery_required";
      throw error;
    }
    this.value = structuredClone(value);
  }

  async clear(expectedDeviceId, expectedRequestHash) {
    this.cleared.push({ expectedDeviceId, expectedRequestHash });
    if (
      this.value &&
      (this.value.deviceId !== expectedDeviceId || this.value.requestHash !== expectedRequestHash)
    ) {
      const error = new Error("pending fence mismatch");
      error.code = "desktop_device_registration_recovery_required";
      throw error;
    }
    this.value = null;
  }
}

function fixture(overrides = {}) {
  const identityStore = overrides.identityStore ?? new FakeIdentityStore();
  const pendingRegistrationStore =
    overrides.pendingRegistrationStore ?? new FakePendingRegistrationStore();
  const requests = [];
  const responses = overrides.responses ?? [
    jsonResponse(200, { data: challenge }),
    jsonResponse(200, { data: { deviceId } })
  ];
  let responseIndex = 0;
  const requestIds = ["desktop-request-1", "desktop-request-2"];
  let requestIdIndex = 0;
  const client = new DesktopDeviceRegistrationClient({
    identityStore,
    pendingRegistrationStore,
    deviceLabel: "AiCRM Desktop",
    appVersion: "0.1.0",
    loadHostSession:
      overrides.loadHostSession ??
      (async () => ({ token: sessionToken, expiresAt: "2026-07-12T01:00:00.000Z" })),
    loadTrustedApiBaseUrl: overrides.loadTrustedApiBaseUrl ?? (() => "https://aicrm.example.test"),
    now: () => now,
    requestIdFactory: () => requestIds[requestIdIndex++] ?? "desktop-request-fallback",
    requestTimeoutMs: 5_000,
    fetch:
      overrides.fetch ??
      (async (url, init) => {
        requests.push({ url, init });
        const response = responses[responseIndex++];
        if (!response) throw new Error("unexpected request");
        return response;
      })
  });
  return { client, identityStore, pendingRegistrationStore, requests };
}

test("Main registration uses Host session and signs the exact create body plus the same Bearer", async () => {
  const current = fixture();
  const result = await current.client.register();

  assert.equal(result.registrationStatus, "registered");
  assert.equal(current.requests.length, 2);
  const [challengeRequest, createRequest] = current.requests;
  assert.equal(
    challengeRequest.url,
    `https://aicrm.example.test${DESKTOP_DEVICE_REGISTRATION_CHALLENGE_PATH}`
  );
  assert.equal(createRequest.url, `https://aicrm.example.test${DESKTOP_DEVICE_REGISTRATION_PATH}`);
  assert.deepEqual(JSON.parse(challengeRequest.init.body), {
    publicKey,
    deviceLabel: "AiCRM Desktop",
    appVersion: "0.1.0"
  });
  assert.equal(
    challengeRequest.init.headers["Idempotency-Key"],
    `desktop-device-challenge:${sha256Hex(Buffer.from(challengeRequest.init.body, "utf8"))}`
  );
  assert.equal("Idempotency-Key" in createRequest.init.headers, false);
  const expectedCreateBody = JSON.stringify({
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    publicKey,
    deviceLabel: "AiCRM Desktop",
    appVersion: "0.1.0"
  });
  assert.equal(createRequest.init.body, expectedCreateBody);

  assert.equal(current.identityStore.signed.length, 1);
  const signed = current.identityStore.signed[0];
  assert.equal(signed.method, "POST");
  assert.equal(signed.path, DESKTOP_DEVICE_REGISTRATION_PATH);
  assert.equal(Buffer.from(signed.body).toString("utf8"), expectedCreateBody);
  assert.equal(signed.authorization, `Bearer ${sessionToken}`);
  assert.deepEqual(signed.allowedAuthorizationSchemes, ["Bearer"]);

  for (const [index, request] of current.requests.entries()) {
    const headers = request.init.headers;
    assert.equal(headers.Authorization, `Bearer ${sessionToken}`);
    assert.equal(headers["X-KY-Workspace-Type"], "platform");
    assert.equal(headers["X-KY-Workspace-Id"], "platform_root");
    assert.equal(headers["X-KY-Request-Id"], `desktop-request-${index + 1}`);
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.cache, "no-store");
    assert.equal(request.init.credentials, "omit");
  }
  assert.equal(createRequest.init.headers["X-AiCRM-Device-Id"], deviceId);
  assert.equal(createRequest.init.headers["X-AiCRM-Device-Sequence"], "1");
  assert.deepEqual(current.identityStore.marked, [{ status: "registered", expectedDeviceId: deviceId }]);
  const serializedRequests = JSON.stringify(current.requests);
  assert.equal(serializedRequests.includes("privateKey"), false);
});

test("challenge Idempotency-Key is legal and stable for the exact canonical request across client rebuilds", async () => {
  const identityStore = new FakeIdentityStore();
  const keys = [];
  for (let index = 0; index < 2; index += 1) {
    const current = fixture({
      identityStore,
      pendingRegistrationStore: new FakePendingRegistrationStore(),
      fetch: async (_url, init) => {
        keys.push(init.headers["Idempotency-Key"]);
        return jsonResponse(503, { error: { code: "temporarily_unavailable" } });
      }
    });
    await assert.rejects(current.client.register(), {
      code: "desktop_device_registration_rejected"
    });
  }
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0], /^[A-Za-z0-9._:-]{8,160}$/);
  assert.equal(identityStore.signed.length, 0);
});

test("concurrent Main registration calls coalesce and already-registered state performs no network call", async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const current = fixture({
    fetch: async (url, init) => {
      current.requests.push({ url, init });
      if (current.requests.length === 1) await waiting;
      return current.requests.length === 1
        ? jsonResponse(200, { data: challenge })
        : jsonResponse(200, { data: { deviceId } });
    }
  });
  const first = current.client.register();
  const second = current.client.register();
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(current.requests.length, 2);

  const registered = fixture({
    identityStore: current.identityStore,
    pendingRegistrationStore: current.pendingRegistrationStore
  });
  const projection = await registered.client.register();
  assert.equal(projection.registrationStatus, "registered");
  assert.equal(registered.requests.length, 0);
});

test("Main session clear can abort an in-flight automatic registration", async () => {
  let fetchStarted;
  const started = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  const current = fixture({
    fetch: async (_url, init) => {
      fetchStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
  });
  const operation = current.client.register();
  await started;
  current.client.cancel();
  await assert.rejects(operation, { code: "desktop_device_registration_cancelled" });
  assert.equal(current.identityStore.marked.length, 0);
});

test("untrusted API bases and expired or malformed Host sessions fail before signing", async (t) => {
  const cases = [
    {
      name: "remote plaintext",
      loadTrustedApiBaseUrl: () => "http://aicrm.example.test",
      code: "desktop_host_api_untrusted"
    },
    {
      name: "URL credentials",
      loadTrustedApiBaseUrl: () => "https://user:secret@aicrm.example.test",
      code: "desktop_host_api_untrusted"
    },
    {
      name: "path prefix",
      loadTrustedApiBaseUrl: () => "https://aicrm.example.test/proxy",
      code: "desktop_host_api_untrusted"
    },
    {
      name: "expired session",
      loadHostSession: async () => ({ token: sessionToken, expiresAt: now.toISOString() }),
      code: "desktop_host_session_expired"
    },
    {
      name: "ambiguous token",
      loadHostSession: async () => ({ token: "token with space", expiresAt: "2026-07-12T01:00:00Z" }),
      code: "desktop_host_session_unavailable"
    }
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const current = fixture(entry);
      await assert.rejects(current.client.register(), { code: entry.code });
      assert.equal(current.requests.length, 0);
      assert.equal(current.identityStore.signed.length, 0);
      assert.equal(current.identityStore.marked.length, 0);
    });
  }

  const loopback = fixture({ loadTrustedApiBaseUrl: () => "http://127.0.0.1:16178/" });
  await loopback.client.register();
  assert.equal(loopback.requests[0].url.startsWith("http://127.0.0.1:16178/"), true);
});

test("challenge and device responses are exact, bounded, and cannot forge local registration state", async (t) => {
  const cases = [
    {
      name: "challenge extra field",
      responses: [jsonResponse(200, { data: { ...challenge, privateMaterial: "forbidden" } })]
    },
    {
      name: "algorithm downgrade",
      responses: [jsonResponse(200, { data: { ...challenge, algorithm: "RSA" } })]
    },
    {
      name: "expired challenge",
      responses: [jsonResponse(200, { data: { ...challenge, expiresAt: now.toISOString() } })]
    },
    {
      name: "device projection extra field",
      responses: [
        jsonResponse(200, { data: challenge }),
        jsonResponse(200, {
          data: { deviceId, status: "active", keyGeneration: 1, registrationStatus: "registered" }
        })
      ]
    },
    {
      name: "mismatched device",
      responses: [
        jsonResponse(200, { data: challenge }),
        jsonResponse(200, { data: { deviceId: "a".repeat(64) } })
      ]
    },
    {
      name: "untrusted status projection",
      responses: [
        jsonResponse(200, { data: challenge }),
        jsonResponse(200, { data: { deviceId, status: "revoked", keyGeneration: 1 } })
      ]
    },
    {
      name: "untrusted key generation projection",
      responses: [
        jsonResponse(200, { data: challenge }),
        jsonResponse(200, { data: { deviceId, status: "active", keyGeneration: 2 } })
      ]
    }
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const current = fixture({ responses: entry.responses });
      await assert.rejects(current.client.register(), {
        code: "desktop_device_registration_response_invalid"
      });
      assert.equal(current.identityStore.marked.length, 0);
      assert.equal((await current.identityStore.getIdentity()).registrationStatus, "unregistered");
    });
  }
});

test("initial registration fails closed unless the durable proof uses generation 1 sequence 1", async () => {
  const identityStore = new FakeIdentityStore({ sequence: "2" });
  const current = fixture({ identityStore });
  await assert.rejects(current.client.register(), {
    code: "desktop_device_registration_recovery_required"
  });
  assert.equal(current.requests.length, 1, "only the unsigned challenge request may leave Main");
  assert.equal(identityStore.marked.length, 0);
});

test("tampered signed headers fail before device create and cannot consume a forged success", async () => {
  const identityStore = new FakeIdentityStore({ tamperHeader: "X-AiCRM-Content-SHA256" });
  const current = fixture({ identityStore });
  await assert.rejects(current.client.register(), {
    code: "desktop_device_registration_recovery_required"
  });
  assert.equal(current.requests.length, 1, "tampered proof must not reach device create");
  assert.equal(identityStore.marked.length, 0);
});

test("server errors are sanitized and never mark a device registered", async () => {
  const current = fixture({
    responses: [
      jsonResponse(200, { data: challenge }),
      jsonResponse(409, {
        error: {
          code: "device_proof_replayed",
          message: `do not echo ${sessionToken}`
        }
      })
    ]
  });
  await assert.rejects(
    current.client.register(),
    (error) =>
      error.code === "desktop_device_registration_rejected" &&
      error.status === 409 &&
      error.serverCode === "device_proof_replayed" &&
      !error.message.includes(sessionToken)
  );
  assert.equal(current.identityStore.marked.length, 0);
});

test("ambiguous create transport persists an encrypted request and a rebuilt client exact-replays it", async (t) => {
  const state = await ambiguousDurableState();
  t.after(() => rm(state.base, { recursive: true, force: true }));
  assert.equal(state.requests.length, 2);
  const firstCreate = state.requests[1];
  const pendingPath = path.join(state.root, "registration-pending.sec");
  const ciphertext = await readFile(pendingPath);
  assert.equal(ciphertext.includes(Buffer.from(sessionToken)), false);
  assert.equal(ciphertext.includes(Buffer.from(firstCreate.init.body)), false);
  const pending = await state.pendingRegistrationStore.load();
  assert.equal(pending.authorization, `Bearer ${sessionToken}`);
  assert.equal(pending.sequence, "1");

  const replayed = [];
  const restarted = durableClient({
    root: state.root,
    storage: state.storage,
    fetch: async (url, init) => {
      replayed.push({ url, init });
      return jsonResponse(201, { data: { deviceId } });
    }
  });
  const registered = await restarted.client.register();
  assert.equal(registered.registrationStatus, "registered");
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].url.endsWith(DESKTOP_DEVICE_REGISTRATION_PATH), true);
  assert.equal(replayed[0].init.body, firstCreate.init.body);
  assert.equal(replayed[0].init.headers.Authorization, firstCreate.init.headers.Authorization);
  for (const header of [
    "X-AiCRM-Content-SHA256",
    "X-AiCRM-Device-Id",
    "X-AiCRM-Device-Nonce",
    "X-AiCRM-Device-Sequence",
    "X-AiCRM-Device-Signature",
    "X-AiCRM-Device-Timestamp"
  ]) {
    assert.equal(replayed[0].init.headers[header], firstCreate.init.headers[header], header);
  }
  assert.equal(await restarted.pendingRegistrationStore.load(), null);
  const next = await restarted.identityStore.signRequest({
    method: "POST",
    path: `/api/v1/ai-executor-devices/${deviceId}/heartbeat`,
    body: Buffer.from("{}")
  });
  assert.equal(next.sequence, "2");
});

test("pending-first ordering recovers every identity/sequence high-water crash point", async (t) => {
  const states = [
    { name: "pending durable before identity and sequence", rollbackIdentity: true, rollbackSequence: true },
    { name: "identity durable before sequence", rollbackIdentity: false, rollbackSequence: true },
    { name: "sequence durable before identity", rollbackIdentity: true, rollbackSequence: false },
    { name: "both high-water records durable", rollbackIdentity: false, rollbackSequence: false }
  ];
  for (const crash of states) {
    await t.test(crash.name, async (t) => {
      const state = await ambiguousDurableState();
      t.after(() => rm(state.base, { recursive: true, force: true }));
      if (crash.rollbackIdentity) {
        await writeFile(path.join(state.root, "identity.sec"), state.identityBefore, { mode: 0o600 });
      }
      if (crash.rollbackSequence) {
        await writeFile(path.join(state.root, "sequence.sec"), state.sequenceBefore, { mode: 0o600 });
      }
      const requests = [];
      const restarted = durableClient({
        root: state.root,
        storage: state.storage,
        fetch: async (url, init) => {
          requests.push({ url, init });
          return jsonResponse(201, { data: { deviceId } });
        }
      });
      assert.equal((await restarted.client.register()).registrationStatus, "registered");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url.endsWith(DESKTOP_DEVICE_REGISTRATION_PATH), true);
      const next = await restarted.identityStore.signRequest({
        method: "POST",
        path: `/api/v1/ai-executor-devices/${deviceId}/heartbeat`,
        body: Buffer.from("{}")
      });
      assert.equal(next.sequence, "2");
    });
  }
});

test("pending persistence failure never advances either identity high-water record", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-registration-pending-failure-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "identity");
  const storage = new FakeSafeStorage();
  const stores = durableStores(root, storage);
  const failingPendingStore = {
    async load() {
      return null;
    },
    async create() {
      throw new Error("simulated fsync failure before durable pending");
    },
    async clear() {}
  };
  const client = new DesktopDeviceRegistrationClient({
    identityStore: stores.identityStore,
    pendingRegistrationStore: failingPendingStore,
    deviceLabel: "AiCRM Desktop",
    appVersion: "0.1.0",
    loadHostSession: async () => ({ token: sessionToken, expiresAt: "2026-07-12T01:00:00Z" }),
    loadTrustedApiBaseUrl: () => "https://aicrm.example.test",
    now: () => now,
    requestIdFactory: () => "pending-failure-request",
    requestTimeoutMs: 5_000,
    fetch: async () => jsonResponse(201, { data: challenge })
  });
  await assert.rejects(client.register(), /simulated fsync failure/);
  const first = await stores.identityStore.signRequest({
    method: "POST",
    path: `/api/v1/ai-executor-devices/${deviceId}/heartbeat`,
    body: Buffer.from("{}")
  });
  assert.equal(first.sequence, "1");
});

test("missing pending after sequence 1 fails recovery and never signs a sequence 2 registration", async (t) => {
  const state = await ambiguousDurableState();
  t.after(() => rm(state.base, { recursive: true, force: true }));
  await rm(path.join(state.root, "registration-pending.sec"));
  const requests = [];
  const restarted = durableClient({
    root: state.root,
    storage: state.storage,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(201, { data: challenge });
    }
  });
  await assert.rejects(restarted.client.register(), {
    code: "desktop_device_registration_recovery_required"
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.endsWith(DESKTOP_DEVICE_REGISTRATION_CHALLENGE_PATH), true);
});

test("a changed Bearer cannot replay or replace a pending sequence 1 registration", async (t) => {
  const state = await ambiguousDurableState();
  t.after(() => rm(state.base, { recursive: true, force: true }));
  let fetchCalls = 0;
  const restarted = durableClient({
    root: state.root,
    storage: state.storage,
    token: "different.session.token",
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse(201, { data: { deviceId } });
    }
  });
  await assert.rejects(restarted.client.register(), {
    code: "desktop_device_registration_recovery_required"
  });
  assert.equal(fetchCalls, 0);
  assert.notEqual(await restarted.pendingRegistrationStore.load(), null);
});

test("corrupt or forged encrypted pending records fail closed before network", async (t) => {
  for (const mode of ["corrupt", "forged"]) {
    await t.test(mode, async (t) => {
      const state = await ambiguousDurableState();
      t.after(() => rm(state.base, { recursive: true, force: true }));
      const pendingPath = path.join(state.root, "registration-pending.sec");
      if (mode === "corrupt") {
        await writeFile(pendingPath, Buffer.from("not-safe-storage"), { mode: 0o600 });
      } else {
        const decoded = JSON.parse(
          state.storage.decryptString(await readFile(pendingPath))
        );
        decoded.headers["X-AiCRM-Content-SHA256"] = "0".repeat(64);
        await writeFile(pendingPath, state.storage.encryptString(JSON.stringify(decoded)), { mode: 0o600 });
      }
      let fetchCalls = 0;
      const restarted = durableClient({
        root: state.root,
        storage: state.storage,
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(201, { data: { deviceId } });
        }
      });
      await assert.rejects(restarted.client.register(), {
        code: "desktop_device_registration_recovery_required"
      });
      assert.equal(fetchCalls, 0);
    });
  }
});

test("registered identity validates and durably clears a leftover pending request without network", async (t) => {
  const state = await ambiguousDurableState();
  t.after(() => rm(state.base, { recursive: true, force: true }));
  await state.identityStore.markRegistration("registered", deviceId);
  let fetchCalls = 0;
  const restarted = durableClient({
    root: state.root,
    storage: state.storage,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("registered cleanup must not call network");
    }
  });
  assert.equal((await restarted.client.register()).registrationStatus, "registered");
  assert.equal(fetchCalls, 0);
  assert.equal(await restarted.pendingRegistrationStore.load(), null);
});

test("registration remains Main-only and is not exposed as IPC or a Codex capability", async () => {
  const [mainIndex, deviceIpc, preloadBridge, preloadTypes, constants] = await Promise.all([
    readFile(new URL("./index.ts", import.meta.url), "utf8"),
    readFile(new URL("./ipc/desktop-device-ipc.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/constants.ts", import.meta.url), "utf8")
  ]);
  const exposed = `${mainIndex}\n${deviceIpc}\n${preloadBridge}\n${preloadTypes}\n${constants}`;
  for (const forbidden of [
    "desktop-device-registration-client",
    "DesktopDeviceRegistrationClient",
    "signRequest",
    "privateKeyPkcs8",
    "desktop-device:register"
  ]) {
    assert.equal(exposed.includes(forbidden), false, `renderer/IPC surface contains ${forbidden}`);
  }
  assert.match(mainIndex, /registerDesktopDeviceIpc\(desktopDeviceTrustRuntime\)/);
  assert.match(deviceIpc, /runtime\.getIdentity\(\)/);
  assert.match(deviceIpc, /runtime\.ensureRegistration\(\)/);
  assert.match(deviceIpc, /runtime\.getRegistrationState\(\)/);
});
