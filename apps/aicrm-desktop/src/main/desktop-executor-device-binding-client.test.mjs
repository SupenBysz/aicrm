import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopDeviceIdentityStore } from "./desktop-device-identity.ts";
import {
  DesktopDeviceRequestJournalStore,
  restoreDesktopDeviceRequestJournalPin
} from "./desktop-device-request-journal.ts";
import { DesktopDeviceRequestLane } from "./desktop-device-request-lane.ts";
import {
  desktopDeviceKeyMaterialFromSeed,
  hashAuthorizationToken,
  sha256Hex
} from "./desktop-device-proof.ts";
import { DesktopExecutorDeviceBindingClient } from "./desktop-executor-device-binding-client.ts";

const NOW = "2026-07-13T10:00:00.123Z";
const OLD_BEARER = "old.binding.session.token";
const NEW_BEARER = "new.binding.session.token";
const EXECUTOR_ID = "executor_initial_binding_canary";

class FakeSafeStorage {
  isEncryptionAvailable() {
    return true;
  }

  getSelectedStorageBackend() {
    return "gnome_libsecret";
  }

  encryptString(value) {
    return Buffer.concat([
      Buffer.from("EXECUTOR-BINDING-TEST\0"),
      Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0x73))
    ]);
  }

  decryptString(value) {
    const prefix = Buffer.from("EXECUTOR-BINDING-TEST\0");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("ciphertext invalid");
    return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0x73)).toString("utf8");
  }
}

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-executor-device-binding-"));
  const safeStorage = new FakeSafeStorage();
  const identityStore = new DesktopDeviceIdentityStore({
    root: path.join(base, "identity"),
    safeStorage,
    keyFactory: () =>
      desktopDeviceKeyMaterialFromSeed(
        Uint8Array.from({ length: 32 }, (_, index) => index + 47)
      ),
    now: () => new Date(NOW)
  });
  const originalIdentity = await identityStore.getIdentity();
  await identityStore.markRegistration("registered", originalIdentity.deviceId);
  let signCount = 0;
  const signedRequests = [];
  const identityFacade = {
    getIdentity: () => identityStore.getIdentity(),
    async signRequest(input) {
      signCount += 1;
      const signed = await identityStore.signRequest(input);
      signedRequests.push(signed);
      return signed;
    }
  };
  const journalRoot = path.join(base, "request-journal");
  const journal = new DesktopDeviceRequestJournalStore({ root: journalRoot, safeStorage });
  const lane = new DesktopDeviceRequestLane();
  let requestCounter = 0;
  const client = (overrides = {}) =>
    new DesktopExecutorDeviceBindingClient({
      identityStore: overrides.identityStore ?? identityFacade,
      requestLane: overrides.requestLane ?? lane,
      requestJournal: overrides.requestJournal ?? journal,
      loadHostSession:
        overrides.loadHostSession ??
        (async () => ({
          token: OLD_BEARER,
          expiresAt: "2026-07-13T11:00:00.000Z"
        })),
      loadTrustedApiBaseUrl:
        overrides.loadTrustedApiBaseUrl ?? (() => "https://aicrm.example.test"),
      waitForRequestFence: overrides.waitForRequestFence,
      fetch: overrides.fetch,
      now: overrides.now ?? (() => new Date(NOW)),
      requestIdFactory:
        overrides.requestIdFactory ?? (() => `binding_request_${++requestCounter}`),
      requestTimeoutMs: overrides.requestTimeoutMs ?? 2_000
    });
  return {
    base,
    safeStorage,
    identityStore,
    identityFacade,
    journal,
    journalRoot,
    lane,
    client,
    signCount: () => signCount,
    signedRequests
  };
}

function bindingData(deviceId, overrides = {}) {
  return {
    binding: {
      executorId: EXECUTOR_ID,
      deviceId,
      status: "active",
      revision: 1,
      force: false,
      updatedAt: "2026-07-13T10:00:01.123456Z"
    },
    replayed: false,
    ...overrides
  };
}

function response(data, { status = 201, requestId = "server_binding_request_1", envelope = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify({ data, requestId, ...envelope });
    }
  };
}

function signedProjection(url, init) {
  const headers = { ...init.headers };
  return {
    url,
    method: init.method,
    redirect: init.redirect,
    credentials: init.credentials,
    body: init.body,
    authorization: headers.Authorization,
    workspaceType: headers["X-KY-Workspace-Type"],
    workspaceId: headers["X-KY-Workspace-Id"],
    signed: Object.fromEntries(
      Object.entries(headers).filter(([name]) => name.startsWith("X-AiCRM-"))
    )
  };
}

test("initial bind signs the exact Bearer vector, accepts only 201, and completes its journal", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const identity = await current.identityStore.getIdentity();
  const requests = [];
  const result = await current.client({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return response(bindingData(identity.deviceId));
    }
  }).bindExecutorDevice({ executorId: EXECUTOR_ID, expectedRevision: 0 });

  assert.equal(result.data.binding.executorId, EXECUTOR_ID);
  assert.equal(result.data.binding.deviceId, identity.deviceId);
  assert.equal(result.data.binding.revision, 1);
  assert.equal(result.recovered, false);
  assert.equal(current.signCount(), 1);
  assert.deepEqual(await current.journal.list(), []);

  const [{ url, init }] = requests;
  const headers = { ...init.headers };
  const expectedPath = `/api/v1/ai-executors/${EXECUTOR_ID}/device-bindings`;
  const expectedBody = JSON.stringify({ deviceId: identity.deviceId, expectedRevision: 0 });
  assert.equal(url, `https://aicrm.example.test${expectedPath}`);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.equal(init.body, expectedBody);
  assert.equal(headers.Authorization, `Bearer ${OLD_BEARER}`);
  assert.equal(headers["X-KY-Workspace-Type"], "platform");
  assert.equal(headers["X-KY-Workspace-Id"], "platform_root");
  assert.equal("Idempotency-Key" in headers, false);
  assert.equal("Cookie" in headers, false);
  assert.equal(Object.keys(headers).filter((name) => name.startsWith("X-AiCRM-")).length, 6);

  const signed = current.signedRequests[0];
  const bodyHash = sha256Hex(Buffer.from(expectedBody, "utf8"));
  const bearerHash = hashAuthorizationToken(`Bearer ${OLD_BEARER}`, ["Bearer"]);
  assert.equal(signed.sequence, "1");
  assert.equal(signed.bodySha256, bodyHash);
  assert.equal(signed.authorizationTokenHash, bearerHash);
  assert.equal(
    signed.signingInput,
    [
      "AICRM-DEVICE-V1",
      "POST",
      expectedPath,
      signed.headers["X-AiCRM-Device-Timestamp"],
      signed.headers["X-AiCRM-Device-Nonce"],
      "1",
      bodyHash,
      bearerHash
    ].join("\n")
  );
});

test("response loss survives Main restart and replays the old encrypted Bearer despite session rotation", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const identity = await current.identityStore.getIdentity();
  const requests = [];
  await assert.rejects(
    current.client({
      fetch: async (url, init) => {
        requests.push(signedProjection(url, init));
        throw new Error("response lost");
      }
    }).bindExecutorDevice({ executorId: EXECUTOR_ID, expectedRevision: 0 }),
    { code: "desktop_executor_device_binding_transport_failed" }
  );
  assert.equal(current.signCount(), 1);
  const [pending] = await current.journal.list();
  assert.equal(pending.response, null);
  const encrypted = await readFile(
    path.join(current.journalRoot, `${pending.reference}.sec`)
  );
  for (const canary of [OLD_BEARER, EXECUTOR_ID, identity.deviceId, "expectedRevision"]) {
    assert.equal(encrypted.includes(Buffer.from(canary)), false);
  }

  const restartedLane = new DesktopDeviceRequestLane();
  const restartedJournal = new DesktopDeviceRequestJournalStore({
    root: current.journalRoot,
    safeStorage: current.safeStorage
  });
  assert.equal(
    await restoreDesktopDeviceRequestJournalPin(restartedJournal, restartedLane),
    pending.reference
  );
  let rotatedSessionReads = 0;
  const recovered = await current.client({
    requestLane: restartedLane,
    requestJournal: restartedJournal,
    loadHostSession: async () => {
      rotatedSessionReads += 1;
      return { token: NEW_BEARER, expiresAt: "2026-07-13T11:00:00.000Z" };
    },
    fetch: async (url, init) => {
      requests.push(signedProjection(url, init));
      return response(bindingData(identity.deviceId, { replayed: true }));
    }
  }).bindExecutorDevice({ executorId: EXECUTOR_ID, expectedRevision: 0 });

  assert.equal(rotatedSessionReads, 0);
  assert.equal(current.signCount(), 1);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(recovered.data.replayed, true);
  assert.deepEqual(await restartedJournal.list(), []);
  await restartedLane.run(async () => undefined);
});

test("a durable 201 response is confirmed and completed after restart without network", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const identity = await current.identityStore.getIdentity();
  let failComplete = true;
  const interruptedJournal = {
    load: current.journal.load.bind(current.journal),
    createOrLoad: current.journal.createOrLoad.bind(current.journal),
    recordResponse: current.journal.recordResponse.bind(current.journal),
    async complete(reference, requestHash) {
      if (failComplete) {
        failComplete = false;
        throw new Error("crash before complete");
      }
      return current.journal.complete(reference, requestHash);
    }
  };
  await assert.rejects(
    current.client({
      requestJournal: interruptedJournal,
      fetch: async () => response(bindingData(identity.deviceId))
    }).bindExecutorDevice({ executorId: EXECUTOR_ID, expectedRevision: 0 })
  );
  const [durable] = await current.journal.list();
  assert.equal(durable.response.status, 201);

  const restartedLane = new DesktopDeviceRequestLane();
  await restoreDesktopDeviceRequestJournalPin(current.journal, restartedLane);
  let networkCalls = 0;
  let sessionReads = 0;
  const recovered = await current.client({
    requestLane: restartedLane,
    loadHostSession: async () => {
      sessionReads += 1;
      return { token: NEW_BEARER, expiresAt: "2026-07-13T11:00:00.000Z" };
    },
    fetch: async () => {
      networkCalls += 1;
      throw new Error("network forbidden");
    }
  }).bindExecutorDevice({ executorId: EXECUTOR_ID, expectedRevision: 0 });
  assert.equal(recovered.recovered, true);
  assert.equal(networkCalls, 0);
  assert.equal(sessionReads, 0);
  assert.deepEqual(await current.journal.list(), []);
});

test("wrong status, oversized bodies, and non-exact success projections stay fail-closed", async (t) => {
  for (const scenario of [
    {
      name: "status",
      fetch: (deviceId) => async () => response(bindingData(deviceId), { status: 200 }),
      code: "desktop_executor_device_binding_rejected"
    },
    {
      name: "projection",
      fetch: (deviceId) => async () =>
        response({ ...bindingData(deviceId), unexpected: true }),
      code: "desktop_executor_device_binding_response_invalid"
    },
    {
      name: "oversized",
      fetch: () => async () => ({
        ok: true,
        status: 201,
        async text() {
          return "x".repeat((64 << 10) + 1);
        }
      }),
      code: "desktop_executor_device_binding_response_invalid"
    }
  ]) {
    await t.test(scenario.name, async (nested) => {
      const current = await fixture();
      nested.after(() => rm(current.base, { recursive: true, force: true }));
      const identity = await current.identityStore.getIdentity();
      await assert.rejects(
        current.client({ fetch: scenario.fetch(identity.deviceId) }).bindExecutorDevice({
          executorId: EXECUTOR_ID,
          expectedRevision: 0
        }),
        { code: scenario.code }
      );
      const [pending] = await current.journal.list();
      assert.equal(pending.response, null);
      assert.equal(current.signCount(), 1);
      await assert.rejects(current.lane.run(async () => undefined), {
        code: "desktop_device_request_lane_pinned"
      });
    });
  }
});

test("multiple startup journal heads install an unrecoverable shared-lane fence", async () => {
  const lane = new DesktopDeviceRequestLane();
  await assert.rejects(
    restoreDesktopDeviceRequestJournalPin(
      {
        async list() {
          return [
            { reference: "a".repeat(64) },
            { reference: "b".repeat(64) }
          ];
        }
      },
      lane
    ),
    { code: "desktop_device_request_journal_conflict" }
  );
  await assert.rejects(lane.run(async () => undefined), {
    code: "desktop_device_request_lane_pinned"
  });
  await assert.rejects(
    lane.runPinned("a".repeat(64), async () => undefined, async () => false),
    { code: "desktop_device_request_lane_pinned" }
  );
});

test("dependency failures never echo Bearer or origin canaries", async (t) => {
  const sessionFailure = await fixture();
  t.after(() => rm(sessionFailure.base, { recursive: true, force: true }));
  const bearerCanary = "secret-bearer-canary-never-echo";
  await assert.rejects(
    sessionFailure.client({
      loadHostSession: async () => {
        throw new Error(`failed ${bearerCanary}`);
      }
    }).bindExecutorDevice({ executorId: EXECUTOR_ID, expectedRevision: 0 }),
    (error) => {
      assert.equal(error.code, "desktop_host_session_unavailable");
      assert.equal(String(error.message).includes(bearerCanary), false);
      return true;
    }
  );

  const originFailure = await fixture();
  t.after(() => rm(originFailure.base, { recursive: true, force: true }));
  const originCanary = "https://secret-origin-canary.invalid";
  await assert.rejects(
    originFailure.client({
      loadTrustedApiBaseUrl: async () => {
        throw new Error(`failed ${originCanary}`);
      }
    }).bindExecutorDevice({ executorId: EXECUTOR_ID, expectedRevision: 0 }),
    (error) => {
      assert.equal(error.code, "desktop_host_api_untrusted");
      assert.equal(String(error.message).includes(originCanary), false);
      return true;
    }
  );
});
