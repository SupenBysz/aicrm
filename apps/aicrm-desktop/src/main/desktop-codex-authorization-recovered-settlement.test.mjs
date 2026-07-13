import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DesktopCodexAuthorizationRecoveredSettlementError,
  DesktopCodexAuthorizationRecoveredSettlementService
} from "./desktop-codex-authorization-recovered-settlement.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const TOKEN = "activation.token.value";
const PROGRESS = [
  "accepted",
  "handoff_claim_starting",
  "handoff_claimed",
  "app_server_starting",
  "app_server_started",
  "login_starting",
  "waiting_user",
  "login_completed",
  "proof_submit_starting",
  "proof_prepared",
  "activation_pending",
  "credential_promotion_starting",
  "credential_durable",
  "activation_ack_starting",
  "activation_ack_response_received",
  "activation_acked"
];

function record(status, generation = PROGRESS.indexOf(status) + 1) {
  const index = PROGRESS.indexOf(status);
  assert.notEqual(index, -1);
  return {
    version: 1,
    generation,
    status,
    lastProgressStatus: status,
    sessionId: "session_1",
    executorId: "executor_1",
    deviceId: "1".repeat(64),
    handoffId: "handoff_1",
    sessionRevision: 3,
    claimRequestReference: index >= 1 ? A : null,
    claimRequestHash: index >= 1 ? B : null,
    claimToken: index >= 2 && index <= 14 ? "claim.token.value" : null,
    claimExpiresAt: index >= 2 ? "2026-07-13T03:00:00Z" : null,
    loginIdHash: index >= 7 ? A : null,
    accountFingerprint: index >= 7 ? B : null,
    candidateBindingDigest: index >= 7 ? C : null,
    proofRequestReference: index >= 8 ? B : null,
    proofRequestHash: index >= 8 ? C : null,
    proofId: index >= 9 ? "proof_1" : null,
    activationOperationId: index >= 9 ? "operation_1" : null,
    activationId: index >= 9 ? "activation_1" : null,
    activationToken: index >= 9 && index <= 14 ? TOKEN : null,
    activationExpiresAt: index >= 9 ? "2026-07-13T03:00:00Z" : null,
    credentialRevision: index >= 9 ? 2 : null,
    leaseEpoch: index >= 9 ? 1 : null,
    sourceCredentialRevision: index >= 9 ? 1 : null,
    revocationEpoch: index >= 9 ? 0 : null,
    bindingDigest: index >= 9 ? C : null,
    promotionReceipt: index >= 12
      ? {
          executorId: "executor_1",
          revision: 2,
          operationId: "operation_1",
          digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
          digest: C,
          fileCount: 1,
          totalBytes: 8
        }
      : null,
    ackRequestReference: index >= 13 ? A : null,
    ackRequestHash: index >= 13 ? B : null,
    localFailureCode: null,
    createdAt: "2026-07-13T01:00:00.000Z",
    updatedAt: "2026-07-13T01:00:00.000Z"
  };
}

function lease(status = "fresh") {
  const semanticKey = createHash("sha256")
    .update("AICRM-ACTIVATION-LEASE-FENCE-V1\nsession_1\nactivation_1")
    .digest("hex");
  const requestReference = createHash("sha256")
    .update(
      "AICRM-TRUSTED-REQUEST-V1\ncredential_activation_lease_renewal\n" +
        "/api/v1/ai-executor-authorization-sessions/session_1" +
        "/desktop-activations/activation_1/lease-renewals"
    )
    .digest("hex");
  return {
    version: 1,
    generation: status === "removed" ? 2 : 1,
    status,
    semanticKey,
    sessionId: "session_1",
    executorId: "executor_1",
    operationId: "operation_1",
    activationId: "activation_1",
    credentialRevision: 2,
    leaseEpoch: 1,
    sourceCredentialRevision: 1,
    revocationEpoch: 0,
    bindingDigest: C,
    tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
    requestReference,
    requestHash: B,
    renewedAt: "2026-07-13T01:00:00Z",
    leaseExpiresAt: "2026-07-13T01:00:30Z",
    replayed: status === "recovery_required",
    recovered: false,
    createdAt: "2026-07-13T01:00:00.000Z",
    updatedAt: status === "removed"
      ? "2026-07-13T01:00:01.000Z"
      : "2026-07-13T01:00:00.000Z",
    removedAt: status === "removed" ? "2026-07-13T01:00:01.000Z" : null
  };
}

function fixture(options = {}) {
  const calls = [];
  const sessions = {
    async transition(expected, next) {
      calls.push("sessions.transition");
      if (options.transitionError) throw options.transitionError;
      const result = {
        ...expected,
        ...next,
        generation: expected.generation + 1,
        updatedAt: "2026-07-13T01:00:01.000Z"
      };
      return options.transitionResult ?? result;
    }
  };
  const transport = {
    async completeRequestIfPresent(reference, hash) {
      calls.push("transport.complete");
      assert.equal(reference.length, 64);
      assert.equal(hash.length, 64);
      await options.transportWait;
      if (options.transportError) throw options.transportError;
      return "completed";
    }
  };
  const credentials = {
    async completeAfterAcknowledgement(input) {
      calls.push("credentials.acknowledge");
      assert.equal(input.authorizationSessionId, "session_1");
      return {};
    },
    async removeAcknowledged(input) {
      calls.push("credentials.remove");
      assert.equal(input.activationAckRequestHash, B);
    }
  };
  const bindings = {
    async activate(input) {
      calls.push("bindings.activate");
      assert.equal(input.activationAckRequestReference, A);
      return {};
    }
  };
  const leases = {
    async inspect() {
      calls.push("leases.inspect");
      return options.leaseResult === undefined ? lease() : options.leaseResult;
    },
    async remove(value) {
      calls.push("leases.remove");
      options.onLeaseRemove?.(value);
    }
  };
  const dependencies = {
    sessions,
    transport,
    credentials,
    bindings,
    leases
  };
  const service = new DesktopCodexAuthorizationRecoveredSettlementService(
    options.wrapDependencies?.(dependencies) ?? dependencies
  );
  return { calls, service };
}

const noPublish = async () => {
  assert.fail("no transition publication expected");
};

test("reconciled outbound completion is reusable and resume stays a caller decision", async () => {
  const current = fixture();
  const resumed = await current.service.settle(record("handoff_claimed"), {
    resume: true,
    onTransition: noPublish
  });
  assert.equal(resumed.record.status, "handoff_claimed");
  assert.equal(resumed.resumeRequested, true);
  assert.deepEqual(current.calls, ["transport.complete"]);

  const cancelled = fixture();
  const notResumed = await cancelled.service.settle(record("proof_prepared"), {
    resume: false,
    onTransition: noPublish
  });
  assert.equal(notResumed.resumeRequested, false);
  assert.deepEqual(cancelled.calls, ["transport.complete"]);
});

test("ACK settlement preserves transition publication before exact artifact cleanup", async () => {
  const current = fixture();
  const result = await current.service.settle(record("activation_ack_response_received"), {
    resume: true,
    async onTransition(value) {
      current.calls.push(`publish:${value.status}`);
    }
  });
  assert.equal(result.record.status, "activation_acked");
  assert.equal(result.resumeRequested, false);
  assert.deepEqual(current.calls, [
    "leases.inspect",
    "bindings.activate",
    "credentials.acknowledge",
    "sessions.transition",
    "publish:activation_acked",
    "transport.complete",
    "credentials.remove",
    "leases.remove"
  ]);
});

test("twenty exact concurrent settlements share one flight", async () => {
  let release;
  const transportWait = new Promise((resolve) => {
    release = resolve;
  });
  const current = fixture({ transportWait });
  const target = record("handoff_claimed");
  const input = { resume: false, onTransition: noPublish };
  const first = current.service.settle(target, input);
  const all = Array.from({ length: 19 }, () => current.service.settle(target, input));
  for (const promise of all) assert.strictEqual(promise, first);
  release();
  await Promise.all([first, ...all]);
  assert.equal(current.calls.filter((value) => value === "transport.complete").length, 1);
});

test("a concurrent different tuple or caller policy is rejected without a second effect", async () => {
  let release;
  const transportWait = new Promise((resolve) => {
    release = resolve;
  });
  const current = fixture({ transportWait });
  const target = record("handoff_claimed");
  const first = current.service.settle(target, { resume: true, onTransition: noPublish });
  await assert.rejects(
    current.service.settle({ ...target, generation: target.generation + 1 }, {
      resume: true,
      onTransition: noPublish
    }),
    { code: "desktop_codex_authorization_recovered_settlement_conflict" }
  );
  await assert.rejects(
    current.service.settle(target, { resume: false, onTransition: noPublish }),
    { code: "desktop_codex_authorization_recovered_settlement_conflict" }
  );
  release();
  await first;
  assert.equal(current.calls.filter((value) => value === "transport.complete").length, 1);
});

test("record and call DTOs reject accessors, symbols, and non-plain prototypes before effects", async () => {
  const cases = [];
  const accessor = record("handoff_claimed");
  Object.defineProperty(accessor, "executorId", {
    enumerable: true,
    get() {
      throw new Error("record getter canary");
    }
  });
  cases.push([accessor, { resume: true, onTransition: noPublish }]);

  const symbol = record("handoff_claimed");
  symbol[Symbol("canary")] = true;
  cases.push([symbol, { resume: true, onTransition: noPublish }]);

  const inherited = Object.assign(Object.create({ canary: true }), record("handoff_claimed"));
  cases.push([inherited, { resume: true, onTransition: noPublish }]);

  const inputAccessor = { onTransition: noPublish };
  Object.defineProperty(inputAccessor, "resume", {
    enumerable: true,
    get() {
      throw new Error("input getter canary");
    }
  });
  cases.push([record("handoff_claimed"), inputAccessor]);

  for (const [target, input] of cases) {
    const current = fixture();
    await assert.rejects(
      current.service.settle(target, input),
      (error) =>
        error instanceof DesktopCodexAuthorizationRecoveredSettlementError &&
        error.code === "desktop_codex_authorization_recovered_settlement_conflict" &&
        !error.message.includes("canary")
    );
    assert.deepEqual(current.calls, []);
  }
});

test("descriptor values are captured once and never re-read from hostile record or lease proxies", async () => {
  const target = record("activation_ack_response_received");
  let recordReads = 0;
  const hostileRecord = new Proxy(target, {
    getOwnPropertyDescriptor(value, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (key !== "executorId" || !descriptor) return descriptor;
      recordReads += 1;
      return { ...descriptor, value: recordReads === 1 ? "executor_1" : "executor_canary" };
    }
  });

  const targetLease = lease();
  let leaseReads = 0;
  const hostileLease = new Proxy(targetLease, {
    getOwnPropertyDescriptor(value, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (key !== "bindingDigest" || !descriptor) return descriptor;
      leaseReads += 1;
      return { ...descriptor, value: leaseReads === 1 ? C : A };
    }
  });
  const current = fixture({
    leaseResult: hostileLease,
    onLeaseRemove(value) {
      assert.equal(value.bindingDigest, C);
    }
  });
  const result = await current.service.settle(hostileRecord, {
    resume: false,
    async onTransition(value) {
      assert.equal(value.executorId, "executor_1");
    }
  });
  assert.equal(result.record.executorId, "executor_1");
  assert.equal(recordReads, 1);
  assert.equal(leaseReads, 1);
});

test("hostile transition output is rejected before publication and cleanup", async () => {
  const transitioned = record("activation_acked", 16);
  Object.defineProperty(transitioned, "executorId", {
    enumerable: true,
    get() {
      throw new Error("transition getter canary");
    }
  });
  const current = fixture({ transitionResult: transitioned });
  let published = false;
  await assert.rejects(
    current.service.settle(record("activation_ack_response_received"), {
      resume: false,
      async onTransition() {
        published = true;
      }
    }),
    (error) =>
      error instanceof DesktopCodexAuthorizationRecoveredSettlementError &&
      error.code === "desktop_codex_authorization_recovered_settlement_conflict" &&
      !error.message.includes("canary")
  );
  assert.equal(published, false);
  assert.equal(current.calls.includes("transport.complete"), false);
  assert.equal(current.calls.includes("credentials.remove"), false);
  assert.equal(current.calls.includes("leases.remove"), false);
});

test("every structurally valid but non-successor transition is rejected before publication and cleanup", async () => {
  const expected = record("activation_ack_response_received");
  const exact = record("activation_acked", expected.generation + 1);
  const candidates = [
    { ...exact, sessionId: "session_other" },
    { ...exact, executorId: "executor_other" },
    { ...exact, generation: exact.generation + 1 },
    { ...exact, ackRequestHash: C },
    record("credential_durable", expected.generation + 1)
  ];

  for (const transitionResult of candidates) {
    const current = fixture({ transitionResult });
    let published = false;
    await assert.rejects(
      current.service.settle(expected, {
        resume: false,
        async onTransition() {
          published = true;
        }
      }),
      { code: "desktop_codex_authorization_recovered_settlement_conflict" }
    );
    assert.equal(published, false);
    assert.equal(current.calls.includes("transport.complete"), false);
    assert.equal(current.calls.includes("credentials.remove"), false);
    assert.equal(current.calls.includes("leases.remove"), false);
  }
});

test("complete lease invariants are rejected before the first irreversible effect", async () => {
  const exact = lease();
  const invalid = [
    { ...exact, semanticKey: A },
    { ...exact, requestReference: A },
    { ...exact, sourceCredentialRevision: exact.credentialRevision },
    { ...exact, leaseExpiresAt: exact.renewedAt },
    { ...exact, leaseExpiresAt: "2026-07-13T01:00:31Z" },
    { ...exact, updatedAt: "2026-07-12T23:59:59.000Z" },
    { ...exact, replayed: true },
    { ...exact, status: "recovery_required", replayed: false, recovered: false },
    {
      ...exact,
      status: "removed",
      generation: 1,
      removedAt: "2026-07-13T01:00:00.000Z"
    },
    {
      ...exact,
      status: "removed",
      generation: 2,
      updatedAt: "2026-07-13T01:00:01.000Z",
      removedAt: "2026-07-13T01:00:00.000Z"
    }
  ];

  for (const leaseResult of invalid) {
    const current = fixture({ leaseResult });
    await assert.rejects(
      current.service.settle(record("activation_ack_response_received"), {
        resume: false,
        onTransition: noPublish
      }),
      { code: "desktop_codex_authorization_recovered_settlement_conflict" }
    );
    assert.deepEqual(current.calls, ["leases.inspect"]);
  }
});

test("unknown dependency failures are normalized without leaking the original message", async () => {
  const current = fixture({ transportError: new Error("transport secret canary") });
  await assert.rejects(
    current.service.settle(record("handoff_claimed"), {
      resume: false,
      onTransition: noPublish
    }),
    (error) =>
      error instanceof DesktopCodexAuthorizationRecoveredSettlementError &&
      error.code === "desktop_codex_authorization_recovered_settlement_failed" &&
      !error.message.includes("canary") &&
      !String(error.stack).includes("canary")
  );
});

test("hostile thrown values are normalized without prototype or code inspection", async () => {
  const hostileProxy = new Proxy(Object.create(null), {
    getPrototypeOf() {
      throw new Error("prototype trap canary");
    }
  });
  const forged = new DesktopCodexAuthorizationRecoveredSettlementError(
    "desktop_codex_authorization_recovered_settlement_conflict",
    "forged error canary"
  );
  Object.defineProperty(forged, "code", {
    configurable: true,
    get() {
      throw new Error("code getter canary");
    }
  });

  for (const transportError of [hostileProxy, forged]) {
    const current = fixture({ transportError });
    await assert.rejects(
      current.service.settle(record("handoff_claimed"), {
        resume: false,
        onTransition: noPublish
      }),
      (error) =>
        error instanceof DesktopCodexAuthorizationRecoveredSettlementError &&
        error.code === "desktop_codex_authorization_recovered_settlement_failed" &&
        !error.message.includes("canary") &&
        !String(error.stack).includes("canary")
    );
  }
});

test("constructor binds each dependency method once and never re-reads hostile proxies", async () => {
  let descriptorReads = 0;
  let replacementCalls = 0;
  const current = fixture({
    wrapDependencies(dependencies) {
      return {
        ...dependencies,
        sessions: new Proxy(dependencies.sessions, {
          get() {
            throw new Error("raw dependency get canary");
          },
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            if (key !== "transition" || !descriptor) return descriptor;
            descriptorReads += 1;
            return {
              ...descriptor,
              value: descriptorReads === 1
                ? descriptor.value
                : async () => {
                    replacementCalls += 1;
                    throw new Error("replacement dependency canary");
                  }
            };
          }
        })
      };
    }
  });
  const result = await current.service.settle(record("activation_ack_response_received"), {
    resume: false,
    async onTransition() {}
  });
  assert.equal(result.record.status, "activation_acked");
  assert.equal(descriptorReads, 1);
  assert.equal(replacementCalls, 0);

  let accessorReads = 0;
  const accessorDependency = {};
  Object.defineProperty(accessorDependency, "transition", {
    get() {
      accessorReads += 1;
      return async () => undefined;
    }
  });
  assert.throws(
    () => new DesktopCodexAuthorizationRecoveredSettlementService({
      sessions: accessorDependency,
      transport: { completeRequestIfPresent: async () => "completed" },
      credentials: {
        completeAfterAcknowledgement: async () => undefined,
        removeAcknowledged: async () => undefined
      },
      bindings: { activate: async () => undefined },
      leases: { inspect: async () => null, remove: async () => undefined }
    }),
    { code: "desktop_codex_authorization_recovered_settlement_conflict" }
  );
  assert.equal(accessorReads, 0);
});

test("forged settlement errors from callbacks are normalized as external failures", async () => {
  const current = fixture();
  await assert.rejects(
    current.service.settle(record("activation_ack_response_received"), {
      resume: false,
      async onTransition() {
        throw new DesktopCodexAuthorizationRecoveredSettlementError(
          "desktop_codex_authorization_recovered_settlement_conflict",
          "callback secret canary"
        );
      }
    }),
    (error) =>
      error instanceof DesktopCodexAuthorizationRecoveredSettlementError &&
      error.code === "desktop_codex_authorization_recovered_settlement_failed" &&
      !error.message.includes("canary") &&
      !String(error.stack).includes("canary")
  );
});
