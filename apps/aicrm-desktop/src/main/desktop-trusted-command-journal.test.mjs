import assert from "node:assert/strict";
import {
  createPrivateKey,
  createPublicKey,
  sign as signEd25519
} from "node:crypto";
import {
  chmod,
  link,
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
  DESKTOP_TRUSTED_COMMAND_TOMBSTONE_SAFETY_SECONDS,
  DesktopTrustedCommandJournalError,
  DesktopTrustedCommandJournalStore
} from "./desktop-trusted-command-journal.ts";
import { verifyDesktopTrustedToken } from "./desktop-trusted-token-verifier.ts";

const JOURNAL_MAGIC = Buffer.from("AICRM-TRUSTED-COMMAND-ENC-V1\n", "ascii");
const PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const IAT = Date.parse("2026-07-13T00:00:00Z") / 1000;
const VERIFY_NOW = new Date((IAT + 1) * 1000);
const DEVICE_ID = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const NONCE = "AAECAwQFBgcICQoLDA0ODw";
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    PKCS8_SEED_PREFIX,
    Uint8Array.from({ length: 32 }, (_, index) => index)
  ]),
  format: "der",
  type: "pkcs8"
});
const PUBLIC_KEY_X = Buffer.from(
  createPublicKey(PRIVATE_KEY).export({ format: "der", type: "spki" })
)
  .subarray(12)
  .toString("base64url");

const EFFECT_REFERENCE = "1".repeat(64);
const RECOVERY_EVIDENCE = "2".repeat(64);
const ACK_REFERENCE = "3".repeat(64);
const INDETERMINATE_REASON = "4".repeat(64);

class FakeSafeStorage {
  isEncryptionAvailable() {
    return true;
  }

  getSelectedStorageBackend() {
    return "gnome_libsecret";
  }

  encryptString(value) {
    return Buffer.concat([
      Buffer.from("TRUSTED-COMMAND-TEST\0", "ascii"),
      Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0xa7))
    ]);
  }

  decryptString(value) {
    const prefix = Buffer.from("TRUSTED-COMMAND-TEST\0", "ascii");
    if (!value.subarray(0, prefix.length).equals(prefix)) {
      throw new Error("ciphertext invalid");
    }
    return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0xa7)).toString(
      "utf8"
    );
  }
}

function keyring() {
  return {
    schemaVersion: 1,
    issuer: "aicrm-agent-executor",
    revision: 1,
    activeKid: "server_key_1",
    generatedAt: "2026-07-13T00:00:00Z",
    refreshAfterSeconds: 30,
    maxTokenLifetimeSeconds: 600,
    keyringDigest: "a".repeat(64),
    desktopAudiences: [
      "aicrm-desktop",
      "aicrm-desktop-claim",
      "aicrm-desktop-activation",
      "aicrm-desktop-command"
    ],
    keys: [
      {
        kid: "server_key_1",
        kty: "OKP",
        crv: "Ed25519",
        alg: "EdDSA",
        use: "sig",
        x: PUBLIC_KEY_X,
        signingNotBefore: "2026-07-12T23:59:00Z",
        signingNotAfter: null,
        verifyUntil: null
      }
    ]
  };
}

function command(overrides = {}) {
  const expectedExecutorRevision = overrides.expectedExecutorRevision ?? 7;
  const nonce = overrides.nonce ?? NONCE;
  const operationId = overrides.operationId ?? "operation_1";
  const claims = {
    v: 1,
    iss: "aicrm-agent-executor",
    aud: "aicrm-desktop-command",
    jti: operationId,
    purpose: "credential_verify",
    nonce,
    iat: IAT,
    exp: IAT + 120,
    actorId: "user_1",
    executorId: "executor_1",
    deviceId: DEVICE_ID,
    operationId,
    expectedExecutorRevision,
    expectedCredentialRevision: 8
  };
  const expectedTarget = {
    audience: "aicrm-desktop-command",
    purpose: "credential_verify",
    executorId: "executor_1",
    actorId: "user_1",
    operationId,
    expectedExecutorRevision,
    expectedCredentialRevision: 8
  };
  return signAndVerify(claims, expectedTarget);
}

function activation() {
  const claims = {
    v: 1,
    iss: "aicrm-agent-executor",
    aud: "aicrm-desktop-activation",
    jti: "activation_1",
    purpose: "credential_activation",
    nonce: NONCE,
    iat: IAT,
    exp: IAT + 600,
    sessionId: "session_1",
    executorId: "executor_1",
    deviceId: DEVICE_ID,
    activationId: "activation_1",
    operationId: "operation_activation_1",
    bindingDigest: "b".repeat(64),
    credentialRevision: 4,
    leaseEpoch: 5,
    sourceCredentialRevision: 3,
    revocationEpoch: 6
  };
  return signAndVerify(claims, {
    audience: "aicrm-desktop-activation",
    purpose: "credential_activation",
    executorId: "executor_1",
    sessionId: "session_1",
    operationId: "operation_activation_1",
    activationId: "activation_1",
    bindingDigest: "b".repeat(64),
    credentialRevision: 4,
    leaseEpoch: 5,
    sourceCredentialRevision: 3,
    revocationEpoch: 6
  });
}

function logoutCommand() {
  const claims = {
    v: 1,
    iss: "aicrm-agent-executor",
    aud: "aicrm-desktop-command",
    jti: "revocation_1",
    purpose: "credential_logout",
    nonce: NONCE,
    iat: IAT,
    exp: IAT + 120,
    actorId: "user_1",
    executorId: "executor_1",
    deviceId: DEVICE_ID,
    operationId: "operation_logout_1",
    revocationId: "revocation_1",
    credentialRevision: 4,
    revocationEpoch: 7
  };
  return signAndVerify(claims, {
    audience: "aicrm-desktop-command",
    purpose: "credential_logout",
    executorId: "executor_1",
    actorId: "user_1",
    operationId: "operation_logout_1",
    revocationId: "revocation_1",
    credentialRevision: 4,
    revocationEpoch: 7
  });
}

function signAndVerify(claims, expectedTarget) {
  const header = { alg: "EdDSA", kid: "server_key_1", typ: "JWT" };
  const headerPart = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const payloadPart = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = signEd25519(null, Buffer.from(signingInput, "ascii"), PRIVATE_KEY);
  const token = `${signingInput}.${signature.toString("base64url")}`;
  const verified = verifyDesktopTrustedToken({
    token,
    keyring: keyring(),
    now: VERIFY_NOW,
    registeredDeviceId: DEVICE_ID,
    expectedTarget
  });
  return { token, claims: verified };
}

async function fixture(options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-trusted-command-"));
  const root = path.join(base, "journal");
  const safeStorage = options.safeStorage ?? new FakeSafeStorage();
  let clock = Date.parse("2026-07-13T00:00:02.000Z");
  const storeOptions = {
    root,
    safeStorage,
    now: () => new Date(clock++),
    faultInjector: options.faultInjector,
    syncDirectory: options.syncDirectory
  };
  const store = new DesktopTrustedCommandJournalStore(storeOptions);
  return {
    base,
    root,
    safeStorage,
    store,
    newStore(overrides = {}) {
      return new DesktopTrustedCommandJournalStore({ ...storeOptions, ...overrides });
    }
  };
}

function reference(record) {
  return {
    semanticKey: record.semanticKey,
    tokenHash: record.tokenHash,
    payloadHash: record.payloadHash
  };
}

async function expectCode(code, operation) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof DesktopTrustedCommandJournalError);
    assert.equal(error.code, code);
    return true;
  });
}

async function reachAckPrepared(current, value = command()) {
  const accepted = await current.store.acceptOrLoad(value);
  const fence = reference(accepted);
  const begun = await current.store.beginEffect({
    ...fence,
    effectRecoveryReference: EFFECT_REFERENCE
  });
  await current.store.markEffectDurable({
    ...fence,
    effectRecoveryReference: EFFECT_REFERENCE,
    effectAttemptToken: begun.effectAttemptToken
  });
  const prepared = await current.store.prepareAcknowledgement({
    ...fence,
    outboundAckReference: ACK_REFERENCE
  });
  return { value, fence, prepared };
}

test("acceptOrLoad is encrypted, semantic-keyed and serialized across store instances", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const value = command();
  const second = current.newStore();
  const [left, right] = await Promise.all([
    current.store.acceptOrLoad(value),
    second.acceptOrLoad(value)
  ]);
  assert.equal(left.semanticKey, right.semanticKey);
  assert.equal(left.status, "accepted");
  assert.equal(left.generation, 1);
  assert.equal(left.kid, "server_key_1");
  assert.equal(left.target.expectedExecutorRevision, 7);
  assert.match(left.semanticKey, /^[0-9a-f]{64}$/);

  const names = await readdir(current.root);
  assert.deepEqual(names, [`${left.semanticKey}.sec`]);
  if (process.platform !== "win32") {
    assert.equal((await stat(current.root)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(current.root, names[0]))).mode & 0o777, 0o600);
  }
  const encrypted = await readFile(path.join(current.root, names[0]));
  assert.equal(encrypted.includes(Buffer.from(value.token, "ascii")), false);

  const changedNonce = Buffer.alloc(16, 9).toString("base64url");
  await expectCode("desktop_trusted_command_conflict", () =>
    current.store.acceptOrLoad(command({ nonce: changedNonce }))
  );
  await expectCode("desktop_trusted_command_conflict", () =>
    current.store.acceptOrLoad(command({ expectedExecutorRevision: 9 }))
  );
});

test("activation and logout preserve every credential, lease and revocation CAS field", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const activationRecord = await current.store.acceptOrLoad(activation());
  assert.deepEqual(
    {
      credentialRevision: activationRecord.target.credentialRevision,
      leaseEpoch: activationRecord.target.leaseEpoch,
      sourceCredentialRevision: activationRecord.target.sourceCredentialRevision,
      revocationEpoch: activationRecord.target.revocationEpoch
    },
    {
      credentialRevision: 4,
      leaseEpoch: 5,
      sourceCredentialRevision: 3,
      revocationEpoch: 6
    }
  );
  const logoutRecord = await current.store.acceptOrLoad(logoutCommand());
  assert.equal(logoutRecord.target.operationId, "operation_logout_1");
  assert.equal(logoutRecord.target.revocationId, "revocation_1");
  assert.equal(logoutRecord.target.credentialRevision, 4);
  assert.equal(logoutRecord.target.revocationEpoch, 7);
});

test("accepted to acknowledged is monotonic and the tombstone removes the raw token", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const value = command();
  const accepted = await current.store.acceptOrLoad(value);
  const fence = reference(accepted);
  await expectCode("desktop_trusted_command_state_invalid", () =>
    current.store.prepareAcknowledgement({
      ...fence,
      outboundAckReference: ACK_REFERENCE
    })
  );

  const begun = await current.store.beginEffect({
    ...fence,
    effectRecoveryReference: EFFECT_REFERENCE
  });
  assert.equal(begun.record.status, "effect_started");
  assert.match(begun.effectAttemptToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    (await current.store.read(fence)).effectRecoveryReference,
    EFFECT_REFERENCE
  );
  await expectCode("desktop_trusted_command_recovery_required", () =>
    current.store.beginEffect({ ...fence, effectRecoveryReference: EFFECT_REFERENCE })
  );
  await expectCode("desktop_trusted_command_recovery_required", () =>
    current.store.markEffectDurable({
      ...fence,
      effectRecoveryReference: EFFECT_REFERENCE,
      effectAttemptToken: Buffer.alloc(32, 1).toString("base64url")
    })
  );

  const durable = await current.store.markEffectDurable({
    ...fence,
    effectRecoveryReference: EFFECT_REFERENCE,
    effectAttemptToken: begun.effectAttemptToken
  });
  assert.equal(durable.status, "effect_durable");
  assert.equal(durable.effectCompletionMode, "direct");
  const durableReplay = await current.store.markEffectDurable({
    ...fence,
    effectRecoveryReference: EFFECT_REFERENCE,
    effectAttemptToken: begun.effectAttemptToken
  });
  assert.equal(durableReplay.generation, durable.generation);
  const prepared = await current.store.prepareAcknowledgement({
    ...fence,
    outboundAckReference: ACK_REFERENCE
  });
  assert.equal(prepared.status, "ack_prepared");
  const acknowledged = await current.store.markAcknowledged({
    ...fence,
    outboundAckReference: ACK_REFERENCE
  });
  assert.equal(acknowledged.status, "acknowledged");
  assert.equal(acknowledged.generation, 5);
  assert.equal(acknowledged.token, null);

  const replayed = await current.store.acceptOrLoad(value);
  assert.equal(replayed.status, "acknowledged");
  assert.equal(replayed.token, null);
  const raw = await readFile(path.join(current.root, `${fence.semanticKey}.sec`));
  const plaintext = current.safeStorage.decryptString(raw.subarray(JOURNAL_MAGIC.length));
  assert.equal(plaintext.includes(value.token), false);
  assert.equal(JSON.parse(plaintext).token, null);
});

test("a crash after durable effect_started can only use explicit recovery", async (t) => {
  let failAt = null;
  const current = await fixture({
    faultInjector(point) {
      if (point === failAt) throw new Error(`crash:${point}`);
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const value = command();
  const accepted = await current.store.acceptOrLoad(value);
  const fence = reference(accepted);
  failAt = "after_temporary_fsync";
  await assert.rejects(
    current.store.beginEffect({ ...fence, effectRecoveryReference: EFFECT_REFERENCE }),
    /crash:after_temporary_fsync/
  );
  failAt = null;

  const restarted = current.newStore({ faultInjector: undefined });
  const restored = await restarted.acceptOrLoad(value);
  assert.equal(restored.status, "effect_started");
  await expectCode("desktop_trusted_command_recovery_required", () =>
    restarted.beginEffect({ ...fence, effectRecoveryReference: EFFECT_REFERENCE })
  );
  await expectCode("desktop_trusted_command_recovery_required", () =>
    restarted.markEffectDurable({
      ...fence,
      effectRecoveryReference: EFFECT_REFERENCE,
      effectAttemptToken: Buffer.alloc(32, 5).toString("base64url")
    })
  );
  const recovered = await restarted.recoverEffectDurable({
    ...fence,
    effectRecoveryReference: EFFECT_REFERENCE,
    recoveryEvidenceHash: RECOVERY_EVIDENCE
  });
  assert.equal(recovered.status, "effect_durable");
  assert.equal(recovered.effectCompletionMode, "recovered");
  assert.equal(recovered.effectRecoveryEvidenceHash, RECOVERY_EVIDENCE);
});

test("indeterminate is terminal and removes the raw token", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const value = command();
  const accepted = await current.store.acceptOrLoad(value);
  const fence = reference(accepted);
  await current.store.beginEffect({ ...fence, effectRecoveryReference: EFFECT_REFERENCE });
  const stopped = await current.store.markIndeterminate({
    ...fence,
    effectRecoveryReference: EFFECT_REFERENCE,
    reasonHash: INDETERMINATE_REASON
  });
  assert.equal(stopped.status, "indeterminate");
  assert.equal(stopped.token, null);
  await expectCode("desktop_trusted_command_state_invalid", () =>
    current.store.recoverEffectDurable({
      ...fence,
      effectRecoveryReference: EFFECT_REFERENCE,
      recoveryEvidenceHash: RECOVERY_EVIDENCE
    })
  );
  const replayed = await current.store.acceptOrLoad(value);
  assert.equal(replayed.status, "indeterminate");
  assert.equal(replayed.token, null);
});

test("temporary states recover accepted and acknowledged crash points exactly", async (t) => {
  let failAt = "after_temporary_fsync";
  const acceptedCrash = await fixture({
    faultInjector(point) {
      if (point === failAt) throw new Error(`crash:${point}`);
    }
  });
  t.after(() => rm(acceptedCrash.base, { recursive: true, force: true }));
  const firstValue = command();
  await assert.rejects(acceptedCrash.store.acceptOrLoad(firstValue), /crash/);
  failAt = null;
  const accepted = await acceptedCrash
    .newStore({ faultInjector: undefined })
    .acceptOrLoad(firstValue);
  assert.equal(accepted.status, "accepted");

  let acknowledgeFailAt = null;
  const acknowledgementCrash = await fixture({
    faultInjector(point) {
      if (point === acknowledgeFailAt) throw new Error(`crash:${point}`);
    }
  });
  t.after(() => rm(acknowledgementCrash.base, { recursive: true, force: true }));
  const reached = await reachAckPrepared(acknowledgementCrash);
  acknowledgeFailAt = "after_temporary_fsync";
  await assert.rejects(
    acknowledgementCrash.store.markAcknowledged({
      ...reached.fence,
      outboundAckReference: ACK_REFERENCE
    }),
    /crash/
  );
  acknowledgeFailAt = null;
  const restored = await acknowledgementCrash
    .newStore({ faultInjector: undefined })
    .acceptOrLoad(reached.value);
  assert.equal(restored.status, "acknowledged");
  assert.equal(restored.token, null);
});

for (const faultPoint of ["after_rename", "before_directory_fsync"]) {
  test(`${faultPoint} retains a generation shadow and restores effect_started`, async (t) => {
    let failAt = null;
    const current = await fixture({
      faultInjector(point) {
        if (point === failAt) throw new Error(`crash:${point}`);
      }
    });
    t.after(() => rm(current.base, { recursive: true, force: true }));
    const value = command();
    const accepted = await current.store.acceptOrLoad(value);
    const fence = reference(accepted);
    failAt = faultPoint;
    await assert.rejects(
      current.store.beginEffect({
        ...fence,
        effectRecoveryReference: EFFECT_REFERENCE
      }),
      new RegExp(`crash:${faultPoint}`)
    );
    assert.equal(
      (await readdir(current.root)).some((name) => name.endsWith(".commit-2")),
      true
    );
    failAt = null;
    const restarted = current.newStore({ faultInjector: undefined });
    const restored = await restarted.acceptOrLoad(value);
    assert.equal(restored.status, "effect_started");
    assert.equal(
      (await readdir(current.root)).some((name) => name.includes(".commit-")),
      false
    );
  });
}

test("unsupported directory fsync keeps only the latest flushed tombstone shadow", async (t) => {
  const current = await fixture({ syncDirectory: async () => false });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const reached = await reachAckPrepared(current);
  const acknowledged = await current.store.markAcknowledged({
    ...reached.fence,
    outboundAckReference: ACK_REFERENCE
  });
  assert.equal(acknowledged.token, null);
  const names = (await readdir(current.root)).sort();
  assert.deepEqual(names, [
    `${reached.fence.semanticKey}.sec`,
    `${reached.fence.semanticKey}.sec.commit-5`
  ]);
  for (const name of names) {
    const raw = await readFile(path.join(current.root, name));
    const plaintext = current.safeStorage.decryptString(raw.subarray(JOURNAL_MAGIC.length));
    assert.equal(plaintext.includes(reached.value.token), false);
    assert.equal(JSON.parse(plaintext).token, null);
  }
});

test("explicit prune keeps tombstones through expiry margin and never removes indeterminate", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const reached = await reachAckPrepared(current);
  await current.store.markAcknowledged({
    ...reached.fence,
    outboundAckReference: ACK_REFERENCE
  });

  const uncertainValue = command({ operationId: "operation_2" });
  const uncertainAccepted = await current.store.acceptOrLoad(uncertainValue);
  const uncertainFence = reference(uncertainAccepted);
  await current.store.beginEffect({
    ...uncertainFence,
    effectRecoveryReference: "5".repeat(64)
  });
  await current.store.markIndeterminate({
    ...uncertainFence,
    effectRecoveryReference: "5".repeat(64),
    reasonHash: INDETERMINATE_REASON
  });

  const pruneAt = IAT + 120 + DESKTOP_TRUSTED_COMMAND_TOMBSTONE_SAFETY_SECONDS;
  const beforeBoundary = current.newStore({
    now: () => new Date((pruneAt - 1) * 1000)
  });
  assert.deepEqual(await beforeBoundary.pruneAcknowledged(), { removed: 0, retained: 2 });
  const atBoundary = current.newStore({ now: () => new Date(pruneAt * 1000) });
  assert.deepEqual(await atBoundary.pruneAcknowledged(), { removed: 1, retained: 1 });
  assert.equal(await atBoundary.read(reached.fence), null);
  const retained = await atBoundary.read(uncertainFence);
  assert.equal(retained?.status, "indeterminate");
  assert.equal(retained?.token, null);
});

test("symlinks, hardlinks, unsafe modes and ciphertext tampering fail closed", async (t) => {
  await t.test("symlink", async () => {
    const current = await fixture();
    t.after(() => rm(current.base, { recursive: true, force: true }));
    const record = await current.store.acceptOrLoad(command());
    await symlink(
      path.join(current.root, `${record.semanticKey}.sec`),
      path.join(current.root, `${"e".repeat(64)}.sec`)
    );
    await expectCode("desktop_trusted_command_unsafe", () =>
      current.store.read(reference(record))
    );
  });

  await t.test("hardlink", async () => {
    const current = await fixture();
    t.after(() => rm(current.base, { recursive: true, force: true }));
    const record = await current.store.acceptOrLoad(command());
    await link(
      path.join(current.root, `${record.semanticKey}.sec`),
      path.join(current.root, `${"d".repeat(64)}.sec`)
    );
    await expectCode("desktop_trusted_command_unsafe", () =>
      current.store.read(reference(record))
    );
  });

  await t.test("unsafe mode", async () => {
    const current = await fixture();
    t.after(() => rm(current.base, { recursive: true, force: true }));
    const record = await current.store.acceptOrLoad(command());
    if (process.platform === "win32") return;
    await chmod(path.join(current.root, `${record.semanticKey}.sec`), 0o644);
    await expectCode("desktop_trusted_command_unsafe", () =>
      current.store.read(reference(record))
    );
  });

  await t.test("tamper", async () => {
    const current = await fixture();
    t.after(() => rm(current.base, { recursive: true, force: true }));
    const record = await current.store.acceptOrLoad(command());
    const file = path.join(current.root, `${record.semanticKey}.sec`);
    const raw = await readFile(file);
    raw[raw.length - 1] ^= 1;
    await writeFile(file, raw, { mode: 0o600 });
    await expectCode("desktop_trusted_command_corrupt", () =>
      current.store.read(reference(record))
    );
  });
});
