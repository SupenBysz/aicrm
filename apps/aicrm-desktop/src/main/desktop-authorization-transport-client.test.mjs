import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DesktopAuthorizationTransportClient
} from "./desktop-authorization-transport-client.ts";
import { DesktopDeviceIdentityStore } from "./desktop-device-identity.ts";
import { DesktopDeviceRequestJournalStore } from "./desktop-device-request-journal.ts";
import { DesktopDeviceRequestLane } from "./desktop-device-request-lane.ts";
import { desktopDeviceKeyMaterialFromSeed } from "./desktop-device-proof.ts";

const NOW = "2026-07-13T09:00:00.123Z";
const HANDOFF_TICKET = "handoff.header.signature";
const CLAIM_TOKEN = "claim.header.signature";
const ACTIVATION_TOKEN = "activation.header.signature";
const LOGIN_HASH = "1".repeat(64);
const ACCOUNT_FINGERPRINT = "2".repeat(64);
const BINDING_DIGEST = "3".repeat(64);

class FakeSafeStorage {
  isEncryptionAvailable() {
    return true;
  }

  getSelectedStorageBackend() {
    return "gnome_libsecret";
  }

  encryptString(value) {
    return Buffer.concat([
      Buffer.from("AUTH-TRANSPORT-TEST\0"),
      Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0x5a))
    ]);
  }

  decryptString(value) {
    const prefix = Buffer.from("AUTH-TRANSPORT-TEST\0");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("ciphertext invalid");
    return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0x5a)).toString("utf8");
  }
}

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-authorization-transport-"));
  const safeStorage = new FakeSafeStorage();
  const identityStore = new DesktopDeviceIdentityStore({
    root: path.join(base, "identity"),
    safeStorage,
    keyFactory: () =>
      desktopDeviceKeyMaterialFromSeed(
        Uint8Array.from({ length: 32 }, (_, index) => index + 31)
      ),
    now: () => new Date(NOW)
  });
  const identity = await identityStore.getIdentity();
  await identityStore.markRegistration("registered", identity.deviceId);
  let signCount = 0;
  const identityFacade = {
    getIdentity: () => identityStore.getIdentity(),
    signRequest: (input) => {
      signCount += 1;
      return identityStore.signRequest(input);
    }
  };
  const journalRoot = path.join(base, "trusted-requests");
  const journal = new DesktopDeviceRequestJournalStore({ root: journalRoot, safeStorage });
  const lane = new DesktopDeviceRequestLane();
  let requestCounter = 0;
  const client = (overrides = {}) =>
    new DesktopAuthorizationTransportClient({
      identityStore: overrides.identityStore ?? identityFacade,
      requestLane: overrides.requestLane ?? lane,
      requestJournal: overrides.requestJournal ?? journal,
      loadTrustedApiBaseUrl:
        overrides.loadTrustedApiBaseUrl ?? (() => "https://aicrm.example.test"),
      fetch: overrides.fetch,
      now: overrides.now ?? (() => new Date(NOW)),
      requestIdFactory:
        overrides.requestIdFactory ?? (() => `req_transport_${++requestCounter}`),
      requestTimeoutMs: overrides.requestTimeoutMs ?? 2_000
    });
  return {
    base,
    journalRoot,
    journal,
    lane,
    identityFacade,
    client,
    signCount: () => signCount
  };
}

function claimInput(overrides = {}) {
  return {
    sessionId: "session_1",
    handoffId: "handoff_1",
    handoffTicket: HANDOFF_TICKET,
    ...overrides
  };
}

function claimData(overrides = {}) {
  return {
    handoffId: "handoff_1",
    executorId: "executor_desktop_1",
    claimToken: CLAIM_TOKEN,
    expiresAt: "2026-07-13T09:02:00.123Z",
    sessionRevision: 2,
    replayed: true,
    ...overrides
  };
}

function response(data, { status = 200, requestId = "req_server_1", envelope = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify({ data, requestId, ...envelope });
    }
  };
}

function requestProjection(url, init) {
  const headers = { ...init.headers };
  return {
    url,
    method: init.method,
    body: init.body,
    authorization: headers.Authorization,
    signed: Object.fromEntries(
      Object.entries(headers).filter(([name]) => name.startsWith("X-AiCRM-"))
    )
  };
}

test("response loss replays the exact encrypted claim and a durable response needs no network", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const requests = [];
  const lossyFetch = async (url, init) => {
    requests.push(requestProjection(url, init));
    if (requests.length === 1) throw new Error("response lost");
    return response(claimData());
  };

  await assert.rejects(current.client({ fetch: lossyFetch }).claimDesktopHandoff(claimInput()), {
    code: "desktop_authorization_transport_failed"
  });
  assert.equal(current.signCount(), 1);
  const pending = await current.journal.list();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].response, null);

  const recovered = await current.client({ fetch: lossyFetch }).claimDesktopHandoff(claimInput());
  assert.equal(current.signCount(), 1);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(recovered.data, claimData());

  const encrypted = await readFile(
    path.join(current.journalRoot, `${recovered.requestReference}.sec`)
  );
  for (const canary of [HANDOFF_TICKET, CLAIM_TOKEN, "handoffId"]) {
    assert.equal(encrypted.includes(Buffer.from(canary)), false);
  }

  let unexpectedNetwork = 0;
  const restarted = current.client({
    fetch: async () => {
      unexpectedNetwork += 1;
      throw new Error("must not send");
    }
  });
  assert.deepEqual((await restarted.claimDesktopHandoff(claimInput())).data, claimData());
  assert.equal(unexpectedNetwork, 0);

  await restarted.completeRequest(recovered.requestReference, recovered.requestHash);
  assert.equal(await current.journal.load(recovered.requestReference), null);
});

test("changed ticket or trusted origin fails closed without signing a replacement", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let requests = 0;
  const fail = async () => {
    requests += 1;
    throw new Error("offline");
  };
  await assert.rejects(current.client({ fetch: fail }).claimDesktopHandoff(claimInput()));
  assert.equal(current.signCount(), 1);

  await assert.rejects(
    current.client({ fetch: fail }).claimDesktopHandoff(
      claimInput({ handoffTicket: "changed.header.signature" })
    ),
    { code: "desktop_authorization_transport_recovery_conflict" }
  );
  await assert.rejects(
    current
      .client({
        fetch: fail,
        loadTrustedApiBaseUrl: () => "https://other.example.test"
      })
      .claimDesktopHandoff(claimInput()),
    { code: "desktop_authorization_transport_recovery_conflict" }
  );
  assert.equal(current.signCount(), 1);
  assert.equal(requests, 1);
});

test("proof and activation ACK use strict device-only contracts and explicit completion fences", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const requests = [];
  const hostFetch = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/desktop-proofs")) {
      return response({
        proofId: "proof_1",
        result: "succeeded",
        sessionRevision: 3,
        replayed: false,
        operationId: "operation_1",
        activationId: "activation_1",
        credentialRevision: 4,
        leaseEpoch: 2,
        sourceCredentialRevision: 0,
        revocationEpoch: 0,
        bindingDigest: BINDING_DIGEST,
        activationToken: ACTIVATION_TOKEN,
        expiresAt: "2026-07-13T09:02:00.123Z"
      });
    }
    return response({
      activationId: "activation_1",
      executorId: "executor_1",
      credentialRevision: 4,
      sessionRevision: 4,
      replayed: false
    });
  };
  const client = current.client({ fetch: hostFetch });
  const proof = await client.submitAuthorizationProof({
    sessionId: "session_1",
    claimToken: CLAIM_TOKEN,
    handoffId: "handoff_1",
    sessionRevision: 2,
    loginIdHash: LOGIN_HASH,
    result: "succeeded",
    checkedAt: NOW,
    accountFingerprint: ACCOUNT_FINGERPRINT,
    candidateBindingDigest: BINDING_DIGEST
  });
  assert.equal(proof.data.result, "succeeded");
  assert.equal(proof.data.activationToken, ACTIVATION_TOKEN);
  await client.completeRequest(proof.requestReference, proof.requestHash);

  const acknowledgement = await client.acknowledgeCredentialActivation({
    sessionId: "session_1",
    activationToken: ACTIVATION_TOKEN,
    operationId: "operation_1",
    activationId: "activation_1",
    credentialRevision: 4,
    leaseEpoch: 2,
    sourceCredentialRevision: 0,
    revocationEpoch: 0,
    durableBarrierCompletedAt: NOW,
    bindingDigest: BINDING_DIGEST
  });
  assert.equal(acknowledgement.data.executorId, "executor_1");
  await client.completeRequest(acknowledgement.requestReference, acknowledgement.requestHash);

  assert.equal(requests.length, 2);
  for (const { init } of requests) {
    const headers = { ...init.headers };
    assert.equal("X-KY-Workspace-Type" in headers, false);
    assert.equal("X-KY-Workspace-Id" in headers, false);
    assert.equal("Idempotency-Key" in headers, false);
    assert.equal(Object.keys(headers).filter((name) => name.startsWith("X-AiCRM-")).length, 6);
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
  }
  assert.equal(requests[0].init.headers.Authorization, `AiCRM-Claim ${CLAIM_TOKEN}`);
  assert.equal(requests[1].init.headers.Authorization, `AiCRM-Activation ${ACTIVATION_TOKEN}`);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    handoffId: "handoff_1",
    sessionRevision: 2,
    loginIdHash: LOGIN_HASH,
    result: "succeeded",
    checkedAt: NOW,
    accountFingerprint: ACCOUNT_FINGERPRINT,
    candidateBindingDigest: BINDING_DIGEST
  });
});

test("invalid successful projections are not journaled and retry the same signature", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const requests = [];
  const invalidFetch = async (url, init) => {
    requests.push(requestProjection(url, init));
    return response(claimData({ unexpected: true }));
  };
  await assert.rejects(
    current.client({ fetch: invalidFetch }).claimDesktopHandoff(claimInput()),
    { code: "desktop_authorization_transport_response_invalid" }
  );
  assert.equal((await current.journal.list())[0].response, null);

  const validFetch = async (url, init) => {
    requests.push(requestProjection(url, init));
    return response(claimData());
  };
  await current.client({ fetch: validFetch }).claimDesktopHandoff(claimInput());
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(current.signCount(), 1);
});

test("claim response requires an exact trusted executor id", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const missingExecutor = claimData();
  delete missingExecutor.executorId;
  const responses = [missingExecutor, claimData({ executorId: "" }), claimData()];
  const requests = [];
  const hostFetch = async (url, init) => {
    requests.push(requestProjection(url, init));
    return response(responses.shift());
  };
  const client = current.client({ fetch: hostFetch });

  await assert.rejects(client.claimDesktopHandoff(claimInput()), {
    code: "desktop_authorization_transport_response_invalid"
  });
  await assert.rejects(client.claimDesktopHandoff(claimInput()), {
    code: "desktop_authorization_transport_response_invalid"
  });
  const accepted = await client.claimDesktopHandoff(claimInput());

  assert.equal(accepted.data.executorId, "executor_desktop_1");
  assert.equal(current.signCount(), 1);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
});

test("shared lane orders authorization behind heartbeat work and cancellation releases it", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let releaseBlocker;
  const blocker = new Promise((resolve) => {
    releaseBlocker = resolve;
  });
  const heartbeatWork = current.lane.run(() => blocker);
  let networkCalls = 0;
  const queued = current.client({
    fetch: async () => {
      networkCalls += 1;
      return response(claimData());
    }
  }).claimDesktopHandoff(claimInput());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(networkCalls, 0);
  assert.equal(current.signCount(), 0);
  releaseBlocker();
  await heartbeatWork;
  await queued;
  assert.equal(networkCalls, 1);

  const second = await fixture();
  t.after(() => rm(second.base, { recursive: true, force: true }));
  let started;
  const fetchStarted = new Promise((resolve) => {
    started = resolve;
  });
  const cancellable = second.client({
    fetch: async (_url, init) => {
      started();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
  });
  const pending = cancellable.claimDesktopHandoff(claimInput());
  await fetchStarted;
  cancellable.cancel();
  await assert.rejects(pending, { code: "desktop_authorization_transport_cancelled" });
  assert.equal((await second.journal.list())[0].response, null);
  let laneReleased = false;
  await second.lane.run(async () => {
    laneReleased = true;
  });
  assert.equal(laneReleased, true);
});
