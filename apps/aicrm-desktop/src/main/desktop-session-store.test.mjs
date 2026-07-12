import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopSessionStore } from "./desktop-session-store.ts";

class FakeSafeStorage {
  isEncryptionAvailable() {
    return true;
  }

  getSelectedStorageBackend() {
    return "gnome_libsecret";
  }

  encryptString(value) {
    return Buffer.concat([
      Buffer.from("SESSION-ENCRYPTED\0"),
      Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0x6d))
    ]);
  }

  decryptString(value) {
    const prefix = Buffer.from("SESSION-ENCRYPTED\0");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("ciphertext invalid");
    return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0x6d)).toString("utf8");
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicrm-session-store-"));
  return { root, storage: new FakeSafeStorage() };
}

const session = {
  token: "host-token-plaintext-canary",
  expiresAt: "2026-07-13T12:00:00.000Z"
};
const envelopeMagic = Buffer.from("AICRM-SESSION-ENC-V1\n", "ascii");

test("host session is safeStorage encrypted, mode 0600, durable, and clear removes memory and disk", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const store = new DesktopSessionStore({ root: current.root, safeStorage: current.storage });
  await store.save(session);
  const target = path.join(current.root, "session.sec");
  const raw = await readFile(target);
  assert.equal(raw.includes(Buffer.from(session.token)), false);
  if (process.platform !== "win32") assert.equal((await stat(target)).mode & 0o777, 0o600);
  const restarted = new DesktopSessionStore({ root: current.root, safeStorage: current.storage });
  assert.deepEqual(await restarted.load(), session);
  await restarted.clear();
  assert.equal(await restarted.load(), null);
  await assert.rejects(readFile(target), { code: "ENOENT" });
});

test("valid legacy plaintext session migrates atomically and erases plaintext", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const target = path.join(current.root, "session.json");
  await writeFile(target, JSON.stringify(session, null, 2), { mode: 0o644 });
  const store = new DesktopSessionStore({ root: current.root, safeStorage: current.storage });
  assert.deepEqual(await store.load(), session);
  const migratedTarget = path.join(current.root, "session.sec");
  const migrated = await readFile(migratedTarget);
  assert.equal(migrated.includes(Buffer.from(session.token)), false);
  assert.equal(migrated.subarray(0, envelopeMagic.length).equals(envelopeMagic), true);
  assert.deepEqual(
    JSON.parse(current.storage.decryptString(migrated.subarray(envelopeMagic.length))),
    session
  );
  if (process.platform !== "win32") assert.equal((await stat(migratedTarget)).mode & 0o777, 0o600);
  await assert.rejects(readFile(target), { code: "ENOENT" });
  assert.equal(
    (await readFile(path.join(current.root, "session.migrated-v1"))).toString("ascii"),
    "AICRM-SESSION-MIGRATED-V1\n"
  );
});

test("encrypted tampering never falls back to a valid-looking legacy plaintext", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const store = new DesktopSessionStore({ root: current.root, safeStorage: current.storage });
  await store.save(session);
  await writeFile(
    path.join(current.root, "session.sec"),
    Buffer.concat([envelopeMagic, Buffer.from(JSON.stringify(session))]),
    { mode: 0o600 }
  );
  await writeFile(path.join(current.root, "session.json"), JSON.stringify(session), { mode: 0o600 });
  const restarted = new DesktopSessionStore({ root: current.root, safeStorage: current.storage });
  await assert.rejects(restarted.load(), { code: "desktop_session_corrupt" });
});

test("legacy plaintext is accepted once and a durable marker rejects downgrade replacement", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  await writeFile(path.join(current.root, "session.json"), JSON.stringify(session), { mode: 0o600 });
  const first = new DesktopSessionStore({ root: current.root, safeStorage: current.storage });
  assert.deepEqual(await first.load(), session);
  await rm(path.join(current.root, "session.sec"));
  await writeFile(path.join(current.root, "session.json"), JSON.stringify(session), { mode: 0o600 });
  const restarted = new DesktopSessionStore({ root: current.root, safeStorage: current.storage });
  await assert.rejects(restarted.load(), { code: "desktop_session_unsafe" });
});

test("first load without files durably closes later plaintext injection", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const first = new DesktopSessionStore({ root: current.root, safeStorage: current.storage });
  assert.equal(await first.load(), null);
  assert.equal(
    (await readFile(path.join(current.root, "session.migrated-v1"))).toString("ascii"),
    "AICRM-SESSION-MIGRATED-V1\n"
  );
  await writeFile(path.join(current.root, "session.json"), JSON.stringify(session), { mode: 0o600 });
  const restarted = new DesktopSessionStore({ root: current.root, safeStorage: current.storage });
  await assert.rejects(restarted.load(), { code: "desktop_session_unsafe" });
});

test("corrupt ciphertext and unsafe legacy shapes fail closed without echoing the token", async (t) => {
  for (const raw of [
    Buffer.from("not-ciphertext"),
    Buffer.from(JSON.stringify({ token: "secret-corrupt-canary", expiresAt: "invalid" })),
    Buffer.from(JSON.stringify({ token: "secret-corrupt-canary", expiresAt: session.expiresAt, extra: true }))
  ]) {
    await t.test(raw.toString("hex").slice(0, 12), async (t) => {
      const current = await fixture();
      t.after(() => rm(current.root, { recursive: true, force: true }));
      await writeFile(path.join(current.root, "session.json"), raw, { mode: 0o600 });
      const store = new DesktopSessionStore({ root: current.root, safeStorage: current.storage });
      await assert.rejects(store.load(), (error) => {
        assert.equal(error.code, "desktop_session_corrupt");
        assert.equal(String(error.message).includes("secret-corrupt-canary"), false);
        return true;
      });
    });
  }
});
