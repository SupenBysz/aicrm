import assert from "node:assert/strict";
import { link, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopExecutorBindingStateStore } from "./desktop-executor-binding-state.ts";

const DEVICE_1 = "1".repeat(64);
const DEVICE_2 = "2".repeat(64);
const BINDING_1 = "3".repeat(64);
const BINDING_2 = "4".repeat(64);
const ACCOUNT_1 = "5".repeat(64);
const ACCOUNT_2 = "6".repeat(64);
const QUARANTINE = "7".repeat(64);

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
      Buffer.from("BINDING-STATE-TEST\0"),
      Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0x37))
    ]);
  }

  decryptString(value) {
    const prefix = Buffer.from("BINDING-STATE-TEST\0");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("ciphertext invalid");
    return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0x37)).toString("utf8");
  }
}

async function fixture(overrides = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-executor-binding-"));
  const root = path.join(base, "bindings");
  const safeStorage = overrides.safeStorage ?? new FakeSafeStorage();
  let now = "2026-07-13T09:00:00.000Z";
  const options = {
    root,
    safeStorage,
    now: () => new Date(now),
    faultInjector: overrides.faultInjector,
    renameFile: overrides.renameFile,
    syncDirectory: overrides.syncDirectory
  };
  return {
    base,
    root,
    safeStorage,
    options,
    store: new DesktopExecutorBindingStateStore(options),
    setNow: (value) => {
      now = value;
    }
  };
}

function activation(overrides = {}) {
  return {
    executorId: "executor_1",
    deviceId: DEVICE_1,
    operationId: "operation_1",
    activationId: "activation_1",
    credentialRevision: 1,
    sourceCredentialRevision: 0,
    revocationEpoch: 0,
    bindingDigest: BINDING_1,
    accountFingerprint: ACCOUNT_1,
    ...overrides
  };
}

function revocationIntent(overrides = {}) {
  return {
    executorId: "executor_1",
    deviceId: DEVICE_1,
    operationId: "revoke_operation_1",
    revocationId: "revocation_1",
    credentialRevision: 1,
    revocationEpoch: 1,
    ...overrides
  };
}

function revocation(overrides = {}) {
  return {
    ...revocationIntent(),
    result: "succeeded",
    quarantineDigest: QUARANTINE,
    ...overrides
  };
}

test("active binding is encrypted, mode 0600, restart-readable and exact-replay safe", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const active = await current.store.activate(activation());
  assert.equal(active.generation, 1);
  assert.equal(active.status, "active");
  assert.equal(active.sourceCredentialRevision, 0);
  assert.deepEqual(await current.store.activate(activation()), active);
  const target = path.join(current.root, "executor_1.sec");
  const raw = await readFile(target);
  for (const canary of ["executor_1", DEVICE_1, BINDING_1, ACCOUNT_1]) {
    assert.equal(raw.includes(Buffer.from(canary)), false);
  }
  if (process.platform !== "win32") assert.equal((await stat(target)).mode & 0o777, 0o600);

  const restarted = new DesktopExecutorBindingStateStore(current.options);
  assert.deepEqual(await restarted.read("executor_1"), active);
  assert.deepEqual(await restarted.list(), [active]);
});

test("activation CAS serializes reauthorization and rejects stale competing sources", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.activate(activation());
  current.setNow("2026-07-13T09:00:01.000Z");
  const replacement = activation({
    operationId: "operation_2",
    activationId: "activation_2",
    credentialRevision: 2,
    sourceCredentialRevision: 1,
    bindingDigest: BINDING_2,
    accountFingerprint: ACCOUNT_2
  });
  const active = await current.store.activate(replacement);
  assert.equal(active.generation, 2);
  assert.equal(active.credentialRevision, 2);
  assert.equal(active.sourceCredentialRevision, 1);
  await assert.rejects(
    current.store.activate({
      ...replacement,
      operationId: "operation_stale",
      activationId: "activation_stale",
      credentialRevision: 3
    }),
    { code: "desktop_executor_binding_conflict" }
  );

  const concurrent = await fixture();
  t.after(() => rm(concurrent.base, { recursive: true, force: true }));
  const secondStore = new DesktopExecutorBindingStateStore(concurrent.options);
  const results = await Promise.allSettled([
    concurrent.store.activate(activation()),
    secondStore.activate(
      activation({
        operationId: "operation_competing",
        activationId: "activation_competing",
        credentialRevision: 2,
        bindingDigest: BINDING_2
      })
    )
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("revocation is a durable epoch tombstone and only source zero may authorize again", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.activate(activation());
  current.setNow("2026-07-13T09:00:01.000Z");
  const revoking = await current.store.beginRevocation(revocationIntent());
  assert.equal(revoking.status, "revoking");
  assert.equal(revoking.generation, 2);
  assert.deepEqual(await current.store.beginRevocation(revocationIntent()), revoking);
  current.setNow("2026-07-13T09:00:02.000Z");
  const revoked = await current.store.markRevoked(revocation());
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.generation, 3);
  assert.equal(revoked.revocationEpoch, 1);
  assert.equal(revoked.revocationResult, "succeeded");
  assert.deepEqual(await current.store.markRevoked(revocation()), revoked);
  await assert.rejects(
    current.store.activate(
      activation({
        operationId: "operation_bad_source",
        activationId: "activation_bad_source",
        credentialRevision: 2,
        sourceCredentialRevision: 1,
        revocationEpoch: 1,
        bindingDigest: BINDING_2
      })
    ),
    { code: "desktop_executor_binding_conflict" }
  );
  current.setNow("2026-07-13T09:00:03.000Z");
  const reauthorized = await current.store.activate(
    activation({
      deviceId: DEVICE_2,
      operationId: "operation_2",
      activationId: "activation_2",
      credentialRevision: 2,
      sourceCredentialRevision: 0,
      revocationEpoch: 1,
      bindingDigest: BINDING_2,
      accountFingerprint: ACCOUNT_2
    })
  );
  assert.equal(reauthorized.status, "active");
  assert.equal(reauthorized.generation, 4);
  assert.equal(reauthorized.deviceId, DEVICE_2);
});

test("revoking is durable before cleanup and failed or stale logout can never revive active state", async (t) => {
  for (const result of ["failed", "stale_target"]) {
    const current = await fixture();
    t.after(() => rm(current.base, { recursive: true, force: true }));
    await current.store.activate(activation());
    current.setNow("2026-07-13T09:00:01.000Z");
    const revoking = await current.store.beginRevocation(revocationIntent());
    assert.equal(revoking.status, "revoking");
    current.setNow("2026-07-13T09:00:02.000Z");
    const revoked = await current.store.markRevoked(
      revocation({ result, quarantineDigest: null })
    );
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revocationResult, result);
    assert.equal(revoked.quarantineDigest, null);
    await assert.rejects(
      current.store.activate(
        activation({
          operationId: `operation_after_${result}`,
          activationId: `activation_after_${result}`,
          credentialRevision: 2,
          sourceCredentialRevision: 1,
          revocationEpoch: 1,
          bindingDigest: BINDING_2
        })
      ),
      { code: "desktop_executor_binding_conflict" }
    );
  }

  const invalid = await fixture();
  t.after(() => rm(invalid.base, { recursive: true, force: true }));
  await invalid.store.activate(activation());
  await invalid.store.beginRevocation(revocationIntent());
  assert.throws(
    () => invalid.store.markRevoked(revocation({ result: "succeeded", quarantineDigest: null })),
    { code: "desktop_executor_binding_unsafe" }
  );
  assert.throws(
    () => invalid.store.markRevoked(revocation({ result: "stale_target" })),
    { code: "desktop_executor_binding_unsafe" }
  );
});

test("a crash after the pre-cleanup fence recovers revoking instead of active", async (t) => {
  let failFence = false;
  const current = await fixture({
    faultInjector: (point) => {
      if (failFence && point === "after_temporary_fsync") {
        failFence = false;
        throw new Error("simulated crash after revoking fence fsync");
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.activate(activation());
  failFence = true;
  await assert.rejects(current.store.beginRevocation(revocationIntent()));
  const restarted = new DesktopExecutorBindingStateStore({
    root: current.root,
    safeStorage: current.safeStorage,
    now: current.options.now
  });
  const recovered = await restarted.read("executor_1");
  assert.equal(recovered?.status, "revoking");
  assert.equal(recovered?.generation, 2);
});

test("CAS rejects epoch gaps and identifier reuse with a different payload", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.activate(activation());
  await assert.rejects(
    current.store.activate(
      activation({
        operationId: "operation_1",
        activationId: "activation_new",
        credentialRevision: 2,
        sourceCredentialRevision: 1,
        bindingDigest: BINDING_2
      })
    ),
    { code: "desktop_executor_binding_conflict" }
  );
  await assert.rejects(
    current.store.activate(
      activation({
        operationId: "operation_new",
        activationId: "activation_1",
        credentialRevision: 2,
        sourceCredentialRevision: 1,
        bindingDigest: BINDING_2
      })
    ),
    { code: "desktop_executor_binding_conflict" }
  );
  await assert.rejects(
    current.store.beginRevocation(revocationIntent({ revocationEpoch: 2 })),
    { code: "desktop_executor_binding_conflict" }
  );
  await current.store.beginRevocation(revocationIntent());
  await assert.rejects(
    current.store.beginRevocation(
      revocationIntent({ operationId: "revoke_operation_changed" })
    ),
    { code: "desktop_executor_binding_conflict" }
  );
});

test("a fsynced newer temporary generation is promoted after crash", async (t) => {
  let failOnce = false;
  const current = await fixture({
    faultInjector: () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated crash after temporary fsync");
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.activate(activation());
  current.setNow("2026-07-13T09:00:01.000Z");
  failOnce = true;
  await assert.rejects(
    current.store.activate(
      activation({
        operationId: "operation_2",
        activationId: "activation_2",
        credentialRevision: 2,
        sourceCredentialRevision: 1,
        bindingDigest: BINDING_2,
        accountFingerprint: ACCOUNT_2
      })
    )
  );
  const restarted = new DesktopExecutorBindingStateStore({
    root: current.root,
    safeStorage: current.safeStorage,
    now: current.options.now
  });
  const recovered = await restarted.read("executor_1");
  assert.equal(recovered?.generation, 2);
  assert.equal(recovered?.credentialRevision, 2);
  await assert.rejects(stat(path.join(current.root, "executor_1.sec.tmp")), { code: "ENOENT" });
});

test("an orphan generation above one is rejected when its predecessor target disappeared", async (t) => {
  let failOnce = false;
  const current = await fixture({
    faultInjector: (point) => {
      if (failOnce && point === "after_temporary_fsync") {
        failOnce = false;
        throw new Error("simulated crash before replacement");
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.activate(activation());
  failOnce = true;
  await assert.rejects(
    current.store.activate(
      activation({
        operationId: "operation_2",
        activationId: "activation_2",
        credentialRevision: 2,
        sourceCredentialRevision: 1,
        bindingDigest: BINDING_2,
        accountFingerprint: ACCOUNT_2
      })
    )
  );
  await rm(path.join(current.root, "executor_1.sec"));
  const restarted = new DesktopExecutorBindingStateStore({
    root: current.root,
    safeStorage: current.safeStorage
  });
  await assert.rejects(restarted.read("executor_1"), {
    code: "desktop_executor_binding_corrupt"
  });
});

for (const faultPoint of ["after_rename", "before_directory_fsync"]) {
  test(`${faultPoint} keeps a durable recovery marker until replacement is verified`, async (t) => {
    let failOnce = false;
    const current = await fixture({
      faultInjector: (point) => {
        if (failOnce && point === faultPoint) {
          failOnce = false;
          throw new Error(`simulated crash at ${faultPoint}`);
        }
      }
    });
    t.after(() => rm(current.base, { recursive: true, force: true }));
    await current.store.activate(activation());
    failOnce = true;
    await assert.rejects(
      current.store.activate(
        activation({
          operationId: "operation_2",
          activationId: "activation_2",
          credentialRevision: 2,
          sourceCredentialRevision: 1,
          bindingDigest: BINDING_2,
          accountFingerprint: ACCOUNT_2
        })
      )
    );
    assert.equal(
      (await readdir(current.root)).some((name) => name.includes(".commit-2")),
      true
    );
    const restarted = new DesktopExecutorBindingStateStore({
      root: current.root,
      safeStorage: current.safeStorage
    });
    const recovered = await restarted.read("executor_1");
    assert.equal(recovered?.generation, 2);
    assert.equal(recovered?.credentialRevision, 2);
    assert.equal(
      (await readdir(current.root)).some((name) => name.includes(".commit-")),
      false
    );
  });
}

test("a directory-sync failure is recovered without accepting an unbarriered exact replay", async (t) => {
  let failDirectorySync = false;
  const current = await fixture({
    syncDirectory: async () => {
      if (failDirectorySync) {
        failDirectorySync = false;
        throw new Error("simulated directory fsync failure");
      }
      return true;
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.activate(activation());
  failDirectorySync = true;
  const replacement = activation({
    operationId: "operation_2",
    activationId: "activation_2",
    credentialRevision: 2,
    sourceCredentialRevision: 1,
    bindingDigest: BINDING_2,
    accountFingerprint: ACCOUNT_2
  });
  await assert.rejects(current.store.activate(replacement));
  assert.equal(
    (await readdir(current.root)).some((name) => name.includes(".commit-2")),
    true
  );
  const restarted = new DesktopExecutorBindingStateStore({
    root: current.root,
    safeStorage: current.safeStorage
  });
  const recovered = await restarted.activate(replacement);
  assert.equal(recovered.generation, 2);
  assert.equal(recovered.credentialRevision, 2);
});

test("unsupported directory fsync retains one flushed generation shadow and allows later CAS", async (t) => {
  const current = await fixture({ syncDirectory: async () => false });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const first = await current.store.activate(activation());
  assert.equal(first.generation, 1);
  assert.deepEqual(await current.store.activate(activation()), first);
  assert.deepEqual(await current.store.list(), [first]);
  assert.deepEqual(
    (await readdir(current.root)).filter((name) => name.includes(".commit-")),
    ["executor_1.sec.commit-1"]
  );
  const replacement = await current.store.activate(
    activation({
      operationId: "operation_2",
      activationId: "activation_2",
      credentialRevision: 2,
      sourceCredentialRevision: 1,
      bindingDigest: BINDING_2,
      accountFingerprint: ACCOUNT_2
    })
  );
  assert.equal(replacement.generation, 2);
  assert.deepEqual(
    (await readdir(current.root)).filter((name) => name.includes(".commit-")),
    ["executor_1.sec.commit-2"]
  );
  const restarted = new DesktopExecutorBindingStateStore({
    root: current.root,
    safeStorage: current.safeStorage,
    syncDirectory: async () => false
  });
  assert.deepEqual(await restarted.read("executor_1"), replacement);
});

test("transient Windows-style rename sharing violations are retried without removing target", async (t) => {
  let attempts = 0;
  const current = await fixture({
    renameFile: async (source, target) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("simulated sharing violation");
        error.code = "EBUSY";
        throw error;
      }
      await rename(source, target);
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const active = await current.store.activate(activation());
  assert.equal(active.status, "active");
  assert.equal(attempts, 3);
});

test("unsafe storage, ciphertext tampering and hardlinks fail closed", async (t) => {
  for (const safeStorage of [
    new FakeSafeStorage({ available: false }),
    new FakeSafeStorage({ backend: "basic_text" })
  ]) {
    const current = await fixture({ safeStorage });
    t.after(() => rm(current.base, { recursive: true, force: true }));
    await assert.rejects(current.store.activate(activation()), {
      code: "desktop_secure_storage_unavailable"
    });
  }

  const corrupt = await fixture();
  t.after(() => rm(corrupt.base, { recursive: true, force: true }));
  await corrupt.store.activate(activation());
  const target = path.join(corrupt.root, "executor_1.sec");
  await writeFile(target, "not-ciphertext", { mode: 0o600 });
  await assert.rejects(corrupt.store.read("executor_1"));

  if (process.platform !== "win32") {
    const linked = await fixture();
    t.after(() => rm(linked.base, { recursive: true, force: true }));
    await linked.store.activate(activation());
    const linkedTarget = path.join(linked.root, "executor_1.sec");
    await link(linkedTarget, path.join(linked.base, "binding-copy.sec"));
    await assert.rejects(linked.store.read("executor_1"), {
      code: "desktop_executor_binding_unsafe"
    });
  }
});
