import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DesktopDeviceRequestJournalStore,
  desktopTrustedRequestReference
} from "./desktop-device-request-journal.ts";
import {
  buildDesktopDeviceProof,
  desktopDeviceKeyMaterialFromSeed
} from "./desktop-device-proof.ts";

const now = new Date("2026-07-13T09:00:00.000Z");
const key = desktopDeviceKeyMaterialFromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => index + 9)
);
const pathValue =
  "/api/v1/ai-executor-authorization-sessions/auth_session_1/desktop-handoffs/handoff_1/claim";
const authorization = "AiCRM-Handoff header.payload.signature";

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
      Buffer.from("REQUEST-JOURNAL-TEST\0"),
      Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0x6d))
    ]);
  }

  decryptString(value) {
    const prefix = Buffer.from("REQUEST-JOURNAL-TEST\0");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("ciphertext invalid");
    return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0x6d)).toString("utf8");
  }
}

async function fixture(storage = new FakeSafeStorage()) {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-device-request-journal-"));
  const root = path.join(base, "requests");
  return {
    base,
    root,
    storage,
    journal: new DesktopDeviceRequestJournalStore({ root, safeStorage: storage })
  };
}

function requestRecord(overrides = {}) {
  const body = Buffer.from(
    JSON.stringify({ handoffId: "handoff_1", claimedAt: now.toISOString() }),
    "utf8"
  );
  const proof = buildDesktopDeviceProof({
    key,
    method: "POST",
    path: pathValue,
    body,
    authorization,
    allowedAuthorizationSchemes: ["AiCRM-Handoff"],
    timestamp: now.getTime(),
    nonce: Buffer.alloc(16, 7).toString("base64url"),
    sequence: 7n
  });
  return {
    version: 1,
    reference: desktopTrustedRequestReference("handoff_claim", pathValue),
    kind: "handoff_claim",
    method: "POST",
    origin: "https://aicrm.example.test",
    path: pathValue,
    authorization,
    bodyBase64: body.toString("base64"),
    signed: {
      ...proof,
      deviceId: key.deviceId,
      publicKey: key.publicKey,
      keyGeneration: 1,
      sequence: "7"
    },
    createdAt: now.toISOString(),
    response: null,
    ...overrides
  };
}

function response(body = { data: { handoffId: "handoff_1" } }) {
  return {
    status: 200,
    bodyBase64: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
    receivedAt: "2026-07-13T09:00:01.000Z"
  };
}

function bindingRequestRecord() {
  const bindingPath = "/api/v1/ai-executors/executor_1/device-bindings";
  const bindingAuthorization = "Bearer binding-session-token";
  const body = Buffer.from(
    JSON.stringify({ deviceId: key.deviceId, expectedRevision: 0 }),
    "utf8"
  );
  const proof = buildDesktopDeviceProof({
    key,
    method: "POST",
    path: bindingPath,
    body,
    authorization: bindingAuthorization,
    allowedAuthorizationSchemes: ["Bearer"],
    timestamp: now.getTime(),
    nonce: Buffer.alloc(16, 8).toString("base64url"),
    sequence: 8n
  });
  return {
    version: 1,
    reference: desktopTrustedRequestReference("device_binding", bindingPath),
    kind: "device_binding",
    method: "POST",
    origin: "https://aicrm.example.test",
    path: bindingPath,
    authorization: bindingAuthorization,
    bodyBase64: body.toString("base64"),
    signed: {
      ...proof,
      deviceId: key.deviceId,
      publicKey: key.publicKey,
      keyGeneration: 1,
      sequence: "8"
    },
    createdAt: now.toISOString(),
    response: null
  };
}

test("exact signed request and ticket are encrypted, mode 0600, and restart-readable", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const record = requestRecord();
  assert.deepEqual(await current.journal.createOrLoad(record), record);
  const target = path.join(current.root, `${record.reference}.sec`);
  const raw = await readFile(target);
  assert.equal(raw.includes(Buffer.from(authorization)), false);
  assert.equal(raw.includes(Buffer.from("handoffId")), false);
  if (process.platform !== "win32") assert.equal((await stat(target)).mode & 0o777, 0o600);

  const restarted = new DesktopDeviceRequestJournalStore({
    root: current.root,
    safeStorage: current.storage
  });
  assert.deepEqual(await restarted.load(record.reference), record);
  assert.deepEqual(await restarted.createOrLoad(record), record);
});

test("same reference rejects changed body, token, signature, and forged response creation", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const record = requestRecord();
  await current.journal.createOrLoad(record);
  for (const candidate of [
    { ...record, authorization: "AiCRM-Handoff changed.payload.signature" },
    { ...record, bodyBase64: Buffer.from("{}", "utf8").toString("base64") },
    {
      ...record,
      signed: {
        ...record.signed,
        headers: { ...record.signed.headers, "X-AiCRM-Device-Signature": "A".repeat(86) }
      }
    }
  ]) {
    await assert.rejects(current.journal.createOrLoad(candidate));
  }
  await assert.rejects(
    current.journal.createOrLoad({ ...requestRecord(), response: response() }),
    { code: "desktop_device_request_journal_unsafe" }
  );
});

test("response is durable before return and only exact completed records may be removed", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const record = await current.journal.createOrLoad(requestRecord());
  await assert.rejects(current.journal.complete(record.reference, record.signed.requestHash), {
    code: "desktop_device_request_journal_not_completed"
  });
  const completed = await current.journal.recordResponse(
    record.reference,
    record.signed.requestHash,
    response()
  );
  assert.deepEqual(completed.response, response());
  assert.deepEqual(
    (await current.journal.recordResponse(record.reference, record.signed.requestHash, response()))
      .response,
    response()
  );
  await assert.rejects(
    current.journal.recordResponse(
      record.reference,
      record.signed.requestHash,
      response({ data: { handoffId: "other" } })
    ),
    { code: "desktop_device_request_journal_conflict" }
  );
  await assert.rejects(current.journal.complete(record.reference, "0".repeat(64)), {
    code: "desktop_device_request_journal_not_completed"
  });
  await current.journal.complete(record.reference, record.signed.requestHash);
  assert.equal(await current.journal.load(record.reference), null);
});

test("device binding alone accepts Bearer and 201 while ticket kinds remain fixed to 200", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const ticket = await current.journal.createOrLoad(requestRecord());
  await assert.rejects(
    current.journal.recordResponse(ticket.reference, ticket.signed.requestHash, {
      ...response(),
      status: 201
    })
  );

  const binding = await current.journal.createOrLoad(bindingRequestRecord());
  await assert.rejects(
    current.journal.recordResponse(binding.reference, binding.signed.requestHash, response())
  );
  const created = {
    ...response({ data: { binding: { revision: 1 }, replayed: false } }),
    status: 201
  };
  assert.deepEqual(
    (await current.journal.recordResponse(
      binding.reference,
      binding.signed.requestHash,
      created
    )).response,
    created
  );
});

test("a fsynced temporary record recovers after a crash before rename", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const record = await current.journal.createOrLoad(requestRecord());
  const target = path.join(current.root, `${record.reference}.sec`);
  const temporary = `${target}.tmp`;
  await rename(target, temporary);
  const restarted = new DesktopDeviceRequestJournalStore({
    root: current.root,
    safeStorage: current.storage
  });
  assert.deepEqual(await restarted.load(record.reference), record);
  assert.deepEqual((await restarted.list()).map((item) => item.reference), [record.reference]);
});

test("unsafe storage, ciphertext tampering and hardlinked journals fail closed", async (t) => {
  for (const storage of [
    new FakeSafeStorage({ available: false }),
    new FakeSafeStorage({ backend: "basic_text" })
  ]) {
    const current = await fixture(storage);
    t.after(() => rm(current.base, { recursive: true, force: true }));
    await assert.rejects(current.journal.createOrLoad(requestRecord()), {
      code: "desktop_secure_storage_unavailable"
    });
  }

  const corrupt = await fixture();
  t.after(() => rm(corrupt.base, { recursive: true, force: true }));
  const record = await corrupt.journal.createOrLoad(requestRecord());
  const target = path.join(corrupt.root, `${record.reference}.sec`);
  await writeFile(target, "not-ciphertext", { mode: 0o600 });
  await assert.rejects(corrupt.journal.load(record.reference));

  if (process.platform !== "win32") {
    const linked = await fixture();
    t.after(() => rm(linked.base, { recursive: true, force: true }));
    const linkedRecord = await linked.journal.createOrLoad(requestRecord());
    const linkedTarget = path.join(linked.root, `${linkedRecord.reference}.sec`);
    await mkdir(path.join(linked.base, "outside"));
    await link(linkedTarget, path.join(linked.base, "outside", "alias.sec"));
    await assert.rejects(linked.journal.load(linkedRecord.reference), {
      code: "desktop_device_request_journal_unsafe"
    });
  }
});

test("reference is bound to kind and path and malformed proof headers fail closed", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const record = requestRecord();
  for (const candidate of [
    { ...record, reference: "0".repeat(64) },
    {
      ...record,
      signed: {
        ...record.signed,
        headers: { ...record.signed.headers, "X-AiCRM-Device-Timestamp": 123 }
      }
    },
    {
      ...record,
      signed: {
        ...record.signed,
        headers: { ...record.signed.headers, "X-AiCRM-Device-Nonce": "not-canonical" }
      }
    },
    {
      ...record,
      signed: { ...record.signed, sequence: 9223372036854775808n.toString(10) }
    }
  ]) {
    await assert.rejects(current.journal.createOrLoad(candidate));
  }
  assert.equal((await current.journal.list()).length, 0);
});

test("field insertion order is irrelevant but origin remains part of the exact request", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const record = requestRecord();
  await current.journal.createOrLoad(record);
  const reordered = {
    response: null,
    createdAt: record.createdAt,
    signed: {
      sequence: record.signed.sequence,
      keyGeneration: record.signed.keyGeneration,
      publicKey: record.signed.publicKey,
      deviceId: record.signed.deviceId,
      requestHash: record.signed.requestHash,
      signingInput: record.signed.signingInput,
      authorizationTokenHash: record.signed.authorizationTokenHash,
      bodySha256: record.signed.bodySha256,
      headers: Object.fromEntries(Object.entries(record.signed.headers).reverse())
    },
    bodyBase64: record.bodyBase64,
    authorization: record.authorization,
    path: record.path,
    origin: record.origin,
    method: record.method,
    kind: record.kind,
    reference: record.reference,
    version: record.version
  };
  assert.deepEqual(await current.journal.createOrLoad(reordered), record);
  await assert.rejects(
    current.journal.createOrLoad({ ...record, origin: "https://other.example.test" }),
    { code: "desktop_device_request_journal_conflict" }
  );
});

test("stores sharing one root serialize create and response updates", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const second = new DesktopDeviceRequestJournalStore({
    root: current.root,
    safeStorage: current.storage
  });
  const record = requestRecord();
  const created = await Promise.all([
    current.journal.createOrLoad(record),
    second.createOrLoad(record)
  ]);
  assert.deepEqual(created, [record, record]);
  const savedResponse = response();
  const updated = await Promise.all([
    current.journal.recordResponse(record.reference, record.signed.requestHash, savedResponse),
    second.recordResponse(record.reference, record.signed.requestHash, savedResponse)
  ]);
  assert.deepEqual(updated.map((item) => item.response), [savedResponse, savedResponse]);
  assert.deepEqual(await second.list(), [{ ...record, response: savedResponse }]);
});

test("durable response survives restart and target wins a safe target-plus-temp recovery", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const record = await current.journal.createOrLoad(requestRecord());
  const savedResponse = response();
  await current.journal.recordResponse(record.reference, record.signed.requestHash, savedResponse);
  const target = path.join(current.root, `${record.reference}.sec`);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, await readFile(target), { mode: 0o600 });

  const restarted = new DesktopDeviceRequestJournalStore({
    root: current.root,
    safeStorage: current.storage
  });
  const recovered = await restarted.load(record.reference);
  assert.deepEqual(recovered?.response, savedResponse);
  await assert.rejects(stat(temporary), { code: "ENOENT" });
});
