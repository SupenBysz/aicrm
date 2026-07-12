import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DESKTOP_TRUSTED_TOKEN_KEYRING_PATH,
  DesktopTrustedTokenKeyringClient
} from "./desktop-trusted-token-keyring.ts";

const oldPublicKey = "25lf4lFp0UHKubu6krqgH58uHs599MsqwFGQ83_MH50";
const activePublicKey = "IVL40Zt5HSRFMkLhXy6rbLfP-ntqXtMAl5YOBpiB2xI";
const goVectorDigest = "6ff9c0469356f330884c62682757dd877db754443f6cc48990b35293da60d3c0";
const requestId = "trusted-keyring-request-1";

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
    const raw = Buffer.from(value, "utf8");
    return Buffer.concat([
      Buffer.from("TEST-KEYRING-ENCRYPTED\0"),
      Buffer.from(raw.map((byte) => byte ^ 0xa5))
    ]);
  }

  decryptString(value) {
    const prefix = Buffer.from("TEST-KEYRING-ENCRYPTED\0");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("ciphertext invalid");
    return Buffer.from(value.subarray(prefix.length).map((byte) => byte ^ 0xa5)).toString(
      "utf8"
    );
  }
}

function keyring(revision = 11, overrides = {}) {
  const result = {
    schemaVersion: 1,
    issuer: "aicrm-agent-executor",
    revision,
    activeKid: "z_key",
    generatedAt: "2026-07-13T00:00:00Z",
    refreshAfterSeconds: 30,
    maxTokenLifetimeSeconds: 600,
    keyringDigest: "",
    desktopAudiences: [
      "aicrm-desktop",
      "aicrm-desktop-claim",
      "aicrm-desktop-activation",
      "aicrm-desktop-command"
    ],
    keys: [
      {
        kid: "a_key",
        kty: "OKP",
        crv: "Ed25519",
        alg: "EdDSA",
        use: "sig",
        x: oldPublicKey,
        signingNotBefore: "2026-07-12T00:00:00Z",
        signingNotAfter: "2026-07-13T00:00:00Z",
        verifyUntil: "2026-07-13T00:10:00Z"
      },
      {
        kid: "z_key",
        kty: "OKP",
        crv: "Ed25519",
        alg: "EdDSA",
        use: "sig",
        x: activePublicKey,
        signingNotBefore: "2026-07-13T00:00:00Z",
        signingNotAfter: null,
        verifyUntil: null
      }
    ],
    ...structuredClone(overrides)
  };
  result.keyringDigest = digest(result);
  return result;
}

function digest(ring) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: ring.schemaVersion,
        issuer: ring.issuer,
        revision: ring.revision,
        activeKid: ring.activeKid,
        maxTokenLifetimeSeconds: ring.maxTokenLifetimeSeconds,
        desktopAudiences: ring.desktopAudiences,
        keys: ring.keys.map((key) => ({
          kid: key.kid,
          kty: key.kty,
          crv: key.crv,
          alg: key.alg,
          use: key.use,
          x: key.x,
          signingNotBefore: key.signingNotBefore,
          signingNotAfter: key.signingNotAfter,
          verifyUntil: key.verifyUntil
        }))
      })
    )
    .digest("hex");
}

function jsonResponse(value, options = {}) {
  return new Response(
    typeof value === "string" ? value : JSON.stringify({ data: value, requestId }),
    { status: options.status ?? 200, headers: { "content-type": "application/json" } }
  );
}

async function fixture(options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-trusted-keyring-"));
  const root = path.join(base, "keyring");
  const storage = options.storage ?? new FakeSafeStorage();
  const requests = [];
  let webUrl = options.webUrl ?? "https://aicrm.example.test/admin/path?ignored=1";
  let response = options.response ?? keyring();
  let now = options.now ?? new Date("2026-07-13T00:00:10.000Z");
  const fetch =
    options.fetch ??
    (async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(response);
    });
  const makeClient = (extra = {}) =>
    new DesktopTrustedTokenKeyringClient({
      root,
      safeStorage: storage,
      loadTrustedWebUrl: () => webUrl,
      fetch,
      now: () => now,
      ...extra
    });
  return {
    base,
    root,
    storage,
    requests,
    makeClient,
    setResponse(value) {
      response = value;
    },
    setWebUrl(value) {
      webUrl = value;
    },
    setNow(value) {
      now = value;
    }
  };
}

test("strict HTTPS fetch matches the Go digest vector and persists only validated trust material", async (t) => {
  const current = await fixture({ response: keyring(11) });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  const client = current.makeClient();
  const fetched = await client.refresh();
  assert.equal(fetched.keyringDigest, goVectorDigest);
  assert.equal(current.requests.length, 1);
  assert.equal(
    current.requests[0].url,
    `https://aicrm.example.test${DESKTOP_TRUSTED_TOKEN_KEYRING_PATH}`
  );
  assert.equal(current.requests[0].init.method, "GET");
  assert.equal(current.requests[0].init.redirect, "error");
  assert.equal(current.requests[0].init.credentials, "omit");
  assert.equal(current.requests[0].init.cache, "no-store");
  assert.equal(current.requests[0].init.referrerPolicy, "no-referrer");
  assert.deepEqual(current.requests[0].init.headers, { Accept: "application/json" });
  assert.ok(current.requests[0].init.signal instanceof AbortSignal);
  const persisted = await Promise.all([
    readFile(path.join(current.root, "keyring.sec")),
    readFile(path.join(current.root, "keyring-high-water.sec"))
  ]);
  assert.deepEqual(persisted[0], persisted[1]);
  assert.equal(persisted[0].includes(Buffer.from(oldPublicKey)), false);
  const restarted = current.makeClient();
  assert.deepEqual(await restarted.readCached(), fetched);
});

test("response projection is exact, canonical, sorted and non-overlapping", async (t) => {
  const invalid = [];
  invalid.push({ name: "unknown data field", mutate: (ring) => (ring.extra = true) });
  invalid.push({ name: "wrong issuer", mutate: (ring) => (ring.issuer = "other") });
  invalid.push({ name: "fractional generatedAt", mutate: (ring) => (ring.generatedAt += ".000Z") });
  invalid.push({
    name: "audience order",
    mutate: (ring) => ring.desktopAudiences.reverse()
  });
  invalid.push({ name: "padded public key", mutate: (ring) => (ring.keys[0].x += "=") });
  invalid.push({ name: "unsorted kids", mutate: (ring) => ring.keys.reverse() });
  invalid.push({ name: "duplicate kid", mutate: (ring) => (ring.keys[1].kid = "a_key") });
  invalid.push({
    name: "overlapping windows",
    mutate: (ring) => {
      ring.keys[0].signingNotAfter = "2026-07-14T00:00:00Z";
      ring.keys[0].verifyUntil = "2026-07-14T00:10:00Z";
    }
  });
  invalid.push({
    name: "wrong retirement grace",
    mutate: (ring) => (ring.keys[0].verifyUntil = "2026-07-13T00:09:59Z")
  });
  for (const testCase of invalid) {
    await t.test(testCase.name, async (inner) => {
      const value = keyring();
      testCase.mutate(value);
      value.keyringDigest = digest(value);
      const current = await fixture({ response: value });
      inner.after(() => rm(current.base, { recursive: true, force: true }));
      await assert.rejects(current.makeClient().refresh(), {
        code: "desktop_trusted_token_keyring_response_invalid"
      });
    });
  }

  await t.test("wrong digest", async (inner) => {
    const value = keyring();
    value.keyringDigest = "0".repeat(64);
    const current = await fixture({ response: value });
    inner.after(() => rm(current.base, { recursive: true, force: true }));
    await assert.rejects(current.makeClient().refresh(), {
      code: "desktop_trusted_token_keyring_response_invalid"
    });
  });

  await t.test("duplicate JSON field", async (inner) => {
    const value = JSON.stringify({ data: keyring(), requestId }).replace(
      `"requestId":"${requestId}"`,
      `"requestId":"${requestId}","requestId":"${requestId}"`
    );
    const current = await fixture({ fetch: async () => jsonResponse(value) });
    inner.after(() => rm(current.base, { recursive: true, force: true }));
    await assert.rejects(current.makeClient().refresh(), {
      code: "desktop_trusted_token_keyring_response_invalid"
    });
  });

  await t.test("non-string requestId", async (inner) => {
    const current = await fixture({
      fetch: async () => jsonResponse(JSON.stringify({ data: keyring(), requestId: 12345678 }))
    });
    inner.after(() => rm(current.base, { recursive: true, force: true }));
    await assert.rejects(current.makeClient().refresh(), {
      code: "desktop_trusted_token_keyring_response_invalid"
    });
  });

  for (const generatedAt of ["2026-07-12T23:59:39Z", "2026-07-13T00:00:41Z"]) {
    await t.test(`generatedAt freshness ${generatedAt}`, async (inner) => {
      const current = await fixture({ response: keyring(11, { generatedAt }) });
      inner.after(() => rm(current.base, { recursive: true, force: true }));
      await assert.rejects(current.makeClient().refresh(), {
        code: "desktop_trusted_token_keyring_response_invalid"
      });
    });
  }

  await t.test("active signing window must cover generatedAt", async (inner) => {
    const value = keyring();
    value.keys[0].signingNotAfter = "2026-07-13T00:00:20Z";
    value.keys[0].verifyUntil = "2026-07-13T00:10:20Z";
    value.keys[1].signingNotBefore = "2026-07-13T00:00:20Z";
    value.keyringDigest = digest(value);
    const current = await fixture({ response: value });
    inner.after(() => rm(current.base, { recursive: true, force: true }));
    await assert.rejects(current.makeClient().refresh(), {
      code: "desktop_trusted_token_keyring_response_invalid"
    });
  });
});

test("revision, digest and origin fences fail closed while explicit origin reset starts a new epoch", async (t) => {
  const current = await fixture({ response: keyring(11) });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.makeClient().refresh();

  current.setResponse(keyring(10));
  await assert.rejects(current.makeClient().refresh(), {
    code: "desktop_trusted_token_keyring_rollback"
  });

  const changed = keyring(11);
  changed.keys[1].x = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg";
  changed.keyringDigest = digest(changed);
  current.setResponse(changed);
  await assert.rejects(current.makeClient().refresh(), {
    code: "desktop_trusted_token_keyring_rollback"
  });

  const refreshedMetadata = keyring(11, { generatedAt: "2026-07-13T00:00:30Z" });
  current.setResponse(refreshedMetadata);
  assert.equal((await current.makeClient().refresh()).generatedAt, "2026-07-13T00:00:30Z");
  assert.equal((await current.makeClient().readCached()).generatedAt, "2026-07-13T00:00:00Z");
  current.setNow(new Date("2026-07-13T00:00:31.001Z"));
  assert.equal(await current.makeClient().readCached(), null);
  current.setNow(new Date("2026-07-13T00:00:10.000Z"));

  const requestsBeforeSwitch = current.requests.length;
  current.setWebUrl("https://new-aicrm.example.test/path");
  await assert.rejects(current.makeClient().refresh(), {
    code: "desktop_trusted_token_keyring_origin_mismatch"
  });
  assert.equal(current.requests.length, requestsBeforeSwitch);

  const resetter = current.makeClient();
  await resetter.resetOrigin(
    "https://aicrm.example.test/old-path",
    "https://new-aicrm.example.test/new-path"
  );
  current.setResponse(keyring(1, { generatedAt: "2026-07-13T00:00:20Z" }));
  assert.equal((await current.makeClient().refresh()).revision, 1);
  await assert.rejects(
    current.makeClient().resetOrigin(
      "https://aicrm.example.test",
      "https://third-aicrm.example.test"
    ),
    { code: "desktop_trusted_token_keyring_origin_mismatch" }
  );
});

test("dual encrypted high-water records repair rollback and interrupted atomic writes", async (t) => {
  const current = await fixture({ response: keyring(10) });
  t.after(() => rm(current.base, { recursive: true, force: true }));
  await current.makeClient().refresh();
  const oldPrimary = await readFile(path.join(current.root, "keyring.sec"));
  const oldHighWater = await readFile(path.join(current.root, "keyring-high-water.sec"));
  current.setResponse(keyring(11));
  await current.makeClient().refresh();

  await writeFile(path.join(current.root, "keyring.sec"), oldPrimary, { mode: 0o600 });
  assert.equal((await current.makeClient().readCached()).revision, 11);
  await writeFile(path.join(current.root, "keyring-high-water.sec"), oldHighWater, { mode: 0o600 });
  assert.equal((await current.makeClient().readCached()).revision, 11);

  current.setResponse(keyring(12));
  let crashed = false;
  const interrupted = current.makeClient({
    faultInjector(point) {
      if (!crashed && point === "after_primary_rename") {
        crashed = true;
        throw new Error("simulated process exit");
      }
    }
  });
  await assert.rejects(interrupted.refresh(), /simulated process exit/);
  assert.equal((await current.makeClient().readCached()).revision, 12);
  assert.deepEqual(
    await readFile(path.join(current.root, "keyring.sec")),
    await readFile(path.join(current.root, "keyring-high-water.sec"))
  );
});

test("unsafe storage, corruption, unknown files, hardlinks and symlinks fail closed", async (t) => {
  const unavailable = await fixture({ storage: new FakeSafeStorage({ available: false }) });
  t.after(() => rm(unavailable.base, { recursive: true, force: true }));
  await assert.rejects(unavailable.makeClient().readCached(), {
    code: "desktop_secure_storage_unavailable"
  });

  const plaintext = await fixture({ storage: new FakeSafeStorage({ backend: "basic_text" }) });
  t.after(() => rm(plaintext.base, { recursive: true, force: true }));
  await assert.rejects(plaintext.makeClient().readCached(), {
    code: "desktop_secure_storage_unavailable"
  });

  for (const kind of ["corrupt", "unknown", "hardlink", "symlink"]) {
    const current = await fixture();
    t.after(() => rm(current.base, { recursive: true, force: true }));
    await current.makeClient().refresh();
    if (kind === "corrupt") {
      await writeFile(path.join(current.root, "keyring.sec"), Buffer.from("corrupt"), {
        mode: 0o600
      });
    } else if (kind === "unknown") {
      await writeFile(path.join(current.root, "unexpected.sec"), Buffer.from("x"), { mode: 0o600 });
    } else if (kind === "hardlink") {
      await link(
        path.join(current.root, "keyring.sec"),
        path.join(current.root, "keyring.sec.tmp")
      );
    } else {
      await rm(path.join(current.root, "keyring-high-water.sec"));
      await symlink("keyring.sec", path.join(current.root, "keyring-high-water.sec"));
    }
    await assert.rejects(current.makeClient().readCached(), {
      code:
        kind === "corrupt"
          ? "desktop_trusted_token_keyring_unsafe"
          : "desktop_trusted_token_keyring_unsafe"
    });
  }
});

test("transport forbids redirects and oversized bodies, and HTTP is test-loopback only", async (t) => {
  const insecure = await fixture({ webUrl: "http://aicrm.example.test" });
  t.after(() => rm(insecure.base, { recursive: true, force: true }));
  await assert.rejects(insecure.makeClient().refresh(), {
    code: "desktop_trusted_token_keyring_contract_invalid"
  });
  assert.equal(insecure.requests.length, 0);

  const loopback = await fixture({ webUrl: "http://127.0.0.2:18086/path" });
  t.after(() => rm(loopback.base, { recursive: true, force: true }));
  await loopback.makeClient({ allowInsecureLoopbackForTests: true }).refresh();
  assert.equal(
    loopback.requests[0].url,
    `http://127.0.0.2:18086${DESKTOP_TRUSTED_TOKEN_KEYRING_PATH}`
  );

  const redirected = await fixture({
    fetch: async () => ({ ok: true, status: 200, redirected: true, text: async () => "{}" })
  });
  t.after(() => rm(redirected.base, { recursive: true, force: true }));
  await assert.rejects(redirected.makeClient().refresh(), {
    code: "desktop_trusted_token_keyring_transport_failed"
  });

  const oversized = await fixture({
    fetch: async () => new Response("x".repeat((64 << 10) + 1), { status: 200 })
  });
  t.after(() => rm(oversized.base, { recursive: true, force: true }));
  await assert.rejects(oversized.makeClient().refresh(), {
    code: "desktop_trusted_token_keyring_response_invalid"
  });
});
