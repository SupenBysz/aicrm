import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DESKTOP_CODEX_AUTHORIZATION_PROGRESS,
  DesktopCodexAuthorizationSessionStore,
  desktopCodexAuthorizationSessionData
} from "./desktop-codex-authorization-session-store.ts";

const DEVICE_ID = "1".repeat(64);
const CLAIM_REFERENCE = "2".repeat(64);
const CLAIM_HASH = "3".repeat(64);
const LOGIN_ID_HASH = "4".repeat(64);
const ACCOUNT_FINGERPRINT = "5".repeat(64);
const CANDIDATE_DIGEST = "9".repeat(64);
const PROOF_REFERENCE = "7".repeat(64);
const PROOF_HASH = "8".repeat(64);
const BINDING_DIGEST = "9".repeat(64);
const CREDENTIAL_DIGEST = BINDING_DIGEST;
const ACK_REFERENCE = "b".repeat(64);
const ACK_HASH = "c".repeat(64);
const CLAIM_TOKEN = "claimTokenCanary.header.signature";
const ACTIVATION_TOKEN = "activationTokenCanary.header.signature";
const CLAIM_EXPIRES_AT = "2026-07-13T10:05:00Z";
const ACTIVATION_EXPIRES_AT = "2026-07-13T10:10:00.123456789Z";
const RAW_LOGIN_ID = "raw-login-id-must-never-persist";
const RAW_AUTH_URL = "https://auth.openai.com/codex/callback?secret=must-never-persist";
const RAW_USER_CODE = "ABCD-EFGH-MUST-NEVER-PERSIST";
const ENVELOPE_MAGIC = Buffer.from("AICRM-CODEX-AUTH-SESSION-ENC-V1\n", "ascii");

class FakeSafeStorage {
  constructor({ available = true, backend = "gnome_libsecret" } = {}) {
    this.available = available;
    this.backend = backend;
  }

  isEncryptionAvailable() {
    return this.available;
  }

  getSelectedStorageBackend() {
    return this.backend;
  }

  encryptString(value) {
    return Buffer.concat([
      Buffer.from("CODEX-AUTH-SESSION-TEST\0"),
      Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0xa5))
    ]);
  }

  decryptString(value) {
    const prefix = Buffer.from("CODEX-AUTH-SESSION-TEST\0");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("ciphertext invalid");
    return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0xa5)).toString("utf8");
  }
}

function activationLeaseRequestReference(record) {
  const requestPath =
    `/api/v1/ai-executor-authorization-sessions/${record.sessionId}` +
    `/desktop-activations/${record.activationId}/lease-renewals`;
  return createHash("sha256")
    .update(
      `AICRM-TRUSTED-REQUEST-V1\ncredential_activation_lease_renewal\n${requestPath}`,
      "utf8"
    )
    .digest("hex");
}

function activationLeaseSemanticKey(record) {
  return createHash("sha256")
    .update(
      `AICRM-ACTIVATION-LEASE-FENCE-V1\n${record.sessionId}\n${record.activationId}`,
      "utf8"
    )
    .digest("hex");
}

function activationLeaseFenceRecord(record, overrides = {}) {
  return {
    version: 1,
    generation: 7,
    status: "fresh",
    semanticKey: activationLeaseSemanticKey(record),
    sessionId: record.sessionId,
    executorId: record.executorId,
    operationId: record.activationOperationId,
    activationId: record.activationId,
    credentialRevision: record.credentialRevision,
    leaseEpoch: record.leaseEpoch,
    sourceCredentialRevision: record.sourceCredentialRevision,
    revocationEpoch: record.revocationEpoch,
    bindingDigest: record.bindingDigest,
    tokenHash: createHash("sha256").update(record.activationToken, "utf8").digest("hex"),
    requestReference: activationLeaseRequestReference(record),
    requestHash: "e".repeat(64),
    renewedAt: "2026-07-13T10:00:00Z",
    leaseExpiresAt: "2026-07-13T10:00:30Z",
    replayed: false,
    recovered: false,
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt: "2026-07-13T10:00:00.000Z",
    removedAt: null,
    ...overrides
  };
}

class FakeActivationLeaseFenceReader {
  constructor({ autoInstall = true, requireFreshHandler = null } = {}) {
    this.autoInstall = autoInstall;
    this.requireFreshHandler = requireFreshHandler;
    this.records = new Map();
    this.readCalls = [];
    this.requireFreshCalls = [];
  }

  install(record, overrides = {}) {
    const fence = activationLeaseFenceRecord(record, overrides);
    this.records.set(fence.activationId, structuredClone(fence));
    return structuredClone(fence);
  }

  async read(activationId) {
    this.readCalls.push(activationId);
    const current = this.records.get(activationId);
    return current ? structuredClone(current) : null;
  }

  async requireFresh(expected) {
    this.requireFreshCalls.push(structuredClone(expected));
    if (this.requireFreshHandler) {
      return structuredClone(await this.requireFreshHandler(expected, this));
    }
    const current = this.records.get(expected.activationId);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error("activation lease fence CAS mismatch");
    }
    return structuredClone(current);
  }
}

function recoveryCapability(record, successor = null, overrides = {}) {
  return {
    sessionId: record.sessionId,
    executorId: record.executorId,
    deviceId: record.deviceId,
    generation: record.generation,
    claimRequestReference: record.claimRequestReference,
    claimRequestHash: record.claimRequestHash,
    proofRequestReference: record.proofRequestReference,
    proofRequestHash: record.proofRequestHash,
    ackRequestReference: record.ackRequestReference,
    ackRequestHash: record.ackRequestHash,
    activationOperationId: record.activationOperationId,
    activationId: record.activationId,
    credentialRevision: record.credentialRevision,
    leaseEpoch: record.leaseEpoch,
    sourceCredentialRevision: record.sourceCredentialRevision,
    revocationEpoch: record.revocationEpoch,
    bindingDigest: record.bindingDigest,
    outboundJournalReconciled: true,
    successor,
    ...overrides
  };
}

class FakeRecoveryReconciler {
  constructor(handler = (record) => recoveryCapability(record)) {
    this.handler = handler;
    this.calls = [];
  }

  async reconcile(record) {
    this.calls.push(record);
    return this.handler(record);
  }
}

async function fixture(overrides = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-codex-auth-session-"));
  const root = path.join(base, "sessions");
  const safeStorage = overrides.safeStorage ?? new FakeSafeStorage();
  const reconciler = overrides.reconciler ?? new FakeRecoveryReconciler();
  const activationLeaseFenceReader =
    overrides.activationLeaseFenceReader ?? new FakeActivationLeaseFenceReader();
  let time = Date.parse(overrides.startTime ?? "2026-07-13T10:00:00.000Z");
  const options = {
    root,
    safeStorage,
    reconciler,
    activationLeaseFenceReader,
    now: overrides.now ?? (() => new Date(time++)),
    faultInjector: overrides.faultInjector,
    renameFile: overrides.renameFile,
    syncDirectory: overrides.syncDirectory
  };
  const store = new DesktopCodexAuthorizationSessionStore(options);
  leaseReadersByStore.set(store, activationLeaseFenceReader);
  return {
    base,
    root,
    safeStorage,
    reconciler,
    activationLeaseFenceReader,
    options,
    store
  };
}

const leaseReadersByStore = new WeakMap();

function initial(overrides = {}) {
  return {
    sessionId: "authsession_1",
    executorId: "executor_1",
    deviceId: DEVICE_ID,
    handoffId: "handoff_1",
    sessionRevision: 1,
    ...overrides
  };
}

async function advance(store, current, status, changes = {}) {
  const leaseReader = leaseReadersByStore.get(store);
  if (
    leaseReader?.autoInstall &&
    (status === "credential_promotion_starting" || status === "activation_ack_starting")
  ) {
    leaseReader.install(current);
  }
  return store.transition(current, {
    ...desktopCodexAuthorizationSessionData(current),
    status,
    lastProgressStatus: status,
    ...changes
  });
}

async function progressToWaiting(store, current) {
  current = await advance(store, current, "handoff_claim_starting", {
    claimRequestReference: CLAIM_REFERENCE,
    claimRequestHash: CLAIM_HASH
  });
  current = await advance(store, current, "handoff_claimed", {
    claimToken: CLAIM_TOKEN,
    claimExpiresAt: CLAIM_EXPIRES_AT,
    sessionRevision: 2
  });
  current = await advance(store, current, "app_server_starting");
  current = await advance(store, current, "app_server_started");
  current = await advance(store, current, "login_starting");
  return advance(store, current, "waiting_user");
}

async function progressToActivationPending(store, current) {
  current = await progressToWaiting(store, current);
  current = await advance(store, current, "login_completed", {
    loginIdHash: LOGIN_ID_HASH,
    accountFingerprint: ACCOUNT_FINGERPRINT,
    candidateBindingDigest: CANDIDATE_DIGEST
  });
  current = await advance(store, current, "proof_submit_starting", {
    proofRequestReference: PROOF_REFERENCE,
    proofRequestHash: PROOF_HASH
  });
  current = await advance(store, current, "proof_prepared", {
    proofId: "proof_1",
    activationOperationId: "activation_operation_1",
    activationId: "activation_1",
    activationToken: ACTIVATION_TOKEN,
    activationExpiresAt: ACTIVATION_EXPIRES_AT,
    credentialRevision: 3,
    leaseEpoch: 2,
    sourceCredentialRevision: 1,
    revocationEpoch: 4,
    bindingDigest: BINDING_DIGEST,
    sessionRevision: 3
  });
  return advance(store, current, "activation_pending");
}

async function progressToAckStarting(store, current) {
  current = await progressToActivationPending(store, current);
  current = await advance(store, current, "credential_promotion_starting");
  current = await advance(store, current, "credential_durable", {
    promotionReceipt: {
      executorId: "executor_1",
      revision: 3,
      operationId: "activation_operation_1",
      digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
      digest: CREDENTIAL_DIGEST,
      fileCount: 12,
      totalBytes: 4096
    }
  });
  return advance(store, current, "activation_ack_starting", {
    ackRequestReference: ACK_REFERENCE,
    ackRequestHash: ACK_HASH
  });
}

async function advanceOneAuthorizationStage(store, current) {
  switch (current.status) {
    case "accepted":
      return advance(store, current, "handoff_claim_starting", {
        claimRequestReference: CLAIM_REFERENCE,
        claimRequestHash: CLAIM_HASH
      });
    case "handoff_claim_starting":
      return advance(store, current, "handoff_claimed", {
        claimToken: CLAIM_TOKEN,
        claimExpiresAt: CLAIM_EXPIRES_AT,
        sessionRevision: 2
      });
    case "handoff_claimed":
      return advance(store, current, "app_server_starting");
    case "app_server_starting":
      return advance(store, current, "app_server_started");
    case "app_server_started":
      return advance(store, current, "login_starting");
    case "login_starting":
      return advance(store, current, "waiting_user");
    case "waiting_user":
      return advance(store, current, "login_completed", {
        loginIdHash: LOGIN_ID_HASH,
        accountFingerprint: ACCOUNT_FINGERPRINT,
        candidateBindingDigest: CANDIDATE_DIGEST
      });
    case "login_completed":
      return advance(store, current, "proof_submit_starting", {
        proofRequestReference: PROOF_REFERENCE,
        proofRequestHash: PROOF_HASH
      });
    case "proof_submit_starting":
      return advance(store, current, "proof_prepared", {
        proofId: "proof_1",
        activationOperationId: "activation_operation_1",
        activationId: "activation_1",
        activationToken: ACTIVATION_TOKEN,
        activationExpiresAt: ACTIVATION_EXPIRES_AT,
        credentialRevision: 3,
        leaseEpoch: 2,
        sourceCredentialRevision: 1,
        revocationEpoch: 4,
        bindingDigest: BINDING_DIGEST,
        sessionRevision: 3
      });
    case "proof_prepared":
      return advance(store, current, "activation_pending");
    case "activation_pending":
      return advance(store, current, "credential_promotion_starting");
    case "credential_promotion_starting":
      return advance(store, current, "credential_durable", {
        promotionReceipt: {
          executorId: "executor_1",
          revision: 3,
          operationId: "activation_operation_1",
          digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
          digest: CREDENTIAL_DIGEST,
          fileCount: 12,
          totalBytes: 4096
        }
      });
    case "credential_durable":
      return advance(store, current, "activation_ack_starting", {
        ackRequestReference: ACK_REFERENCE,
        ackRequestHash: ACK_HASH
      });
    case "activation_ack_starting":
      return advance(store, current, "activation_ack_response_received", {
        sessionRevision: 4
      });
    case "activation_ack_response_received":
      return advance(store, current, "activation_acked", {
        claimToken: null,
        activationToken: null
      });
    default:
      throw new Error(`cannot advance authorization status ${current.status}`);
  }
}

test("server response transitions require the exact next session revision", async (t) => {
  for (const stage of ["claim", "proof", "ack"]) {
    await t.test(stage, async (st) => {
      for (const delta of [0, 2]) {
        const current = await fixture();
        st.after(() => rm(current.base, { recursive: true, force: true }));
        let value = await current.store.create(initial());
        let status;
        let changes;
        if (stage === "claim") {
          value = await advance(current.store, value, "handoff_claim_starting", {
            claimRequestReference: CLAIM_REFERENCE,
            claimRequestHash: CLAIM_HASH
          });
          status = "handoff_claimed";
          changes = {
            claimToken: CLAIM_TOKEN,
            claimExpiresAt: CLAIM_EXPIRES_AT,
            sessionRevision: value.sessionRevision + delta
          };
        } else if (stage === "proof") {
          value = await progressToWaiting(current.store, value);
          value = await advance(current.store, value, "login_completed", {
            loginIdHash: LOGIN_ID_HASH,
            accountFingerprint: ACCOUNT_FINGERPRINT,
            candidateBindingDigest: CANDIDATE_DIGEST
          });
          value = await advance(current.store, value, "proof_submit_starting", {
            proofRequestReference: PROOF_REFERENCE,
            proofRequestHash: PROOF_HASH
          });
          status = "proof_prepared";
          changes = {
            proofId: "proof_1",
            activationOperationId: "activation_operation_1",
            activationId: "activation_1",
            activationToken: ACTIVATION_TOKEN,
            activationExpiresAt: ACTIVATION_EXPIRES_AT,
            credentialRevision: 3,
            leaseEpoch: 2,
            sourceCredentialRevision: 1,
            revocationEpoch: 4,
            bindingDigest: BINDING_DIGEST,
            sessionRevision: value.sessionRevision + delta
          };
        } else {
          value = await progressToAckStarting(current.store, value);
          status = "activation_ack_response_received";
          changes = { sessionRevision: value.sessionRevision + delta };
        }
        await assert.rejects(
          advance(current.store, value, status, changes),
          { code: "desktop_codex_authorization_conflict" }
        );
      }
    });
  }
});

test("superseded is a durable token-clearing terminal at every unfinished progress stage", async (t) => {
  for (const targetStatus of DESKTOP_CODEX_AUTHORIZATION_PROGRESS.slice(0, -1)) {
    await t.test(targetStatus, async (st) => {
      const current = await fixture();
      st.after(() => rm(current.base, { recursive: true, force: true }));
      let record = await current.store.create(initial());
      while (record.status !== targetStatus) {
        record = await advanceOneAuthorizationStage(current.store, record);
      }
      const frozenProgress = record.lastProgressStatus;
      const superseded = await current.store.terminalize(record, "superseded");
      assert.equal(superseded.status, "superseded");
      assert.equal(superseded.lastProgressStatus, frozenProgress);
      assert.equal(superseded.localFailureCode, null);
      assert.equal(superseded.claimToken, null);
      assert.equal(superseded.activationToken, null);

      const restarted = new DesktopCodexAuthorizationSessionStore(current.options);
      const persisted = await restarted.read(record.sessionId);
      assert.deepEqual(persisted, superseded);
      assert.deepEqual(await restarted.snapshot(record.sessionId), {
        sessionId: record.sessionId,
        executorId: record.executorId,
        sequence: superseded.generation,
        status: "superseded",
        canReopen: false,
        canCancel: false
      });
      const raw = await readFile(path.join(current.root, `${record.sessionId}.sec`));
      const encryptedRecord = JSON.parse(
        current.safeStorage.decryptString(raw.subarray(ENVELOPE_MAGIC.length))
      );
      assert.equal(encryptedRecord.status, "superseded");
      assert.equal(encryptedRecord.lastProgressStatus, frozenProgress);
      assert.equal(encryptedRecord.claimToken, null);
      assert.equal(encryptedRecord.activationToken, null);

      await assert.rejects(
        advanceOneAuthorizationStage(restarted, record),
        { code: "desktop_codex_authorization_conflict" }
      );
      await assert.rejects(
        restarted.transition(persisted, desktopCodexAuthorizationSessionData(persisted)),
        { code: "desktop_codex_authorization_conflict" }
      );
    });
  }
});

test("superseded rejects non-null failure codes through APIs and encrypted recovery", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const record = await current.store.create(initial());
  const supersededWithFailure = {
    ...desktopCodexAuthorizationSessionData(record),
    status: "superseded",
    localFailureCode: "desktop_authorization_superseded"
  };

  await assert.rejects(
    async () =>
      current.store.terminalize(
        record,
        "superseded",
        "desktop_authorization_superseded"
      ),
    { code: "desktop_codex_authorization_unsafe" }
  );
  await assert.rejects(
    async () => current.store.transition(record, supersededWithFailure),
    { code: "desktop_codex_authorization_unsafe" }
  );
  assert.deepEqual(await current.store.read(record.sessionId), record);

  const target = path.join(current.root, `${record.sessionId}.sec`);
  const raw = await readFile(target);
  const forged = JSON.parse(
    current.safeStorage.decryptString(raw.subarray(ENVELOPE_MAGIC.length))
  );
  forged.status = "superseded";
  forged.localFailureCode = "desktop_authorization_superseded";
  await writeFile(
    target,
    Buffer.concat([
      ENVELOPE_MAGIC,
      current.safeStorage.encryptString(JSON.stringify(forged))
    ]),
    { mode: 0o600 }
  );

  const restarted = new DesktopCodexAuthorizationSessionStore(current.options);
  await assert.rejects(restarted.read(record.sessionId), {
    code: "desktop_codex_authorization_corrupt"
  });
});

test("full success chain is monotonic, encrypted, and exposes only the documented safe snapshot", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let record = await current.store.create(initial());
  record = await progressToWaiting(current.store, record);

  assert.deepEqual(await current.store.snapshot(record.sessionId), {
    sessionId: "authsession_1",
    executorId: "executor_1",
    sequence: record.generation,
    status: "waiting_user",
    canReopen: true,
    canCancel: true
  });

  record = await advance(current.store, record, "login_completed", {
    loginIdHash: LOGIN_ID_HASH,
    accountFingerprint: ACCOUNT_FINGERPRINT,
    candidateBindingDigest: CANDIDATE_DIGEST
  });
  record = await advance(current.store, record, "proof_submit_starting", {
    proofRequestReference: PROOF_REFERENCE,
    proofRequestHash: PROOF_HASH
  });
  record = await advance(current.store, record, "proof_prepared", {
    proofId: "proof_1",
    activationOperationId: "activation_operation_1",
    activationId: "activation_1",
    activationToken: ACTIVATION_TOKEN,
    activationExpiresAt: ACTIVATION_EXPIRES_AT,
    credentialRevision: 3,
    leaseEpoch: 2,
    sourceCredentialRevision: 1,
    revocationEpoch: 4,
    bindingDigest: BINDING_DIGEST,
    sessionRevision: 3
  });
  assert.equal(record.claimToken, CLAIM_TOKEN, "claim recovery token must survive until final ACK");
  record = await advance(current.store, record, "activation_pending");
  record = await advance(current.store, record, "credential_promotion_starting");
  record = await advance(current.store, record, "credential_durable", {
    promotionReceipt: {
      executorId: "executor_1",
      revision: 3,
      operationId: "activation_operation_1",
      digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
      digest: CREDENTIAL_DIGEST,
      fileCount: 12,
      totalBytes: 4096
    }
  });
  await assert.rejects(
    async () => advance(current.store, record, "activation_ack_starting"),
    { code: "desktop_codex_authorization_unsafe" }
  );
  record = await advance(current.store, record, "activation_ack_starting", {
    ackRequestReference: ACK_REFERENCE,
    ackRequestHash: ACK_HASH
  });
  assert.equal(record.ackRequestReference, ACK_REFERENCE);
  assert.equal(record.ackRequestHash, ACK_HASH);
  await assert.rejects(
    current.store.transition(record, {
      ...desktopCodexAuthorizationSessionData(record),
      status: "activation_ack_response_received",
      lastProgressStatus: "activation_ack_response_received",
      ackRequestReference: "d".repeat(64),
      ackRequestHash: "e".repeat(64),
      sessionRevision: 4
    }),
    { code: "desktop_codex_authorization_conflict" }
  );
  record = await advance(current.store, record, "activation_ack_response_received", {
    ackRequestReference: ACK_REFERENCE,
    ackRequestHash: ACK_HASH,
    sessionRevision: 4
  });
  assert.equal(record.claimToken, CLAIM_TOKEN);
  assert.equal(record.activationToken, ACTIVATION_TOKEN);
  record = await advance(current.store, record, "activation_acked", {
    claimToken: null,
    activationToken: null
  });
  assert.equal(record.claimToken, null);
  assert.equal(record.activationToken, null);
  assert.equal(record.claimExpiresAt, CLAIM_EXPIRES_AT);
  assert.equal(record.activationExpiresAt, ACTIVATION_EXPIRES_AT);

  const snapshot = await current.store.snapshot(record.sessionId);
  assert.deepEqual(snapshot, {
    sessionId: "authsession_1",
    executorId: "executor_1",
    sequence: record.generation,
    status: "succeeded",
    canReopen: false,
    canCancel: false
  });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "canCancel",
    "canReopen",
    "executorId",
    "sequence",
    "sessionId",
    "status"
  ]);
  const safeJSON = JSON.stringify(snapshot);
  for (const canary of [
    CLAIM_TOKEN,
    ACTIVATION_TOKEN,
    CLAIM_HASH,
    LOGIN_ID_HASH,
    ACCOUNT_FINGERPRINT,
    RAW_LOGIN_ID,
    RAW_AUTH_URL,
    RAW_USER_CODE
  ]) {
    assert.equal(safeJSON.includes(canary), false);
  }

  const target = path.join(current.root, "authsession_1.sec");
  const raw = await readFile(target);
  for (const canary of [
    CLAIM_TOKEN,
    ACTIVATION_TOKEN,
    CLAIM_HASH,
    LOGIN_ID_HASH,
    ACCOUNT_FINGERPRINT,
    CREDENTIAL_DIGEST,
    RAW_LOGIN_ID,
    RAW_AUTH_URL,
    RAW_USER_CODE
  ]) {
    assert.equal(raw.includes(Buffer.from(canary)), false);
  }
  if (process.platform !== "win32") {
    assert.equal((await stat(current.root)).mode & 0o777, 0o700);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  }
  const restarted = new DesktopCodexAuthorizationSessionStore(current.options);
  assert.deepEqual(await restarted.read(record.sessionId), record);
});

test("full-record generation CAS serializes two stores, rejects stale tuples, and replays exactly", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const first = await current.store.create(initial());
  const secondStore = new DesktopCodexAuthorizationSessionStore(current.options);
  const left = {
    ...desktopCodexAuthorizationSessionData(first),
    status: "handoff_claim_starting",
    lastProgressStatus: "handoff_claim_starting",
    claimRequestReference: CLAIM_REFERENCE,
    claimRequestHash: CLAIM_HASH
  };
  const right = {
    ...left,
    claimRequestReference: "d".repeat(64),
    claimRequestHash: "e".repeat(64)
  };
  const results = await Promise.allSettled([
    current.store.transition(first, left),
    secondStore.transition(first, right)
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const winner = await current.store.read(first.sessionId);
  assert.equal(winner.generation, 2);
  const winnerData = desktopCodexAuthorizationSessionData(winner);
  assert.deepEqual(await secondStore.transition(first, winnerData), winner);
  await assert.rejects(
    current.store.transition(first, {
      ...winnerData,
      claimRequestHash: "f".repeat(64)
    }),
    { code: "desktop_codex_authorization_conflict" }
  );
});

for (const faultPoint of [
  "after_commit_shadow_fsync",
  "after_temporary_fsync",
  "after_rename",
  "before_directory_fsync"
]) {
  test(`${faultPoint} recovers the exact next generation from its durable commit evidence`, async (t) => {
    let armed = false;
    const current = await fixture({
      faultInjector: (point) => {
        if (armed && point === faultPoint) {
          armed = false;
          throw new Error("simulated process crash");
        }
      }
    });
    t.after(() => rm(current.base, { recursive: true, force: true }));
    const accepted = await current.store.create(initial());
    armed = true;
    await assert.rejects(
      advance(current.store, accepted, "handoff_claim_starting", {
        claimRequestReference: CLAIM_REFERENCE,
        claimRequestHash: CLAIM_HASH
      })
    );
    const restarted = new DesktopCodexAuthorizationSessionStore({
      root: current.root,
      safeStorage: current.safeStorage,
      reconciler: current.reconciler,
      activationLeaseFenceReader: current.activationLeaseFenceReader,
      now: current.options.now
    });
    const recovered = await restarted.read(accepted.sessionId);
    assert.equal(recovered.status, "handoff_claim_starting");
    assert.equal(recovered.generation, 2);
    assert.equal(recovered.claimRequestHash, CLAIM_HASH);
    assert.deepEqual(await readdir(current.root), ["authsession_1.sec"]);
  });
}

test("divergent temporary evidence is rejected in place and never deleted", async (t) => {
  let armed = false;
  const current = await fixture({
    faultInjector: (point) => {
      if (armed && point === "after_temporary_fsync") {
        armed = false;
        throw new Error("leave generation two evidence");
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const accepted = await current.store.create(initial());
  armed = true;
  await assert.rejects(
    advance(current.store, accepted, "handoff_claim_starting", {
      claimRequestReference: CLAIM_REFERENCE,
      claimRequestHash: CLAIM_HASH
    }),
    { code: "desktop_codex_authorization_corrupt" }
  );
  const temporary = path.join(current.root, "authsession_1.sec.tmp");
  const raw = await readFile(temporary);
  const divergent = JSON.parse(
    current.safeStorage.decryptString(raw.subarray(ENVELOPE_MAGIC.length))
  );
  divergent.claimRequestReference = "d".repeat(64);
  divergent.claimRequestHash = "e".repeat(64);
  const divergentRaw = Buffer.concat([
    ENVELOPE_MAGIC,
    current.safeStorage.encryptString(JSON.stringify(divergent))
  ]);
  await writeFile(temporary, divergentRaw, { mode: 0o600 });
  const restarted = new DesktopCodexAuthorizationSessionStore({
    ...current.options,
    faultInjector: undefined
  });
  await assert.rejects(restarted.read(accepted.sessionId), {
    code: "desktop_codex_authorization_corrupt"
  });
  assert.deepEqual(await readFile(temporary), divergentRaw);
});

test("repair rejects a gapped historical commit chain and a non-accepted generation-one orphan", async (t) => {
  await t.test("gapped old commit", async (t) => {
    const current = await fixture();
    t.after(() => rm(current.base, { recursive: true, force: true }));
    let record = await current.store.create(initial());
    const generationOne = await readFile(path.join(current.root, "authsession_1.sec"));
    record = await advance(current.store, record, "handoff_claim_starting", {
      claimRequestReference: CLAIM_REFERENCE,
      claimRequestHash: CLAIM_HASH
    });
    record = await advance(current.store, record, "handoff_claimed", {
      claimToken: CLAIM_TOKEN,
      claimExpiresAt: CLAIM_EXPIRES_AT,
      sessionRevision: 2
    });
    await writeFile(
      path.join(current.root, "authsession_1.sec.commit-1"),
      generationOne,
      { mode: 0o600 }
    );
    const restarted = new DesktopCodexAuthorizationSessionStore(current.options);
    await assert.rejects(restarted.read(record.sessionId), {
      code: "desktop_codex_authorization_corrupt"
    });
    assert.equal(
      (await readdir(current.root)).includes("authsession_1.sec.commit-1"),
      true
    );
  });

  await t.test("generation one must be accepted", async (t) => {
    const current = await fixture();
    t.after(() => rm(current.base, { recursive: true, force: true }));
    await current.store.create(initial());
    const target = path.join(current.root, "authsession_1.sec");
    const raw = await readFile(target);
    const forged = JSON.parse(
      current.safeStorage.decryptString(raw.subarray(ENVELOPE_MAGIC.length))
    );
    forged.status = "indeterminate";
    forged.localFailureCode = "desktop_effect_outcome_indeterminate";
    await rm(target);
    await writeFile(
      path.join(current.root, "authsession_1.sec.commit-1"),
      Buffer.concat([
        ENVELOPE_MAGIC,
        current.safeStorage.encryptString(JSON.stringify(forged))
      ]),
      { mode: 0o600 }
    );
    const restarted = new DesktopCodexAuthorizationSessionStore(current.options);
    await assert.rejects(restarted.read("authsession_1"), {
      code: "desktop_codex_authorization_corrupt"
    });
  });
});

test("unknown filesystem and fault errors are normalized without leaking host paths", async (t) => {
  const pathCanary = "/Volumes/private/customer/authsession_1.sec";
  const current = await fixture({
    faultInjector(point) {
      if (point === "after_commit_shadow_fsync") {
        throw new Error(`EIO while syncing ${pathCanary}`);
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await assert.rejects(current.store.create(initial()), (error) => {
    assert.equal(error.code, "desktop_codex_authorization_corrupt");
    assert.equal(error.message, "Codex 授权恢复操作失败");
    assert.equal(String(error).includes(pathCanary), false);
    assert.equal(String(error.stack).includes(pathCanary), false);
    return true;
  });
});

test("restart never re-enters an effect fence without a durable successor", async (t) => {
  const early = await fixture();
  t.after(() => rm(early.base, { recursive: true, force: true }));
  let record = await early.store.create(initial());
  record = await advance(early.store, record, "handoff_claim_starting", {
    claimRequestReference: CLAIM_REFERENCE,
    claimRequestHash: CLAIM_HASH
  });
  const earlyRestart = new DesktopCodexAuthorizationSessionStore(early.options);
  const indeterminate = await earlyRestart.recover(record.sessionId);
  assert.equal(indeterminate.status, "indeterminate");
  assert.equal(indeterminate.lastProgressStatus, "handoff_claim_starting");
  assert.equal(indeterminate.localFailureCode, "desktop_effect_outcome_indeterminate");

  const late = await fixture();
  t.after(() => rm(late.base, { recursive: true, force: true }));
  record = await late.store.create(initial());
  record = await progressToAckStarting(late.store, record);
  assert.equal(record.claimToken, CLAIM_TOKEN);
  assert.equal(record.activationToken, ACTIVATION_TOKEN);
  const lateRestart = new DesktopCodexAuthorizationSessionStore(late.options);
  const lateIndeterminate = await lateRestart.recover(record.sessionId);
  assert.equal(lateIndeterminate.status, "indeterminate");
  assert.equal(lateIndeterminate.claimToken, null);
  assert.equal(lateIndeterminate.activationToken, null);
  assert.deepEqual(await lateRestart.snapshot(record.sessionId), {
    sessionId: "authsession_1",
    executorId: "executor_1",
    sequence: lateIndeterminate.generation,
    status: "interrupted",
    canReopen: false,
    canCancel: false,
    localFailureCode: "desktop_effect_outcome_indeterminate"
  });
});

test("ACK response durable fence closes the server-response/local-terminal crash window", async (t) => {
  let armed = false;
  const current = await fixture({
    faultInjector: (point) => {
      if (armed && point === "after_temporary_fsync") {
        armed = false;
        throw new Error("crash while persisting ACK response evidence");
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let record = await current.store.create(initial());
  record = await progressToAckStarting(current.store, record);
  assert.equal(record.ackRequestReference, ACK_REFERENCE);
  assert.equal(record.ackRequestHash, ACK_HASH);
  armed = true;
  await assert.rejects(
    advance(current.store, record, "activation_ack_response_received", {
      ackRequestReference: ACK_REFERENCE,
      ackRequestHash: ACK_HASH,
      sessionRevision: 4
    })
  );

  const restarted = new DesktopCodexAuthorizationSessionStore({
    root: current.root,
    safeStorage: current.safeStorage,
    reconciler: current.reconciler,
    activationLeaseFenceReader: current.activationLeaseFenceReader,
    now: current.options.now
  });
  const recovered = await restarted.recover(record.sessionId);
  assert.equal(recovered.status, "activation_ack_response_received");
  assert.equal(recovered.ackRequestReference, ACK_REFERENCE);
  assert.equal(recovered.claimToken, CLAIM_TOKEN);
  assert.equal(recovered.activationToken, ACTIVATION_TOKEN);
  assert.equal(recovered.claimExpiresAt, CLAIM_EXPIRES_AT);
  assert.equal(recovered.activationExpiresAt, ACTIVATION_EXPIRES_AT);
  const acked = await advance(restarted, recovered, "activation_acked", {
    claimToken: null,
    activationToken: null
  });
  assert.equal(acked.status, "activation_acked");
  assert.equal(acked.claimToken, null);
  assert.equal(acked.activationToken, null);
});

test("all failure terminals clear raw tokens and reject a terminal payload that retains them", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let record = await current.store.create(initial());
  record = await progressToActivationPending(current.store, record);
  await assert.rejects(
    async () => current.store.transition(record, {
      ...desktopCodexAuthorizationSessionData(record),
      status: "failed",
      localFailureCode: "desktop_authorization_failed"
    }),
    { code: "desktop_codex_authorization_unsafe" }
  );
  const failed = await current.store.terminalize(
    record,
    "failed",
    "desktop_authorization_failed"
  );
  assert.equal(failed.claimToken, null);
  assert.equal(failed.activationToken, null);
  assert.equal(failed.claimExpiresAt, CLAIM_EXPIRES_AT);
  assert.equal(failed.activationExpiresAt, ACTIVATION_EXPIRES_AT);
  assert.equal(failed.status, "failed");
  await assert.rejects(current.store.terminalize(failed, "cancelled"), {
    code: "desktop_codex_authorization_conflict"
  });
});

test("raw authUrl, loginId and userCode fields are rejected without entering record, error, snapshot, or ciphertext", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const record = await current.store.create(initial());
  const unsafe = {
    ...desktopCodexAuthorizationSessionData(record),
    status: "handoff_claim_starting",
    lastProgressStatus: "handoff_claim_starting",
    claimRequestReference: CLAIM_REFERENCE,
    claimRequestHash: CLAIM_HASH,
    authUrl: RAW_AUTH_URL,
    loginId: RAW_LOGIN_ID,
    userCode: RAW_USER_CODE
  };
  await assert.rejects(async () => current.store.transition(record, unsafe), (error) => {
    const safeError = `${error.code}:${error.message}`;
    assert.equal(safeError.includes(RAW_AUTH_URL), false);
    assert.equal(safeError.includes(RAW_LOGIN_ID), false);
    assert.equal(safeError.includes(RAW_USER_CODE), false);
    return true;
  });
  const stored = await current.store.read(record.sessionId);
  const snapshot = await current.store.snapshot(record.sessionId);
  const raw = await readFile(path.join(current.root, "authsession_1.sec"));
  for (const canary of [RAW_AUTH_URL, RAW_LOGIN_ID, RAW_USER_CODE]) {
    assert.equal(JSON.stringify(stored).includes(canary), false);
    assert.equal(JSON.stringify(snapshot).includes(canary), false);
    assert.equal(raw.includes(Buffer.from(canary)), false);
  }
});

test("claim and activation expiries are mandatory by phase, canonical, immutable, and exact", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let record = await current.store.create(initial());
  record = await advance(current.store, record, "handoff_claim_starting", {
    claimRequestReference: CLAIM_REFERENCE,
    claimRequestHash: CLAIM_HASH
  });
  const claimedWithoutExpiry = {
    ...desktopCodexAuthorizationSessionData(record),
    status: "handoff_claimed",
    lastProgressStatus: "handoff_claimed",
    claimToken: CLAIM_TOKEN,
    sessionRevision: 2
  };
  await assert.rejects(async () => current.store.transition(record, claimedWithoutExpiry), {
    code: "desktop_codex_authorization_unsafe"
  });
  for (const invalid of [
    "2026-07-13T10:05:00.120Z",
    "2026-07-13T10:05:00.1234567891Z",
    "2026-07-13T10:05:00z",
    "2026-07-13T18:05:00+08:00"
  ]) {
    await assert.rejects(
      async () =>
        current.store.transition(record, {
          ...claimedWithoutExpiry,
          claimExpiresAt: invalid
        }),
      { code: "desktop_codex_authorization_unsafe" }
    );
  }
  record = await current.store.transition(record, {
    ...claimedWithoutExpiry,
    claimExpiresAt: CLAIM_EXPIRES_AT
  });
  for (const changed of [
    "2026-07-13T10:04:59.999Z",
    "2026-07-13T10:05:00.001Z"
  ]) {
    await assert.rejects(
      current.store.transition(record, {
        ...desktopCodexAuthorizationSessionData(record),
        status: "app_server_starting",
        lastProgressStatus: "app_server_starting",
        claimExpiresAt: changed
      }),
      { code: "desktop_codex_authorization_conflict" }
    );
  }

  record = await advance(current.store, record, "app_server_starting");
  record = await advance(current.store, record, "app_server_started");
  record = await advance(current.store, record, "login_starting");
  record = await advance(current.store, record, "waiting_user");
  record = await advance(current.store, record, "login_completed", {
    loginIdHash: LOGIN_ID_HASH,
    accountFingerprint: ACCOUNT_FINGERPRINT,
    candidateBindingDigest: CANDIDATE_DIGEST
  });
  record = await advance(current.store, record, "proof_submit_starting", {
    proofRequestReference: PROOF_REFERENCE,
    proofRequestHash: PROOF_HASH
  });
  const proofPreparedWithoutExpiry = {
    ...desktopCodexAuthorizationSessionData(record),
    status: "proof_prepared",
    lastProgressStatus: "proof_prepared",
    proofId: "proof_1",
    activationOperationId: "activation_operation_1",
    activationId: "activation_1",
    activationToken: ACTIVATION_TOKEN,
    credentialRevision: 3,
    leaseEpoch: 2,
    sourceCredentialRevision: 1,
    revocationEpoch: 4,
    bindingDigest: BINDING_DIGEST,
    sessionRevision: 3
  };
  await assert.rejects(
    async () => current.store.transition(record, proofPreparedWithoutExpiry),
    { code: "desktop_codex_authorization_unsafe" }
  );
  await assert.rejects(
    async () =>
      current.store.transition(record, {
        ...proofPreparedWithoutExpiry,
        activationExpiresAt: "not-a-canonical-time"
      }),
    { code: "desktop_codex_authorization_unsafe" }
  );
  record = await current.store.transition(record, {
    ...proofPreparedWithoutExpiry,
    activationExpiresAt: ACTIVATION_EXPIRES_AT
  });
  for (const changed of [
    "2026-07-13T10:09:59.999Z",
    "2026-07-13T10:10:00.001Z"
  ]) {
    await assert.rejects(
      current.store.transition(record, {
        ...desktopCodexAuthorizationSessionData(record),
        status: "activation_pending",
        lastProgressStatus: "activation_pending",
        activationExpiresAt: changed
      }),
      { code: "desktop_codex_authorization_conflict" }
    );
  }
  const pending = await advance(current.store, record, "activation_pending");
  assert.equal(pending.claimExpiresAt, CLAIM_EXPIRES_AT);
  assert.equal(pending.activationExpiresAt, ACTIVATION_EXPIRES_AT);
});

test("a pre-expiry encrypted record is rejected as a non-migratable corrupt tuple", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.create(initial());
  const target = path.join(current.root, "authsession_1.sec");
  const raw = await readFile(target);
  const oldRecord = JSON.parse(
    current.safeStorage.decryptString(raw.subarray(ENVELOPE_MAGIC.length))
  );
  delete oldRecord.claimExpiresAt;
  delete oldRecord.activationExpiresAt;
  await writeFile(
    target,
    Buffer.concat([
      ENVELOPE_MAGIC,
      current.safeStorage.encryptString(JSON.stringify(oldRecord))
    ]),
    { mode: 0o600 }
  );
  const restarted = new DesktopCodexAuthorizationSessionStore(current.options);
  await assert.rejects(restarted.read("authsession_1"), {
    code: "desktop_codex_authorization_corrupt"
  });
});

test("only an injected exact reconciler capability may resolve or terminalize an effect fence", async (t) => {
  const failurePath = "/Users/private/codex-journals/authsession_1.sec";
  const failedReconciler = new FakeRecoveryReconciler(async () => {
    throw new Error(`outbound failed at ${failurePath}`);
  });
  const failed = await fixture({ reconciler: failedReconciler });
  t.after(() => rm(failed.base, { recursive: true, force: true }));
  let record = await failed.store.create(initial());
  record = await advance(failed.store, record, "handoff_claim_starting", {
    claimRequestReference: CLAIM_REFERENCE,
    claimRequestHash: CLAIM_HASH
  });
  await assert.rejects(failed.store.recover(record.sessionId), (error) => {
    assert.equal(error.code, "desktop_codex_authorization_conflict");
    assert.equal(String(error.message).includes(failurePath), false);
    return true;
  });
  assert.equal((await failed.store.read(record.sessionId)).status, "handoff_claim_starting");

  const mismatchedReconciler = new FakeRecoveryReconciler((value) => ({
    ...recoveryCapability(value),
    generation: value.generation + 1
  }));
  const mismatched = await fixture({ reconciler: mismatchedReconciler });
  t.after(() => rm(mismatched.base, { recursive: true, force: true }));
  record = await mismatched.store.create(initial());
  record = await advance(mismatched.store, record, "handoff_claim_starting", {
    claimRequestReference: CLAIM_REFERENCE,
    claimRequestHash: CLAIM_HASH
  });
  await assert.rejects(mismatched.store.recover(record.sessionId), {
    code: "desktop_codex_authorization_conflict"
  });
  assert.equal((await mismatched.store.read(record.sessionId)).generation, record.generation);

  const successorReconciler = new FakeRecoveryReconciler((value) =>
    recoveryCapability(value, {
      ...desktopCodexAuthorizationSessionData(value),
      status: "handoff_claimed",
      lastProgressStatus: "handoff_claimed",
      claimToken: CLAIM_TOKEN,
      claimExpiresAt: CLAIM_EXPIRES_AT,
      sessionRevision: 2
    })
  );
  const recovered = await fixture({ reconciler: successorReconciler });
  t.after(() => rm(recovered.base, { recursive: true, force: true }));
  record = await recovered.store.create(initial());
  record = await advance(recovered.store, record, "handoff_claim_starting", {
    claimRequestReference: CLAIM_REFERENCE,
    claimRequestHash: CLAIM_HASH
  });
  const claimed = await recovered.store.recover(record.sessionId);
  assert.equal(claimed.status, "handoff_claimed");
  assert.equal(claimed.generation, record.generation + 1);
  assert.equal(claimed.claimToken, CLAIM_TOKEN);
  assert.equal(successorReconciler.calls.length, 1);
});

test("wrong activation capability or exact lease-fence record never terminalizes an activation effect", async (t) => {
  const wrongActivationReconciler = new FakeRecoveryReconciler((record) =>
    recoveryCapability(record, null, { activationId: "activation_wrong" })
  );
  const wrongActivation = await fixture({ reconciler: wrongActivationReconciler });
  t.after(() => rm(wrongActivation.base, { recursive: true, force: true }));
  let record = await wrongActivation.store.create(initial());
  record = await progressToAckStarting(wrongActivation.store, record);
  await assert.rejects(wrongActivation.store.recover(record.sessionId), {
    code: "desktop_codex_authorization_conflict"
  });
  let preserved = await wrongActivation.store.read(record.sessionId);
  assert.equal(preserved.status, "activation_ack_starting");
  assert.equal(preserved.generation, record.generation);

  for (const [label, overrides] of [
    ["token hash", { tokenHash: "f".repeat(64) }],
    ["request hash", { requestHash: "not-a-digest" }],
    [
      "future server pair",
      {
        renewedAt: "2026-07-13T10:01:00Z",
        leaseExpiresAt: "2026-07-13T10:01:30Z"
      }
    ]
  ]) {
    await t.test(label, async (t) => {
      const current = await fixture();
      t.after(() => rm(current.base, { recursive: true, force: true }));
      let effect = await current.store.create(initial());
      effect = await progressToActivationPending(current.store, effect);
      effect = await advance(current.store, effect, "credential_promotion_starting");
      current.activationLeaseFenceReader.install(effect, overrides);
      await assert.rejects(current.store.recover(effect.sessionId), {
        code: "desktop_codex_authorization_conflict"
      });
      const exact = await current.store.read(effect.sessionId);
      assert.equal(exact.status, "credential_promotion_starting");
      assert.equal(exact.generation, effect.generation);
    });
  }
});

test("a stale but unexpired generation returned by requireFresh cannot authorize a future effect", async (t) => {
  const leaseReader = new FakeActivationLeaseFenceReader({
    autoInstall: false,
    requireFreshHandler(expected) {
      return { ...expected, generation: expected.generation - 1 };
    }
  });
  const current = await fixture({ activationLeaseFenceReader: leaseReader });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let record = await current.store.create(initial());
  record = await progressToActivationPending(current.store, record);
  leaseReader.install(record, { generation: 8 });
  await assert.rejects(
    advance(current.store, record, "credential_promotion_starting"),
    { code: "desktop_codex_authorization_conflict" }
  );
  const preserved = await current.store.read(record.sessionId);
  assert.equal(preserved.status, "activation_pending");
  assert.equal(preserved.generation, record.generation);
  assert.equal(leaseReader.requireFreshCalls.length, 1);
});

test("idempotent promotion-starting retry rechecks the exact fresh lease", async (t) => {
  let now = Date.parse("2026-07-13T10:00:00.000Z");
  const leaseReader = new FakeActivationLeaseFenceReader({ autoInstall: false });
  const current = await fixture({
    activationLeaseFenceReader: leaseReader,
    now: () => new Date(now)
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let expected = await current.store.create(initial());
  expected = await progressToActivationPending(current.store, expected);
  const desired = {
    ...desktopCodexAuthorizationSessionData(expected),
    status: "credential_promotion_starting",
    lastProgressStatus: "credential_promotion_starting"
  };
  leaseReader.install(expected);
  const starting = await current.store.transition(expected, desired);
  assert.equal(starting.status, "credential_promotion_starting");
  assert.equal(leaseReader.requireFreshCalls.length, 1);

  now = Date.parse("2026-07-13T10:01:00.000Z");
  await assert.rejects(current.store.transition(expected, desired), {
    code: "desktop_codex_authorization_conflict"
  });
  assert.equal(leaseReader.requireFreshCalls.length, 2);
  const preserved = await current.store.read(expected.sessionId);
  assert.equal(preserved.status, "credential_promotion_starting");
  assert.equal(preserved.generation, starting.generation);
  assert.deepEqual(desktopCodexAuthorizationSessionData(preserved), desired);
});

test("idempotent ACK-starting retry rejects a recovery-required lease", async (t) => {
  const leaseReader = new FakeActivationLeaseFenceReader({ autoInstall: false });
  const current = await fixture({ activationLeaseFenceReader: leaseReader });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let expected = await current.store.create(initial());
  expected = await progressToActivationPending(current.store, expected);
  leaseReader.install(expected);
  expected = await advance(current.store, expected, "credential_promotion_starting");
  expected = await advance(current.store, expected, "credential_durable", {
    promotionReceipt: {
      executorId: "executor_1",
      revision: 3,
      operationId: "activation_operation_1",
      digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
      digest: CREDENTIAL_DIGEST,
      fileCount: 12,
      totalBytes: 4096
    }
  });
  const desired = {
    ...desktopCodexAuthorizationSessionData(expected),
    status: "activation_ack_starting",
    lastProgressStatus: "activation_ack_starting",
    ackRequestReference: ACK_REFERENCE,
    ackRequestHash: ACK_HASH
  };
  leaseReader.install(expected);
  const starting = await current.store.transition(expected, desired);
  assert.equal(starting.status, "activation_ack_starting");
  const freshChecks = leaseReader.requireFreshCalls.length;

  leaseReader.install(starting, {
    status: "recovery_required",
    recovered: true
  });
  await assert.rejects(current.store.transition(expected, desired), {
    code: "desktop_codex_authorization_conflict"
  });
  assert.equal(leaseReader.requireFreshCalls.length, freshChecks + 1);
  const preserved = await current.store.read(expected.sessionId);
  assert.equal(preserved.status, "activation_ack_starting");
  assert.equal(preserved.generation, starting.generation);
  assert.deepEqual(desktopCodexAuthorizationSessionData(preserved), desired);
});

test("an ACK response recovered after lease expiry converges without authorizing another effect", async (t) => {
  let now = Date.parse("2026-07-13T10:00:00.000Z");
  const reconciler = new FakeRecoveryReconciler((record) =>
    recoveryCapability(record, {
      ...desktopCodexAuthorizationSessionData(record),
      status: "activation_ack_response_received",
      lastProgressStatus: "activation_ack_response_received",
      sessionRevision: 4
    })
  );
  const current = await fixture({ reconciler, now: () => new Date(now++) });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let record = await current.store.create(initial());
  record = await progressToAckStarting(current.store, record);
  current.activationLeaseFenceReader.install(record, {
    status: "recovery_required",
    recovered: true
  });
  const freshChecksBeforeRecovery = current.activationLeaseFenceReader.requireFreshCalls.length;
  now = Date.parse("2026-07-13T10:01:00.000Z");

  const recovered = await current.store.recover(record.sessionId);
  assert.equal(recovered.status, "activation_ack_response_received");
  assert.equal(recovered.claimToken, CLAIM_TOKEN);
  assert.equal(recovered.activationToken, ACTIVATION_TOKEN);
  const acked = await advance(current.store, recovered, "activation_acked", {
    claimToken: null,
    activationToken: null
  });
  assert.equal(acked.status, "activation_acked");
  assert.equal(
    current.activationLeaseFenceReader.requireFreshCalls.length,
    freshChecksBeforeRecovery
  );
});

test("past credential promotion converges on an expired exact fence but its next effect needs renewal", async (t) => {
  let now = Date.parse("2026-07-13T10:00:00.000Z");
  const reconciler = new FakeRecoveryReconciler((record) =>
    recoveryCapability(record, {
      ...desktopCodexAuthorizationSessionData(record),
      status: "credential_durable",
      lastProgressStatus: "credential_durable",
      promotionReceipt: {
        executorId: record.executorId,
        revision: record.credentialRevision,
        operationId: record.activationOperationId,
        digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
        digest: record.bindingDigest,
        fileCount: 12,
        totalBytes: 4096
      }
    })
  );
  const leaseReader = new FakeActivationLeaseFenceReader();
  const current = await fixture({
    reconciler,
    activationLeaseFenceReader: leaseReader,
    now: () => new Date(now++)
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let record = await current.store.create(initial());
  record = await progressToActivationPending(current.store, record);
  record = await advance(current.store, record, "credential_promotion_starting");
  now = Date.parse("2026-07-13T10:01:00.000Z");

  const durable = await current.store.recover(record.sessionId);
  assert.equal(durable.status, "credential_durable");
  leaseReader.autoInstall = false;
  await assert.rejects(
    advance(current.store, durable, "activation_ack_starting", {
      ackRequestReference: ACK_REFERENCE,
      ackRequestHash: ACK_HASH
    }),
    { code: "desktop_codex_authorization_conflict" }
  );
  assert.equal((await current.store.read(record.sessionId)).status, "credential_durable");

  leaseReader.install(durable, {
    generation: 8,
    renewedAt: "2026-07-13T10:01:00Z",
    leaseExpiresAt: "2026-07-13T10:01:30Z",
    updatedAt: "2026-07-13T10:01:00.000Z"
  });
  const ackStarting = await advance(current.store, durable, "activation_ack_starting", {
    ackRequestReference: ACK_REFERENCE,
    ackRequestHash: ACK_HASH
  });
  assert.equal(ackStarting.status, "activation_ack_starting");
});

test("recoverAll reconciles every effect fence before terminalizing any session", async (t) => {
  const reconciler = new FakeRecoveryReconciler((record) => {
    if (record.sessionId === "authsession_2") throw new Error("lease fence failed");
    return recoveryCapability(record);
  });
  const current = await fixture({ reconciler });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let first = await current.store.create(initial());
  first = await advance(current.store, first, "handoff_claim_starting", {
    claimRequestReference: CLAIM_REFERENCE,
    claimRequestHash: CLAIM_HASH
  });
  let second = await current.store.create(
    initial({ sessionId: "authsession_2", handoffId: "handoff_2" })
  );
  second = await advance(current.store, second, "handoff_claim_starting", {
    claimRequestReference: "d".repeat(64),
    claimRequestHash: "e".repeat(64)
  });
  await assert.rejects(current.store.recoverAll(), {
    code: "desktop_codex_authorization_conflict"
  });
  assert.equal((await current.store.read(first.sessionId)).status, "handoff_claim_starting");
  assert.equal((await current.store.read(second.sessionId)).status, "handoff_claim_starting");
});

test("corrupt ciphertext, symlink, hardlink, loose directory mode, and plaintext safeStorage fail closed", async (t) => {
  await t.test("corrupt", async (t) => {
    const current = await fixture();
    t.after(() => rm(current.base, { recursive: true, force: true }));
    await current.store.create(initial());
    await writeFile(
      path.join(current.root, "authsession_1.sec"),
      Buffer.concat([ENVELOPE_MAGIC, Buffer.from("corrupt-secret-canary")]),
      { mode: 0o600 }
    );
    const restarted = new DesktopCodexAuthorizationSessionStore(current.options);
    await assert.rejects(restarted.read("authsession_1"), (error) => {
      assert.equal(error.code, "desktop_codex_authorization_corrupt");
      assert.equal(String(error.message).includes("corrupt-secret-canary"), false);
      return true;
    });
  });

  await t.test("hardlink", async (t) => {
    const current = await fixture();
    t.after(() => rm(current.base, { recursive: true, force: true }));
    await current.store.create(initial());
    await link(
      path.join(current.root, "authsession_1.sec"),
      path.join(current.base, "hardlink-copy.sec")
    );
    await assert.rejects(current.store.read("authsession_1"), {
      code: "desktop_codex_authorization_unsafe"
    });
  });

  await t.test("symlink", async (t) => {
    const current = await fixture();
    t.after(() => rm(current.base, { recursive: true, force: true }));
    await mkdir(current.root, { mode: 0o700 });
    const outside = path.join(current.base, "outside.sec");
    await writeFile(outside, "not-a-session", { mode: 0o600 });
    await symlink(outside, path.join(current.root, "authsession_1.sec"));
    await assert.rejects(current.store.read("authsession_1"), {
      code: "desktop_codex_authorization_unsafe"
    });
  });

  if (process.platform !== "win32") {
    await t.test("directory mode", async (t) => {
      const current = await fixture();
      t.after(() => rm(current.base, { recursive: true, force: true }));
      await current.store.create(initial());
      await chmod(current.root, 0o755);
      const restarted = new DesktopCodexAuthorizationSessionStore(current.options);
      await assert.rejects(restarted.read("authsession_1"), {
        code: "desktop_codex_authorization_unsafe"
      });
    });
  }

  for (const safeStorage of [
    new FakeSafeStorage({ available: false }),
    new FakeSafeStorage({ backend: "basic_text" })
  ]) {
    const current = await fixture({ safeStorage });
    t.after(() => rm(current.base, { recursive: true, force: true }));
    await assert.rejects(current.store.create(initial()), {
      code: "desktop_secure_storage_unavailable"
    });
  }
});
