import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM,
  canonicalDesktopCredentialManifest,
  digestDesktopCredentialTree
} from "./desktop-credential-tree-digest.ts";
import { DesktopCredentialTreeManager } from "./desktop-credential-tree-manager.ts";

const fixturePath = path.resolve(
  process.cwd(),
  "../../docs/testdata/aicrm_credential_tree_vectors.json"
);
const tokenCanary = "plaintext-ack-token-must-never-be-persisted";

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
      Buffer.from("CREDENTIAL-JOURNAL-TEST\0"),
      Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0x9b))
    ]);
  }

  decryptString(value) {
    const prefix = Buffer.from("CREDENTIAL-JOURNAL-TEST\0");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("ciphertext invalid");
    return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0x9b)).toString("utf8");
  }
}

async function managerFixture(options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-credential-tree-"));
  const root = path.join(base, "vault");
  const storage = options.safeStorage ?? new FakeSafeStorage();
  const manager = new DesktopCredentialTreeManager({
    root,
    safeStorage: storage,
    now: () => new Date("2026-07-13T00:00:00.000Z"),
    faultInjector: options.faultInjector
  });
  await manager.initialize();
  return { base, root, storage, manager };
}

async function writeTreeFile(root, relative, content) {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode: 0o600 });
}

async function seedStaging(manager, executorId, sessionId, content = "credential") {
  const ref = await manager.createStaging(executorId, sessionId);
  const target = manager.mainOnlyResolvePath(ref);
  await writeTreeFile(target, "auth.json", Buffer.from(content));
  return { ref, target, digest: await digestDesktopCredentialTree(target) };
}

function acknowledge(manager, projection) {
  return manager.completeAfterAcknowledgement({
    executorId: projection.executorId,
    operationId: projection.operationId,
    revision: projection.revision,
    expectedDigest: projection.digest
  });
}

function ackReplay() {
  return {
    tokenHash: createHash("sha256").update(tokenCanary).digest("hex"),
    tokenReference: "ack_ref_1"
  };
}

function runPromotionProcess(root, sessionId, operationId, expectedDigest) {
  const managerModule = new URL("./desktop-credential-tree-manager.ts", import.meta.url).href;
  const script = `
    import { DesktopCredentialTreeManager } from ${JSON.stringify(managerModule)};
    class Storage {
      isEncryptionAvailable() { return true; }
      getSelectedStorageBackend() { return "gnome_libsecret"; }
      encryptString(value) {
        return Buffer.concat([
          Buffer.from("CREDENTIAL-JOURNAL-TEST\\0"),
          Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0x9b))
        ]);
      }
      decryptString(value) {
        const prefix = Buffer.from("CREDENTIAL-JOURNAL-TEST\\0");
        if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("ciphertext invalid");
        return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0x9b)).toString("utf8");
      }
    }
    const [root, sessionId, operationId, expectedDigest] = process.argv.slice(1);
    const manager = new DesktopCredentialTreeManager({ root, safeStorage: new Storage() });
    try {
      const projection = await manager.promoteStaging({
        executorId: "executor_1", sessionId, operationId, revision: 1, expectedDigest
      });
      process.stdout.write(JSON.stringify({ ok: true, projection }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? "unknown" }));
      process.exitCode = 2;
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script, root, sessionId, operationId, expectedDigest],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => {
      try {
        resolve({ status, stderr, ...JSON.parse(stdout) });
      } catch {
        reject(new Error(`promotion child produced invalid output: ${stderr}`));
      }
    });
  });
}

test("Desktop and Go consume the same locked RFC8785/NFC fixture", async (t) => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(fixture.version, 1);
  assert.equal(fixture.algorithm, DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM);
  for (const vector of fixture.vectors) {
    await t.test(vector.name, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "aicrm-digest-vector-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const entries = [];
      for (const file of vector.files) {
        const content = Buffer.from(file.contentBase64, "base64");
        await writeTreeFile(root, file.path, content);
        entries.push({
          path: file.path.normalize("NFC"),
          sha256: createHash("sha256").update(content).digest("hex"),
          size: content.byteLength
        });
      }
      const canonical = canonicalDesktopCredentialManifest(entries);
      assert.deepEqual(JSON.parse(canonical).map((entry) => entry.path), vector.expectedManifestPaths);
      const measured = await digestDesktopCredentialTree(root);
      assert.deepEqual(measured, {
        algorithm: fixture.algorithm,
        digest: vector.expectedDigest,
        fileCount: vector.files.length,
        totalBytes: vector.files.reduce(
          (total, file) => total + Buffer.from(file.contentBase64, "base64").byteLength,
          0
        )
      });
    });
  }
  if (process.platform !== "darwin" && process.platform !== "win32") {
    for (const vector of fixture.negativeVectors) {
      await t.test(vector.name, async (t) => {
        const root = await mkdtemp(path.join(os.tmpdir(), "aicrm-digest-negative-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        for (const file of vector.files) {
          await writeTreeFile(root, file.path, Buffer.from(file.contentBase64, "base64"));
        }
        await assert.rejects(digestDesktopCredentialTree(root), {
          code: "desktop_credential_tree_unsafe"
        });
      });
    }
  }
});

test("opaque IDs, root symlinks and executor subdirectory symlinks fail closed", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  for (const id of ["", "../escape", "with/slash", "with:colon", "a".repeat(121), "设备"]) {
    await assert.rejects(current.manager.createStaging(id, "session_1"), {
      code: "desktop_credential_path_invalid"
    });
    await assert.rejects(current.manager.createStaging("executor_1", id), {
      code: "desktop_credential_path_invalid"
    });
  }
  assert.throws(
    () => current.manager.mainOnlyResolvePath({ kind: "revision", executorId: "executor_1", revision: 0 }),
    { code: "desktop_credential_path_invalid" }
  );

  if (process.platform !== "win32") {
    const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-credential-root-link-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const real = path.join(base, "real");
    const linked = path.join(base, "vault");
    await mkdir(real);
    await symlink(real, linked);
    const linkedManager = new DesktopCredentialTreeManager({ root: linked, safeStorage: new FakeSafeStorage() });
    await assert.rejects(linkedManager.initialize(), { code: "desktop_credential_tree_unsafe" });

    const sub = await managerFixture();
    t.after(() => rm(sub.base, { recursive: true, force: true }));
    const outside = path.join(sub.base, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(sub.root, "executor_1"));
    await assert.rejects(sub.manager.createStaging("executor_1", "session_1"), {
      code: "desktop_credential_tree_unsafe"
    });
  }
});

test("digest rejects symlinks, hardlinks, FIFO and Unix sockets", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-credential-unsafe-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const symlinkRoot = path.join(base, "symlink");
  await mkdir(symlinkRoot);
  await writeFile(path.join(base, "outside"), "secret");
  await symlink(path.join(base, "outside"), path.join(symlinkRoot, "auth.json"));
  await assert.rejects(digestDesktopCredentialTree(symlinkRoot), {
    code: "desktop_credential_tree_unsafe"
  });

  const hardlinkRoot = path.join(base, "hardlink");
  await mkdir(hardlinkRoot);
  await writeFile(path.join(hardlinkRoot, "auth.json"), "secret");
  await link(path.join(hardlinkRoot, "auth.json"), path.join(hardlinkRoot, "alias.json"));
  await assert.rejects(digestDesktopCredentialTree(hardlinkRoot), {
    code: "desktop_credential_tree_unsafe"
  });

  if (process.platform !== "win32") {
    const fifoRoot = path.join(base, "fifo");
    await mkdir(fifoRoot);
    const fifo = path.join(fifoRoot, "credential.pipe");
    const result = spawnSync("mkfifo", [fifo]);
    if (result.status === 0) {
      await assert.rejects(digestDesktopCredentialTree(fifoRoot), {
        code: "desktop_credential_tree_unsafe"
      });
    }

    const socketRoot = path.join(base, "socket");
    await mkdir(socketRoot);
    const socket = path.join(socketRoot, "credential.sock");
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    try {
      await assert.rejects(digestDesktopCredentialTree(socketRoot), {
        code: "desktop_credential_tree_unsafe"
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("digest rejects NFC-equivalent directories and file-directory namespace collisions", async (t) => {
  if (process.platform === "darwin" || process.platform === "win32") {
    t.skip("test requires a filesystem that preserves both NFC spellings");
    return;
  }
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-credential-nfc-nodes-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const directories = path.join(base, "directories");
  await mkdir(path.join(directories, "é"), { recursive: true });
  await mkdir(path.join(directories, "e\u0301"), { recursive: true });
  await assert.rejects(digestDesktopCredentialTree(directories), {
    code: "desktop_credential_tree_unsafe"
  });

  const mixed = path.join(base, "mixed");
  await mkdir(mixed);
  await writeFile(path.join(mixed, "é"), "credential");
  await mkdir(path.join(mixed, "e\u0301"));
  await assert.rejects(digestDesktopCredentialTree(mixed), {
    code: "desktop_credential_tree_unsafe"
  });
});

test("digest enforces file-count and byte limits before reading content", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-credential-limits-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const oversized = path.join(base, "oversized");
  await mkdir(oversized);
  const sparse = await open(path.join(oversized, "credential.bin"), "w", 0o600);
  await sparse.truncate((128 << 20) + 1);
  await sparse.close();
  await assert.rejects(digestDesktopCredentialTree(oversized), {
    code: "desktop_credential_tree_unsafe"
  });

  const tooMany = path.join(base, "too-many");
  await mkdir(tooMany);
  for (let index = 0; index < 4097; index += 1) {
    await writeFile(path.join(tooMany, `credential-${String(index).padStart(4, "0")}`), "");
  }
  await assert.rejects(digestDesktopCredentialTree(tooMany), {
    code: "desktop_credential_tree_unsafe"
  });
});

test("staging promotion is digest-bound, durable, immutable and no-replace", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const first = await seedStaging(current.manager, "executor_1", "session_1");
  await writeTreeFile(first.target, "nested/config.toml", Buffer.from("model='gpt-5.6'\n"));
  first.digest = await digestDesktopCredentialTree(first.target);
  const projection = await current.manager.promoteStaging({
    executorId: "executor_1",
    sessionId: "session_1",
    operationId: "promote_1",
    revision: 1,
    expectedDigest: first.digest.digest
  });
  assert.equal("path" in projection, false);
  assert.equal(projection.digest, first.digest.digest);
  await assert.rejects(lstat(first.target), { code: "ENOENT" });
  const revision = current.manager.mainOnlyResolvePath({
    kind: "revision",
    executorId: "executor_1",
    revision: 1
  });
  assert.equal((await digestDesktopCredentialTree(revision)).digest, first.digest.digest);
  if (process.platform !== "win32") {
    assert.equal((await stat(path.dirname(revision))).mode & 0o777, 0o500);
    assert.equal((await stat(path.join(path.dirname(revision), "owner.fence"))).mode & 0o777, 0o400);
    assert.equal((await stat(revision)).mode & 0o777, 0o500);
    assert.equal((await stat(path.join(revision, "auth.json"))).mode & 0o777, 0o400);
  }
  assert.equal((await current.manager.listPendingOperations("executor_1"))[0].phase, "verified");
  await acknowledge(current.manager, projection);
  assert.deepEqual(await current.manager.listPendingOperations("executor_1"), []);

  const second = await seedStaging(current.manager, "executor_1", "session_2", "other");
  await assert.rejects(
    current.manager.promoteStaging({
      executorId: "executor_1",
      sessionId: "session_2",
      operationId: "promote_2",
      revision: 1,
      expectedDigest: second.digest.digest
    }),
    { code: "desktop_credential_target_exists" }
  );
  assert.equal((await lstat(second.target)).isDirectory(), true);
});

test("digest mismatch never creates a revision or success journal", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_bad");
  await assert.rejects(
    current.manager.promoteStaging({
      executorId: "executor_1",
      sessionId: "session_bad",
      operationId: "promote_bad",
      revision: 1,
      expectedDigest: "0".repeat(64)
    }),
    { code: "desktop_credential_digest_mismatch" }
  );
  assert.equal((await lstat(staging.target)).isDirectory(), true);
  await assert.rejects(
    lstat(current.manager.mainOnlyResolvePath({ kind: "revision", executorId: "executor_1", revision: 1 })),
    { code: "ENOENT" }
  );
  assert.deepEqual(await current.manager.listPendingOperations("executor_1"), []);
});

test("post-rename digest mismatch quarantines the whole reserved revision", async (t) => {
  let root = "";
  let tampered = false;
  const current = await managerFixture({
    async faultInjector(point) {
      if (!tampered && point === "after_target_durable") {
        tampered = true;
        const target = path.join(root, "executor_1", "revisions", "1", "home", "auth.json");
        if (process.platform !== "win32") await chmod(target, 0o600);
        await writeFile(target, "tampered", { mode: 0o600 });
        if (process.platform !== "win32") await chmod(target, 0o400);
      }
    }
  });
  root = current.root;
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_1", "original");
  await assert.rejects(
    current.manager.promoteStaging({
      executorId: "executor_1",
      sessionId: "session_1",
      operationId: "promote_1",
      revision: 1,
      expectedDigest: staging.digest.digest
    }),
    { code: "desktop_credential_digest_mismatch" }
  );
  const revision = current.manager.mainOnlyResolvePath({
    kind: "revision",
    executorId: "executor_1",
    revision: 1
  });
  await assert.rejects(lstat(revision), { code: "ENOENT" });
  const quarantined = current.manager.mainOnlyResolvePath({
    kind: "quarantine",
    executorId: "executor_1",
    sourceKind: "revision",
    sourceId: "1"
  });
  assert.equal(await readFile(path.join(quarantined, "auth.json"), "utf8"), "tampered");
  assert.equal((await current.manager.listPendingOperations("executor_1"))[0].phase, "quarantined");
});

test("COW operations never mount an active revision writable and quarantine is no-replace", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_1", "original");
  const firstProjection = await current.manager.promoteStaging({
    executorId: "executor_1",
    sessionId: "session_1",
    operationId: "promote_1",
    revision: 1,
    expectedDigest: staging.digest.digest
  });
  await acknowledge(current.manager, firstProjection);
  const revision1 = current.manager.mainOnlyResolvePath({
    kind: "revision",
    executorId: "executor_1",
    revision: 1
  });
  const operationRef = await current.manager.cloneRevision("executor_1", 1, "rotate_1");
  const operation = current.manager.mainOnlyResolvePath(operationRef);
  if (process.platform !== "win32") {
    assert.equal((await stat(revision1)).mode & 0o222, 0);
    assert.notEqual((await stat(operation)).mode & 0o200, 0);
  }
  await writeFile(path.join(operation, "auth.json"), "rotated", { mode: 0o600 });
  assert.equal((await readFile(path.join(revision1, "auth.json"), "utf8")), "original");
  const rotatedDigest = await digestDesktopCredentialTree(operation);
  const secondProjection = await current.manager.promoteOperation({
    executorId: "executor_1",
    sourceOperationId: "rotate_1",
    operationId: "promote_2",
    revision: 2,
    expectedDigest: rotatedDigest.digest
  });
  await acknowledge(current.manager, secondProjection);
  const revision2Ref = { kind: "revision", executorId: "executor_1", revision: 2 };
  const revision2 = current.manager.mainOnlyResolvePath(revision2Ref);
  const quarantineRef = await current.manager.quarantine(revision2Ref);
  const quarantined = current.manager.mainOnlyResolvePath(quarantineRef);
  await assert.rejects(lstat(revision2), { code: "ENOENT" });
  await assert.rejects(lstat(path.dirname(revision2)), { code: "ENOENT" });
  assert.equal((await lstat(path.join(path.dirname(quarantined), "owner.fence"))).isFile(), true);
  assert.equal((await digestDesktopCredentialTree(quarantined)).digest, rotatedDigest.digest);
  if (process.platform !== "win32") assert.equal((await stat(quarantined)).mode & 0o222, 0);

  const third = await seedStaging(current.manager, "executor_1", "session_3", "third");
  const thirdProjection = await current.manager.promoteStaging({
    executorId: "executor_1",
    sessionId: "session_3",
    operationId: "promote_3",
    revision: 3,
    expectedDigest: third.digest.digest
  });
  await acknowledge(current.manager, thirdProjection);
  const revision3Ref = { kind: "revision", executorId: "executor_1", revision: 3 };
  const revision3 = current.manager.mainOnlyResolvePath(revision3Ref);
  const quarantine3 = current.manager.mainOnlyResolvePath({
    kind: "quarantine",
    executorId: "executor_1",
    sourceKind: "revision",
    sourceId: "3"
  });
  await mkdir(path.dirname(path.dirname(quarantine3)), { recursive: true, mode: 0o700 });
  await assert.rejects(current.manager.quarantine(revision3Ref), {
    code: "desktop_credential_target_exists"
  });
  assert.equal((await lstat(revision3)).isDirectory(), true);
});

test("per-executor process mutex serializes conflicting staging creation", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const results = await Promise.allSettled(
    Array.from({ length: 16 }, () => current.manager.createStaging("executor_1", "session_1"))
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(rejected.length, 15);
  assert.equal(rejected.every((result) => result.reason.code === "desktop_credential_target_exists"), true);
});

test("atomic permanent reservation prevents cross-process revision replacement", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const first = await seedStaging(current.manager, "executor_1", "session_a", "credential-a");
  const second = await seedStaging(current.manager, "executor_1", "session_b", "credential-b");
  const results = await Promise.all([
    runPromotionProcess(current.root, "session_a", "promote_a", first.digest.digest),
    runPromotionProcess(current.root, "session_b", "promote_b", second.digest.digest)
  ]);
  const winners = results.filter((result) => result.ok);
  const losers = results.filter((result) => !result.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(losers.length, 1, JSON.stringify(results));
  assert.equal(losers[0].code, "desktop_credential_target_exists");
  const winner = winners[0].projection;
  const expected = winner.operationId === "promote_a" ? first : second;
  const loser = winner.operationId === "promote_a" ? second : first;
  const loserOperationId = winner.operationId === "promote_a" ? "promote_b" : "promote_a";
  const revision = current.manager.mainOnlyResolvePath({
    kind: "revision",
    executorId: "executor_1",
    revision: 1
  });
  assert.equal((await digestDesktopCredentialTree(revision)).digest, expected.digest.digest);
  assert.equal((await lstat(loser.target)).isDirectory(), true);
  const fence = JSON.parse(await readFile(path.join(path.dirname(revision), "owner.fence"), "utf8"));
  assert.deepEqual(Object.keys(fence).sort(), [
    "executorId",
    "expectedDigest",
    "operationId",
    "revision",
    "version"
  ]);
  assert.equal(fence.operationId, winner.operationId);
  assert.equal(fence.expectedDigest, winner.digest);
  const pendingBeforeAck = await current.manager.listPendingOperations("executor_1");
  assert.equal([1, 2].includes(pendingBeforeAck.length), true);
  assert.equal(pendingBeforeAck.some((item) => item.operationId === winner.operationId), true);
  if (pendingBeforeAck.length === 2) {
    assert.equal(pendingBeforeAck.some((item) => item.operationId === loserOperationId), true);
  }
  await acknowledge(current.manager, winner);
  const pendingAfterAck = await current.manager.listPendingOperations("executor_1");
  assert.equal([0, 1].includes(pendingAfterAck.length), true);
  if (pendingAfterAck.length === 1) {
    assert.equal(pendingAfterAck[0].operationId, loserOperationId);
  }
});

test("a journaled loser keeps recovery evidence when another operation owns the revision", async (t) => {
  let paused = false;
  const current = await managerFixture({
    faultInjector(point) {
      if (!paused && point === "after_journal_prepared") {
        paused = true;
        throw new Error("pause loser after journal");
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const loserStaging = await seedStaging(current.manager, "executor_1", "session_loser", "loser");
  await assert.rejects(
    current.manager.promoteStaging({
      executorId: "executor_1",
      sessionId: "session_loser",
      operationId: "promote_loser",
      revision: 1,
      expectedDigest: loserStaging.digest.digest
    }),
    /pause loser/
  );
  const winnerStaging = await seedStaging(current.manager, "executor_1", "session_winner", "winner");
  const winner = await current.manager.promoteStaging({
    executorId: "executor_1",
    sessionId: "session_winner",
    operationId: "promote_winner",
    revision: 1,
    expectedDigest: winnerStaging.digest.digest
  });
  await assert.rejects(current.manager.recoverOperation("executor_1", "promote_loser"), {
    code: "desktop_credential_target_exists"
  });
  const pending = await current.manager.listPendingOperations("executor_1");
  assert.equal(pending.length, 2);
  assert.equal(pending.find((item) => item.operationId === "promote_loser")?.phase, "prepared");
  assert.equal((await lstat(loserStaging.target)).isDirectory(), true);
  await acknowledge(current.manager, winner);
  const afterAck = await current.manager.listPendingOperations("executor_1");
  assert.equal(afterAck.length, 1);
  assert.equal(afterAck[0].operationId, "promote_loser");
});

test("same promotion call resumes its durable reservation instead of rejecting the target", async (t) => {
  let crashed = false;
  const current = await managerFixture({
    faultInjector(point) {
      if (!crashed && point === "after_reservation_fence") {
        crashed = true;
        throw new Error("crash after durable reservation");
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_1");
  const input = {
    executorId: "executor_1",
    sessionId: "session_1",
    operationId: "promote_1",
    revision: 1,
    expectedDigest: staging.digest.digest,
    ackReplay: ackReplay()
  };
  await assert.rejects(current.manager.promoteStaging(input), /crash after durable reservation/);
  const restarted = new DesktopCredentialTreeManager({
    root: current.root,
    safeStorage: current.storage
  });
  const recovered = await restarted.promoteStaging(input);
  assert.equal(recovered.digest, staging.digest.digest);
  assert.equal((await restarted.listPendingOperations("executor_1"))[0].phase, "verified");
  await acknowledge(restarted, recovered);
});

test("ambiguous source plus revision quarantines both trees and keeps terminal evidence", async (t) => {
  let crashed = false;
  const current = await managerFixture({
    faultInjector(point) {
      if (!crashed && point === "after_rename") {
        crashed = true;
        throw new Error("crash after rename before journal phase advance");
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_1", "original");
  await assert.rejects(
    current.manager.promoteStaging({
      executorId: "executor_1",
      sessionId: "session_1",
      operationId: "promote_1",
      revision: 1,
      expectedDigest: staging.digest.digest
    }),
    /crash after rename/
  );
  await mkdir(staging.target, { recursive: true, mode: 0o700 });
  await writeTreeFile(staging.target, "auth.json", Buffer.from("late-source"));

  const restarted = new DesktopCredentialTreeManager({
    root: current.root,
    safeStorage: current.storage
  });
  await assert.rejects(restarted.recoverOperation("executor_1", "promote_1"), {
    code: "desktop_credential_recovery_required"
  });
  const revision = restarted.mainOnlyResolvePath({
    kind: "revision",
    executorId: "executor_1",
    revision: 1
  });
  await assert.rejects(lstat(staging.target), { code: "ENOENT" });
  await assert.rejects(lstat(revision), { code: "ENOENT" });
  assert.equal(
    (await lstat(
      restarted.mainOnlyResolvePath({
        kind: "quarantine",
        executorId: "executor_1",
        sourceKind: "staging",
        sourceId: "session_1"
      })
    )).isDirectory(),
    true
  );
  assert.equal(
    (await lstat(
      restarted.mainOnlyResolvePath({
        kind: "quarantine",
        executorId: "executor_1",
        sourceKind: "revision",
        sourceId: "1"
      })
    )).isDirectory(),
    true
  );
  const pending = await restarted.listPendingOperations("executor_1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].phase, "quarantined");
  await assert.rejects(restarted.recoverOperation("executor_1", "promote_1"), {
    code: "desktop_credential_recovery_required"
  });
});

for (const crashPoint of [
  "after_journal_prepared",
  "after_reservation_fence",
  "after_rename",
  "after_readonly",
  "after_verified"
]) {
  test(`encrypted operation journal recovers crash point ${crashPoint}`, async (t) => {
    let crashed = false;
    const current = await managerFixture({
      faultInjector(point) {
        if (!crashed && point === crashPoint) {
          crashed = true;
          throw new Error("simulated crash without sensitive data");
        }
      }
    });
    t.after(() => rm(current.base, { recursive: true, force: true }));
    const staging = await seedStaging(current.manager, "executor_1", "session_1");
    await assert.rejects(
      current.manager.promoteStaging({
        executorId: "executor_1",
        sessionId: "session_1",
        operationId: "promote_1",
        revision: 1,
        expectedDigest: staging.digest.digest,
        ackReplay: ackReplay()
      }),
      /simulated crash/
    );
    const pending = await current.manager.listPendingOperations("executor_1");
    assert.equal(pending.length, 1);
    assert.equal("path" in pending[0], false);
    assert.equal("token" in pending[0], false);
    assert.deepEqual(pending[0].ackReplay, ackReplay());
    const journal = path.join(current.root, "executor_1", "journals", "promote_1.sec");
    const raw = await readFile(journal);
    assert.equal(raw.includes(Buffer.from(tokenCanary)), false);
    if (process.platform !== "win32") assert.equal((await stat(journal)).mode & 0o777, 0o600);

    const restarted = new DesktopCredentialTreeManager({
      root: current.root,
      safeStorage: current.storage,
      now: () => new Date("2026-07-13T00:00:01.000Z")
    });
    const recovered = await restarted.recoverOperation("executor_1", "promote_1");
    assert.equal(recovered.digest, staging.digest.digest);
    assert.equal((await restarted.listPendingOperations("executor_1"))[0].phase, "verified");
    await assert.rejects(
      restarted.completeAfterAcknowledgement({
        executorId: "executor_1",
        operationId: "promote_1",
        revision: 1,
        expectedDigest: "0".repeat(64)
      }),
      { code: "desktop_credential_recovery_required" }
    );
    await acknowledge(restarted, recovered);
    assert.deepEqual(await restarted.listPendingOperations("executor_1"), []);
    const revision = restarted.mainOnlyResolvePath({
      kind: "revision",
      executorId: "executor_1",
      revision: 1
    });
    if (process.platform !== "win32") assert.equal((await stat(revision)).mode & 0o222, 0);
  });
}

test("ownerless permanent revision reservation is never guessed away", async (t) => {
  let crashed = false;
  const current = await managerFixture({
    faultInjector(point) {
      if (!crashed && point === "after_reservation_mkdir") {
        crashed = true;
        throw new Error("crash before ownership fence");
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_1");
  await assert.rejects(
    current.manager.promoteStaging({
      executorId: "executor_1",
      sessionId: "session_1",
      operationId: "promote_1",
      revision: 1,
      expectedDigest: staging.digest.digest
    }),
    /crash before ownership fence/
  );
  const container = path.dirname(
    current.manager.mainOnlyResolvePath({ kind: "revision", executorId: "executor_1", revision: 1 })
  );
  assert.equal((await lstat(container)).isDirectory(), true);
  await assert.rejects(readFile(path.join(container, "owner.fence")), { code: "ENOENT" });
  const restarted = new DesktopCredentialTreeManager({ root: current.root, safeStorage: current.storage });
  await assert.rejects(restarted.recoverOperation("executor_1", "promote_1"), {
    code: "desktop_credential_recovery_required"
  });
  assert.equal((await lstat(staging.target)).isDirectory(), true);
  assert.equal((await lstat(container)).isDirectory(), true);
});

test("file and parent fsync failures remain recoverable and never report success", async (t) => {
  for (const scenario of ["before_file_fsync", "before_parent_fsync"]) {
    await t.test(scenario, async (t) => {
      let armed = false;
      let failed = false;
      const current = await managerFixture({
        faultInjector(point) {
          if (armed && !failed && point === scenario) {
            failed = true;
            throw new Error("synthetic fsync failure");
          }
        }
      });
      t.after(() => rm(current.base, { recursive: true, force: true }));
      const staging = await seedStaging(current.manager, "executor_1", "session_1");
      armed = true;
      await assert.rejects(
        current.manager.promoteStaging({
          executorId: "executor_1",
          sessionId: "session_1",
          operationId: "promote_1",
          revision: 1,
          expectedDigest: staging.digest.digest
        }),
        { code: "desktop_credential_durability_failed" }
      );
      assert.equal((await current.manager.listPendingOperations("executor_1")).length, 1);
      const restarted = new DesktopCredentialTreeManager({
        root: current.root,
        safeStorage: current.storage
      });
      const recovered = await restarted.recoverOperation("executor_1", "promote_1");
      assert.equal(recovered.digest, staging.digest.digest);
      await acknowledge(restarted, recovered);
    });
  }
});

test("journal refuses unavailable or plaintext safeStorage before filesystem promotion", async (t) => {
  for (const storage of [
    new FakeSafeStorage({ available: false }),
    new FakeSafeStorage({ backend: "basic_text" })
  ]) {
    await t.test(storage.backend, async (t) => {
      const current = await managerFixture({ safeStorage: storage });
      t.after(() => rm(current.base, { recursive: true, force: true }));
      const staging = await seedStaging(current.manager, "executor_1", "session_1");
      await assert.rejects(
        current.manager.promoteStaging({
          executorId: "executor_1",
          sessionId: "session_1",
          operationId: "promote_1",
          revision: 1,
          expectedDigest: staging.digest.digest
        }),
        { code: "desktop_credential_secure_storage_unavailable" }
      );
      assert.equal((await lstat(staging.target)).isDirectory(), true);
    });
  }
});
