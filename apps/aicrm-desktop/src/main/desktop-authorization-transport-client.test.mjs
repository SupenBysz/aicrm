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

function proofInput(overrides = {}) {
  return {
    sessionId: "session_1",
    claimToken: CLAIM_TOKEN,
    handoffId: "handoff_1",
    sessionRevision: 2,
    loginIdHash: LOGIN_HASH,
    result: "succeeded",
    checkedAt: NOW,
    accountFingerprint: ACCOUNT_FINGERPRINT,
    candidateBindingDigest: BINDING_DIGEST,
    ...overrides
  };
}

function proofData(overrides = {}) {
  return {
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
    expiresAt: "2026-07-13T09:02:00.123Z",
    ...overrides
  };
}

function acknowledgementInput(overrides = {}) {
  return {
    sessionId: "session_1",
    activationToken: ACTIVATION_TOKEN,
    operationId: "operation_1",
    activationId: "activation_1",
    credentialRevision: 4,
    leaseEpoch: 2,
    sourceCredentialRevision: 0,
    revocationEpoch: 0,
    durableBarrierCompletedAt: NOW,
    bindingDigest: BINDING_DIGEST,
    ...overrides
  };
}

function acknowledgementData(overrides = {}) {
  return {
    activationId: "activation_1",
    executorId: "executor_1",
    credentialRevision: 4,
    sessionRevision: 4,
    replayed: false,
    ...overrides
  };
}

function proofRecoveryInput(prepared, overrides = {}) {
  return {
    sessionId: "session_1",
    handoffId: "handoff_1",
    sessionRevision: 2,
    loginIdHash: LOGIN_HASH,
    result: "succeeded",
    accountFingerprint: ACCOUNT_FINGERPRINT,
    candidateBindingDigest: BINDING_DIGEST,
    expectedRequestReference: prepared.requestReference,
    expectedRequestHash: prepared.requestHash,
    ...overrides
  };
}

function acknowledgementRecoveryInput(prepared, overrides = {}) {
  return {
    sessionId: "session_1",
    operationId: "operation_1",
    activationId: "activation_1",
    credentialRevision: 4,
    leaseEpoch: 2,
    sourceCredentialRevision: 0,
    revocationEpoch: 0,
    bindingDigest: BINDING_DIGEST,
    expectedRequestReference: prepared.requestReference,
    expectedRequestHash: prepared.requestHash,
    ...overrides
  };
}

function response(data, { status = 200, requestId = "req_server_1", envelope = {} } = {}) {
  const encoded = Buffer.from(JSON.stringify({ data, requestId, ...envelope }), "utf8");
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      }
    }),
    async text() {
      throw new Error("transport must read the bounded response stream");
    }
  };
}

function rejectionResponse(status, code, canary = "server-detail-must-not-escape") {
  return response(undefined, {
    status,
    envelope: {
      error: { code, message: canary },
      debug: canary
    }
  });
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

test("prepared hook observes the durable exact request before the network", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const order = [];
  let preparedProjection;
  const client = current.client({
    fetch: async () => {
      order.push("fetch");
      return response(claimData());
    }
  });

  const result = await client.claimDesktopHandoff(claimInput(), {
    onPrepared: async (prepared) => {
      order.push("prepared");
      preparedProjection = prepared;
      const durable = await current.journal.load(prepared.requestReference);
      assert.ok(durable);
      assert.equal(durable.signed.requestHash, prepared.requestHash);
      assert.equal(durable.response, null);
      assert.equal(Object.isFrozen(prepared), true);
    }
  });

  assert.deepEqual(order, ["prepared", "fetch"]);
  assert.deepEqual(preparedProjection, {
    requestReference: result.requestReference,
    requestHash: result.requestHash,
    recovered: false,
    responseAvailable: false
  });
  assert.deepEqual(Object.keys(preparedProjection).sort(), [
    "recovered",
    "requestHash",
    "requestReference",
    "responseAvailable"
  ]);
  const safeProjection = JSON.stringify(preparedProjection);
  for (const canary of [HANDOFF_TICKET, CLAIM_TOKEN, "session_1", "handoff_1", current.base]) {
    assert.equal(safeProjection.includes(canary), false);
  }
});

test("prepared hook failure sends nothing and pins the exact durable request for retry", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let networkCalls = 0;
  let failedProjection;
  const client = current.client({
    fetch: async () => {
      networkCalls += 1;
      return response(claimData());
    }
  });

  await assert.rejects(
    client.claimDesktopHandoff(claimInput(), {
      onPrepared: async (prepared) => {
        failedProjection = prepared;
        throw new Error("downstream state unavailable");
      }
    }),
    /downstream state unavailable/
  );
  assert.equal(networkCalls, 0);
  assert.equal(current.signCount(), 1);
  const pending = await current.journal.load(failedProjection.requestReference);
  assert.ok(pending);
  assert.equal(pending.response, null);
  assert.equal(pending.signed.requestHash, failedProjection.requestHash);
  await assert.rejects(current.lane.run(async () => undefined), {
    code: "desktop_device_request_lane_pinned"
  });

  let recoveredProjection;
  const recovered = await client.claimDesktopHandoff(claimInput(), {
    onPrepared: async (prepared) => {
      recoveredProjection = prepared;
    }
  });
  assert.equal(networkCalls, 1);
  assert.equal(current.signCount(), 1);
  assert.deepEqual(recoveredProjection, {
    requestReference: failedProjection.requestReference,
    requestHash: failedProjection.requestHash,
    recovered: true,
    responseAvailable: false
  });
  assert.equal(recovered.requestReference, failedProjection.requestReference);
  assert.equal(recovered.requestHash, failedProjection.requestHash);

  let laneReleased = false;
  await current.lane.run(async () => {
    laneReleased = true;
  });
  assert.equal(laneReleased, true);
});

test("prepared hook runs before returning a recovered durable response without network", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const first = await current.client({
    fetch: async () => response(claimData())
  }).claimDesktopHandoff(claimInput());
  let networkCalls = 0;
  let hookCompleted = false;
  let preparedProjection;

  const recovered = await current.client({
    fetch: async () => {
      networkCalls += 1;
      throw new Error("must not send");
    }
  }).claimDesktopHandoff(claimInput(), {
    onPrepared: async (prepared) => {
      preparedProjection = prepared;
      const durable = await current.journal.load(prepared.requestReference);
      assert.ok(durable?.response);
      hookCompleted = true;
    }
  });

  assert.equal(hookCompleted, true);
  assert.equal(networkCalls, 0);
  assert.deepEqual(recovered.data, claimData());
  assert.deepEqual(preparedProjection, {
    requestReference: first.requestReference,
    requestHash: first.requestHash,
    recovered: true,
    responseAvailable: true
  });
});

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

test("ticket-free claim recovery replays only the exact durable request under the shared lane", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const requests = [];
  let firstPrepared;
  await assert.rejects(
    current.client({
      fetch: async (url, init) => {
        requests.push(requestProjection(url, init));
        throw new Error("offline");
      }
    }).claimDesktopHandoff(claimInput(), {
      onPrepared: async (prepared) => {
        firstPrepared = prepared;
      }
    }),
    { code: "desktop_authorization_transport_failed" }
  );
  assert.equal(current.signCount(), 1);
  assert.ok(firstPrepared);
  await assert.rejects(current.lane.run(async () => undefined), {
    code: "desktop_device_request_lane_pinned"
  });

  const order = [];
  let recoveryProjection;
  const recoveryInput = {
    sessionId: "session_1",
    handoffId: "handoff_1",
    expectedRequestReference: firstPrepared.requestReference,
    expectedRequestHash: firstPrepared.requestHash
  };
  const recovered = await current.client({
    fetch: async (url, init) => {
      order.push("fetch");
      requests.push(requestProjection(url, init));
      return response(claimData());
    }
  }).recoverDesktopHandoffClaim(recoveryInput, {
    onPrepared: async (prepared) => {
      order.push("prepared");
      recoveryProjection = prepared;
    }
  });

  assert.deepEqual(order, ["prepared", "fetch"]);
  assert.equal(current.signCount(), 1);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.data, claimData());
  assert.deepEqual(recoveryProjection, {
    requestReference: firstPrepared.requestReference,
    requestHash: firstPrepared.requestHash,
    recovered: true,
    responseAvailable: false
  });
  assert.deepEqual(Object.keys(recoveryInput).sort(), [
    "expectedRequestHash",
    "expectedRequestReference",
    "handoffId",
    "sessionId"
  ]);
  const safeProjection = JSON.stringify(recoveryProjection);
  for (const canary of [HANDOFF_TICKET, requests[0].url, requests[0].body, current.base]) {
    assert.equal(safeProjection.includes(canary), false);
  }

  let durableNetworkCalls = 0;
  let durableProjection;
  const durableRecovery = await current.client({
    fetch: async () => {
      durableNetworkCalls += 1;
      throw new Error("must not send a durable response");
    }
  }).recoverDesktopHandoffClaim(recoveryInput, {
    onPrepared: async (prepared) => {
      durableProjection = prepared;
    }
  });
  assert.equal(durableNetworkCalls, 0);
  assert.equal(current.signCount(), 1);
  assert.equal(durableRecovery.recovered, true);
  assert.deepEqual(durableRecovery.data, claimData());
  assert.deepEqual(durableProjection, {
    requestReference: firstPrepared.requestReference,
    requestHash: firstPrepared.requestHash,
    recovered: true,
    responseAvailable: true
  });

  await assert.rejects(
    current.client().recoverDesktopHandoffClaim(recoveryInput, {
      onPrepared: async () => {
        throw new Error("business reconciliation unavailable");
      }
    }),
    /business reconciliation unavailable/
  );
  await assert.rejects(current.lane.run(async () => undefined), {
    code: "desktop_device_request_lane_pinned"
  });
  await current.client().recoverDesktopHandoffClaim(recoveryInput, {
    onPrepared: async () => undefined
  });

  let laneReleased = false;
  await current.lane.run(async () => {
    laneReleased = true;
  });
  assert.equal(laneReleased, true);
});

test("ticket-free claim recovery rejects every mismatched fence without signing or sending", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let networkCalls = 0;
  let prepared;
  await assert.rejects(
    current.client({
      fetch: async () => {
        networkCalls += 1;
        throw new Error("offline");
      }
    }).claimDesktopHandoff(claimInput(), {
      onPrepared: async (value) => {
        prepared = value;
      }
    })
  );
  assert.ok(prepared);
  assert.equal(current.signCount(), 1);
  assert.equal(networkCalls, 1);
  const exact = {
    sessionId: "session_1",
    handoffId: "handoff_1",
    expectedRequestReference: prepared.requestReference,
    expectedRequestHash: prepared.requestHash
  };

  await assert.rejects(
    current.client({
      fetch: async () => {
        networkCalls += 1;
        return response(claimData());
      }
    })
      .recoverDesktopHandoffClaim({ ...exact, expectedRequestHash: "f".repeat(64) }),
    { code: "desktop_authorization_transport_recovery_conflict" }
  );
  await assert.rejects(
    async () =>
      current.client().recoverDesktopHandoffClaim({
        ...exact,
        expectedRequestReference: "e".repeat(64)
      }),
    { code: "desktop_authorization_transport_recovery_conflict" }
  );
  await assert.rejects(
    async () =>
      current.client().recoverDesktopHandoffClaim({
        ...exact,
        sessionId: "session_wrong"
      }),
    { code: "desktop_authorization_transport_recovery_conflict" }
  );
  await assert.rejects(
    async () =>
      current.client().recoverDesktopHandoffClaim({
        ...exact,
        handoffId: "handoff_wrong"
      }),
    { code: "desktop_authorization_transport_recovery_conflict" }
  );
  await assert.rejects(
    current.client({ loadTrustedApiBaseUrl: () => "https://other.example.test" })
      .recoverDesktopHandoffClaim(exact),
    { code: "desktop_authorization_transport_recovery_conflict" }
  );
  await assert.rejects(
    async () =>
      current.client().recoverDesktopHandoffClaim({
        ...exact,
        handoffTicket: HANDOFF_TICKET
      }),
    { code: "desktop_authorization_transport_contract_invalid" }
  );

  assert.equal(current.signCount(), 1);
  assert.equal(networkCalls, 1);
  await assert.rejects(current.lane.run(async () => undefined), {
    code: "desktop_device_request_lane_pinned"
  });
});

test("claim-token-free proof recovery replays the exact old signed body and durable success", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const requests = [];
  let prepared;
  await assert.rejects(
    current.client({
      fetch: async (url, init) => {
        requests.push(requestProjection(url, init));
        throw new Error("offline");
      }
    }).submitAuthorizationProof(proofInput(), {
      onPrepared: async (value) => {
        prepared = value;
      }
    }),
    { code: "desktop_authorization_transport_failed" }
  );
  assert.ok(prepared);
  assert.equal(current.signCount(), 1);
  const exact = proofRecoveryInput(prepared);
  let recoveryProjection;
  const recovered = await current.client({
    now: () => new Date("2026-08-13T09:00:00.000Z"),
    fetch: async (url, init) => {
      requests.push(requestProjection(url, init));
      return response(proofData());
    }
  }).recoverAuthorizationProof(exact, {
    onPrepared: async (value) => {
      recoveryProjection = value;
    }
  });
  assert.equal(current.signCount(), 1);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.data, proofData());
  assert.deepEqual(recoveryProjection, {
    requestReference: prepared.requestReference,
    requestHash: prepared.requestHash,
    recovered: true,
    responseAvailable: false
  });
  assert.equal("claimToken" in exact, false);
  assert.equal("checkedAt" in exact, false);

  let networkCalls = 0;
  const durable = await current.client({
    now: () => new Date("2026-09-13T09:00:00.000Z"),
    fetch: async () => {
      networkCalls += 1;
      throw new Error("must not send durable proof");
    }
  }).recoverAuthorizationProof(exact);
  assert.equal(networkCalls, 0);
  assert.deepEqual(durable.data, proofData());
  await current.client().completeRequest(prepared.requestReference, prepared.requestHash);
});

test("activation-token-free ACK recovery replays the exact old barrier body and durable success", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const requests = [];
  let prepared;
  await assert.rejects(
    current.client({
      fetch: async (url, init) => {
        requests.push(requestProjection(url, init));
        throw new Error("offline");
      }
    }).acknowledgeCredentialActivation(acknowledgementInput(), {
      onPrepared: async (value) => {
        prepared = value;
      }
    }),
    { code: "desktop_authorization_transport_failed" }
  );
  assert.ok(prepared);
  assert.equal(current.signCount(), 1);
  const exact = acknowledgementRecoveryInput(prepared);
  const recovered = await current.client({
    now: () => new Date("2026-08-13T09:00:00.000Z"),
    fetch: async (url, init) => {
      requests.push(requestProjection(url, init));
      return response(acknowledgementData());
    }
  }).recoverCredentialActivationAck(exact);
  assert.equal(current.signCount(), 1);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.data, acknowledgementData());
  assert.equal("activationToken" in exact, false);
  assert.equal("durableBarrierCompletedAt" in exact, false);

  let networkCalls = 0;
  const durable = await current.client({
    now: () => new Date("2026-09-13T09:00:00.000Z"),
    fetch: async () => {
      networkCalls += 1;
      throw new Error("must not send durable ACK");
    }
  }).recoverCredentialActivationAck(exact);
  assert.equal(networkCalls, 0);
  assert.deepEqual(durable.data, acknowledgementData());
  await current.client().completeRequest(prepared.requestReference, prepared.requestHash);
});

test("proof and ACK exact recovery return durable 4xx without network", async (t) => {
  for (const [label, createPending, recover] of [
    [
      "proof",
      (client, hooks) => client.submitAuthorizationProof(proofInput(), hooks),
      (client, prepared, hooks) =>
        client.recoverAuthorizationProof(proofRecoveryInput(prepared), hooks)
    ],
    [
      "ACK",
      (client, hooks) => client.acknowledgeCredentialActivation(acknowledgementInput(), hooks),
      (client, prepared, hooks) =>
        client.recoverCredentialActivationAck(acknowledgementRecoveryInput(prepared), hooks)
    ]
  ]) {
    await t.test(label, async (st) => {
      const current = await fixture();
      st.after(() => rm(current.base, { recursive: true, force: true }));
      let prepared;
      const first = await createPending(
        current.client({
          fetch: async () => rejectionResponse(409, "revision_conflict")
        }),
        {
          onPrepared: async (value) => {
            prepared = value;
          }
        }
      ).then(
        () => assert.fail("expected durable rejection"),
        (error) => error
      );
      assert.ok(prepared);
      assert.equal(first.code, "desktop_authorization_transport_rejected");
      assert.equal(first.status, 409);
      assert.equal(current.signCount(), 1);

      let networkCalls = 0;
      const replayed = await recover(
        current.client({
          fetch: async () => {
            networkCalls += 1;
            throw new Error("must not send durable rejection");
          }
        }),
        prepared
      ).then(
        () => assert.fail("expected recovered durable rejection"),
        (error) => error
      );
      assert.equal(networkCalls, 0);
      assert.equal(current.signCount(), 1);
      assert.deepEqual(
        { code: replayed.code, status: replayed.status, serverCode: replayed.serverCode },
        { code: first.code, status: first.status, serverCode: first.serverCode }
      );
    });
  }
});

test("proof and ACK exact recovery reject mismatched tuples and raw-token extras without effects", async (t) => {
  const cases = [
    {
      label: "proof",
      create: (client, hooks) => client.submitAuthorizationProof(proofInput(), hooks),
      exact: proofRecoveryInput,
      recover: (client, input) => client.recoverAuthorizationProof(input),
      mismatches: [
        { sessionId: "session_other" },
        { handoffId: "handoff_other" },
        { sessionRevision: 9 },
        { loginIdHash: "9".repeat(64) },
        { result: "failed", accountFingerprint: "", candidateBindingDigest: "" },
        { accountFingerprint: "8".repeat(64) },
        { candidateBindingDigest: "7".repeat(64) },
        { expectedRequestReference: "6".repeat(64) },
        { expectedRequestHash: "5".repeat(64) },
        { claimToken: CLAIM_TOKEN },
        { checkedAt: NOW }
      ]
    },
    {
      label: "ACK",
      create: (client, hooks) => client.acknowledgeCredentialActivation(acknowledgementInput(), hooks),
      exact: acknowledgementRecoveryInput,
      recover: (client, input) => client.recoverCredentialActivationAck(input),
      mismatches: [
        { sessionId: "session_other" },
        { operationId: "operation_other" },
        { activationId: "activation_other" },
        { credentialRevision: 5 },
        { leaseEpoch: 3 },
        { sourceCredentialRevision: 1 },
        { revocationEpoch: 1 },
        { bindingDigest: "7".repeat(64) },
        { expectedRequestReference: "6".repeat(64) },
        { expectedRequestHash: "5".repeat(64) },
        { activationToken: ACTIVATION_TOKEN },
        { durableBarrierCompletedAt: NOW }
      ]
    }
  ];
  for (const currentCase of cases) {
    await t.test(currentCase.label, async (st) => {
      const current = await fixture();
      st.after(() => rm(current.base, { recursive: true, force: true }));
      let prepared;
      let networkCalls = 0;
      await assert.rejects(
        currentCase.create(
          current.client({
            fetch: async () => {
              networkCalls += 1;
              throw new Error("offline");
            }
          }),
          {
            onPrepared: async (value) => {
              prepared = value;
            }
          }
        )
      );
      const exact = currentCase.exact(prepared);
      assert.equal(networkCalls, 1);
      assert.equal(current.signCount(), 1);
      for (const mismatch of currentCase.mismatches) {
        await assert.rejects(async () =>
          currentCase.recover(current.client({
            fetch: async () => {
              networkCalls += 1;
              throw new Error("mismatch must not reach network");
            }
          }), { ...exact, ...mismatch })
        );
      }
      await assert.rejects(
        async () => currentCase.recover(
          current.client({
            loadTrustedApiBaseUrl: () => "https://other.example.test",
            fetch: async () => {
              networkCalls += 1;
              throw new Error("origin mismatch must not reach network");
            }
          }),
          exact
        ),
        { code: "desktop_authorization_transport_recovery_conflict" }
      );
      const identity = await current.identityFacade.getIdentity();
      await assert.rejects(
        currentCase.recover(
          current.client({
            identityStore: {
              getIdentity: async () => ({ ...identity, keyGeneration: identity.keyGeneration + 1 }),
              signRequest: async () => {
                throw new Error("recovery must not sign");
              }
            },
            fetch: async () => {
              networkCalls += 1;
              throw new Error("identity mismatch must not reach network");
            }
          }),
          exact
        ),
        { code: "desktop_authorization_transport_recovery_conflict" }
      );
      assert.equal(networkCalls, 1);
      assert.equal(current.signCount(), 1);
    });
  }
});

test("proof recovery hook failure and ACK recovery cancellation keep the exact lane pinned", async (t) => {
  const proof = await fixture();
  t.after(() => rm(proof.base, { recursive: true, force: true }));
  let proofPrepared;
  await assert.rejects(
    proof.client({ fetch: async () => { throw new Error("offline"); } })
      .submitAuthorizationProof(proofInput(), {
        onPrepared: async (value) => {
          proofPrepared = value;
        }
      })
  );
  let proofNetworkCalls = 0;
  await assert.rejects(
    proof.client({
      fetch: async () => {
        proofNetworkCalls += 1;
        return response(proofData());
      }
    }).recoverAuthorizationProof(proofRecoveryInput(proofPrepared), {
      onPrepared: async () => {
        throw new Error("business fence unavailable");
      }
    }),
    /business fence unavailable/
  );
  assert.equal(proofNetworkCalls, 0);
  await assert.rejects(proof.lane.run(async () => undefined), {
    code: "desktop_device_request_lane_pinned"
  });

  const ack = await fixture();
  t.after(() => rm(ack.base, { recursive: true, force: true }));
  let ackPrepared;
  await assert.rejects(
    ack.client({ fetch: async () => { throw new Error("offline"); } })
      .acknowledgeCredentialActivation(acknowledgementInput(), {
        onPrepared: async (value) => {
          ackPrepared = value;
        }
      })
  );
  let fetchStarted;
  const started = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  const cancellable = ack.client({
    fetch: async (_url, init) => {
      fetchStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
  });
  const pending = cancellable.recoverCredentialActivationAck(
    acknowledgementRecoveryInput(ackPrepared)
  );
  await started;
  cancellable.cancel();
  await assert.rejects(pending, { code: "desktop_authorization_transport_cancelled" });
  await assert.rejects(ack.lane.run(async () => undefined), {
    code: "desktop_device_request_lane_pinned"
  });
});

test("deterministic 4xx is encrypted before rejection and restarts without network", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const bodyCanary = "raw-ticket-path-and-server-detail-must-not-escape";
  let prepared;
  const firstError = await current.client({
    fetch: async () => rejectionResponse(409, "handoff_already_claimed", bodyCanary)
  }).claimDesktopHandoff(claimInput(), {
    onPrepared: async (value) => {
      prepared = value;
    }
  }).then(
    () => assert.fail("expected deterministic rejection"),
    (error) => error
  );
  assert.deepEqual(
    {
      code: firstError.code,
      status: firstError.status,
      serverCode: firstError.serverCode,
      message: firstError.message
    },
    {
      code: "desktop_authorization_transport_rejected",
      status: 409,
      serverCode: "handoff_already_claimed",
      message: "服务端拒绝设备授权请求"
    }
  );
  for (const canary of [bodyCanary, HANDOFF_TICKET, prepared.requestReference]) {
    assert.equal(JSON.stringify(firstError).includes(canary), false);
    assert.equal(firstError.message.includes(canary), false);
  }
  const durable = await current.journal.load(prepared.requestReference);
  assert.equal(durable?.response?.status, 409);
  assert.equal(current.signCount(), 1);
  const encrypted = await readFile(path.join(current.journalRoot, `${prepared.requestReference}.sec`));
  for (const canary of [bodyCanary, HANDOFF_TICKET, "handoff_already_claimed"]) {
    assert.equal(encrypted.includes(Buffer.from(canary)), false);
  }

  let networkCalls = 0;
  let restartedPrepared;
  const restartedError = await current.client({
    fetch: async () => {
      networkCalls += 1;
      throw new Error("must not send");
    }
  }).recoverDesktopHandoffClaim({
    sessionId: "session_1",
    handoffId: "handoff_1",
    expectedRequestReference: prepared.requestReference,
    expectedRequestHash: prepared.requestHash
  }, {
    onPrepared: async (value) => {
      restartedPrepared = value;
    }
  }).then(
    () => assert.fail("expected recovered deterministic rejection"),
    (error) => error
  );
  assert.equal(networkCalls, 0);
  assert.equal(current.signCount(), 1);
  assert.deepEqual(restartedPrepared, {
    requestReference: prepared.requestReference,
    requestHash: prepared.requestHash,
    recovered: true,
    responseAvailable: true
  });
  assert.deepEqual(
    {
      code: restartedError.code,
      status: restartedError.status,
      serverCode: restartedError.serverCode,
      message: restartedError.message
    },
    {
      code: firstError.code,
      status: firstError.status,
      serverCode: firstError.serverCode,
      message: firstError.message
    }
  );

  await assert.rejects(
    current.client().completeRequest(prepared.requestReference, "0".repeat(64)),
    { code: "desktop_device_request_journal_not_completed" }
  );
  assert.ok(await current.journal.load(prepared.requestReference));
  await current.client().completeRequest(prepared.requestReference, prepared.requestHash);
  assert.equal(await current.journal.load(prepared.requestReference), null);
});

test("ambiguous HTTP outcomes and oversized bodies stay unresolved and pin the lane", async (t) => {
  for (const status of [404, 408, 418, 425, 429, 499, 500, 503]) {
    await t.test(`status ${status}`, async (st) => {
      const current = await fixture();
      st.after(() => rm(current.base, { recursive: true, force: true }));
      await assert.rejects(
        current.client({
          fetch: async () => rejectionResponse(status, "retry_later")
        }).claimDesktopHandoff(claimInput()),
        { code: "desktop_authorization_transport_rejected", status }
      );
      assert.equal((await current.journal.list())[0].response, null);
      await assert.rejects(current.lane.run(async () => undefined), {
        code: "desktop_device_request_lane_pinned"
      });
    });
  }

  await t.test("oversized deterministic rejection", async (st) => {
    const current = await fixture();
    st.after(() => rm(current.base, { recursive: true, force: true }));
    let pulls = 0;
    let cancelled = false;
    let textCalls = 0;
    let requestSignal;
    await assert.rejects(
      current.client({
        fetch: async (_url, init) => {
          requestSignal = init.signal;
          return {
            ok: false,
            status: 409,
            body: new ReadableStream({
              pull(controller) {
                pulls += 1;
                if (pulls > 10) {
                  controller.close();
                  return;
                }
                controller.enqueue(Buffer.alloc(20 << 10, 0x78));
              },
              cancel() {
                cancelled = true;
              }
            }),
            async text() {
              textCalls += 1;
              throw new Error("unbounded text aggregation is forbidden");
            }
          };
        }
      }).claimDesktopHandoff(claimInput()),
      { code: "desktop_authorization_transport_response_invalid" }
    );
    assert.equal(cancelled, true);
    assert.equal(textCalls, 0);
    assert.equal(pulls < 10, true);
    assert.equal(requestSignal.aborted, true);
    assert.equal((await current.journal.list())[0].response, null);
    await assert.rejects(current.lane.run(async () => undefined), {
      code: "desktop_device_request_lane_pinned"
    });
  });
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
    if (url.endsWith("/lease-renewals")) {
      return response({
        activationId: "activation_1",
        executorId: "executor_1",
        operationId: "operation_1",
        credentialRevision: 4,
        leaseEpoch: 2,
        sourceCredentialRevision: 0,
        revocationEpoch: 0,
        renewedAt: "2026-07-13T09:00:00.123Z",
        leaseExpiresAt: "2026-07-13T09:00:30.123Z",
        replayed: false
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

  const renewal = await client.renewCredentialActivationLease({
    sessionId: "session_1",
    activationToken: ACTIVATION_TOKEN,
    operationId: "operation_1",
    activationId: "activation_1",
    credentialRevision: 4,
    leaseEpoch: 2,
    sourceCredentialRevision: 0,
    revocationEpoch: 0,
    bindingDigest: BINDING_DIGEST
  });
  assert.equal(renewal.data.leaseExpiresAt, "2026-07-13T09:00:30.123Z");
  await client.completeRequest(renewal.requestReference, renewal.requestHash);

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

  assert.equal(requests.length, 3);
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
  assert.equal(requests[2].init.headers.Authorization, `AiCRM-Activation ${ACTIVATION_TOKEN}`);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    handoffId: "handoff_1",
    sessionRevision: 2,
    loginIdHash: LOGIN_HASH,
    result: "succeeded",
    checkedAt: NOW,
    accountFingerprint: ACCOUNT_FINGERPRINT,
    candidateBindingDigest: BINDING_DIGEST
  });
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    operationId: "operation_1",
    activationId: "activation_1",
    credentialRevision: 4,
    leaseEpoch: 2,
    sourceCredentialRevision: 0,
    revocationEpoch: 0,
    bindingDigest: BINDING_DIGEST
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

test("shared lane orders requests and pins every later sequence behind an ambiguous journal", async (t) => {
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
  await assert.rejects(second.lane.run(async () => undefined), {
    code: "desktop_device_request_lane_pinned"
  });

  const recovered = await second.client({
    fetch: async () => response(claimData())
  }).claimDesktopHandoff(claimInput());
  assert.equal(recovered.data.handoffId, "handoff_1");
  let laneReleased = false;
  await second.lane.run(async () => {
    laneReleased = true;
  });
  assert.equal(laneReleased, true);
});

test("startup restoration blocks heartbeat work until the exact journal head is recovered", async () => {
  const lane = new DesktopDeviceRequestLane();
  const reference = "a".repeat(64);
  await lane.restorePin(reference);
  let heartbeatReleased = false;
  const heartbeatFence = lane.waitUntilUnpinned().then(() => {
    heartbeatReleased = true;
  });
  await Promise.resolve();
  assert.equal(heartbeatReleased, false);
  let laterRequestStarted = false;
  await assert.rejects(
    lane.run(async () => {
      laterRequestStarted = true;
    }),
    { code: "desktop_device_request_lane_pinned" }
  );
  assert.equal(laterRequestStarted, false);

  const recovered = await lane.runPinned(
    reference,
    async () => "recovered",
    async () => false
  );
  assert.equal(recovered, "recovered");
  await heartbeatFence;
  assert.equal(heartbeatReleased, true);
  await lane.run(async () => {
    laterRequestStarted = true;
  });
  assert.equal(laterRequestStarted, true);
});
