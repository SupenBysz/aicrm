import assert from "node:assert/strict";
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
const CLAIM_EXPIRES_AT = "2026-07-13T10:05:00.000Z";
const ACTIVATION_EXPIRES_AT = "2026-07-13T10:10:00.000Z";
const OUTBOUND_RECOVERY_ATTEMPT = {
  exactOutboundJournalRecoveryAttempted: true,
  activationLeaseFenceRecoveryAttempted: true
};
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

async function fixture(overrides = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-codex-auth-session-"));
  const root = path.join(base, "sessions");
  const safeStorage = overrides.safeStorage ?? new FakeSafeStorage();
  let time = Date.parse("2026-07-13T10:00:00.000Z");
  const options = {
    root,
    safeStorage,
    now: () => new Date(time++),
    faultInjector: overrides.faultInjector,
    renameFile: overrides.renameFile,
    syncDirectory: overrides.syncDirectory
  };
  return {
    base,
    root,
    safeStorage,
    options,
    store: new DesktopCodexAuthorizationSessionStore(options)
  };
}

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
  return advance(store, current, "activation_ack_starting");
}

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
  record = await advance(current.store, record, "activation_ack_starting");
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
      now: current.options.now
    });
    const recovered = await restarted.read(accepted.sessionId);
    assert.equal(recovered.status, "handoff_claim_starting");
    assert.equal(recovered.generation, 2);
    assert.equal(recovered.claimRequestHash, CLAIM_HASH);
    assert.deepEqual(await readdir(current.root), ["authsession_1.sec"]);
  });
}

test("restart never re-enters an effect fence without a durable successor", async (t) => {
  const early = await fixture();
  t.after(() => rm(early.base, { recursive: true, force: true }));
  let record = await early.store.create(initial());
  record = await advance(early.store, record, "handoff_claim_starting", {
    claimRequestReference: CLAIM_REFERENCE,
    claimRequestHash: CLAIM_HASH
  });
  const earlyRestart = new DesktopCodexAuthorizationSessionStore(early.options);
  const indeterminate = await earlyRestart.recover(record.sessionId, OUTBOUND_RECOVERY_ATTEMPT);
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
  const lateIndeterminate = await lateRestart.recover(record.sessionId, OUTBOUND_RECOVERY_ATTEMPT);
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
    now: current.options.now
  });
  const recovered = await restarted.recover(record.sessionId, OUTBOUND_RECOVERY_ATTEMPT);
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
  await assert.rejects(
    async () =>
      current.store.transition(record, {
        ...claimedWithoutExpiry,
        claimExpiresAt: "2026-07-13T10:05:00Z"
      }),
    { code: "desktop_codex_authorization_unsafe" }
  );
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

test("recovery finalization is forbidden until outbound journal and lease fence attempts complete", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  let record = await current.store.create(initial());
  record = await advance(current.store, record, "handoff_claim_starting", {
    claimRequestReference: CLAIM_REFERENCE,
    claimRequestHash: CLAIM_HASH
  });
  assert.throws(() => current.store.recover(record.sessionId), {
    code: "desktop_codex_authorization_unsafe"
  });
  assert.throws(
    () =>
      current.store.recover(record.sessionId, {
        exactOutboundJournalRecoveryAttempted: true,
        activationLeaseFenceRecoveryAttempted: false
      }),
    { code: "desktop_codex_authorization_unsafe" }
  );
  assert.throws(
    () => current.store.recoverAll({ exactOutboundJournalRecoveryAttempted: true }),
    { code: "desktop_codex_authorization_unsafe" }
  );
  assert.equal((await current.store.read(record.sessionId)).status, "handoff_claim_starting");
  const finalized = await current.store.recover(record.sessionId, OUTBOUND_RECOVERY_ATTEMPT);
  assert.equal(finalized.status, "indeterminate");
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
