import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DesktopCodexAuthorizationRecoveryCoordinator,
  DesktopCodexAuthorizationRecoveryCoordinatorError
} from "./desktop-codex-authorization-recovery-coordinator.ts";

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
  return {
    version: 1,
    generation: status === "removed" ? 2 : 1,
    status,
    semanticKey: A,
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
    requestReference: A,
    requestHash: B,
    renewedAt: "2026-07-13T01:00:00Z",
    leaseExpiresAt: "2026-07-13T01:00:30Z",
    replayed: false,
    recovered: false,
    createdAt: "2026-07-13T01:00:00.000Z",
    updatedAt: "2026-07-13T01:00:00.000Z",
    removedAt: status === "removed" ? "2026-07-13T01:00:01.000Z" : null
  };
}

function fixture(initial, options = {}) {
  const calls = [];
  let current = { ...initial };
  const sessions = {
    async list() {
      calls.push("sessions.list");
      return [{ ...current }];
    },
    async transition(expected, next) {
      calls.push(`sessions.transition:${next.status}`);
      assert.equal(expected.generation, current.generation);
      current = {
        version: 1,
        generation: current.generation + 1,
        ...next,
        createdAt: current.createdAt,
        updatedAt: "2026-07-13T01:00:01.000Z"
      };
      return { ...current };
    },
    async terminalize(expected, status, localFailureCode) {
      calls.push(`sessions.terminalize:${status}`);
      assert.equal(expected.generation, current.generation);
      current = {
        ...current,
        generation: current.generation + 1,
        status,
        claimToken: null,
        activationToken: null,
        localFailureCode,
        updatedAt: "2026-07-13T01:00:03.000Z"
      };
      return { ...current };
    },
    async recoverAll() {
      calls.push("sessions.recoverAll");
      if (options.recoverError) throw options.recoverError;
      if (options.recoveredStatus) {
        current = record(options.recoveredStatus, current.generation + 1);
        current.updatedAt = "2026-07-13T01:00:02.000Z";
      }
      return [{ ...current }];
    }
  };
  const events = {
    async restoreHighWater(snapshot) {
      calls.push(`events.restore:${snapshot.sequence}`);
    },
    async broadcast(snapshot) {
      calls.push(`events.broadcast:${snapshot.sequence}`);
      return null;
    }
  };
  const transport = {
    async completeRequestIfPresent(reference, hash) {
      calls.push("transport.complete");
      assert.equal(reference.length, 64);
      assert.equal(hash.length, 64);
      return options.requestAlreadyAbsent ? "already_absent" : "completed";
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
    },
    async quarantineStaging() {
      calls.push("credentials.quarantine");
      return {};
    }
  };
  const bindings = {
    async activate(input) {
      calls.push("bindings.activate");
      assert.equal(input.authorizationSessionId, "session_1");
      assert.equal(input.activationAckRequestReference, A);
      return {};
    }
  };
  const leases = {
    async inspect() {
      calls.push("leases.read");
      if (options.leaseMissing) return null;
      return { ...lease(options.leaseStatus), ...options.leaseOverrides };
    },
    async remove() {
      calls.push("leases.remove");
    }
  };
  const artifacts = {
    async inspect() {
      calls.push("artifacts.inspect");
      return options.artifact ?? null;
    }
  };
  const coordinator = new DesktopCodexAuthorizationRecoveryCoordinator({
    sessions,
    events,
    transport,
    credentials,
    bindings,
    leases,
    artifacts,
    async resume(value) {
      calls.push(`resume:${value.status}`);
    }
  });
  return { calls, coordinator, current: () => current };
}

test("adopts a durable claim journal, CAS-recovers it, then completes and resumes", async () => {
  const { calls, coordinator } = fixture(record("accepted"), {
    artifact: {
      kind: "handoff_claim",
      sessionId: "session_1",
      executorId: "executor_1",
      requestReference: A,
      requestHash: B
    },
    recoveredStatus: "handoff_claimed"
  });
  const snapshots = await coordinator.recoverOnStartup();
  assert.equal(snapshots[0].status, "starting");
  assert.deepEqual(calls, [
    "sessions.list",
    "events.restore:1",
    "artifacts.inspect",
    "sessions.transition:handoff_claim_starting",
    "events.broadcast:2",
    "sessions.recoverAll",
    "events.broadcast:3",
    "transport.complete",
    "resume:handoff_claimed"
  ]);
});

test("ambiguous session-store recovery completes no journal and publishes no successor", async () => {
  const { calls, coordinator } = fixture(record("handoff_claim_starting"), {
    recoverError: new Error("ambiguous canary")
  });
  await assert.rejects(
    coordinator.recoverOnStartup(),
    (error) =>
      error instanceof DesktopCodexAuthorizationRecoveryCoordinatorError &&
      error.code === "desktop_codex_authorization_recovery_failed" &&
      !error.message.includes("canary")
  );
  assert.equal(calls.includes("transport.complete"), false);
  assert.equal(calls.some((item) => item.startsWith("events.broadcast")), false);
});

test("ACK response settles binding and credential evidence before session success and cleanup", async () => {
  const { calls, coordinator } = fixture(record("activation_ack_response_received"));
  const snapshots = await coordinator.recoverOnStartup();
  assert.equal(snapshots[0].status, "succeeded");
  assert.deepEqual(calls, [
    "sessions.list",
    "events.restore:15",
    "artifacts.inspect",
    "sessions.recoverAll",
    "leases.read",
    "bindings.activate",
    "credentials.acknowledge",
    "sessions.transition:activation_acked",
    "events.broadcast:16",
    "transport.complete",
    "credentials.remove",
    "leases.remove"
  ]);
});

test("already activated session finishes idempotent tombstone cleanup without requiring token", async () => {
  const { calls, coordinator } = fixture(record("activation_acked"), {
    leaseStatus: "removed"
  });
  const snapshots = await coordinator.recoverOnStartup();
  assert.equal(snapshots[0].status, "succeeded");
  assert.deepEqual(calls.slice(-3), ["leases.read", "transport.complete", "credentials.remove"]);
  assert.equal(calls.includes("leases.remove"), false);
  assert.equal(calls.some((item) => item.startsWith("resume:")), false);
});

test("missing, removed, or mismatched lease proof causes zero ACK settlement side effects", async () => {
  for (const options of [
    { leaseMissing: true },
    { leaseStatus: "removed" },
    { leaseOverrides: { bindingDigest: A } }
  ]) {
    const current = fixture(record("activation_ack_response_received"), options);
    await assert.rejects(current.coordinator.recoverOnStartup(), {
      code: "desktop_codex_authorization_recovery_conflict"
    });
    for (const forbidden of [
      "bindings.activate",
      "credentials.acknowledge",
      "sessions.transition:activation_acked",
      "transport.complete",
      "credentials.remove",
      "leases.remove"
    ]) {
      assert.equal(current.calls.includes(forbidden), false, `${forbidden} ran for ${JSON.stringify(options)}`);
    }
  }

  const activated = fixture(record("activation_acked"), { leaseMissing: true });
  await assert.rejects(activated.coordinator.recoverOnStartup(), {
    code: "desktop_codex_authorization_recovery_conflict"
  });
  assert.equal(activated.calls.includes("transport.complete"), false);
  assert.equal(activated.calls.includes("credentials.remove"), false);
});

test("twenty concurrent startup calls share one recovery and a later call is rejected", async () => {
  const { calls, coordinator } = fixture(record("handoff_claimed"));
  const results = await Promise.all(
    Array.from({ length: 20 }, () => coordinator.recoverOnStartup())
  );
  assert.equal(results.length, 20);
  assert.equal(calls.filter((item) => item === "sessions.list").length, 1);
  await assert.rejects(
    coordinator.recoverOnStartup(),
    (error) =>
      error instanceof DesktopCodexAuthorizationRecoveryCoordinatorError &&
      error.code === "desktop_codex_authorization_recovery_conflict"
  );
});

test("already completed request and already-adopted artifact converge without a second CAS", async () => {
  const current = record("handoff_claimed");
  const { calls, coordinator } = fixture(current, {
    artifact: {
      kind: "handoff_claim",
      sessionId: current.sessionId,
      executorId: current.executorId,
      requestReference: A,
      requestHash: B
    },
    requestAlreadyAbsent: true
  });
  await coordinator.recoverOnStartup();
  assert.equal(calls.some((item) => item.startsWith("sessions.transition")), false);
  assert.equal(calls.filter((item) => item === "transport.complete").length, 1);
  assert.equal(calls.includes("resume:handoff_claimed"), true);
});

test("startup-only accepted and browser-waiting orphans converge to interrupted", async () => {
  const accepted = fixture(record("accepted"));
  const acceptedResult = await accepted.coordinator.recoverOnStartup();
  assert.equal(acceptedResult[0].status, "interrupted");
  assert.equal(accepted.calls.includes("sessions.terminalize:interrupted"), true);
  assert.equal(accepted.calls.includes("credentials.quarantine"), false);

  const waiting = fixture(record("waiting_user"));
  const waitingResult = await waiting.coordinator.recoverOnStartup();
  assert.equal(waitingResult[0].status, "interrupted");
  assert.deepEqual(waiting.calls.slice(-3), [
    "credentials.quarantine",
    "sessions.terminalize:interrupted",
    "events.broadcast:8"
  ]);
});
