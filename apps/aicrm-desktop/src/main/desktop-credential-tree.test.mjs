import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm as removePath,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
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
import { DesktopCredentialOperationJournalStore } from "./desktop-credential-operation-journal.ts";
import { PowerShellDesktopWindowsCredentialProtection } from "./desktop-credential-windows-protection.ts";

const fixturePath = path.resolve(
  process.cwd(),
  "../../docs/testdata/aicrm_credential_tree_vectors.json"
);
const tokenCanary = "plaintext-ack-token-must-never-be-persisted";
const acknowledgementProvenance = Object.freeze({
  authorizationSessionId: "authorization_session_credential_tree_1",
  activationAckRequestReference: createHash("sha256")
    .update("credential-tree-ack-reference")
    .digest("hex"),
  activationAckRequestHash: createHash("sha256")
    .update("credential-tree-ack-request")
    .digest("hex")
});

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

class FakeWindowsCredentialProtection {
  constructor() {
    this.privateDirectories = [];
    this.syncedFiles = [];
    this.syncedDirectories = [];
    this.syncedTrees = [];
    this.sealedTrees = [];
    this.validatedTrees = [];
    this.preparedMoves = [];
    this.sealedQuarantines = [];
    this.protectedRoots = new Set();
    this.driftedRoots = new Set();
    this.failSeal = false;
    this.failNextFileSync = false;
    this.failNextDirectorySync = false;
    this.failDirectorySyncWhen = null;
  }

  async ensurePrivateDirectory(directory) {
    this.privateDirectories.push(path.resolve(directory));
  }

  async syncFile(file) {
    this.syncedFiles.push(path.resolve(file));
    if (this.failNextFileSync) {
      this.failNextFileSync = false;
      throw new Error("native file flush failed");
    }
  }

  async syncDirectory(directory) {
    const resolved = path.resolve(directory);
    this.syncedDirectories.push(resolved);
    if (this.failNextDirectorySync || this.failDirectorySyncWhen?.(resolved)) {
      this.failNextDirectorySync = false;
      this.failDirectorySyncWhen = null;
      throw new Error("native directory flush failed");
    }
  }

  async syncMutableTree(root) {
    const resolvedRoot = path.resolve(root);
    this.syncedTrees.push(resolvedRoot);
    const directories = [];
    const visit = async (directory) => {
      directories.push(directory);
      for (const child of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, child.name);
        if (child.isDirectory()) await visit(target);
        else await this.syncFile(target);
      }
    };
    await visit(resolvedRoot);
    directories.sort((left, right) => right.length - left.length);
    for (const directory of directories) await this.syncDirectory(directory);
  }

  async sealReadOnlyTree(root) {
    const resolved = path.resolve(root);
    this.sealedTrees.push(resolved);
    if (this.failSeal) throw new Error("native ACL seal failed");
    if (this.protectedRoots.has(resolved)) {
      throw new Error("sealed tree cannot be reopened with GENERIC_WRITE");
    }
    this.protectedRoots.add(resolved);
  }

  async validateReadOnlyTree(root) {
    const resolved = path.resolve(root);
    this.validatedTrees.push(resolved);
    if (
      [...this.driftedRoots].some(
        (drifted) => isSameOrDescendant(resolved, drifted) || isSameOrDescendant(drifted, resolved)
      )
    ) {
      throw new Error("ACL drift detected");
    }
    if (
      path.basename(resolved) === "payload" &&
      ![...this.protectedRoots].some((sealed) => isSameOrDescendant(resolved, sealed))
    ) {
      const moved = this.preparedMoves.find((source) => this.protectedRoots.has(source));
      if (moved) {
        this.protectedRoots.delete(moved);
        this.protectedRoots.add(resolved);
      }
    }
    if (![...this.protectedRoots].some((sealed) => isSameOrDescendant(resolved, sealed))) {
      throw new Error("tree is not protected");
    }
  }

  async prepareReadOnlyTreeForMove(root) {
    await this.validateReadOnlyTree(root);
    this.preparedMoves.push(path.resolve(root));
  }

  async sealQuarantineReservation(reservation, payload) {
    const resolved = path.resolve(reservation);
    const resolvedPayload = path.resolve(payload);
    if (this.preparedMoves.length === 0) throw new Error("readonly payload was not prepared");
    this.protectedRoots.add(resolvedPayload);
    await this.validateReadOnlyTree(resolvedPayload);
    this.sealedQuarantines.push({
      reservation: resolved,
      payload: resolvedPayload
    });
    if (this.failSeal) throw new Error("native quarantine ACL seal failed");
    this.protectedRoots.add(resolved);
  }

  drift(root) {
    this.driftedRoots.add(path.resolve(root));
  }
}

function isSameOrDescendant(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function rm(target, options) {
  if (options?.recursive) await makeTestTreeWritable(target);
  return removePath(target, options);
}

async function makeTestTreeWritable(target) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) {
    await chmod(target, 0o600).catch(() => undefined);
    return;
  }
  await chmod(target, 0o700).catch(() => undefined);
  for (const child of await readdir(target)) {
    await makeTestTreeWritable(path.join(target, child));
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
    faultInjector: options.faultInjector,
    platform: options.platform,
    windowsProtection: options.windowsProtection
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
    expectedDigest: projection.digest,
    ...acknowledgementProvenance
  });
}

function ackReplay() {
  return {
    tokenHash: createHash("sha256").update(tokenCanary).digest("hex"),
    tokenReference: "ack_ref_1"
  };
}

function operationRecordDigest(record) {
  return createHash("sha256")
    .update("AICRM-CREDENTIAL-OPERATION-RECORD-V2\n", "utf8")
    .update(JSON.stringify({
      version: record.version,
      generation: record.generation,
      executorId: record.executorId,
      operationId: record.operationId,
      sourceKind: record.sourceKind,
      sourceId: record.sourceId,
      sourceOwnershipDigest: record.sourceOwnershipDigest,
      targetRevision: record.targetRevision,
      expectedDigest: record.expectedDigest,
      phase: record.phase,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ackReplay: record.ackReplay,
      authorizationSessionId: record.authorizationSessionId,
      activationAckRequestReference: record.activationAckRequestReference,
      activationAckRequestHash: record.activationAckRequestHash,
      acknowledgedAt: record.acknowledgedAt
    }), "utf8")
    .digest("hex");
}

function withOperationRecordDigest(record) {
  const value = { ...record, recordDigest: "" };
  value.recordDigest = operationRecordDigest(value);
  return value;
}

function operationJournalEnvelope(storage, record) {
  const value = withOperationRecordDigest(record);
  return Buffer.concat([
    Buffer.from("AICRM-CREDENTIAL-OP-ENC-V2\n"),
    storage.encryptString(JSON.stringify(value))
  ]);
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

function runJournalContender(root, action, ready, go) {
  const journalModule = new URL(
    "./desktop-credential-operation-journal.ts",
    import.meta.url
  ).href;
  const script = `
    import { access, writeFile } from "node:fs/promises";
    import { DesktopCredentialOperationJournalStore } from ${JSON.stringify(journalModule)};
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
    const [root, action, ready, go] = process.argv.slice(1);
    const store = new DesktopCredentialOperationJournalStore({ root, safeStorage: new Storage() });
    const previous = await store.load("operation_process_cas");
    await writeFile(ready, "ready");
    while (true) {
      try { await access(go); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
    }
    try {
      const next = action === "ack"
        ? await store.transition(previous, "acknowledged", {
            authorizationSessionId: "authorization_session_process_cas",
            activationAckRequestReference: "1".repeat(64),
            activationAckRequestHash: "2".repeat(64)
          })
        : await store.transition(previous, "quarantined");
      process.stdout.write(JSON.stringify({ ok: true, phase: next.phase, digest: next.recordDigest }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error?.code, message: error?.message }));
    }
  `;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
    root,
    action,
    ready,
    go
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value) => { stdout += value; });
  child.stderr.on("data", (value) => { stderr += value; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`journal contender exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

async function waitForPath(target) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await lstat(target);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw new Error("timed out waiting for child process barrier");
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

test("Vault-owned measurement flushes mutable candidates and verifies sealed revisions", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_measure", "session_measure", "measured");
  const candidate = await current.manager.measure({
    kind: "staging",
    executorId: "executor_measure",
    sessionId: "session_measure"
  });
  assert.equal(candidate.digest, staging.digest.digest);
  assert.equal("path" in candidate, false);

  const projection = await current.manager.promoteStaging({
    executorId: "executor_measure",
    sessionId: "session_measure",
    operationId: "promotion_measure",
    revision: 1,
    expectedDigest: candidate.digest
  });
  const revision = await current.manager.measure({
    kind: "revision",
    executorId: "executor_measure",
    revision: 1
  });
  assert.equal(revision.digest, candidate.digest);
  await acknowledge(current.manager, projection);
});

test("pending executor enumeration is strict, sorted, and excludes acknowledged journals", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const pendingStaging = await seedStaging(current.manager, "executor_z", "session_z", "pending");
  await current.manager.promoteStaging({
    executorId: "executor_z",
    sessionId: "session_z",
    operationId: "promotion_z",
    revision: 1,
    expectedDigest: pendingStaging.digest.digest
  });
  const acknowledgedStaging = await seedStaging(current.manager, "executor_a", "session_a", "done");
  const acknowledged = await current.manager.promoteStaging({
    executorId: "executor_a",
    sessionId: "session_a",
    operationId: "promotion_a",
    revision: 1,
    expectedDigest: acknowledgedStaging.digest.digest
  });
  await acknowledge(current.manager, acknowledged);
  await current.manager.createStaging("executor_empty", "session_empty");

  assert.deepEqual(await current.manager.listPendingExecutorIds(), ["executor_z"]);
  await writeFile(path.join(current.root, "unexpected.txt"), "unsafe", { mode: 0o600 });
  await assert.rejects(current.manager.listPendingExecutorIds(), {
    code: "desktop_credential_tree_unsafe"
  });
});

test("ACK tombstones are exact, idempotent, inspectable, filtered, and explicitly removable", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(
    current.manager,
    "executor_ack_tombstone",
    "session_ack_tombstone",
    tokenCanary
  );
  const promoted = await current.manager.promoteStaging({
    executorId: "executor_ack_tombstone",
    sessionId: "session_ack_tombstone",
    operationId: "operation_ack_tombstone",
    revision: 1,
    expectedDigest: staging.digest.digest,
    ackReplay: ackReplay()
  });
  const exact = {
    executorId: promoted.executorId,
    operationId: promoted.operationId,
    revision: promoted.revision,
    expectedDigest: promoted.digest,
    ...acknowledgementProvenance
  };
  assert.equal(await current.manager.inspectAcknowledged(exact), null);
  await assert.rejects(current.manager.removeAcknowledged(exact), {
    code: "desktop_credential_recovery_required"
  });

  assert.deepEqual(await current.manager.completeAfterAcknowledgement(exact), promoted);
  assert.deepEqual(await current.manager.completeAfterAcknowledgement(exact), promoted);
  const tombstone = await current.manager.inspectAcknowledged(exact);
  assert.equal(tombstone.phase, "acknowledged");
  assert.equal(tombstone.generation, 7);
  assert.equal(tombstone.authorizationSessionId, exact.authorizationSessionId);
  assert.equal(tombstone.activationAckRequestReference, exact.activationAckRequestReference);
  assert.equal(tombstone.activationAckRequestHash, exact.activationAckRequestHash);
  assert.equal(tombstone.acknowledgedAt, tombstone.updatedAt);
  assert.deepEqual(await current.manager.listPendingOperations(exact.executorId), []);
  assert.deepEqual(await current.manager.recoverExecutor(exact.executorId), []);

  const wrong = { ...exact, activationAckRequestHash: "f".repeat(64) };
  await assert.rejects(current.manager.completeAfterAcknowledgement(wrong), {
    code: "desktop_credential_recovery_required"
  });
  await assert.rejects(current.manager.inspectAcknowledged(wrong), {
    code: "desktop_credential_recovery_required"
  });
  await assert.rejects(current.manager.removeAcknowledged(wrong), {
    code: "desktop_credential_recovery_required"
  });
  const raw = await readFile(path.join(
    current.root,
    exact.executorId,
    "journals",
    `${exact.operationId}.sec`
  ));
  assert.equal(raw.includes(Buffer.from(tokenCanary)), false);
  assert.equal(raw.includes(Buffer.from(current.root)), false);

  await current.manager.removeAcknowledged(exact);
  assert.equal(await current.manager.inspectAcknowledged(exact), null);
  await current.manager.removeAcknowledged(exact);
  assert.deepEqual(await current.manager.completeAfterAcknowledgement(exact), promoted);
  assert.deepEqual(await current.manager.listPendingOperations(exact.executorId), []);
});

test("operation journal atomically recovers every write boundary and rejects the old envelope", async (t) => {
  for (const point of [
    "after_commit_fsync",
    "after_temporary_fsync",
    "after_rename",
    "before_directory_fsync"
  ]) {
    const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-operation-journal-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = path.join(base, "journal");
    let armed = true;
    const store = new DesktopCredentialOperationJournalStore({
      root,
      safeStorage: new FakeSafeStorage(),
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      faultInjector(actual) {
        if (armed && actual === point) {
          armed = false;
          throw new Error(`${base}/must-not-leak`);
        }
      }
    });
    await assert.rejects(store.create({
      executorId: "executor_atomic",
      operationId: `operation_${point}`,
      sourceKind: "operation",
      sourceId: "source_atomic",
      sourceOwnershipDigest: null,
      targetRevision: 1,
      expectedDigest: "a".repeat(64),
      createdAt: "2026-07-13T00:00:00.000Z",
      ackReplay: null
    }), (error) => {
      assert.equal(String(error.message).includes(base), false);
      return true;
    });
    const recovered = await new DesktopCredentialOperationJournalStore({
      root,
      safeStorage: new FakeSafeStorage(),
      now: () => new Date("2026-07-13T00:00:01.000Z")
    }).load(`operation_${point}`);
    assert.equal(recovered.phase, "prepared");
    assert.equal(recovered.generation, 1);
    assert.match(recovered.recordDigest, /^[0-9a-f]{64}$/);
  }

  const renameBase = await mkdtemp(path.join(os.tmpdir(), "aicrm-operation-rename-error-"));
  t.after(() => rm(renameBase, { recursive: true, force: true }));
  const renameRoot = path.join(renameBase, "journal");
  const renameStorage = new FakeSafeStorage();
  const renameFailure = new DesktopCredentialOperationJournalStore({
    root: renameRoot,
    safeStorage: renameStorage,
    renameFile() {
      throw new Error(`${renameBase}/${tokenCanary}`);
    }
  });
  await assert.rejects(renameFailure.create({
    executorId: "executor_rename_error",
    operationId: "operation_rename_error",
    sourceKind: "operation",
    sourceId: "source_rename_error",
    sourceOwnershipDigest: null,
    targetRevision: 1,
    expectedDigest: "0".repeat(64),
    createdAt: "2026-07-13T00:00:00.000Z",
    ackReplay: null
  }), (error) => {
    assert.equal(error.code, "desktop_credential_journal_corrupt");
    assert.equal(String(error.message).includes(renameBase), false);
    assert.equal(String(error.message).includes(tokenCanary), false);
    return true;
  });
  assert.equal((await new DesktopCredentialOperationJournalStore({
    root: renameRoot,
    safeStorage: renameStorage
  }).load("operation_rename_error")).phase, "prepared");

  const oldBase = await mkdtemp(path.join(os.tmpdir(), "aicrm-operation-journal-old-"));
  t.after(() => rm(oldBase, { recursive: true, force: true }));
  const oldRoot = path.join(oldBase, "journal");
  await mkdir(oldRoot, { recursive: true, mode: 0o700 });
  const storage = new FakeSafeStorage();
  const oldCiphertext = storage.encryptString(JSON.stringify({ version: 1 }));
  await writeFile(
    path.join(oldRoot, "operation_old.sec"),
    Buffer.concat([Buffer.from("AICRM-CREDENTIAL-OP-ENC-V1\n"), oldCiphertext]),
    { mode: 0o600 }
  );
  const oldStore = new DesktopCredentialOperationJournalStore({ root: oldRoot, safeStorage: storage });
  await assert.rejects(oldStore.load("operation_old"), (error) => {
    assert.equal(error.code, "desktop_credential_journal_corrupt");
    assert.equal(String(error.message).includes(oldBase), false);
    return true;
  });
});

test("journal rejects pre-existing non-private roots and fixes no permissions", async (t) => {
  if (process.platform === "win32") return;
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-operation-root-mode-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "journal");
  await mkdir(root, { mode: 0o755 });
  const store = new DesktopCredentialOperationJournalStore({
    root,
    safeStorage: new FakeSafeStorage()
  });
  await assert.rejects(store.listOperationIds(), {
    code: "desktop_credential_journal_unsafe"
  });
  assert.equal((await stat(root)).mode & 0o777, 0o755);
});

test("second directory-sync and ACK removal failures retain exact durable recovery evidence", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-operation-second-sync-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "journal");
  const storage = new FakeSafeStorage();
  const store = new DesktopCredentialOperationJournalStore({ root, safeStorage: storage });
  const prepared = await store.create({
    executorId: "executor_second_sync",
    operationId: "operation_second_sync",
    sourceKind: "operation",
    sourceId: "source_second_sync",
    sourceOwnershipDigest: null,
    targetRevision: 1,
    expectedDigest: "d".repeat(64),
    createdAt: "2026-07-13T00:00:00.000Z",
    ackReplay: null
  });
  const target = path.join(root, "operation_second_sync.sec");
  await writeFile(path.join(root, "operation_second_sync.sec.tmp"), await readFile(target), {
    mode: 0o600
  });
  let syncCount = 0;
  const failingCleanup = new DesktopCredentialOperationJournalStore({
    root,
    safeStorage: storage,
    directorySync() {
      syncCount += 1;
      if (syncCount === 2) throw new Error(`${base}/${tokenCanary}`);
      return Promise.resolve();
    }
  });
  await assert.rejects(failingCleanup.load("operation_second_sync"), (error) => {
    assert.equal(error.code, "desktop_credential_journal_corrupt");
    assert.equal(String(error.message).includes(base), false);
    assert.equal(String(error.message).includes(tokenCanary), false);
    return true;
  });
  assert.equal((await lstat(target)).isFile(), true);
  assert.equal((await lstat(path.join(root, "operation_second_sync.sec.commit-1"))).isFile(), true);
  assert.deepEqual(await store.load("operation_second_sync"), prepared);

  const removeBase = await mkdtemp(path.join(os.tmpdir(), "aicrm-operation-remove-sync-"));
  t.after(() => rm(removeBase, { recursive: true, force: true }));
  const removeRoot = path.join(removeBase, "journal");
  const removeStore = new DesktopCredentialOperationJournalStore({
    root: removeRoot,
    safeStorage: storage,
    now: () => new Date("2026-07-13T00:00:00.000Z")
  });
  let acknowledged = await removeStore.create({
    executorId: "executor_remove_sync",
    operationId: "operation_remove_sync",
    sourceKind: "operation",
    sourceId: "source_remove_sync",
    sourceOwnershipDigest: null,
    targetRevision: 1,
    expectedDigest: "e".repeat(64),
    createdAt: "2026-07-13T00:00:00.000Z",
    ackReplay: null
  });
  for (const phase of ["source_durable", "reserved", "renamed", "immutable", "verified"]) {
    acknowledged = await removeStore.transition(acknowledged, phase);
  }
  acknowledged = await removeStore.transition(acknowledged, "acknowledged", {
    authorizationSessionId: "authorization_session_remove_sync",
    activationAckRequestReference: "3".repeat(64),
    activationAckRequestHash: "4".repeat(64)
  });
  let removeSyncCount = 0;
  const failingRemove = new DesktopCredentialOperationJournalStore({
    root: removeRoot,
    safeStorage: storage,
    directorySync() {
      removeSyncCount += 1;
      if (removeSyncCount === 2) throw new Error(`${removeBase}/${tokenCanary}`);
      return Promise.resolve();
    }
  });
  await assert.rejects(failingRemove.removeAcknowledged(acknowledged), (error) => {
    assert.equal(error.code, "desktop_credential_journal_corrupt");
    assert.equal(String(error.message).includes(removeBase), false);
    assert.equal(String(error.message).includes(tokenCanary), false);
    return true;
  });
  assert.equal((await lstat(path.join(removeRoot, "operation_remove_sync.sec"))).isFile(), true);
  assert.equal((await lstat(path.join(removeRoot, "operation_remove_sync.sec.commit-8"))).isFile(), true);
  const removed = await removeStore.load("operation_remove_sync");
  assert.equal(removed.phase, "removed");
  assert.equal((await removeStore.removeAcknowledged(acknowledged)).recordDigest, removed.recordDigest);
  assert.deepEqual(await removeStore.listOperationIds(), []);
  assert.deepEqual(await removeStore.listPendingOperationIds(), []);
});

test("removed successors bind every ACK provenance field in direct CAS and recovery", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-operation-removed-provenance-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "journal");
  const storage = new FakeSafeStorage();
  const store = new DesktopCredentialOperationJournalStore({
    root,
    safeStorage: storage,
    now: () => new Date("2026-07-13T00:00:00.000Z")
  });
  const mutations = [
    ["authorizationSessionId", "authorization_session_removed_forged"],
    ["activationAckRequestReference", "a".repeat(64)],
    ["activationAckRequestHash", "b".repeat(64)],
    ["acknowledgedAt", "2026-07-13T00:00:01.000Z"]
  ];
  for (const [index, [field, forgedValue]] of mutations.entries()) {
    const operationId = `operation_removed_provenance_${index}`;
    let acknowledged = await store.create({
      executorId: "executor_removed_provenance",
      operationId,
      sourceKind: "operation",
      sourceId: `source_removed_provenance_${index}`,
      sourceOwnershipDigest: null,
      targetRevision: index + 1,
      expectedDigest: String(index + 1).repeat(64),
      createdAt: "2026-07-13T00:00:00.000Z",
      ackReplay: null
    });
    for (const phase of ["source_durable", "reserved", "renamed", "immutable", "verified"]) {
      acknowledged = await store.transition(acknowledged, phase);
    }
    acknowledged = await store.transition(acknowledged, "acknowledged", {
      authorizationSessionId: `authorization_session_removed_${index}`,
      activationAckRequestReference: "c".repeat(64),
      activationAckRequestHash: "d".repeat(64)
    });

    const forgedPredecessor = {
      ...acknowledged,
      [field]: forgedValue
    };
    if (field === "acknowledgedAt") {
      forgedPredecessor.updatedAt = forgedValue;
    }
    const signedForgedPredecessor = withOperationRecordDigest(forgedPredecessor);
    await assert.rejects(store.removeAcknowledged(signedForgedPredecessor), {
      code: "desktop_credential_journal_conflict"
    });
    assert.equal((await store.load(operationId)).recordDigest, acknowledged.recordDigest);

    const forgedRemoved = {
      ...acknowledged,
      generation: acknowledged.generation + 1,
      phase: "removed",
      updatedAt: "2026-07-13T00:00:02.000Z",
      [field]: forgedValue
    };
    await writeFile(
      path.join(root, `${operationId}.sec.commit-8`),
      operationJournalEnvelope(storage, forgedRemoved),
      { mode: 0o600 }
    );
    await assert.rejects(store.load(operationId), {
      code: "desktop_credential_journal_corrupt"
    });
  }
});

test("operation journal rejects phase skips, divergent temporaries, and generation gaps", async (t) => {
  const makePrepared = async (suffix) => {
    const base = await mkdtemp(path.join(os.tmpdir(), `aicrm-operation-cas-${suffix}-`));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = path.join(base, "journal");
    const storage = new FakeSafeStorage();
    const store = new DesktopCredentialOperationJournalStore({
      root,
      safeStorage: storage,
      now: () => new Date("2026-07-13T00:00:00.000Z")
    });
    const prepared = await store.create({
      executorId: "executor_cas",
      operationId: `operation_${suffix}`,
      sourceKind: "operation",
      sourceId: "source_cas",
      sourceOwnershipDigest: null,
      targetRevision: 1,
      expectedDigest: "b".repeat(64),
      createdAt: "2026-07-13T00:00:00.000Z",
      ackReplay: null
    });
    return { base, root, storage, store, prepared };
  };

  const skipped = await makePrepared("skip");
  await assert.rejects(skipped.store.transition(skipped.prepared, "reserved"), {
    code: "desktop_credential_journal_conflict"
  });
  const quarantined = await skipped.store.transition(skipped.prepared, "quarantined");
  await assert.rejects(skipped.store.transition(quarantined, "prepared"), {
    code: "desktop_credential_journal_conflict"
  });

  const terminalBranch = {
    ...quarantined,
    generation: quarantined.generation + 1,
    phase: "prepared",
    updatedAt: "2026-07-13T00:00:03.000Z",
    authorizationSessionId: null,
    activationAckRequestReference: null,
    activationAckRequestHash: null,
    acknowledgedAt: null
  };
  await writeFile(
    path.join(skipped.root, "operation_skip.sec.commit-3"),
    operationJournalEnvelope(skipped.storage, terminalBranch),
    { mode: 0o600 }
  );
  await assert.rejects(skipped.store.load("operation_skip"), {
    code: "desktop_credential_journal_corrupt"
  });

  const divergent = await makePrepared("divergent");
  let armed = true;
  const interrupted = new DesktopCredentialOperationJournalStore({
    root: divergent.root,
    safeStorage: divergent.storage,
    now: () => new Date("2026-07-13T00:00:01.000Z"),
    faultInjector(point) {
      if (armed && point === "after_commit_fsync") {
        armed = false;
        throw new Error("transition interrupted");
      }
    }
  });
  await assert.rejects(interrupted.transition(divergent.prepared, "source_durable"));
  const commit = await readFile(path.join(
    divergent.root,
    "operation_divergent.sec.commit-2"
  ));
  const committed = JSON.parse(divergent.storage.decryptString(
    commit.subarray(Buffer.byteLength("AICRM-CREDENTIAL-OP-ENC-V2\n"))
  ));
  const branch = {
    ...committed,
    updatedAt: "2026-07-13T00:00:02.000Z"
  };
  await writeFile(
    path.join(divergent.root, "operation_divergent.sec.tmp"),
    operationJournalEnvelope(divergent.storage, branch),
    { mode: 0o600 }
  );
  await assert.rejects(divergent.store.load("operation_divergent"), {
    code: "desktop_credential_journal_corrupt"
  });

  const gap = await makePrepared("gap");
  const generationGap = {
    ...gap.prepared,
    generation: 3,
    phase: "source_durable",
    updatedAt: "2026-07-13T00:00:02.000Z"
  };
  await writeFile(
    path.join(gap.root, "operation_gap.sec.commit-3"),
    operationJournalEnvelope(gap.storage, generationGap),
    { mode: 0o600 }
  );
  await assert.rejects(gap.store.load("operation_gap"), {
    code: "desktop_credential_journal_corrupt"
  });

  const transitionCrash = await makePrepared("transition_commit");
  let transitionArmed = true;
  const transitionWriter = new DesktopCredentialOperationJournalStore({
    root: transitionCrash.root,
    safeStorage: transitionCrash.storage,
    now: () => new Date("2026-07-13T00:00:01.000Z"),
    faultInjector(point) {
      if (transitionArmed && point === "after_commit_fsync") {
        transitionArmed = false;
        throw new Error("transition commit-only crash");
      }
    }
  });
  await assert.rejects(
    transitionWriter.transition(transitionCrash.prepared, "source_durable")
  );
  const transitionRecovery = new DesktopCredentialOperationJournalStore({
    root: transitionCrash.root,
    safeStorage: transitionCrash.storage,
    now: () => new Date("2026-07-13T00:00:02.000Z")
  });
  let recovered = await transitionRecovery.load("operation_transition_commit");
  assert.equal(recovered.phase, "source_durable");
  for (const phase of ["reserved", "renamed", "immutable", "verified"]) {
    recovered = await transitionRecovery.transition(recovered, phase);
  }
  let ackArmed = true;
  const ackWriter = new DesktopCredentialOperationJournalStore({
    root: transitionCrash.root,
    safeStorage: transitionCrash.storage,
    now: () => new Date("2026-07-13T00:00:03.000Z"),
    faultInjector(point) {
      if (ackArmed && point === "after_commit_fsync") {
        ackArmed = false;
        throw new Error("ACK commit-only crash");
      }
    }
  });
  await assert.rejects(ackWriter.transition(recovered, "acknowledged", {
    authorizationSessionId: "authorization_session_commit_only",
    activationAckRequestReference: "5".repeat(64),
    activationAckRequestHash: "6".repeat(64)
  }));
  assert.equal(
    (await transitionRecovery.load("operation_transition_commit")).phase,
    "acknowledged"
  );

  const missingClaim = await makePrepared("missing_claim");
  const claimlessNext = {
    ...missingClaim.prepared,
    generation: 2,
    phase: "source_durable",
    updatedAt: "2026-07-13T00:00:01.000Z"
  };
  await writeFile(
    path.join(missingClaim.root, "operation_missing_claim.sec.tmp"),
    operationJournalEnvelope(missingClaim.storage, claimlessNext),
    { mode: 0o600 }
  );
  await assert.rejects(missingClaim.store.load("operation_missing_claim"), {
    code: "desktop_credential_journal_corrupt"
  });

  const tmpOnlyBase = await mkdtemp(path.join(os.tmpdir(), "aicrm-operation-tmp-only-"));
  t.after(() => rm(tmpOnlyBase, { recursive: true, force: true }));
  const tmpOnlyRoot = path.join(tmpOnlyBase, "journal");
  await mkdir(tmpOnlyRoot, { mode: 0o700 });
  const tmpOnlyStorage = new FakeSafeStorage();
  await writeFile(
    path.join(tmpOnlyRoot, "operation_tmp_only.sec.tmp"),
    operationJournalEnvelope(tmpOnlyStorage, {
      ...missingClaim.prepared,
      operationId: "operation_tmp_only"
    }),
    { mode: 0o600 }
  );
  await assert.rejects(new DesktopCredentialOperationJournalStore({
    root: tmpOnlyRoot,
    safeStorage: tmpOnlyStorage
  }).load("operation_tmp_only"), {
    code: "desktop_credential_journal_corrupt"
  });
});

test("persistent generation claims serialize real-process ACK versus quarantine successors", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-operation-process-cas-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "journal");
  const storage = new FakeSafeStorage();
  const store = new DesktopCredentialOperationJournalStore({
    root,
    safeStorage: storage,
    now: () => new Date("2026-07-13T00:00:00.000Z")
  });
  const secondStore = new DesktopCredentialOperationJournalStore({
    root,
    safeStorage: storage,
    now: () => new Date("2026-07-13T00:00:00.000Z")
  });
  let dualStoreVerified = await store.create({
    executorId: "executor_process_cas",
    operationId: "operation_dual_store",
    sourceKind: "operation",
    sourceId: "source_dual_store",
    sourceOwnershipDigest: null,
    targetRevision: 2,
    expectedDigest: "7".repeat(64),
    createdAt: "2026-07-13T00:00:00.000Z",
    ackReplay: null
  });
  for (const phase of ["source_durable", "reserved", "renamed", "immutable", "verified"]) {
    dualStoreVerified = await store.transition(dualStoreVerified, phase);
  }
  const dualStoreStale = await secondStore.load("operation_dual_store");
  const dualResults = await Promise.allSettled([
    store.transition(dualStoreVerified, "acknowledged", {
      authorizationSessionId: "authorization_session_dual_store",
      activationAckRequestReference: "8".repeat(64),
      activationAckRequestHash: "9".repeat(64)
    }),
    secondStore.transition(dualStoreStale, "quarantined")
  ]);
  assert.equal(dualResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(dualResults.filter((result) => result.status === "rejected").length, 1);
  assert.equal(
    (await store.load("operation_dual_store")).phase,
    dualResults.find((result) => result.status === "fulfilled").value.phase
  );

  let verified = await store.create({
    executorId: "executor_process_cas",
    operationId: "operation_process_cas",
    sourceKind: "operation",
    sourceId: "source_process_cas",
    sourceOwnershipDigest: null,
    targetRevision: 1,
    expectedDigest: "c".repeat(64),
    createdAt: "2026-07-13T00:00:00.000Z",
    ackReplay: null
  });
  for (const phase of ["source_durable", "reserved", "renamed", "immutable", "verified"]) {
    verified = await store.transition(verified, phase);
  }

  const readyAck = path.join(base, "ready-ack");
  const readyQuarantine = path.join(base, "ready-quarantine");
  const go = path.join(base, "go");
  const ack = runJournalContender(root, "ack", readyAck, go);
  const quarantine = runJournalContender(root, "quarantine", readyQuarantine, go);
  await Promise.all([waitForPath(readyAck), waitForPath(readyQuarantine)]);
  await writeFile(go, "go");
  const results = await Promise.all([ack, quarantine]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  const winner = results.find((result) => result.ok);
  const current = await store.load("operation_process_cas");
  assert.equal(current.phase, winner.phase);
  assert.equal(current.recordDigest, winner.digest);
  assert.equal(["acknowledged", "quarantined"].includes(current.phase), true);
  const losingPhase = current.phase === "acknowledged" ? "quarantined" : "acknowledged";
  await assert.rejects(
    losingPhase === "acknowledged"
      ? store.transition(verified, losingPhase, {
          authorizationSessionId: "authorization_session_process_cas",
          activationAckRequestReference: "1".repeat(64),
          activationAckRequestHash: "2".repeat(64)
        })
      : store.transition(verified, losingPhase),
    { code: "desktop_credential_journal_conflict" }
  );
  const afterRetry = await store.load("operation_process_cas");
  assert.equal(afterRetry.recordDigest, current.recordDigest);
  const generationSevenClaim = await readFile(path.join(
    root,
    "operation_process_cas.sec.commit-7"
  ));
  assert.equal(generationSevenClaim.includes(Buffer.from(base)), false);
});

test("promotion recovery rejects a forged staging owner fence without leaking nonce or path", async (t) => {
  let armed = true;
  const current = await managerFixture({
    faultInjector(point) {
      if (armed && point === "after_journal_prepared") {
        armed = false;
        throw new Error("promotion interrupted");
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(
    current.manager,
    "executor_owner_forge",
    "session_owner_forge"
  );
  await assert.rejects(current.manager.promoteStaging({
    executorId: "executor_owner_forge",
    sessionId: "session_owner_forge",
    operationId: "operation_owner_forge",
    revision: 1,
    expectedDigest: staging.digest.digest
  }));
  const forgedNonce = "f".repeat(64);
  const forged = current.storage.encryptString(JSON.stringify({
    version: 1,
    kind: "staging",
    executorId: "executor_owner_forge",
    sessionId: "session_owner_forge",
    nonce: forgedNonce
  }));
  await writeFile(
    path.join(current.root, "executor_owner_forge", "staging", "session_owner_forge", "owner.fence"),
    Buffer.concat([Buffer.from("AICRM-CREDENTIAL-OWNER-FENCE-V1\n"), forged]),
    { mode: 0o600 }
  );
  await assert.rejects(
    current.manager.recoverOperation("executor_owner_forge", "operation_owner_forge"),
    (error) => {
      assert.equal(error.code, "desktop_credential_recovery_required");
      assert.equal(String(error.message).includes(forgedNonce), false);
      assert.equal(String(error.message).includes(current.root), false);
      return true;
    }
  );
});

test("exact staging creation is idempotent and recovers a crash after mkdir", async (t) => {
  let armed = true;
  const current = await managerFixture({
    faultInjector(point) {
      if (armed && point === "after_staging_mkdir") {
        armed = false;
        throw new Error(`${current.root}/private-staging-path`);
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));

  await assert.rejects(
    current.manager.createOrRecoverStaging("executor_exact", "session_exact"),
    (error) => {
      assert.equal(error.code, "desktop_credential_recovery_required");
      assert.equal(String(error.message).includes(current.root), false);
      return true;
    }
  );

  const restarted = new DesktopCredentialTreeManager({
    root: current.root,
    safeStorage: current.storage,
    now: () => new Date("2026-07-13T00:00:01.000Z")
  });
  await restarted.initialize();
  const recovered = await restarted.createOrRecoverStaging(
    "executor_exact",
    "session_exact"
  );
  assert.deepEqual(recovered, {
    ref: {
      kind: "staging",
      executorId: "executor_exact",
      sessionId: "session_exact"
    },
    recovered: true,
    ownershipDigest: recovered.ownershipDigest
  });
  assert.match(recovered.ownershipDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    await restarted.createOrRecoverStaging("executor_exact", "session_exact"),
    recovered
  );
  assert.equal(JSON.stringify(recovered).includes(current.root), false);
});

test("exact staging recovery rejects quarantine ambiguity and unsafe existing trees", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));

  const created = await current.manager.createOrRecoverStaging(
    "executor_private",
    "session_private"
  );
  assert.equal(created.recovered, false);
  const staging = current.manager.mainOnlyResolvePath(created.ref);
  if (process.platform !== "win32") {
    await chmod(staging, 0o755);
    await assert.rejects(
      current.manager.createOrRecoverStaging("executor_private", "session_private"),
      { code: "desktop_credential_tree_unsafe" }
    );
    await chmod(staging, 0o700);
    const ownerFence = path.join(path.dirname(staging), "owner.fence");
    await chmod(ownerFence, 0o644);
    await assert.rejects(
      current.manager.createOrRecoverStaging("executor_private", "session_private"),
      { code: "desktop_credential_tree_unsafe" }
    );
    await chmod(ownerFence, 0o600);
    const ownerFenceAlias = path.join(current.base, "owner-fence-alias");
    await link(ownerFence, ownerFenceAlias);
    await assert.rejects(
      current.manager.createOrRecoverStaging("executor_private", "session_private"),
      { code: "desktop_credential_tree_unsafe" }
    );
    await removePath(ownerFenceAlias);
  }

  await writeTreeFile(staging, "auth.json", "secret");
  if (process.platform !== "win32") {
    await link(path.join(staging, "auth.json"), path.join(staging, "alias.json"));
    await assert.rejects(
      current.manager.createOrRecoverStaging("executor_private", "session_private"),
      { code: "desktop_credential_tree_unsafe" }
    );
    await removePath(path.join(staging, "alias.json"));
  }

  const quarantineReservation = path.join(
    current.root,
    "executor_private",
    "quarantine",
    "staging",
    "session_private"
  );
  await mkdir(quarantineReservation, { recursive: true, mode: 0o700 });
  await assert.rejects(
    current.manager.createOrRecoverStaging("executor_private", "session_private"),
    { code: "desktop_credential_recovery_required" }
  );

  if (process.platform !== "win32") {
    const linked = await managerFixture();
    t.after(() => rm(linked.base, { recursive: true, force: true }));
    const stagingParent = path.join(linked.root, "executor_link", "staging");
    const outside = path.join(linked.base, "outside-staging");
    await mkdir(stagingParent, { recursive: true, mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, path.join(stagingParent, "session_link"));
    await assert.rejects(
      linked.manager.createOrRecoverStaging("executor_link", "session_link"),
      { code: "desktop_credential_tree_unsafe" }
    );
  }
});

test("exact staging quarantine is durable and returns one stable safe projection", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(
    current.manager,
    "executor_cleanup",
    "session_cleanup",
    "candidate"
  );
  const expected = await digestDesktopCredentialTree(staging.target);
  const first = await current.manager.quarantineStaging(
    "executor_cleanup",
    "session_cleanup"
  );
  assert.deepEqual(first, {
    ref: {
      kind: "quarantine",
      executorId: "executor_cleanup",
      sourceKind: "staging",
      sourceId: "session_cleanup"
    },
    digestAlgorithm: DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM,
    digest: expected.digest,
    fileCount: expected.fileCount,
    totalBytes: expected.totalBytes
  });
  await assert.rejects(lstat(staging.target), { code: "ENOENT" });
  const quarantined = current.manager.mainOnlyResolvePath(first.ref);
  assert.equal(await readFile(path.join(quarantined, "auth.json"), "utf8"), "candidate");
  if (process.platform !== "win32") {
    const payload = path.dirname(quarantined);
    const reservation = path.dirname(payload);
    assert.equal((await stat(reservation)).mode & 0o777, 0o500);
    assert.equal((await stat(path.join(reservation, "owner.fence"))).mode & 0o777, 0o400);
    assert.equal((await stat(payload)).mode & 0o777, 0o500);
    assert.equal((await stat(path.join(payload, "owner.fence"))).mode & 0o777, 0o400);
    assert.equal((await stat(quarantined)).mode & 0o777, 0o500);
    assert.equal((await stat(path.join(quarantined, "auth.json"))).mode & 0o777, 0o400);
  }
  assert.deepEqual(
    await current.manager.quarantineStaging("executor_cleanup", "session_cleanup"),
    first
  );
  assert.equal(JSON.stringify(first).includes(current.root), false);
});

for (const faultPoint of ["after_quarantine_reservation", "after_quarantine_rename"]) {
  test(`exact staging quarantine recovers crash point ${faultPoint}`, async (t) => {
    let armed = false;
    const current = await managerFixture({
      faultInjector(point) {
        if (armed && point === faultPoint) {
          armed = false;
          throw new Error(`${current.root}/private-quarantine-path`);
        }
      }
    });
    t.after(() => rm(current.base, { recursive: true, force: true }));
    const staging = await seedStaging(
      current.manager,
      "executor_crash_cleanup",
      "session_crash_cleanup",
      faultPoint
    );
    armed = true;
    await assert.rejects(
      current.manager.quarantineStaging(
        "executor_crash_cleanup",
        "session_crash_cleanup"
      ),
      (error) => {
        assert.equal(error.code, "desktop_credential_recovery_required");
        assert.equal(String(error.message).includes(current.root), false);
        return true;
      }
    );

    const restarted = new DesktopCredentialTreeManager({
      root: current.root,
      safeStorage: current.storage,
      now: () => new Date("2026-07-13T00:00:01.000Z")
    });
    await restarted.initialize();
    const recovered = await restarted.quarantineStaging(
      "executor_crash_cleanup",
      "session_crash_cleanup"
    );
    assert.equal(recovered.digest, staging.digest.digest);
    assert.deepEqual(
      await restarted.quarantineStaging(
        "executor_crash_cleanup",
        "session_crash_cleanup"
      ),
      recovered
    );
  });
}

test("exact staging quarantine rejects missing, dual and unknown filesystem shapes", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));

  await assert.rejects(
    current.manager.quarantineStaging("executor_missing", "session_missing"),
    { code: "desktop_credential_recovery_required" }
  );

  const dual = await seedStaging(
    current.manager,
    "executor_dual",
    "session_dual",
    "source"
  );
  const dualReservation = path.join(
    current.root,
    "executor_dual",
    "quarantine",
    "staging",
    "session_dual"
  );
  await mkdir(path.join(dualReservation, "payload"), {
    recursive: true,
    mode: 0o700
  });
  await writeTreeFile(path.join(dualReservation, "payload"), "auth.json", "target");
  await assert.rejects(
    current.manager.quarantineStaging("executor_dual", "session_dual"),
    { code: "desktop_credential_recovery_required" }
  );
  assert.equal((await lstat(dual.target)).isDirectory(), true);

  const unknown = await seedStaging(
    current.manager,
    "executor_unknown",
    "session_unknown",
    "source"
  );
  const unknownReservation = path.join(
    current.root,
    "executor_unknown",
    "quarantine",
    "staging",
    "session_unknown"
  );
  await mkdir(unknownReservation, { recursive: true, mode: 0o700 });
  await writeFile(path.join(unknownReservation, "unexpected"), "foreign", {
    mode: 0o600
  });
  await assert.rejects(
    current.manager.quarantineStaging("executor_unknown", "session_unknown"),
    { code: "desktop_credential_recovery_required" }
  );
  assert.equal((await lstat(unknown.target)).isDirectory(), true);

  if (process.platform !== "win32") {
    const unsafe = await seedStaging(
      current.manager,
      "executor_unsafe_cleanup",
      "session_unsafe_cleanup",
      "unsafe"
    );
    await chmod(unsafe.target, 0o755);
    await assert.rejects(
      current.manager.quarantineStaging(
        "executor_unsafe_cleanup",
        "session_unsafe_cleanup"
      ),
      { code: "desktop_credential_tree_unsafe" }
    );

    const badTarget = await seedStaging(
      current.manager,
      "executor_bad_target_mode",
      "session_bad_target_mode",
      "bad-target"
    );
    const quarantined = await current.manager.quarantineStaging(
      "executor_bad_target_mode",
      "session_bad_target_mode"
    );
    const payload = current.manager.mainOnlyResolvePath(quarantined.ref);
    await chmod(path.dirname(payload), 0o755);
    await assert.rejects(
      current.manager.quarantineStaging(
        "executor_bad_target_mode",
        "session_bad_target_mode"
      ),
      { code: "desktop_credential_tree_unsafe" }
    );
    assert.equal(badTarget.digest.digest, quarantined.digest);
  }
});

test("startup staging quarantine proves a wholly absent create window as a no-op", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  assert.equal(
    await current.manager.quarantineStagingIfPresent(
      "executor_not_created",
      "session_not_created"
    ),
    null
  );
  await seedStaging(
    current.manager,
    "executor_created",
    "session_created",
    "candidate"
  );
  const quarantined = await current.manager.quarantineStagingIfPresent(
    "executor_created",
    "session_created"
  );
  assert.equal(quarantined.ref.sourceId, "session_created");
  assert.deepEqual(
    await current.manager.quarantineStagingIfPresent(
      "executor_created",
      "session_created"
    ),
    quarantined
  );
});

test("exact staging quarantine rejects symlink and hardlink payloads", async (t) => {
  if (process.platform === "win32") return;
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));

  const linked = await seedStaging(
    current.manager,
    "executor_link_cleanup",
    "session_link_cleanup",
    "secret"
  );
  await link(path.join(linked.target, "auth.json"), path.join(linked.target, "alias.json"));
  await assert.rejects(
    current.manager.quarantineStaging(
      "executor_link_cleanup",
      "session_link_cleanup"
    ),
    { code: "desktop_credential_tree_unsafe" }
  );

  const symbolic = await seedStaging(
    current.manager,
    "executor_symlink_cleanup",
    "session_symlink_cleanup",
    "secret"
  );
  await symlink(
    path.join(symbolic.target, "auth.json"),
    path.join(symbolic.target, "alias.json")
  );
  await assert.rejects(
    current.manager.quarantineStaging(
      "executor_symlink_cleanup",
      "session_symlink_cleanup"
    ),
    { code: "desktop_credential_tree_unsafe" }
  );
});

test("exact staging recovery never adopts a pre-existing reservation without an authenticated owner", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const foreign = path.join(
    current.root,
    "executor_foreign_staging",
    "staging",
    "session_foreign_staging"
  );
  const home = path.join(foreign, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeTreeFile(home, "auth.json", "foreign-staging");
  await writeFile(
    path.join(foreign, "owner.fence"),
    JSON.stringify({
      version: 1,
      kind: "staging",
      executorId: "executor_foreign_staging",
      sessionId: "session_foreign_staging",
      nonce: "a".repeat(64)
    }),
    { mode: 0o600 }
  );
  await assert.rejects(
    current.manager.createOrRecoverStaging(
      "executor_foreign_staging",
      "session_foreign_staging"
    ),
    { code: "desktop_credential_recovery_required" }
  );
  assert.equal(await readFile(path.join(home, "auth.json"), "utf8"), "foreign-staging");
});

test("exact staging quarantine never adopts a foreign valid-looking payload with unauthenticated fences", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const reservation = path.join(
    current.root,
    "executor_foreign_quarantine",
    "quarantine",
    "staging",
    "session_foreign_quarantine"
  );
  const home = path.join(reservation, "payload", "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeTreeFile(home, "auth.json", "foreign-quarantine");
  const digest = await digestDesktopCredentialTree(home);
  await writeFile(
    path.join(reservation, "payload", "owner.fence"),
    JSON.stringify({
      version: 1,
      kind: "staging",
      executorId: "executor_foreign_quarantine",
      sessionId: "session_foreign_quarantine",
      nonce: "a".repeat(64)
    }),
    { mode: 0o600 }
  );
  await writeFile(
    path.join(reservation, "owner.fence"),
    JSON.stringify({
      version: 1,
      kind: "staging_quarantine",
      executorId: "executor_foreign_quarantine",
      sessionId: "session_foreign_quarantine",
      sourceNonce: "a".repeat(64),
      expectedDigest: digest.digest
    }),
    { mode: 0o600 }
  );
  await assert.rejects(
    current.manager.quarantineStaging(
      "executor_foreign_quarantine",
      "session_foreign_quarantine"
    ),
    { code: "desktop_credential_recovery_required" }
  );
  assert.equal(
    await readFile(path.join(home, "auth.json"), "utf8"),
    "foreign-quarantine"
  );
});

test("completed staging quarantine is immutable and rejects post-success digest drift", async (t) => {
  if (process.platform === "win32") return;
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await seedStaging(
    current.manager,
    "executor_immutable_cleanup",
    "session_immutable_cleanup",
    "immutable"
  );
  const first = await current.manager.quarantineStaging(
    "executor_immutable_cleanup",
    "session_immutable_cleanup"
  );
  const home = current.manager.mainOnlyResolvePath(first.ref);
  const credential = path.join(home, "auth.json");
  let privilegedWriteSucceeded = false;
  try {
    await writeFile(credential, "changed");
    privilegedWriteSucceeded = true;
  } catch (error) {
    assert.equal(["EACCES", "EPERM"].includes(error?.code), true);
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    assert.equal(
      privilegedWriteSucceeded,
      false,
      "a non-root POSIX process must not write the sealed credential directly"
    );
  }
  if (!privilegedWriteSucceeded) {
    await chmod(credential, 0o600);
    await writeFile(credential, "changed");
  }
  await assert.rejects(
    current.manager.quarantineStaging(
      "executor_immutable_cleanup",
      "session_immutable_cleanup"
    ),
    { code: "desktop_credential_digest_mismatch" }
  );
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

test("rejected activation quarantines the exact verified promotion idempotently", async (t) => {
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_reject", "session_reject", "candidate");
  const promoted = await current.manager.promoteStaging({
    executorId: "executor_reject",
    sessionId: "session_reject",
    operationId: "promotion_reject",
    revision: 2,
    expectedDigest: staging.digest.digest
  });
  const input = {
    executorId: promoted.executorId,
    operationId: promoted.operationId,
    revision: promoted.revision,
    expectedDigest: promoted.digest
  };
  const first = await current.manager.quarantinePromotion(input);
  assert.deepEqual(first, {
    executorId: "executor_reject",
    operationId: "promotion_reject",
    revision: 2,
    digestAlgorithm: DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM,
    quarantineDigest: staging.digest.digest,
    fileCount: staging.digest.fileCount,
    totalBytes: staging.digest.totalBytes
  });
  assert.deepEqual(await current.manager.quarantinePromotion(input), first);
  assert.equal((await current.manager.listPendingOperations("executor_reject"))[0].phase, "quarantined");
  await assert.rejects(current.manager.completeAfterAcknowledgement({
    ...input,
    ...acknowledgementProvenance
  }), {
    code: "desktop_credential_recovery_required"
  });
  const quarantined = current.manager.mainOnlyResolvePath({
    kind: "quarantine",
    executorId: "executor_reject",
    sourceKind: "revision",
    sourceId: "2"
  });
  assert.equal((await digestDesktopCredentialTree(quarantined)).digest, staging.digest.digest);
  await assert.rejects(
    current.manager.quarantinePromotion({ ...input, expectedDigest: "0".repeat(64) }),
    { code: "desktop_credential_recovery_required" }
  );
  const straySourceContainer = path.join(
    current.root,
    "executor_reject",
    "revisions",
    "2"
  );
  await mkdir(straySourceContainer, { mode: 0o700 });
  await assert.rejects(current.manager.quarantinePromotion(input), {
    code: "desktop_credential_recovery_required"
  });
});

test("promotion quarantine rejects unknown revision-container entries before terminalizing", async (t) => {
  if (process.platform === "win32") return;
  const current = await managerFixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_shape", "session_shape", "candidate");
  const promoted = await current.manager.promoteStaging({
    executorId: "executor_shape",
    sessionId: "session_shape",
    operationId: "promotion_shape",
    revision: 4,
    expectedDigest: staging.digest.digest
  });
  const revision = current.manager.mainOnlyResolvePath({
    kind: "revision",
    executorId: "executor_shape",
    revision: 4
  });
  const container = path.dirname(revision);
  await chmod(container, 0o700);
  await writeFile(path.join(container, "unexpected"), "not-owned", { mode: 0o400 });
  await chmod(container, 0o500);
  await assert.rejects(
    current.manager.quarantinePromotion({
      executorId: promoted.executorId,
      operationId: promoted.operationId,
      revision: promoted.revision,
      expectedDigest: promoted.digest
    }),
    { code: "desktop_credential_tree_unsafe" }
  );
  assert.equal((await current.manager.listPendingOperations("executor_shape"))[0].phase, "verified");
  assert.equal((await lstat(revision)).isDirectory(), true);
});

for (const faultPoint of [
  "after_quarantine_journal",
  "after_quarantine_reservation",
  "after_quarantine_rename"
]) {
  test(`promotion quarantine recovers crash point ${faultPoint}`, async (t) => {
    let armed = false;
    const current = await managerFixture({
      faultInjector(point) {
        if (armed && point === faultPoint) {
          armed = false;
          throw new Error("simulated quarantine crash");
        }
      }
    });
    t.after(() => rm(current.base, { recursive: true, force: true }));
    const staging = await seedStaging(current.manager, "executor_recover", "session_recover", faultPoint);
    const promoted = await current.manager.promoteStaging({
      executorId: "executor_recover",
      sessionId: "session_recover",
      operationId: "promotion_recover",
      revision: 3,
      expectedDigest: staging.digest.digest
    });
    const input = {
      executorId: promoted.executorId,
      operationId: promoted.operationId,
      revision: promoted.revision,
      expectedDigest: promoted.digest
    };
    armed = true;
    await assert.rejects(current.manager.quarantinePromotion(input), (error) => {
      assert.equal(error.code, "desktop_credential_recovery_required");
      assert.equal(String(error.message).includes(current.root), false);
      return true;
    });
    assert.equal((await current.manager.listPendingOperations("executor_recover"))[0].phase, "quarantined");
    if (process.platform !== "win32" && faultPoint === "after_quarantine_reservation") {
      await chmod(
        path.join(current.root, "executor_recover", "revisions", "3"),
        0o700
      );
    }
    if (process.platform !== "win32" && faultPoint === "after_quarantine_rename") {
      await chmod(
        path.join(
          current.root,
          "executor_recover",
          "quarantine",
          "revisions",
          "3",
          "payload"
        ),
        0o700
      );
    }

    const restarted = new DesktopCredentialTreeManager({
      root: current.root,
      safeStorage: current.storage,
      now: () => new Date("2026-07-13T00:00:01.000Z")
    });
    await restarted.initialize();
    const recovered = await restarted.quarantinePromotion(input);
    assert.equal(recovered.quarantineDigest, staging.digest.digest);
    assert.deepEqual(await restarted.quarantinePromotion(input), recovered);
  });
}

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
    "sourceOwnershipDigest",
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
        expectedDigest: "0".repeat(64),
        ...acknowledgementProvenance
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

test("Windows protection helper uses execFile stdin and literal environment input without secret inheritance", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-windows-protection-runner-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const shim = path.join(base, "powershell-shim");
  await writeFile(
    shim,
    [
      `#!${process.execPath}`,
      'import fs from "node:fs";',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  fs.writeFileSync(`${process.argv[1]}.capture`, JSON.stringify({',
      '    args: process.argv.slice(2),',
      '    action: process.env.AICRM_CREDENTIAL_ACTION,',
      '    target: process.env.AICRM_CREDENTIAL_TARGET,',
      '    leak: process.env.AICRM_TEST_SECRET,',
      '    path: process.env.PATH ?? process.env.Path,',
      '    psModulePath: process.env.PSModulePath,',
      '    pathExt: process.env.PATHEXT,',
      '    input',
      '  }));',
      '  process.stdout.write("OK");',
      '});',
      ''
    ].join("\n"),
    { mode: 0o700 }
  );
  const target = path.join(base, "literal ; $(must-not-run) [credential]");
  const previous = process.env.AICRM_TEST_SECRET;
  process.env.AICRM_TEST_SECRET = tokenCanary;
  try {
    const protection = new PowerShellDesktopWindowsCredentialProtection(shim);
    await protection.ensurePrivateDirectory(target);
  } finally {
    if (previous === undefined) delete process.env.AICRM_TEST_SECRET;
    else process.env.AICRM_TEST_SECRET = previous;
  }
  const capture = JSON.parse(await readFile(`${shim}.capture`, "utf8"));
  assert.equal(capture.args.join("\n").includes(target), false);
  assert.equal(capture.args.join("\n").includes(tokenCanary), false);
  assert.equal(capture.target, target);
  assert.equal(capture.action, "ensure_private_directory");
  assert.equal(capture.leak, undefined);
  assert.equal(capture.path, undefined);
  assert.equal(capture.psModulePath, undefined);
  assert.equal(capture.pathExt, undefined);
  assert.equal(capture.input.includes("Get-Item -LiteralPath $Target -Force"), true);
});

test("simulated Windows promotion uses native ACL sealing and explicit durable flushes", async (t) => {
  const protection = new FakeWindowsCredentialProtection();
  const current = await managerFixture({
    platform: "win32",
    windowsProtection: protection
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_1", "windows");
  const projection = await current.manager.promoteStaging({
    executorId: "executor_1",
    sessionId: "session_1",
    operationId: "promote_1",
    revision: 1,
    expectedDigest: staging.digest.digest
  });
  const revision = current.manager.mainOnlyResolvePath({
    kind: "revision",
    executorId: "executor_1",
    revision: 1
  });
  const container = path.dirname(revision);
  assert.deepEqual(protection.sealedTrees, [container]);
  assert.equal(protection.validatedTrees.includes(container), true);
  assert.equal(protection.syncedFiles.some((file) => file.endsWith(`${path.sep}auth.json`)), true);
  assert.equal(protection.syncedDirectories.includes(path.dirname(container)), true);
  assert.equal((await current.manager.listPendingOperations("executor_1"))[0].phase, "verified");
  await acknowledge(current.manager, projection);
});

test("simulated Windows ACL drift blocks COW before creating an operation tree", async (t) => {
  const protection = new FakeWindowsCredentialProtection();
  const current = await managerFixture({
    platform: "win32",
    windowsProtection: protection
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_1", "windows");
  const projection = await current.manager.promoteStaging({
    executorId: "executor_1",
    sessionId: "session_1",
    operationId: "promote_1",
    revision: 1,
    expectedDigest: staging.digest.digest
  });
  await acknowledge(current.manager, projection);
  const revision = current.manager.mainOnlyResolvePath({
    kind: "revision",
    executorId: "executor_1",
    revision: 1
  });
  protection.drift(path.dirname(revision));
  await assert.rejects(current.manager.cloneRevision("executor_1", 1, "rotate_1"), {
    code: "desktop_credential_tree_unsafe"
  });
  await assert.rejects(
    lstat(current.manager.mainOnlyResolvePath({
      kind: "operation",
      executorId: "executor_1",
      operationId: "rotate_1"
    })),
    { code: "ENOENT" }
  );
});

test("simulated Windows seal failure never advances the journal to immutable", async (t) => {
  const protection = new FakeWindowsCredentialProtection();
  const current = await managerFixture({
    platform: "win32",
    windowsProtection: protection
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_1", "windows");
  protection.failSeal = true;
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
  const pending = await current.manager.listPendingOperations("executor_1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].phase, "renamed");
  assert.equal(protection.protectedRoots.size, 0);
});

test("simulated Windows durable immutable receipt recovers without weakening or resealing", async (t) => {
  const protection = new FakeWindowsCredentialProtection();
  let crashed = false;
  const current = await managerFixture({
    platform: "win32",
    windowsProtection: protection,
    faultInjector(point) {
      if (!crashed && point === "after_readonly") {
        crashed = true;
        throw new Error("crash after durable Windows seal receipt");
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_1", "windows");
  await assert.rejects(
    current.manager.promoteStaging({
      executorId: "executor_1",
      sessionId: "session_1",
      operationId: "promote_1",
      revision: 1,
      expectedDigest: staging.digest.digest
    }),
    /crash after durable Windows seal receipt/
  );
  assert.equal((await current.manager.listPendingOperations("executor_1"))[0].phase, "immutable");
  const restarted = new DesktopCredentialTreeManager({
    root: current.root,
    safeStorage: current.storage,
    platform: "win32",
    windowsProtection: protection
  });
  const recovered = await restarted.recoverOperation("executor_1", "promote_1");
  assert.equal(recovered.digest, staging.digest.digest);
  assert.equal(protection.sealedTrees.length, 1);
  await acknowledge(restarted, recovered);
});

test("simulated Windows parent flush failure after sealing remains fail closed and unverified", async (t) => {
  const protection = new FakeWindowsCredentialProtection();
  const current = await managerFixture({
    platform: "win32",
    windowsProtection: protection
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_1", "windows");
  protection.failDirectorySyncWhen = (directory) =>
    protection.sealedTrees.length === 1 && directory.endsWith(`${path.sep}revisions`);
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
  assert.equal((await current.manager.listPendingOperations("executor_1"))[0].phase, "renamed");
  await assert.rejects(current.manager.recoverOperation("executor_1", "promote_1"), {
    code: "desktop_credential_durability_failed"
  });
  assert.equal((await current.manager.listPendingOperations("executor_1"))[0].phase, "renamed");
});

test("simulated Windows directory flush failure is not treated as success", async (t) => {
  const protection = new FakeWindowsCredentialProtection();
  const current = await managerFixture({
    platform: "win32",
    windowsProtection: protection
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_1", "windows");
  protection.failNextDirectorySync = true;
  await assert.rejects(
    current.manager.promoteStaging({
      executorId: "executor_1",
      sessionId: "session_1",
      operationId: "promote_1",
      revision: 1,
      expectedDigest: staging.digest.digest
    }),
    { code: "desktop_credential_journal_corrupt" }
  );
  assert.equal(protection.syncedDirectories.length > 0, true);
  assert.equal((await current.manager.listPendingOperations("executor_1"))[0].phase, "prepared");
});

test("simulated Windows revision quarantine verifies the sealed payload and seals its reservation", async (t) => {
  const protection = new FakeWindowsCredentialProtection();
  const current = await managerFixture({
    platform: "win32",
    windowsProtection: protection
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_1", "session_1", "windows");
  const projection = await current.manager.promoteStaging({
    executorId: "executor_1",
    sessionId: "session_1",
    operationId: "promote_1",
    revision: 1,
    expectedDigest: staging.digest.digest
  });
  await acknowledge(current.manager, projection);
  const ref = { kind: "revision", executorId: "executor_1", revision: 1 };
  const source = path.dirname(current.manager.mainOnlyResolvePath(ref));
  const quarantinedRef = await current.manager.quarantine(ref);
  const quarantined = current.manager.mainOnlyResolvePath(quarantinedRef);
  assert.deepEqual(protection.preparedMoves, [source]);
  assert.deepEqual(protection.sealedQuarantines, [{
    reservation: path.dirname(path.dirname(quarantined)),
    payload: path.dirname(quarantined)
  }]);
  assert.equal((await digestDesktopCredentialTree(quarantined)).digest, staging.digest.digest);
});

test("simulated Windows promotion quarantine recovers rename crash and never reseals an outer reservation", async (t) => {
  let armed = false;
  const protection = new FakeWindowsCredentialProtection();
  const current = await managerFixture({
    platform: "win32",
    windowsProtection: protection,
    faultInjector(point) {
      if (armed && point === "after_quarantine_rename") {
        armed = false;
        throw new Error(`${current.root}/sensitive-vault-path`);
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const staging = await seedStaging(current.manager, "executor_win_recover", "session_win_recover", "windows");
  const promoted = await current.manager.promoteStaging({
    executorId: "executor_win_recover",
    sessionId: "session_win_recover",
    operationId: "promotion_win_recover",
    revision: 5,
    expectedDigest: staging.digest.digest
  });
  const input = {
    executorId: promoted.executorId,
    operationId: promoted.operationId,
    revision: promoted.revision,
    expectedDigest: promoted.digest
  };
  const source = path.dirname(current.manager.mainOnlyResolvePath({
    kind: "revision",
    executorId: "executor_win_recover",
    revision: 5
  }));
  armed = true;
  await assert.rejects(current.manager.quarantinePromotion(input), (error) => {
    assert.equal(error.code, "desktop_credential_recovery_required");
    assert.equal(String(error.message).includes(current.root), false);
    return true;
  });
  const quarantined = current.manager.mainOnlyResolvePath({
    kind: "quarantine",
    executorId: "executor_win_recover",
    sourceKind: "revision",
    sourceId: "5"
  });
  const payload = path.dirname(quarantined);
  const reservation = path.dirname(payload);
  await assert.rejects(lstat(source), { code: "ENOENT" });
  assert.equal((await lstat(quarantined)).isDirectory(), true);
  assert.equal(protection.protectedRoots.has(source), true);
  assert.equal(protection.protectedRoots.has(reservation), false);

  const restarted = new DesktopCredentialTreeManager({
    root: current.root,
    safeStorage: current.storage,
    now: () => new Date("2026-07-13T00:00:01.000Z"),
    platform: "win32",
    windowsProtection: protection
  });
  await restarted.initialize();
  const recovered = await restarted.quarantinePromotion(input);
  assert.equal(recovered.quarantineDigest, staging.digest.digest);
  assert.equal(protection.sealedQuarantines.length, 1);
  assert.deepEqual(await restarted.quarantinePromotion(input), recovered);
  assert.equal(protection.sealedQuarantines.length, 1);
});

test("simulated Windows exact staging recovery and quarantine are idempotently protected", async (t) => {
  let armed = false;
  const protection = new FakeWindowsCredentialProtection();
  const current = await managerFixture({
    platform: "win32",
    windowsProtection: protection,
    faultInjector(point) {
      if (armed && point === "after_quarantine_rename") {
        armed = false;
        throw new Error(`${current.root}/private-windows-staging`);
      }
    }
  });
  t.after(() => rm(current.base, { recursive: true, force: true }));

  const created = await current.manager.createOrRecoverStaging(
    "executor_win_staging",
    "session_win_staging"
  );
  assert.equal(created.recovered, false);
  const recoveredCreation = await current.manager.createOrRecoverStaging(
    "executor_win_staging",
    "session_win_staging"
  );
  assert.equal(recoveredCreation.recovered, true);
  const source = current.manager.mainOnlyResolvePath(created.ref);
  await writeTreeFile(source, "auth.json", "windows-staging");
  armed = true;
  await assert.rejects(
    current.manager.quarantineStaging(
      "executor_win_staging",
      "session_win_staging"
    ),
    (error) => {
      assert.equal(error.code, "desktop_credential_recovery_required");
      assert.equal(String(error.message).includes(current.root), false);
      return true;
    }
  );

  const restarted = new DesktopCredentialTreeManager({
    root: current.root,
    safeStorage: current.storage,
    now: () => new Date("2026-07-13T00:00:01.000Z"),
    platform: "win32",
    windowsProtection: protection
  });
  await restarted.initialize();
  const quarantined = await restarted.quarantineStaging(
    "executor_win_staging",
    "session_win_staging"
  );
  assert.equal(quarantined.digestAlgorithm, DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM);
  assert.equal(protection.sealedTrees.length, 1);
  assert.deepEqual(
    await restarted.quarantineStaging(
      "executor_win_staging",
      "session_win_staging"
    ),
    quarantined
  );
  assert.equal(protection.sealedTrees.length, 1);
});

test("simulated Windows fails closed when no native credential protection is injected", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-credential-tree-win-missing-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const manager = new DesktopCredentialTreeManager({
    root: path.join(base, "vault"),
    safeStorage: new FakeSafeStorage(),
    platform: "win32"
  });
  await assert.rejects(manager.initialize(), {
    code: "desktop_credential_tree_unsafe"
  });
});
