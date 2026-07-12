import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DesktopCodexExactRecoveryArtifactInspector,
  DesktopCodexRecoveryArtifactInspectorError
} from "./desktop-codex-recovery-artifacts.ts";
import {
  DesktopDeviceRequestJournalStore,
  desktopTrustedRequestReference
} from "./desktop-device-request-journal.ts";
import {
  buildDesktopDeviceProof,
  desktopDeviceKeyMaterialFromSeed
} from "./desktop-device-proof.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

function record(status, overrides = {}) {
  return {
    status,
    lastProgressStatus: status,
    sessionId: "session_1",
    executorId: "executor_1",
    deviceId: "1".repeat(64),
    handoffId: "handoff_1",
    sessionRevision: 3,
    claimToken: "claim.token.value",
    loginIdHash: A,
    accountFingerprint: B,
    candidateBindingDigest: B,
    claimRequestReference: null,
    claimRequestHash: null,
    proofRequestReference: null,
    proofRequestHash: null,
    ackRequestReference: null,
    ackRequestHash: null,
    activationOperationId: "operation_1",
    activationId: "activation_1",
    activationToken: "activation.token.value",
    credentialRevision: 2,
    leaseEpoch: 1,
    sourceCredentialRevision: 1,
    revocationEpoch: 0,
    bindingDigest: B,
    ...overrides
  };
}

function pendingRequest(kind, path, requestHash = A, overrides = {}) {
  const body = kind === "handoff_claim"
    ? { handoffId: "handoff_1", claimedAt: "2026-07-13T01:00:00.000Z" }
    : kind === "authorization_proof"
      ? {
          handoffId: "handoff_1",
          sessionRevision: 3,
          loginIdHash: A,
          result: "succeeded",
          checkedAt: "2026-07-13T01:00:00.000Z",
          accountFingerprint: B,
          candidateBindingDigest: B
        }
      : {
          operationId: "operation_1",
          activationId: "activation_1",
          credentialRevision: 2,
          leaseEpoch: 1,
          sourceCredentialRevision: 1,
          revocationEpoch: 0,
          durableBarrierCompletedAt: "2026-07-13T01:00:00.000Z",
          bindingDigest: B
        };
  const authorization = kind === "authorization_proof"
    ? "AiCRM-Claim claim.token.value"
    : kind === "credential_activation_ack"
      ? "AiCRM-Activation activation.token.value"
      : "AiCRM-Handoff header.payload.signature";
  return {
    reference: desktopTrustedRequestReference(kind, path),
    kind,
    method: "POST",
    path,
    authorization,
    bodyBase64: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
    signed: { requestHash, deviceId: "1".repeat(64) },
    ...overrides
  };
}

function fixture({ request = null, operations = [] } = {}) {
  const calls = [];
  const inspector = new DesktopCodexExactRecoveryArtifactInspector({
    requests: {
      async load(reference) {
        calls.push(["load", reference]);
        return request;
      }
    },
    credentials: {
      async listPendingOperations(executorId) {
        calls.push(["operations", executorId]);
        return operations;
      }
    }
  });
  return { calls, inspector };
}

test("accepted session adopts only its exact durable claim request", async () => {
  const current = record("accepted");
  const path =
    `/api/v1/ai-executor-authorization-sessions/${current.sessionId}` +
    `/desktop-handoffs/${current.handoffId}/claim`;
  const request = pendingRequest("handoff_claim", path);
  const { inspector } = fixture({ request });
  assert.deepEqual(await inspector.inspect(current), {
    kind: "handoff_claim",
    sessionId: current.sessionId,
    executorId: current.executorId,
    requestReference: request.reference,
    requestHash: A
  });
});

test("already-fenced request must retain the exact frozen reference and hash", async () => {
  const current = record("handoff_claim_starting", {
    claimRequestReference: B,
    claimRequestHash: B
  });
  const path =
    `/api/v1/ai-executor-authorization-sessions/${current.sessionId}` +
    `/desktop-handoffs/${current.handoffId}/claim`;
  const { inspector } = fixture({ request: pendingRequest("handoff_claim", path) });
  await assert.rejects(
    inspector.inspect(current),
    (error) =>
      error instanceof DesktopCodexRecoveryArtifactInspectorError &&
      error.code === "desktop_codex_recovery_artifact_conflict"
  );
});

test("proof adoption binds device, canonical body, frozen tuple, and claim token", async () => {
  const current = record("login_completed");
  const path = "/api/v1/ai-executor-authorization-sessions/session_1/desktop-proofs";
  const mismatchedBody = {
    handoffId: current.handoffId,
    sessionRevision: current.sessionRevision,
    loginIdHash: current.loginIdHash,
    result: "succeeded",
    checkedAt: "2026-07-13T01:00:00.000Z",
    accountFingerprint: current.accountFingerprint,
    candidateBindingDigest: A
  };
  for (const request of [
    pendingRequest("authorization_proof", path, A, {
      signed: { requestHash: A, deviceId: "2".repeat(64) }
    }),
    pendingRequest("authorization_proof", path, A, {
      bodyBase64: Buffer.from(JSON.stringify(mismatchedBody), "utf8").toString("base64")
    }),
    pendingRequest("authorization_proof", path, A, {
      authorization: "AiCRM-Claim foreign.token.value"
    })
  ]) {
    const { inspector } = fixture({ request });
    await assert.rejects(inspector.inspect(current), {
      code: "desktop_codex_recovery_artifact_conflict"
    });
  }
});

test("a real encrypted proof journal with a different frozen digest is rejected before adoption", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-recovery-artifact-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => Buffer.from(value).toString("utf8")
  };
  const journal = new DesktopDeviceRequestJournalStore({
    root: path.join(base, "requests"),
    safeStorage
  });
  const key = desktopDeviceKeyMaterialFromSeed(Buffer.alloc(32, 7));
  const current = record("login_completed", { deviceId: key.deviceId });
  const proofPath = "/api/v1/ai-executor-authorization-sessions/session_1/desktop-proofs";
  const authorization = "AiCRM-Claim claim.token.value";
  const body = Buffer.from(JSON.stringify({
    handoffId: current.handoffId,
    sessionRevision: current.sessionRevision,
    loginIdHash: current.loginIdHash,
    result: "succeeded",
    checkedAt: "2026-07-13T01:00:00.000Z",
    accountFingerprint: current.accountFingerprint,
    candidateBindingDigest: A
  }), "utf8");
  const signed = buildDesktopDeviceProof({
    key,
    method: "POST",
    path: proofPath,
    body,
    authorization,
    allowedAuthorizationSchemes: ["AiCRM-Claim"],
    timestamp: Date.parse("2026-07-13T01:00:00.000Z"),
    nonce: Buffer.alloc(16, 4).toString("base64url"),
    sequence: 1n
  });
  await journal.createOrLoad({
    version: 1,
    reference: desktopTrustedRequestReference("authorization_proof", proofPath),
    kind: "authorization_proof",
    method: "POST",
    origin: "https://aicrm.example.test",
    path: proofPath,
    authorization,
    bodyBase64: body.toString("base64"),
    signed: {
      ...signed,
      deviceId: key.deviceId,
      publicKey: key.publicKey,
      keyGeneration: 1,
      sequence: "1"
    },
    createdAt: "2026-07-13T01:00:00.000Z",
    response: null
  });
  const inspector = new DesktopCodexExactRecoveryArtifactInspector({
    requests: journal,
    credentials: { listPendingOperations: async () => [] }
  });
  await assert.rejects(inspector.inspect(current), {
    code: "desktop_codex_recovery_artifact_conflict"
  });
});

test("claim and ACK adoption reject foreign device, body tuple, or activation token", async () => {
  const claimRecord = record("accepted");
  const claimPath =
    "/api/v1/ai-executor-authorization-sessions/session_1/desktop-handoffs/handoff_1/claim";
  const wrongClaimBody = Buffer.from(JSON.stringify({
    handoffId: "foreign_handoff",
    claimedAt: "2026-07-13T01:00:00.000Z"
  }), "utf8").toString("base64");
  for (const request of [
    pendingRequest("handoff_claim", claimPath, A, {
      signed: { requestHash: A, deviceId: "2".repeat(64) }
    }),
    pendingRequest("handoff_claim", claimPath, A, { bodyBase64: wrongClaimBody })
  ]) {
    await assert.rejects(fixture({ request }).inspector.inspect(claimRecord), {
      code: "desktop_codex_recovery_artifact_conflict"
    });
  }

  const ackPath =
    "/api/v1/ai-executor-authorization-sessions/session_1/desktop-activations/activation_1/ack";
  const ackReference = desktopTrustedRequestReference("credential_activation_ack", ackPath);
  const ackRecord = record("activation_ack_starting", {
    ackRequestReference: ackReference,
    ackRequestHash: A
  });
  const wrongAckBody = Buffer.from(JSON.stringify({
    operationId: ackRecord.activationOperationId,
    activationId: ackRecord.activationId,
    credentialRevision: ackRecord.credentialRevision,
    leaseEpoch: ackRecord.leaseEpoch,
    sourceCredentialRevision: ackRecord.sourceCredentialRevision,
    revocationEpoch: 99,
    durableBarrierCompletedAt: "2026-07-13T01:00:00.000Z",
    bindingDigest: ackRecord.bindingDigest
  }), "utf8").toString("base64");
  for (const request of [
    pendingRequest("credential_activation_ack", ackPath, A, {
      bodyBase64: wrongAckBody
    }),
    pendingRequest("credential_activation_ack", ackPath, A, {
      authorization: "AiCRM-Activation foreign.activation.token"
    })
  ]) {
    await assert.rejects(fixture({ request }).inspector.inspect(ackRecord), {
      code: "desktop_codex_recovery_artifact_conflict"
    });
  }
});

test("activation pending adopts only one exact staging promotion operation", async () => {
  const current = record("activation_pending");
  const operation = {
    executorId: current.executorId,
    operationId: current.activationOperationId,
    sourceKind: "staging",
    sourceId: current.sessionId,
    targetRevision: current.credentialRevision,
    expectedDigest: current.bindingDigest,
    phase: "verified"
  };
  const { inspector } = fixture({ operations: [operation] });
  assert.deepEqual(await inspector.inspect(current), {
    kind: "credential_promotion",
    sessionId: current.sessionId,
    executorId: current.executorId,
    operationId: current.activationOperationId,
    credentialRevision: current.credentialRevision,
    bindingDigest: current.bindingDigest
  });
});

test("competing or mismatched promotion journals fail closed", async () => {
  const current = record("credential_promotion_starting");
  const exact = {
    executorId: current.executorId,
    operationId: current.activationOperationId,
    sourceKind: "staging",
    sourceId: current.sessionId,
    targetRevision: current.credentialRevision,
    expectedDigest: current.bindingDigest,
    phase: "prepared"
  };
  for (const operations of [
    [exact, { ...exact, operationId: "other" }],
    [{ ...exact, sourceId: "foreign_session" }],
    [{ ...exact, phase: "quarantined" }]
  ]) {
    const { inspector } = fixture({ operations });
    await assert.rejects(inspector.inspect(current), {
      code: "desktop_codex_recovery_artifact_conflict"
    });
  }
});

test("ACK state inspects ACK instead of an older proof or promotion artifact", async () => {
  const current = record("activation_ack_response_received", {
    ackRequestReference: desktopTrustedRequestReference(
      "credential_activation_ack",
      "/api/v1/ai-executor-authorization-sessions/session_1/desktop-activations/activation_1/ack"
    ),
    ackRequestHash: A
  });
  const path =
    "/api/v1/ai-executor-authorization-sessions/session_1/desktop-activations/activation_1/ack";
  const request = pendingRequest("credential_activation_ack", path);
  const { calls, inspector } = fixture({ request });
  const artifact = await inspector.inspect(current);
  assert.equal(artifact.kind, "credential_activation_ack");
  assert.equal(calls.some(([kind]) => kind === "operations"), false);
});

test("cleared tokens use only the exact frozen request evidence for ACKed and terminal recovery", async () => {
  const proofPath =
    "/api/v1/ai-executor-authorization-sessions/session_1/desktop-proofs";
  const proofReference = desktopTrustedRequestReference("authorization_proof", proofPath);
  const ackPath =
    "/api/v1/ai-executor-authorization-sessions/session_1/desktop-activations/activation_1/ack";
  const ackReference = desktopTrustedRequestReference("credential_activation_ack", ackPath);
  const cases = [
    {
      current: record("activation_acked", {
        claimToken: null,
        activationToken: null,
        ackRequestReference: ackReference,
        ackRequestHash: A
      }),
      request: pendingRequest("credential_activation_ack", ackPath),
      kind: "credential_activation_ack"
    },
    {
      current: record("indeterminate", {
        lastProgressStatus: "proof_submit_starting",
        claimToken: null,
        activationToken: null,
        proofRequestReference: proofReference,
        proofRequestHash: A
      }),
      request: pendingRequest("authorization_proof", proofPath),
      kind: "authorization_proof"
    },
    {
      current: record("indeterminate", {
        lastProgressStatus: "activation_ack_starting",
        claimToken: null,
        activationToken: null,
        ackRequestReference: ackReference,
        ackRequestHash: A
      }),
      request: pendingRequest("credential_activation_ack", ackPath),
      kind: "credential_activation_ack"
    }
  ];
  for (const item of cases) {
    const artifact = await fixture({ request: item.request }).inspector.inspect(item.current);
    assert.equal(artifact.kind, item.kind);
    await assert.rejects(
      fixture({ request: item.request }).inspector.inspect({
        ...item.current,
        [item.kind === "authorization_proof"
          ? "proofRequestHash"
          : "ackRequestHash"]: B
      }),
      { code: "desktop_codex_recovery_artifact_conflict" }
    );
  }
});

test("a stage without a relevant existing artifact returns null without scans", async () => {
  const { calls, inspector } = fixture();
  assert.equal(await inspector.inspect(record("app_server_started")), null);
  assert.deepEqual(calls, []);
});
