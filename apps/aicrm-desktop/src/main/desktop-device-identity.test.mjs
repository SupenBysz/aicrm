import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDesktopDeviceProof,
  canonicalDeviceMethod,
  canonicalDevicePath,
  desktopDeviceKeyMaterialFromSeed,
  hashAuthorizationToken,
  verifyDesktopDeviceSigningInput
} from "./desktop-device-proof.ts";
import { DesktopDeviceIdentityStore } from "./desktop-device-identity.ts";

const vectorPublicKey = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg";
const vectorDeviceId = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const vectorPath = "/api/v1/ai-executor-authorization-sessions/authsession_1/desktop-handoffs/handoff_1/claim";
const vectorTimestamp = 1783814400123;
const vectorNonce = "AAECAwQFBgcICQoLDA0ODw";
const vectorBody = Buffer.from('{"handoffId":"handoff_1","claimedAt":"2026-07-12T00:00:00Z"}');
const vectorBodyHash = "76cbc68fdaa606ecadfc3b5ce68256b1433ab2be332f847a6bb86e245e55eb17";
const vectorToken = "eyJhbGciOiJFZERTQSJ9.eyJwdXJwb3NlIjoiYXV0aG9yaXphdGlvbiJ9.c2lnbmF0dXJl";
const vectorTokenHash = "3f946b6e7e496dfe18ff3b6d9bce87b7fcfe96e10c12e04faa0c1d790d364fb3";
const vectorSignature = "z8gBKdlISOQwHDoWdihJDCM-wQWgDeyW3JtB4mLCqtgM6xdWLr6FCy8j2554bdtc0NKkASMTADWnU2Oa6pGqAg";
const vectorRequestHash = "8cea6e51fd24c5c79b75e38a6467721e366fdb6770457c3f1170b062c8b91367";

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
    const source = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from("TEST-ENCRYPTED\0"), Buffer.from(source.map((byte) => byte ^ 0xa5))]);
  }

  decryptString(value) {
    const prefix = Buffer.from("TEST-ENCRYPTED\0");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("ciphertext invalid");
    return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0xa5)).toString("utf8");
  }
}

function fixedKey() {
  return desktopDeviceKeyMaterialFromSeed(Uint8Array.from({ length: 32 }, (_, index) => index));
}

async function fixture(storage = new FakeSafeStorage()) {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-device-identity-"));
  const root = path.join(base, "identity");
  const store = new DesktopDeviceIdentityStore({
    root,
    safeStorage: storage,
    keyFactory: fixedKey,
    now: () => new Date("2026-07-12T00:00:00.000Z")
  });
  return { base, root, store, storage };
}

test("TypeScript device proof exactly matches the locked Go Ed25519 vector", () => {
  const key = fixedKey();
  assert.equal(key.publicKey, vectorPublicKey);
  assert.equal(key.deviceId, vectorDeviceId);
  const proof = buildDesktopDeviceProof({
    key,
    method: "POST",
    path: vectorPath,
    body: vectorBody,
    authorization: `AiCRM-Handoff ${vectorToken}`,
    allowedAuthorizationSchemes: ["AiCRM-Handoff"],
    timestamp: vectorTimestamp,
    nonce: vectorNonce,
    sequence: 42n
  });
  assert.equal(proof.bodySha256, vectorBodyHash);
  assert.equal(proof.authorizationTokenHash, vectorTokenHash);
  assert.equal(proof.requestHash, vectorRequestHash);
  assert.equal(proof.headers["X-AiCRM-Device-Signature"], vectorSignature);
  assert.equal(proof.headers["X-AiCRM-Device-Sequence"], "42");
  assert.equal(verifyDesktopDeviceSigningInput(key.publicKey, proof.signingInput, vectorSignature), true);
  assert.equal(proof.signingInput.endsWith("\n"), false);
});

test("identity is OS-encrypted, mode 0600, stable across restart, and renderer-safe", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const identity = await current.store.getIdentity();
  assert.deepEqual(identity, {
    deviceId: vectorDeviceId,
    publicKey: vectorPublicKey,
    keyGeneration: 1,
    registrationStatus: "unregistered",
    createdAt: "2026-07-12T00:00:00.000Z",
    registeredAt: null
  });
  assert.equal("privateKeyPkcs8" in identity, false);
  if (process.platform !== "win32") assert.equal((await stat(current.root)).mode & 0o777, 0o700);
  for (const name of ["identity.sec", "sequence.sec"]) {
    const file = path.join(current.root, name);
    const info = await stat(file);
    if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
    const ciphertext = await readFile(file);
    assert.equal(ciphertext.includes(Buffer.from(fixedKey().privateKeyPkcs8)), false);
  }
  const restarted = new DesktopDeviceIdentityStore({
    root: current.root,
    safeStorage: current.storage,
    keyFactory: () => {
      throw new Error("must not regenerate");
    }
  });
  assert.deepEqual(await restarted.getIdentity(), identity);
});

test("sequence allocation is serialized, durable, and never resets after restart", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const requests = await Promise.all(
    Array.from({ length: 32 }, () =>
      current.store.signRequest({
        method: "POST",
        path: "/api/v1/ai-executor-devices/heartbeat_1",
        body: Buffer.from("{}"),
        timestamp: vectorTimestamp
      })
    )
  );
  const sequences = requests.map((item) => BigInt(item.sequence)).sort((left, right) => (left < right ? -1 : 1));
  assert.deepEqual(sequences, Array.from({ length: 32 }, (_, index) => BigInt(index + 1)));
  assert.equal(new Set(requests.map((item) => item.headers["X-AiCRM-Device-Nonce"])).size, 32);
  const restarted = new DesktopDeviceIdentityStore({ root: current.root, safeStorage: current.storage });
  const next = await restarted.signRequest({
    method: "POST",
    path: "/api/v1/ai-executor-devices/heartbeat_1",
    body: Buffer.from("{}"),
    timestamp: vectorTimestamp
  });
  assert.equal(next.sequence, "33");
});

test("dual encrypted high-water records repair a one-file rollback", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const input = {
    method: "POST",
    path: "/api/v1/ai-executor-devices/heartbeat_1",
    body: Buffer.from("{}"),
    timestamp: vectorTimestamp,
    nonce: vectorNonce
  };
  await current.store.signRequest(input);
  const oldIdentity = await readFile(path.join(current.root, "identity.sec"));
  const oldSequence = await readFile(path.join(current.root, "sequence.sec"));
  await current.store.signRequest({ ...input, nonce: "EBESExQVFhcYGRobHB0eHw" });
  await current.store.signRequest({ ...input, nonce: "ICEiIyQlJicoKSorLC0uLw" });
  await writeFile(path.join(current.root, "identity.sec"), oldIdentity, { mode: 0o600 });
  const afterIdentityRollback = new DesktopDeviceIdentityStore({ root: current.root, safeStorage: current.storage });
  assert.equal((await afterIdentityRollback.signRequest({ ...input, nonce: "MDEyMzQ1Njc4OTo7PD0-Pw" })).sequence, "4");
  await writeFile(path.join(current.root, "sequence.sec"), oldSequence, { mode: 0o600 });
  const afterSequenceRollback = new DesktopDeviceIdentityStore({ root: current.root, safeStorage: current.storage });
  assert.equal((await afterSequenceRollback.signRequest({ ...input, nonce: "QEFCQ0RFRkdISUpLTE1OTw" })).sequence, "5");
});

test("unsafe storage, basic_text, corruption, hardlinks and irreversible registration fail closed", async (t) => {
  const unavailable = await fixture(new FakeSafeStorage({ available: false }));
  t.after(() => rm(unavailable.base, { recursive: true, force: true }));
  await assert.rejects(unavailable.store.getIdentity(), { code: "desktop_secure_storage_unavailable" });

  const plaintext = await fixture(new FakeSafeStorage({ backend: "basic_text" }));
  t.after(() => rm(plaintext.base, { recursive: true, force: true }));
  await assert.rejects(plaintext.store.getIdentity(), { code: "desktop_secure_storage_unavailable" });

  const corrupt = await fixture();
  t.after(() => rm(corrupt.base, { recursive: true, force: true }));
  await corrupt.store.getIdentity();
  await writeFile(path.join(corrupt.root, "identity.sec"), Buffer.from("not-ciphertext"), { mode: 0o600 });
  await assert.rejects(corrupt.store.getIdentity(), { code: "desktop_device_identity_corrupt" });

  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const identity = await current.store.getIdentity();
  const registered = await current.store.markRegistration("registered", identity.deviceId);
  assert.equal(registered.registrationStatus, "registered");
  assert.equal(registered.registeredAt, "2026-07-12T00:00:00.000Z");
  await assert.rejects(current.store.markRegistration("unregistered", identity.deviceId), {
    code: "desktop_device_identity_corrupt"
  });
  await current.store.markRegistration("revoked", identity.deviceId);
  await assert.rejects(current.store.markRegistration("registered", identity.deviceId), {
    code: "desktop_device_identity_corrupt"
  });

  const hardlinkPath = path.join(current.root, "identity-copy.sec");
  await link(path.join(current.root, "identity.sec"), hardlinkPath);
  await assert.rejects(current.store.getIdentity(), { code: "desktop_device_identity_unsafe" });
});

test("canonical request validation rejects normalization and authorization ambiguity", () => {
  assert.equal(canonicalDeviceMethod("POST"), "POST");
  assert.equal(canonicalDevicePath(vectorPath), vectorPath);
  for (const method of ["post", "Post", "P0ST", "POST "]) {
    assert.throws(() => canonicalDeviceMethod(method), { code: "desktop_device_request_invalid" });
  }
  for (const value of [
    "/",
    "relative",
    "/api//v1/device",
    "/api/v1/../device",
    "/api/v1/device/",
    "/api/v1/device?x=1",
    "/api/v1/device%2Fother",
    "/api/v1/device+other",
    "/api/v1/设备"
  ]) {
    assert.throws(() => canonicalDevicePath(value), { code: "desktop_device_request_invalid" });
  }
  assert.equal(hashAuthorizationToken(`AiCRM-Handoff ${vectorToken}`, ["AiCRM-Handoff"]), vectorTokenHash);
  for (const value of ["Bearer", " Bearer token", "Bearer token ", "Bearer  token", "Bearer töken"]) {
    assert.throws(() => hashAuthorizationToken(value, ["Bearer"]), {
      code: "desktop_device_authorization_invalid"
    });
  }
});

test("explicit recovery reset is durable across crash and never resets a registered identity", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-device-reset-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "identity");
  const storage = new FakeSafeStorage();
  const replacement = desktopDeviceKeyMaterialFromSeed(
    Uint8Array.from({ length: 32 }, (_, index) => 200 - index)
  );
  let generated = 0;
  const store = new DesktopDeviceIdentityStore({
    root,
    safeStorage: storage,
    keyFactory: () => (generated++ === 0 ? fixedKey() : replacement),
    now: () => new Date("2026-07-12T00:00:00.000Z")
  });
  const old = await store.getIdentity();
  let pendingCleared = false;
  const rotated = await store.resetRegistrationRecovery(old.deviceId, async () => {
    pendingCleared = true;
  });
  assert.equal(pendingCleared, true);
  assert.equal(rotated.deviceId, replacement.deviceId);
  await assert.rejects(readFile(path.join(root, "registration-reset.sec")), { code: "ENOENT" });
  await store.markRegistration("registered", rotated.deviceId);
  await assert.rejects(
    store.resetRegistrationRecovery(rotated.deviceId, async () => undefined),
    { code: "desktop_device_identity_reset_forbidden" }
  );

  const crashBase = await mkdtemp(path.join(os.tmpdir(), "aicrm-device-reset-crash-"));
  t.after(() => rm(crashBase, { recursive: true, force: true }));
  const crashRoot = path.join(crashBase, "identity");
  let crashGenerated = 0;
  const crashing = new DesktopDeviceIdentityStore({
    root: crashRoot,
    safeStorage: storage,
    keyFactory: () => (crashGenerated++ === 0 ? fixedKey() : replacement),
    now: () => new Date("2026-07-12T00:00:00.000Z")
  });
  const crashOld = await crashing.getIdentity();
  await writeFile(path.join(crashRoot, "registration-pending.sec"), Buffer.from("pending-canary"), {
    mode: 0o600
  });
  await assert.rejects(
    crashing.resetRegistrationRecovery(crashOld.deviceId, async () => {
      throw new Error("simulated crash after durable reset marker");
    })
  );
  const marker = await readFile(path.join(crashRoot, "registration-reset.sec"));
  assert.equal(marker.includes(Buffer.from(crashOld.deviceId)), false);
  const restarted = new DesktopDeviceIdentityStore({
    root: crashRoot,
    safeStorage: storage,
    keyFactory: () => replacement,
    now: () => new Date("2026-07-12T00:01:00.000Z")
  });
  const recovered = await restarted.getIdentity();
  assert.equal(recovered.deviceId, replacement.deviceId);
  assert.equal(recovered.registrationStatus, "unregistered");
  await assert.rejects(readFile(path.join(crashRoot, "registration-reset.sec")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(crashRoot, "registration-pending.sec")), { code: "ENOENT" });
});

test("renderer bridge exposes identity query only and never private signing material", async () => {
  const [constants, preloadTypes, preloadBridge, ipc] = await Promise.all([
    readFile(new URL("../shared/constants.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("./ipc/desktop-device-ipc.ts", import.meta.url), "utf8")
  ]);
  assert.match(constants, /desktopDeviceGetIdentity: "desktop-device:get-identity"/);
  assert.match(constants, /desktopDeviceEnsureRegistration: "desktop-device:ensure-registration"/);
  assert.match(constants, /desktopDeviceGetRegistrationState: "desktop-device:get-registration-state"/);
  assert.match(preloadTypes, /desktopDevice:\s*\{\s*getIdentity:/);
  assert.match(preloadTypes, /ensureRegistration:/);
  assert.match(preloadTypes, /getRegistrationState:/);
  assert.match(preloadBridge, /desktopDeviceGetIdentity/);
  assert.match(ipc, /runtime\.getIdentity\(\)/);
  const exposed = `${preloadTypes}\n${preloadBridge}\n${ipc}`;
  for (const forbidden of [
    "privateKeyPkcs8",
    "signRequest",
    "buildDesktopDeviceProof",
    "encryptString(",
    "pendingRegistrationStore",
    "authorizationTokenHash"
  ]) {
    assert.equal(exposed.includes(forbidden), false, `renderer identity surface contains ${forbidden}`);
  }
});
