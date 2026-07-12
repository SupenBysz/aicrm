import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DesktopActivationLeaseFenceStore,
  DesktopActivationLeaseFenceStoreError
} from "./desktop-activation-lease-fence-store.ts";

const TOKEN = `eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhY3RpdmF0aW9uIn0.${"A".repeat(86)}`;
const TOKEN_HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const BINDING_DIGEST = "d".repeat(64);

class FakeSafeStorage {
  constructor({ available = true, backend = "keychain" } = {}) {
    this.available = available;
    this.backend = backend;
    this.plaintexts = [];
  }

  isEncryptionAvailable() {
    return this.available;
  }

  getSelectedStorageBackend() {
    return this.backend;
  }

  encryptString(value) {
    this.plaintexts.push(value);
    return Buffer.concat([
      Buffer.from("LEASE-FENCE-TEST\0", "ascii"),
      Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0x5a))
    ]);
  }

  decryptString(value) {
    const prefix = Buffer.from("LEASE-FENCE-TEST\0", "ascii");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("ciphertext invalid");
    return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0x5a)).toString("utf8");
  }
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestReference(sessionId = "session_1", activationId = "activation_1") {
  const requestPath =
    `/api/v1/ai-executor-authorization-sessions/${sessionId}` +
    `/desktop-activations/${activationId}/lease-renewals`;
  return sha256Text(
    `AICRM-TRUSTED-REQUEST-V1\ncredential_activation_lease_renewal\n${requestPath}`
  );
}

function target(overrides = {}) {
  return {
    sessionId: "session_1",
    activationToken: TOKEN,
    operationId: "operation_1",
    activationId: "activation_1",
    credentialRevision: 2,
    leaseEpoch: 3,
    sourceCredentialRevision: 1,
    revocationEpoch: 0,
    bindingDigest: BINDING_DIGEST,
    ...overrides
  };
}

function renewal(overrides = {}) {
  const { data: dataOverrides = {}, sessionId = "session_1", ...top } = overrides;
  const activationId = dataOverrides.activationId ?? "activation_1";
  return {
    requestReference: requestReference(sessionId, activationId),
    requestHash: "a".repeat(64),
    recovered: false,
    data: {
      activationId,
      executorId: "executor_1",
      operationId: "operation_1",
      credentialRevision: 2,
      leaseEpoch: 3,
      sourceCredentialRevision: 1,
      revocationEpoch: 0,
      renewedAt: "2026-07-13T09:00:00Z",
      leaseExpiresAt: "2026-07-13T09:00:30Z",
      replayed: false,
      ...dataOverrides
    },
    ...top
  };
}

async function fixture(overrides = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-activation-lease-fence-"));
  const root = path.join(base, "fences");
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
    store: new DesktopActivationLeaseFenceStore(options),
    setNow(value) {
      now = value;
    }
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error instanceof DesktopActivationLeaseFenceStoreError, true);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

test("fresh renewal is encrypted, token-hashed, exact-replay idempotent, and restart-readable", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.persistRenewal(target(), renewal());
  const record = await current.store.read("activation_1");
  assert.equal(record.generation, 1);
  assert.equal(record.status, "fresh");
  assert.equal(record.tokenHash, TOKEN_HASH);
  assert.equal("activationToken" in record, false);
  assert.equal(record.requestReference, requestReference());
  assert.deepEqual(await current.store.list(), [record]);

  await current.store.persistRenewal(target(), renewal());
  assert.equal((await current.store.read("activation_1")).generation, 1);

  const file = path.join(current.root, "activation_1.sec");
  const ciphertext = await readFile(file);
  for (const canary of [TOKEN, "session_1", "executor_1", BINDING_DIGEST]) {
    assert.equal(ciphertext.includes(Buffer.from(canary)), false);
  }
  assert.equal(current.safeStorage.plaintexts.every((value) => !value.includes(TOKEN)), true);
  if (process.platform !== "win32") {
    assert.equal((await lstat(current.root)).mode & 0o777, 0o700);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  }

  const restarted = new DesktopActivationLeaseFenceStore(current.options);
  assert.deepEqual(await restarted.read("activation_1"), record);
});

test("same request only degrades fresh to recovery_required, and only a new fresh hash restores freshness", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.persistRenewal(target(), renewal());
  const initial = await current.store.read("activation_1");
  assert.deepEqual(await current.store.requireFresh(initial), initial);
  current.setNow("2026-07-13T09:00:01.000Z");
  await current.store.persistRenewal(target(), renewal({ recovered: true }));
  const degraded = await current.store.read("activation_1");
  assert.equal(degraded.generation, 2);
  assert.equal(degraded.status, "recovery_required");
  assert.equal(degraded.recovered, true);
  await assert.rejects(
    current.store.requireFresh(degraded),
    expectCode("desktop_activation_lease_fence_conflict")
  );

  await current.store.persistRenewal(target(), renewal({ recovered: true }));
  assert.equal((await current.store.read("activation_1")).generation, 2);
  await assert.rejects(
    current.store.persistRenewal(target(), renewal()),
    expectCode("desktop_activation_lease_fence_conflict")
  );

  current.setNow("2026-07-13T09:00:02.000Z");
  await current.store.persistRenewal(
    target(),
    renewal({
      requestHash: "b".repeat(64),
      data: {
        renewedAt: "2026-07-13T09:00:01Z",
        leaseExpiresAt: "2026-07-13T09:00:31Z"
      }
    })
  );
  const fresh = await current.store.read("activation_1");
  assert.equal(fresh.generation, 3);
  assert.equal(fresh.status, "fresh");
  assert.equal(fresh.recovered, false);

  current.setNow("2026-07-13T09:00:31.000Z");
  await assert.rejects(
    current.store.requireFresh(fresh),
    expectCode("desktop_activation_lease_fence_conflict")
  );

  current.setNow("2026-07-13T09:00:03.000Z");
  await current.store.persistRenewal(
    target(),
    renewal({
      requestHash: "c".repeat(64),
      data: {
        renewedAt: "2026-07-13T09:00:02Z",
        leaseExpiresAt: "2026-07-13T09:00:32Z",
        replayed: true
      }
    })
  );
  assert.equal((await current.store.read("activation_1")).status, "recovery_required");
});

test("exact target, result, semantic reference, and frozen tuple reject forged values", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await assert.rejects(
    current.store.persistRenewal({ ...target(), rendererOverride: true }, renewal()),
    expectCode("desktop_activation_lease_fence_unsafe")
  );
  await assert.rejects(
    current.store.persistRenewal(target({ activationToken: "bad.token.shape=" }), renewal()),
    expectCode("desktop_activation_lease_fence_unsafe")
  );
  await assert.rejects(
    current.store.persistRenewal(target(), { ...renewal(), unexpected: true }),
    expectCode("desktop_activation_lease_fence_unsafe")
  );
  await assert.rejects(
    current.store.persistRenewal(target(), renewal({ requestReference: "f".repeat(64) })),
    expectCode("desktop_activation_lease_fence_unsafe")
  );
  await assert.rejects(
    current.store.persistRenewal(
      target(),
      renewal({ data: { credentialRevision: 3 } })
    ),
    expectCode("desktop_activation_lease_fence_unsafe")
  );

  await current.store.persistRenewal(target(), renewal());
  current.setNow("2026-07-13T09:00:01.000Z");
  const next = renewal({
    requestHash: "b".repeat(64),
    data: {
      renewedAt: "2026-07-13T09:00:01Z",
      leaseExpiresAt: "2026-07-13T09:00:31Z"
    }
  });
  await assert.rejects(
    current.store.persistRenewal(target({ activationToken: `${TOKEN.slice(0, -1)}Q` }), next),
    expectCode("desktop_activation_lease_fence_conflict")
  );
  await assert.rejects(
    current.store.persistRenewal(target(), renewal({ ...next, data: { ...next.data, executorId: "executor_2" } })),
    expectCode("desktop_activation_lease_fence_conflict")
  );
});

test("canonical lease time and strict monotonicity reject rollback while allowing a capped equal expiry", async (t) => {
  const invalidFixture = await fixture();
  t.after(() => rm(invalidFixture.base, { recursive: true, force: true }));
  for (const data of [
    { renewedAt: "2026-07-13T09:00:00.000Z" },
    { renewedAt: "2026-02-31T09:00:00Z" },
    { leaseExpiresAt: "2026-07-13T09:00:00Z" },
    { leaseExpiresAt: "2026-07-13T09:00:31Z" }
  ]) {
    await assert.rejects(
      invalidFixture.store.persistRenewal(target(), renewal({ data })),
      expectCode("desktop_activation_lease_fence_unsafe")
    );
  }

  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.persistRenewal(target(), renewal());
  current.setNow("2026-07-13T09:00:01.000Z");
  await assert.rejects(
    current.store.persistRenewal(
      target(),
      renewal({ requestHash: "b".repeat(64), data: { replayed: true } })
    ),
    expectCode("desktop_activation_lease_fence_conflict")
  );
  await assert.rejects(
    current.store.persistRenewal(
      target(),
      renewal({
        requestHash: "c".repeat(64),
        data: {
          renewedAt: "2026-07-13T09:00:01Z",
          leaseExpiresAt: "2026-07-13T09:00:29Z"
        }
      })
    ),
    expectCode("desktop_activation_lease_fence_conflict")
  );
  await current.store.persistRenewal(
    target(),
    renewal({
      requestHash: "d".repeat(64),
      data: {
        renewedAt: "2026-07-13T09:00:01Z",
        leaseExpiresAt: "2026-07-13T09:00:30Z"
      }
    })
  );
  assert.equal((await current.store.read("activation_1")).generation, 2);
});

test("root-wide CAS converges identical renewals and rejects competing heads", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const second = new DesktopActivationLeaseFenceStore(current.options);
  const identical = await Promise.allSettled([
    current.store.persistRenewal(target(), renewal()),
    second.persistRenewal(target(), renewal())
  ]);
  assert.equal(identical.every((item) => item.status === "fulfilled"), true);
  assert.equal((await current.store.read("activation_1")).generation, 1);

  current.setNow("2026-07-13T09:00:01.000Z");
  const competing = await Promise.allSettled([
    current.store.persistRenewal(
      target(),
      renewal({
        requestHash: "b".repeat(64),
        data: {
          renewedAt: "2026-07-13T09:00:01Z",
          leaseExpiresAt: "2026-07-13T09:00:31Z"
        }
      })
    ),
    second.persistRenewal(
      target(),
      renewal({
        requestHash: "c".repeat(64),
        data: {
          renewedAt: "2026-07-13T09:00:01Z",
          leaseExpiresAt: "2026-07-13T09:00:31Z"
        }
      })
    )
  ]);
  assert.equal(competing.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(competing.filter((item) => item.status === "rejected").length, 1);
  assert.equal((await current.store.read("activation_1")).generation, 2);

  const split = await fixture();
  t.after(() => rm(split.base, { recursive: true, force: true }));
  const splitSecond = new DesktopActivationLeaseFenceStore(split.options);
  const otherTarget = target({
    sessionId: "session_2",
    operationId: "operation_2",
    activationId: "activation_2"
  });
  const otherRenewal = renewal({
    sessionId: "session_2",
    data: { activationId: "activation_2" }
  });
  const splitHeads = await Promise.allSettled([
    split.store.persistRenewal(target(), renewal()),
    splitSecond.persistRenewal(otherTarget, {
      ...otherRenewal,
      data: { ...otherRenewal.data, executorId: "executor_1", operationId: "operation_2" }
    })
  ]);
  assert.equal(splitHeads.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(splitHeads.filter((item) => item.status === "rejected").length, 1);
});

test("every atomic fault point recovers a complete generation after restart", async (t) => {
  for (const point of [
    "after_commit_shadow_fsync",
    "after_temporary_fsync",
    "after_rename",
    "before_directory_fsync"
  ]) {
    await t.test(point, async (t) => {
      let injected = false;
      const current = await fixture({
        faultInjector(candidate) {
          if (!injected && candidate === point) {
            injected = true;
            throw new Error(`crash:${point}`);
          }
        }
      });
      t.after(() => rm(current.base, { recursive: true, force: true }));
      await assert.rejects(current.store.persistRenewal(target(), renewal()), /crash:/);
      const restarted = new DesktopActivationLeaseFenceStore({
        ...current.options,
        faultInjector: undefined
      });
      const recovered = await restarted.read("activation_1");
      assert.equal(recovered.generation, 1);
      assert.equal(recovered.status, "fresh");
    });
  }
});

test("a crashed successor chain recovers generation two instead of choosing the old target", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.persistRenewal(target(), renewal());
  current.setNow("2026-07-13T09:00:01.000Z");
  let injected = false;
  const crashing = new DesktopActivationLeaseFenceStore({
    ...current.options,
    faultInjector(point) {
      if (!injected && point === "after_temporary_fsync") {
        injected = true;
        throw new Error("generation-two crash");
      }
    }
  });
  await assert.rejects(
    crashing.persistRenewal(
      target(),
      renewal({
        requestHash: "b".repeat(64),
        data: {
          renewedAt: "2026-07-13T09:00:01Z",
          leaseExpiresAt: "2026-07-13T09:00:31Z"
        }
      })
    ),
    /generation-two crash/
  );
  const restarted = new DesktopActivationLeaseFenceStore(current.options);
  const recovered = await restarted.read("activation_1");
  assert.equal(recovered.generation, 2);
  assert.equal(recovered.renewedAt, "2026-07-13T09:00:01Z");
});

test("unsupported directory fsync retains the latest flushed commit shadow", async (t) => {
  const current = await fixture({ syncDirectory: async () => false });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.persistRenewal(target(), renewal());
  let entries = await readdir(current.root);
  assert.equal(entries.includes("activation_1.sec.commit-1"), true);
  assert.equal(entries.includes("activation_1.sec"), true);

  const restarted = new DesktopActivationLeaseFenceStore(current.options);
  assert.equal((await restarted.read("activation_1")).generation, 1);
  current.setNow("2026-07-13T09:00:01.000Z");
  await restarted.persistRenewal(
    target(),
    renewal({
      requestHash: "b".repeat(64),
      data: {
        renewedAt: "2026-07-13T09:00:01Z",
        leaseExpiresAt: "2026-07-13T09:00:31Z"
      }
    })
  );
  entries = await readdir(current.root);
  assert.equal(entries.includes("activation_1.sec.commit-2"), true);
  assert.equal(entries.includes("activation_1.sec.commit-1"), false);
});

test("conflicting old shadows and a generation-one tombstone are corrupt, never cleaned as evidence", async (t) => {
  await t.test("old shadow branch", async (t) => {
    const current = await fixture();
    const foreign = await fixture({
      faultInjector(point) {
        if (point === "after_commit_shadow_fsync") throw new Error("keep foreign shadow");
      }
    });
    t.after(() => rm(current.base, { recursive: true, force: true }));
    t.after(() => rm(foreign.base, { recursive: true, force: true }));
    await current.store.persistRenewal(target(), renewal());
    current.setNow("2026-07-13T09:00:01.000Z");
    await current.store.persistRenewal(
      target(),
      renewal({
        requestHash: "b".repeat(64),
        data: {
          renewedAt: "2026-07-13T09:00:01Z",
          leaseExpiresAt: "2026-07-13T09:00:31Z"
        }
      })
    );
    await assert.rejects(
      foreign.store.persistRenewal(
        target(),
        renewal({ data: { executorId: "executor_foreign" } })
      ),
      /keep foreign shadow/
    );
    await copyFile(
      path.join(foreign.root, "activation_1.sec.commit-1"),
      path.join(current.root, "activation_1.sec.commit-1")
    );
    await chmod(path.join(current.root, "activation_1.sec.commit-1"), 0o600);
    await assert.rejects(
      new DesktopActivationLeaseFenceStore(current.options).read("activation_1"),
      expectCode("desktop_activation_lease_fence_corrupt")
    );
    assert.equal(
      await lstat(path.join(current.root, "activation_1.sec.commit-1")).then(() => true),
      true
    );
  });

  await t.test("generation one tombstone", async (t) => {
    const current = await fixture();
    t.after(() => rm(current.base, { recursive: true, force: true }));
    await current.store.persistRenewal(target(), renewal());
    const exact = await current.store.read("activation_1");
    current.setNow("2026-07-13T09:00:01.000Z");
    await current.store.remove(exact);
    const file = path.join(current.root, "activation_1.sec");
    const raw = await readFile(file);
    const magic = Buffer.from("AICRM-ACTIVATION-LEASE-FENCE-ENC-V1\n", "ascii");
    const record = JSON.parse(current.safeStorage.decryptString(raw.subarray(magic.length)));
    record.generation = 1;
    const forged = Buffer.concat([
      magic,
      current.safeStorage.encryptString(JSON.stringify(record))
    ]);
    await writeFile(file, forged, { mode: 0o600 });
    await assert.rejects(
      new DesktopActivationLeaseFenceStore(current.options).read("activation_1"),
      expectCode("desktop_activation_lease_fence_corrupt")
    );
  });
});

test("remove requires the exact current fence and crash-recovers a terminal tombstone", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.persistRenewal(target(), renewal());
  const exact = await current.store.read("activation_1");
  await assert.rejects(
    current.store.remove({ ...exact, generation: exact.generation + 1 }),
    expectCode("desktop_activation_lease_fence_conflict")
  );
  assert.notEqual(await current.store.read("activation_1"), null);

  current.setNow("2026-07-13T09:00:01.000Z");
  let injected = false;
  const crashing = new DesktopActivationLeaseFenceStore({
    ...current.options,
    faultInjector(point) {
      if (!injected && point === "after_commit_shadow_fsync") {
        injected = true;
        throw new Error("remove crash");
      }
    }
  });
  await assert.rejects(crashing.remove(exact), /remove crash/);
  const restarted = new DesktopActivationLeaseFenceStore(current.options);
  assert.equal(await restarted.read("activation_1"), null);
  assert.deepEqual(await restarted.list(), []);
  await restarted.remove(exact);
  await assert.rejects(
    restarted.persistRenewal(target(), renewal()),
    expectCode("desktop_activation_lease_fence_conflict")
  );
});

test("basic_text, symlink, hardlink, loose directory, and unknown files fail closed", async (t) => {
  const basic = await fixture({ safeStorage: new FakeSafeStorage({ backend: "basic_text" }) });
  t.after(() => rm(basic.base, { recursive: true, force: true }));
  await assert.rejects(
    basic.store.persistRenewal(target(), renewal()),
    expectCode("desktop_secure_storage_unavailable")
  );

  if (process.platform !== "win32") {
    const loose = await fixture();
    t.after(() => rm(loose.base, { recursive: true, force: true }));
    await mkdir(loose.root, { mode: 0o755 });
    await chmod(loose.root, 0o755);
    await assert.rejects(loose.store.list(), expectCode("desktop_activation_lease_fence_unsafe"));

    const symbolic = await fixture();
    t.after(() => rm(symbolic.base, { recursive: true, force: true }));
    await mkdir(symbolic.root, { mode: 0o700 });
    const external = path.join(symbolic.base, "external.sec");
    await writeFile(external, "not-a-fence", { mode: 0o600 });
    await symlink(external, path.join(symbolic.root, "activation_1.sec"));
    await assert.rejects(symbolic.store.read("activation_1"), expectCode("desktop_activation_lease_fence_unsafe"));
  }

  const hard = await fixture();
  t.after(() => rm(hard.base, { recursive: true, force: true }));
  await hard.store.persistRenewal(target(), renewal());
  await link(path.join(hard.root, "activation_1.sec"), path.join(hard.base, "linked.sec"));
  await assert.rejects(hard.store.read("activation_1"), expectCode("desktop_activation_lease_fence_unsafe"));

  if (process.platform !== "win32") {
    const permissive = await fixture();
    t.after(() => rm(permissive.base, { recursive: true, force: true }));
    await permissive.store.persistRenewal(target(), renewal());
    await chmod(path.join(permissive.root, "activation_1.sec"), 0o644);
    await assert.rejects(
      permissive.store.read("activation_1"),
      expectCode("desktop_activation_lease_fence_unsafe")
    );
  }

  const unknown = await fixture();
  t.after(() => rm(unknown.base, { recursive: true, force: true }));
  await mkdir(unknown.root, { mode: 0o700 });
  await writeFile(path.join(unknown.root, "unexpected.txt"), "x", { mode: 0o600 });
  await assert.rejects(unknown.store.list(), expectCode("desktop_activation_lease_fence_unsafe"));
});

test("ciphertext or envelope tampering is rejected without leaking sensitive material", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.store.persistRenewal(target(), renewal());
  const file = path.join(current.root, "activation_1.sec");
  const raw = await readFile(file);
  raw[0] ^= 0xff;
  await writeFile(file, raw, { mode: 0o600 });
  await assert.rejects(
    new DesktopActivationLeaseFenceStore(current.options).read("activation_1"),
    (error) => {
      assert.equal(error.code, "desktop_activation_lease_fence_corrupt");
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    }
  );
});
