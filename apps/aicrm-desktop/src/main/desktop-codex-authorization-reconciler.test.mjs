import assert from "node:assert/strict";
import test from "node:test";
import { DesktopAuthorizationTransportError } from "./desktop-authorization-transport-client.ts";
import {
  DesktopCodexAuthorizationReconciler,
  DesktopCodexAuthorizationReconcilerError
} from "./desktop-codex-authorization-reconciler.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
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

function record(status) {
  const index = PROGRESS.indexOf(status);
  assert.notEqual(index, -1);
  return {
    version: 1,
    generation: index + 1,
    status,
    lastProgressStatus: status,
    sessionId: "session_1",
    executorId: "executor_1",
    deviceId: "1".repeat(64),
    handoffId: "handoff_1",
    sessionRevision: 3,
    claimRequestReference: index >= 1 ? DIGEST_A : null,
    claimRequestHash: index >= 1 ? DIGEST_B : null,
    claimToken: index >= 2 && index <= 14 ? "claim.token.value" : null,
    claimExpiresAt: index >= 2 ? "2026-07-13T03:00:00Z" : null,
    loginIdHash: index >= 7 ? DIGEST_A : null,
    accountFingerprint: index >= 7 ? DIGEST_B : null,
    candidateBindingDigest: index >= 7 ? DIGEST_C : null,
    proofRequestReference: index >= 8 ? DIGEST_B : null,
    proofRequestHash: index >= 8 ? DIGEST_C : null,
    proofId: index >= 9 ? "proof_1" : null,
    activationOperationId: index >= 9 ? "operation_1" : null,
    activationId: index >= 9 ? "activation_1" : null,
    activationToken: index >= 9 && index <= 14 ? "activation.token.value" : null,
    activationExpiresAt: index >= 9 ? "2026-07-13T03:00:00Z" : null,
    credentialRevision: index >= 9 ? 2 : null,
    leaseEpoch: index >= 9 ? 1 : null,
    sourceCredentialRevision: index >= 9 ? 1 : null,
    revocationEpoch: index >= 9 ? 0 : null,
    bindingDigest: index >= 9 ? DIGEST_C : null,
    promotionReceipt: index >= 12
      ? {
          executorId: "executor_1",
          revision: 2,
          operationId: "operation_1",
          digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
          digest: DIGEST_C,
          fileCount: 2,
          totalBytes: 10
        }
      : null,
    ackRequestReference: index >= 13 ? DIGEST_A : null,
    ackRequestHash: index >= 13 ? DIGEST_B : null,
    localFailureCode: null,
    createdAt: "2026-07-13T01:00:00.000Z",
    updatedAt: "2026-07-13T01:00:00.000Z"
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const transport = {
    async recoverDesktopHandoffClaim(input) {
      calls.push(["claim", input]);
      return {
        requestReference: DIGEST_A,
        requestHash: DIGEST_B,
        recovered: true,
        data: {
          handoffId: "handoff_1",
          executorId: "executor_1",
          claimToken: "new.claim.token",
          expiresAt: "2026-07-13T03:00:00Z",
          sessionRevision: 4,
          replayed: true
        }
      };
    },
    async recoverAuthorizationProof(input) {
      calls.push(["proof", input]);
      return {
        requestReference: DIGEST_B,
        requestHash: DIGEST_C,
        recovered: true,
        data: {
          proofId: "proof_2",
          result: "succeeded",
          sessionRevision: 4,
          replayed: true,
          operationId: "operation_2",
          activationId: "activation_2",
          credentialRevision: 2,
          leaseEpoch: 2,
          sourceCredentialRevision: 1,
          revocationEpoch: 0,
          bindingDigest: DIGEST_C,
          activationToken: "new.activation.token",
          expiresAt: "2026-07-13T03:00:00Z"
        }
      };
    },
    async recoverCredentialActivationAck(input) {
      calls.push(["ack", input]);
      return {
        requestReference: DIGEST_A,
        requestHash: DIGEST_B,
        recovered: true,
        data: {
          activationId: "activation_1",
          executorId: "executor_1",
          credentialRevision: 2,
          sessionRevision: 4,
          replayed: true
        }
      };
    },
    ...overrides.transport
  };
  const credentials = {
    async recoverOperation(executorId, operationId) {
      calls.push(["promotion", executorId, operationId]);
      return {
        executorId,
        revision: 2,
        operationId,
        digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
        digest: DIGEST_C,
        fileCount: 2,
        totalBytes: 10
      };
    },
    async quarantineStaging(executorId, sessionId) {
      calls.push(["quarantine", executorId, sessionId]);
      return {
        ref: { kind: "quarantine", executorId, sourceKind: "staging", sourceId: sessionId },
        digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
        digest: DIGEST_C,
        fileCount: 0,
        totalBytes: 0
      };
    },
    async quarantineStagingIfPresent(executorId, sessionId) {
      calls.push(["quarantineIfPresent", executorId, sessionId]);
      return null;
    },
    async quarantinePromotion(input) {
      calls.push(["quarantinePromotion", input.operationId]);
      return {
        executorId: input.executorId,
        operationId: input.operationId,
        revision: input.revision,
        digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
        quarantineDigest: input.expectedDigest,
        fileCount: 2,
        totalBytes: 10
      };
    },
    ...overrides.credentials
  };
  const appServer = {
    async observe(value) {
      calls.push(["observe", value.status]);
      return { executorId: value.executorId, sessionId: value.sessionId, state: "absent" };
    },
    async stop(value) {
      calls.push(["stop", value.state]);
    },
    ...overrides.appServer
  };
  return {
    calls,
    reconciler: new DesktopCodexAuthorizationReconciler({ transport, credentials, appServer })
  };
}

test("claim recovery returns an exact successor without completing the request", async () => {
  const current = record("handoff_claim_starting");
  const { calls, reconciler } = fixture();
  const result = await reconciler.reconcile(current);
  assert.equal(result.outboundJournalReconciled, true);
  assert.equal(result.generation, current.generation);
  assert.equal(result.successor.status, "handoff_claimed");
  assert.equal(result.successor.claimToken, "new.claim.token");
  assert.equal(result.successor.sessionRevision, 4);
  assert.deepEqual(calls.map((item) => item[0]), ["claim"]);
});

test("deterministic claim rejection becomes a safe failed successor", async () => {
  const { reconciler } = fixture({
    transport: {
      async recoverDesktopHandoffClaim() {
        throw new DesktopAuthorizationTransportError(
          "desktop_authorization_transport_rejected",
          "sensitive server message",
          { status: 409, serverCode: "sensitive_conflict" }
        );
      }
    }
  });
  const result = await reconciler.reconcile(record("handoff_claim_starting"));
  assert.equal(result.successor.status, "failed");
  assert.equal(result.successor.localFailureCode, "desktop_handoff_claim_rejected");
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
});

test("ambiguous HTTP outcome remains pinned by rejecting recovery", async () => {
  const { reconciler } = fixture({
    transport: {
      async recoverDesktopHandoffClaim() {
        throw new DesktopAuthorizationTransportError(
          "desktop_authorization_transport_failed",
          "network canary",
          { status: 503 }
        );
      }
    }
  });
  await assert.rejects(
    reconciler.reconcile(record("handoff_claim_starting")),
    (error) =>
      error instanceof DesktopCodexAuthorizationReconcilerError &&
      error.code === "desktop_codex_authorization_recovery_ambiguous" &&
      !error.message.includes("canary")
  );
});

test("current-boot ready App Server advances only the exact session", async () => {
  const { calls, reconciler } = fixture({
    appServer: {
      async observe(value) {
        calls.push(["observe", value.status]);
        return { executorId: value.executorId, sessionId: value.sessionId, state: "ready" };
      }
    }
  });
  const result = await reconciler.reconcile(record("app_server_starting"));
  assert.equal(result.successor.status, "app_server_started");
  assert.deepEqual(calls.map((item) => item[0]), ["observe"]);
});

test("missing App Server ownership quarantines staging before interruption", async () => {
  const { calls, reconciler } = fixture();
  const result = await reconciler.reconcile(record("app_server_starting"));
  assert.equal(result.successor.status, "interrupted");
  assert.equal(result.successor.localFailureCode, "desktop_codex_app_server_restarted");
  assert.deepEqual(calls.map((item) => item[0]), ["observe", "quarantineIfPresent"]);
});

test("current-boot waiting login advances to waiting_user", async () => {
  const { reconciler } = fixture({
    appServer: {
      async observe(value) {
        return { executorId: value.executorId, sessionId: value.sessionId, state: "waiting_user" };
      }
    }
  });
  const result = await reconciler.reconcile(record("login_starting"));
  assert.equal(result.successor.status, "waiting_user");
});

test("proof recovery freezes the server activation tuple", async () => {
  const { calls, reconciler } = fixture();
  const result = await reconciler.reconcile(record("proof_submit_starting"));
  assert.equal(result.successor.status, "proof_prepared");
  assert.equal(result.successor.activationOperationId, "operation_2");
  assert.equal(result.successor.activationId, "activation_2");
  assert.equal(result.successor.leaseEpoch, 2);
  assert.deepEqual(calls.map((item) => item[0]), ["proof"]);
});

test("promotion recovery adopts only the exact existing operation", async () => {
  const { calls, reconciler } = fixture();
  const result = await reconciler.reconcile(record("credential_promotion_starting"));
  assert.equal(result.successor.status, "credential_durable");
  assert.equal(result.successor.promotionReceipt.operationId, "operation_1");
  assert.deepEqual(calls, [["promotion", "executor_1", "operation_1"]]);
});

test("ACK recovery advances only to response_received and leaves business settlement to coordinator", async () => {
  const { calls, reconciler } = fixture();
  const result = await reconciler.reconcile(record("activation_ack_starting"));
  assert.equal(result.successor.status, "activation_ack_response_received");
  assert.notEqual(result.successor.activationToken, null);
  assert.deepEqual(calls.map((item) => item[0]), ["ack"]);
});

test("deterministic ACK rejection quarantines the exact promotion before terminalizing", async () => {
  const { calls, reconciler } = fixture({
    transport: {
      async recoverCredentialActivationAck() {
        throw new DesktopAuthorizationTransportError(
          "desktop_authorization_transport_rejected",
          "ack rejected",
          { status: 410 }
        );
      }
    }
  });
  const result = await reconciler.reconcile(record("activation_ack_starting"));
  assert.equal(result.successor.status, "failed");
  assert.equal(result.successor.localFailureCode, "desktop_activation_ack_rejected");
  assert.deepEqual(calls, [["quarantinePromotion", "operation_1"]]);
});

test("deterministic proof rejection quarantines staging before returning a terminal capability", async () => {
  const { calls, reconciler } = fixture({
    transport: {
      async recoverAuthorizationProof() {
        throw new DesktopAuthorizationTransportError(
          "desktop_authorization_transport_rejected",
          "proof rejected",
          { status: 409 }
        );
      }
    }
  });
  const result = await reconciler.reconcile(record("proof_submit_starting"));
  assert.equal(result.successor.status, "failed");
  assert.equal(result.successor.localFailureCode, "desktop_authorization_proof_rejected");
  assert.deepEqual(calls, [["quarantine", "executor_1", "session_1"]]);
});

test("proof quarantine failure keeps the request and session pinned", async () => {
  const { reconciler } = fixture({
    transport: {
      async recoverAuthorizationProof() {
        throw new DesktopAuthorizationTransportError(
          "desktop_authorization_transport_rejected",
          "proof rejected",
          { status: 409 }
        );
      }
    },
    credentials: {
      async quarantineStaging() {
        throw new Error("quarantine canary");
      }
    }
  });
  await assert.rejects(
    reconciler.reconcile(record("proof_submit_starting")),
    (error) =>
      error instanceof DesktopCodexAuthorizationReconcilerError &&
      error.code === "desktop_codex_authorization_recovery_conflict" &&
      !error.message.includes("canary")
  );
});

test("claim, proof, and ACK recovery reject equal or jumped session revisions", async () => {
  for (const nextRevision of [3, 5]) {
    const claim = fixture({
      transport: {
        async recoverDesktopHandoffClaim() {
          return {
            requestReference: DIGEST_A,
            requestHash: DIGEST_B,
            recovered: true,
            data: {
              handoffId: "handoff_1",
              executorId: "executor_1",
              claimToken: "new.claim.token",
              expiresAt: "2026-07-13T03:00:00Z",
              sessionRevision: nextRevision,
              replayed: true
            }
          };
        }
      }
    });
    await assert.rejects(claim.reconciler.reconcile(record("handoff_claim_starting")));

    const proof = fixture({
      transport: {
        async recoverAuthorizationProof() {
          return {
            requestReference: DIGEST_B,
            requestHash: DIGEST_C,
            recovered: true,
            data: {
              proofId: "proof_2",
              result: "succeeded",
              sessionRevision: nextRevision,
              replayed: true,
              operationId: "operation_2",
              activationId: "activation_2",
              credentialRevision: 2,
              leaseEpoch: 2,
              sourceCredentialRevision: 1,
              revocationEpoch: 0,
              bindingDigest: DIGEST_C,
              activationToken: "new.activation.token",
              expiresAt: "2026-07-13T03:00:00Z"
            }
          };
        }
      }
    });
    await assert.rejects(proof.reconciler.reconcile(record("proof_submit_starting")));

    const ack = fixture({
      transport: {
        async recoverCredentialActivationAck() {
          return {
            requestReference: DIGEST_A,
            requestHash: DIGEST_B,
            recovered: true,
            data: {
              activationId: "activation_1",
              executorId: "executor_1",
              credentialRevision: 2,
              sessionRevision: nextRevision,
              replayed: true
            }
          };
        }
      }
    });
    await assert.rejects(ack.reconciler.reconcile(record("activation_ack_starting")));
  }
});

test("proof binding and promotion projection metadata are exact", async () => {
  const proof = fixture({
    transport: {
      async recoverAuthorizationProof() {
        return {
          requestReference: DIGEST_B,
          requestHash: DIGEST_C,
          recovered: true,
          data: {
            proofId: "proof_2",
            result: "succeeded",
            sessionRevision: 4,
            replayed: true,
            operationId: "operation_2",
            activationId: "activation_2",
            credentialRevision: 2,
            leaseEpoch: 2,
            sourceCredentialRevision: 1,
            revocationEpoch: 0,
            bindingDigest: DIGEST_A,
            activationToken: "new.activation.token",
            expiresAt: "2026-07-13T03:00:00Z"
          }
        };
      }
    }
  });
  await assert.rejects(proof.reconciler.reconcile(record("proof_submit_starting")));

  for (const bad of [
    { digestAlgorithm: "wrong" },
    { fileCount: -1 },
    { totalBytes: -1 }
  ]) {
    const promotion = fixture({
      credentials: {
        async recoverOperation(executorId, operationId) {
          return {
            executorId,
            revision: 2,
            operationId,
            digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
            digest: DIGEST_C,
            fileCount: 2,
            totalBytes: 10,
            ...bad
          };
        }
      }
    });
    await assert.rejects(
      promotion.reconciler.reconcile(record("credential_promotion_starting"))
    );
  }
});

test("mismatched recovered request fence fails closed", async () => {
  const { reconciler } = fixture({
    transport: {
      async recoverDesktopHandoffClaim() {
        return {
          requestReference: DIGEST_C,
          requestHash: DIGEST_B,
          recovered: true,
          data: {
            handoffId: "handoff_1",
            executorId: "executor_1",
            claimToken: "claim",
            expiresAt: "2026-07-13T03:00:00Z",
            sessionRevision: 4,
            replayed: true
          }
        };
      }
    }
  });
  await assert.rejects(
    reconciler.reconcile(record("handoff_claim_starting")),
    (error) =>
      error instanceof DesktopCodexAuthorizationReconcilerError &&
      error.code === "desktop_codex_authorization_recovery_conflict"
  );
});
