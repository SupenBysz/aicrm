import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MatrixAccountSessionVault } from "./matrix-account-session-vault.ts";

function scope(attemptId = "attempt-1") {
  return {
    attemptId,
    webSpaceId: "space-1",
    workspaceId: "workspace-1",
    workspaceType: "enterprise",
    platform: "douyin",
    deviceId: "device-1"
  };
}

function fingerprint() {
  return {
    appVersion: "0.1.0",
    electronVersion: "43.0.0",
    chromiumVersion: "142.0.0",
    operatingSystem: "darwin",
    architecture: "arm64",
    userAgent: "AiCRM-Test",
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
    viewport: { width: 1180, height: 820, deviceScaleFactor: 2 },
    deviceId: "device-1"
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicrm-session-vault-"));
  const source = path.join(root, "source");
  const vaultRoot = path.join(root, "vault");
  await mkdir(path.join(source, "Network"), { recursive: true });
  await mkdir(path.join(source, "Local Storage", "leveldb"), { recursive: true });
  await mkdir(path.join(source, "Cache", "Cache_Data"), { recursive: true });
  await writeFile(path.join(source, "Network", "Cookies"), "encrypted-cookie-database");
  await writeFile(path.join(source, "Local Storage", "leveldb", "000001.ldb"), "persistent-local-storage");
  await writeFile(path.join(source, "Cache", "Cache_Data", "cache.bin"), "regenerable-cache");
  return { root, source, vaultRoot, vault: new MatrixAccountSessionVault({ vaultRoot }) };
}

test("seal verifies and restores persistent WebSpace data without regenerable caches", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));

  const sealInput = {
    snapshotId: "snapshot-1",
    sourceStoragePath: current.source,
    scope: scope(),
    fingerprint: fingerprint()
  };
  const [sealed, duplicate] = await Promise.all([current.vault.seal(sealInput), current.vault.seal(sealInput)]);

  assert.equal(sealed.manifest.snapshotId, "snapshot-1");
  assert.equal(duplicate.manifest.archive.contentHash, sealed.manifest.archive.contentHash);
  assert.equal(sealed.manifest.archive.fileCount, 2);
  assert.match(sealed.verificationReceipt, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(await readFile(path.join(current.source, "Network", "Cookies"), "utf8"), "encrypted-cookie-database");

  const verified = await current.vault.verify({ snapshotId: "snapshot-1", expectedScope: scope() });
  assert.equal(verified.manifest.archive.contentHash, sealed.manifest.archive.contentHash);

  const restoredPath = path.join(current.root, "restored");
  const restored = await current.vault.restore({
    snapshotId: "snapshot-1",
    expectedScope: scope(),
    targetStoragePath: restoredPath
  });
  assert.equal(restored.manifest.fingerprintHash, sealed.manifest.fingerprintHash);
  assert.equal(await readFile(path.join(restoredPath, "Network", "Cookies"), "utf8"), "encrypted-cookie-database");
  assert.equal(
    await readFile(path.join(restoredPath, "Local Storage", "leveldb", "000001.ldb"), "utf8"),
    "persistent-local-storage"
  );
  await assert.rejects(stat(path.join(restoredPath, "Cache", "Cache_Data", "cache.bin")), { code: "ENOENT" });
});

test("tampering is rejected without deleting the source WebSpace", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  await current.vault.seal({
    snapshotId: "snapshot-tamper",
    sourceStoragePath: current.source,
    scope: scope("attempt-tamper"),
    fingerprint: { ...fingerprint(), viewport: undefined }
  });

  const archivePath = path.join(current.vaultRoot, "snapshots", "snapshot-tamper.vault");
  const archive = await readFile(archivePath);
  archive[Math.floor(archive.length / 2)] ^= 0xff;
  await writeFile(archivePath, archive);

  await assert.rejects(
    current.vault.verify({ snapshotId: "snapshot-tamper", expectedScope: scope("attempt-tamper") }),
    (error) => error?.code === "session_snapshot_verify_failed"
  );
  assert.equal(await readFile(path.join(current.source, "Network", "Cookies"), "utf8"), "encrypted-cookie-database");
});

test("physical cleanup reports released bytes and removes the full storage directory", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const releasedBytes = await current.vault.cleanupStoragePath(current.source);
  assert.ok(releasedBytes > 0);
  await assert.rejects(stat(current.source), { code: "ENOENT" });
});
