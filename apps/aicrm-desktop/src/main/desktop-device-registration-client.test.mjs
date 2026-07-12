import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DESKTOP_DEVICE_REGISTRATION_CHALLENGE_PATH,
  DESKTOP_DEVICE_REGISTRATION_PATH,
  DesktopDeviceRegistrationClient
} from "./desktop-device-registration-client.ts";
import {
  buildDesktopDeviceProof,
  desktopDeviceKeyMaterialFromSeed
} from "./desktop-device-proof.ts";

const deviceId = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const publicKey = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg";
const sessionToken = "host.session.token";
const now = new Date("2026-07-12T00:00:00.000Z");
const challenge = {
  challengeId: "challenge_1",
  challenge: "registration_challenge_value_1",
  expiresAt: "2026-07-12T00:02:00.000Z",
  algorithm: "Ed25519"
};
const fixedKey = desktopDeviceKeyMaterialFromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => index)
);

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(data);
    }
  };
}

class FakeIdentityStore {
  constructor({ sequence = "1", status = "unregistered", tamperHeader = null } = {}) {
    this.sequence = sequence;
    this.tamperHeader = tamperHeader;
    this.identity = {
      deviceId,
      publicKey,
      keyGeneration: 1,
      registrationStatus: status,
      createdAt: now.toISOString(),
      registeredAt: null
    };
    this.signed = [];
    this.marked = [];
  }

  async getIdentity() {
    return { ...this.identity };
  }

  async signRequest(input) {
    this.signed.push({ ...input, body: Buffer.from(input.body) });
    const proof = buildDesktopDeviceProof({
      key: fixedKey,
      method: input.method,
      path: input.path,
      body: input.body,
      authorization: input.authorization,
      allowedAuthorizationSchemes: input.allowedAuthorizationSchemes,
      timestamp: now.getTime(),
      nonce: "AAECAwQFBgcICQoLDA0ODw",
      sequence: BigInt(this.sequence)
    });
    if (this.tamperHeader) proof.headers[this.tamperHeader] = "0".repeat(64);
    return {
      ...proof,
      deviceId,
      publicKey,
      keyGeneration: 1,
      sequence: this.sequence
    };
  }

  async markRegistration(status, expectedDeviceId) {
    this.marked.push({ status, expectedDeviceId });
    this.identity = {
      ...this.identity,
      registrationStatus: status,
      registeredAt: now.toISOString()
    };
    return { ...this.identity };
  }
}

function fixture(overrides = {}) {
  const identityStore = overrides.identityStore ?? new FakeIdentityStore();
  const requests = [];
  const responses = overrides.responses ?? [
    jsonResponse(200, { data: challenge }),
    jsonResponse(200, { data: { deviceId, status: "active", keyGeneration: 1 } })
  ];
  let responseIndex = 0;
  const requestIds = ["desktop-request-1", "desktop-request-2"];
  let requestIdIndex = 0;
  const client = new DesktopDeviceRegistrationClient({
    identityStore,
    deviceLabel: "AiCRM Desktop",
    appVersion: "0.1.0",
    loadHostSession:
      overrides.loadHostSession ??
      (async () => ({ token: sessionToken, expiresAt: "2026-07-12T01:00:00.000Z" })),
    loadTrustedApiBaseUrl: overrides.loadTrustedApiBaseUrl ?? (() => "https://aicrm.example.test"),
    now: () => now,
    requestIdFactory: () => requestIds[requestIdIndex++] ?? "desktop-request-fallback",
    requestTimeoutMs: 5_000,
    fetch:
      overrides.fetch ??
      (async (url, init) => {
        requests.push({ url, init });
        const response = responses[responseIndex++];
        if (!response) throw new Error("unexpected request");
        return response;
      })
  });
  return { client, identityStore, requests };
}

test("Main registration uses Host session and signs the exact create body plus the same Bearer", async () => {
  const current = fixture();
  const result = await current.client.register();

  assert.equal(result.registrationStatus, "registered");
  assert.equal(current.requests.length, 2);
  const [challengeRequest, createRequest] = current.requests;
  assert.equal(
    challengeRequest.url,
    `https://aicrm.example.test${DESKTOP_DEVICE_REGISTRATION_CHALLENGE_PATH}`
  );
  assert.equal(createRequest.url, `https://aicrm.example.test${DESKTOP_DEVICE_REGISTRATION_PATH}`);
  assert.deepEqual(JSON.parse(challengeRequest.init.body), {
    publicKey,
    deviceLabel: "AiCRM Desktop",
    appVersion: "0.1.0"
  });
  const expectedCreateBody = JSON.stringify({
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    publicKey,
    deviceLabel: "AiCRM Desktop",
    appVersion: "0.1.0"
  });
  assert.equal(createRequest.init.body, expectedCreateBody);

  assert.equal(current.identityStore.signed.length, 1);
  const signed = current.identityStore.signed[0];
  assert.equal(signed.method, "POST");
  assert.equal(signed.path, DESKTOP_DEVICE_REGISTRATION_PATH);
  assert.equal(Buffer.from(signed.body).toString("utf8"), expectedCreateBody);
  assert.equal(signed.authorization, `Bearer ${sessionToken}`);
  assert.deepEqual(signed.allowedAuthorizationSchemes, ["Bearer"]);

  for (const [index, request] of current.requests.entries()) {
    const headers = request.init.headers;
    assert.equal(headers.Authorization, `Bearer ${sessionToken}`);
    assert.equal(headers["X-KY-Workspace-Type"], "platform");
    assert.equal(headers["X-KY-Workspace-Id"], "platform_root");
    assert.equal(headers["X-KY-Request-Id"], `desktop-request-${index + 1}`);
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.cache, "no-store");
    assert.equal(request.init.credentials, "omit");
  }
  assert.equal(createRequest.init.headers["X-AiCRM-Device-Id"], deviceId);
  assert.equal(createRequest.init.headers["X-AiCRM-Device-Sequence"], "1");
  assert.deepEqual(current.identityStore.marked, [{ status: "registered", expectedDeviceId: deviceId }]);
  const serializedRequests = JSON.stringify(current.requests);
  assert.equal(serializedRequests.includes("privateKey"), false);
});

test("concurrent Main registration calls coalesce and already-registered state performs no network call", async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const current = fixture({
    fetch: async (url, init) => {
      current.requests.push({ url, init });
      if (current.requests.length === 1) await waiting;
      return current.requests.length === 1
        ? jsonResponse(200, { data: challenge })
        : jsonResponse(200, { data: { deviceId, status: "active", keyGeneration: 1 } });
    }
  });
  const first = current.client.register();
  const second = current.client.register();
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(current.requests.length, 2);

  const registered = fixture({ identityStore: current.identityStore });
  const projection = await registered.client.register();
  assert.equal(projection.registrationStatus, "registered");
  assert.equal(registered.requests.length, 0);
});

test("untrusted API bases and expired or malformed Host sessions fail before signing", async (t) => {
  const cases = [
    {
      name: "remote plaintext",
      loadTrustedApiBaseUrl: () => "http://aicrm.example.test",
      code: "desktop_host_api_untrusted"
    },
    {
      name: "URL credentials",
      loadTrustedApiBaseUrl: () => "https://user:secret@aicrm.example.test",
      code: "desktop_host_api_untrusted"
    },
    {
      name: "path prefix",
      loadTrustedApiBaseUrl: () => "https://aicrm.example.test/proxy",
      code: "desktop_host_api_untrusted"
    },
    {
      name: "expired session",
      loadHostSession: async () => ({ token: sessionToken, expiresAt: now.toISOString() }),
      code: "desktop_host_session_expired"
    },
    {
      name: "ambiguous token",
      loadHostSession: async () => ({ token: "token with space", expiresAt: "2026-07-12T01:00:00Z" }),
      code: "desktop_host_session_unavailable"
    }
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const current = fixture(entry);
      await assert.rejects(current.client.register(), { code: entry.code });
      assert.equal(current.requests.length, 0);
      assert.equal(current.identityStore.signed.length, 0);
      assert.equal(current.identityStore.marked.length, 0);
    });
  }

  const loopback = fixture({ loadTrustedApiBaseUrl: () => "http://127.0.0.1:16178/" });
  await loopback.client.register();
  assert.equal(loopback.requests[0].url.startsWith("http://127.0.0.1:16178/"), true);
});

test("challenge and device responses are exact, bounded, and cannot forge local registration state", async (t) => {
  const cases = [
    {
      name: "challenge extra field",
      responses: [jsonResponse(200, { data: { ...challenge, privateMaterial: "forbidden" } })]
    },
    {
      name: "algorithm downgrade",
      responses: [jsonResponse(200, { data: { ...challenge, algorithm: "RSA" } })]
    },
    {
      name: "expired challenge",
      responses: [jsonResponse(200, { data: { ...challenge, expiresAt: now.toISOString() } })]
    },
    {
      name: "device projection extra field",
      responses: [
        jsonResponse(200, { data: challenge }),
        jsonResponse(200, {
          data: { deviceId, status: "active", keyGeneration: 1, registrationStatus: "registered" }
        })
      ]
    },
    {
      name: "mismatched device",
      responses: [
        jsonResponse(200, { data: challenge }),
        jsonResponse(200, {
          data: { deviceId: "a".repeat(64), status: "active", keyGeneration: 1 }
        })
      ]
    },
    {
      name: "inactive server projection",
      responses: [
        jsonResponse(200, { data: challenge }),
        jsonResponse(200, { data: { deviceId, status: "revoked", keyGeneration: 1 } })
      ]
    },
    {
      name: "wrong key generation",
      responses: [
        jsonResponse(200, { data: challenge }),
        jsonResponse(200, { data: { deviceId, status: "active", keyGeneration: 2 } })
      ]
    }
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const current = fixture({ responses: entry.responses });
      await assert.rejects(current.client.register(), {
        code: "desktop_device_registration_response_invalid"
      });
      assert.equal(current.identityStore.marked.length, 0);
      assert.equal((await current.identityStore.getIdentity()).registrationStatus, "unregistered");
    });
  }
});

test("initial registration fails closed unless the durable proof uses generation 1 sequence 1", async () => {
  const identityStore = new FakeIdentityStore({ sequence: "2" });
  const current = fixture({ identityStore });
  await assert.rejects(current.client.register(), {
    code: "desktop_device_registration_recovery_required"
  });
  assert.equal(current.requests.length, 1, "only the unsigned challenge request may leave Main");
  assert.equal(identityStore.marked.length, 0);
});

test("tampered signed headers fail before device create and cannot consume a forged success", async () => {
  const identityStore = new FakeIdentityStore({ tamperHeader: "X-AiCRM-Content-SHA256" });
  const current = fixture({ identityStore });
  await assert.rejects(current.client.register(), {
    code: "desktop_device_registration_recovery_required"
  });
  assert.equal(current.requests.length, 1, "tampered proof must not reach device create");
  assert.equal(identityStore.marked.length, 0);
});

test("server errors are sanitized and never mark a device registered", async () => {
  const current = fixture({
    responses: [
      jsonResponse(200, { data: challenge }),
      jsonResponse(409, {
        error: {
          code: "device_proof_replayed",
          message: `do not echo ${sessionToken}`
        }
      })
    ]
  });
  await assert.rejects(
    current.client.register(),
    (error) =>
      error.code === "desktop_device_registration_rejected" &&
      error.status === 409 &&
      error.serverCode === "device_proof_replayed" &&
      !error.message.includes(sessionToken)
  );
  assert.equal(current.identityStore.marked.length, 0);
});

test("registration remains Main-only and is not exposed as IPC or a Codex capability", async () => {
  const [mainIndex, deviceIpc, preloadBridge, preloadTypes, constants] = await Promise.all([
    readFile(new URL("./index.ts", import.meta.url), "utf8"),
    readFile(new URL("./ipc/desktop-device-ipc.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/constants.ts", import.meta.url), "utf8")
  ]);
  const exposed = `${mainIndex}\n${deviceIpc}\n${preloadBridge}\n${preloadTypes}\n${constants}`;
  for (const forbidden of [
    "desktop-device-registration-client",
    "DesktopDeviceRegistrationClient",
    "signRequest",
    "privateKeyPkcs8",
    "desktop-device:register"
  ]) {
    assert.equal(exposed.includes(forbidden), false, `renderer/IPC surface contains ${forbidden}`);
  }
  assert.match(mainIndex, /registerDesktopDeviceIpc\(\)/);
  assert.match(deviceIpc, /getIdentityStore\(\)\.getIdentity\(\)/);
});
