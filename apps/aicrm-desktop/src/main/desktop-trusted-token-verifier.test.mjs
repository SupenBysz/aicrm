import assert from "node:assert/strict";
import {
  createPrivateKey,
  createPublicKey,
  sign as signEd25519
} from "node:crypto";
import test from "node:test";

import {
  DesktopTrustedTokenVerificationError,
  verifyDesktopAuthorizationHandoffToken,
  verifyDesktopTrustedToken
} from "./desktop-trusted-token-verifier.ts";

const PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX_BYTES = 12;
const IAT = Date.parse("2026-07-13T00:00:00Z") / 1000;
const NOW = new Date((IAT + 1) * 1000);
const NONCE = "AAECAwQFBgcICQoLDA0ODw";
const DEVICE_ID = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const BINDING_DIGEST = "b".repeat(64);
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    PKCS8_SEED_PREFIX,
    Uint8Array.from({ length: 32 }, (_, index) => index)
  ]),
  format: "der",
  type: "pkcs8"
});
const PUBLIC_KEY = Buffer.from(
  createPublicKey(PRIVATE_KEY).export({ format: "der", type: "spki" })
).subarray(SPKI_PREFIX_BYTES);
const PUBLIC_KEY_X = PUBLIC_KEY.toString("base64url");
const VECTOR_HANDOFF_TOKEN =
  "eyJhbGciOiJFZERTQSIsImtpZCI6InNlcnZlcl9rZXlfMSIsInR5cCI6IkpXVCJ9." +
  "eyJ2IjoxLCJpc3MiOiJhaWNybS1hZ2VudC1leGVjdXRvciIsImF1ZCI6ImFpY3JtLWRlc2t0b3AiLCJqdGkiOiJoYW5kb2ZmXzEiLCJwdXJwb3NlIjoiYXV0aG9yaXphdGlvbl9oYW5kb2ZmIiwibm9uY2UiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R3IiwiaWF0IjoxNzgzOTAwODAwLCJleHAiOjE3ODM5MDA5MjAsImFjdG9ySWQiOiJ1c2VyXzEiLCJzZXNzaW9uSWQiOiJzZXNzaW9uXzEiLCJleGVjdXRvcklkIjoiZXhlY3V0b3JfMSIsImRldmljZUlkIjoiNTY0NzVhYTc1NDYzNDc0YzAyODVkZjVkYmYyYmNhYjczZGE2NTEzNTg4MzllOWI3NzQ4MWIyZWFiMTA3NzA4YyIsImhhbmRvZmZJZCI6ImhhbmRvZmZfMSIsImV4cGVjdGVkU2Vzc2lvblJldmlzaW9uIjoyfQ." +
  "uw-Xv4pbePVicr8xvlowktu8KtT_NuBsmchlSv45gGPP5O5kM4wEVhr16nNp9G9q1dB0X4CdgiRp_W2l8mTGCw";

function verificationKey(overrides = {}) {
  return {
    kid: "server_key_1",
    kty: "OKP",
    crv: "Ed25519",
    alg: "EdDSA",
    use: "sig",
    x: PUBLIC_KEY_X,
    signingNotBefore: "2026-07-12T23:59:00Z",
    signingNotAfter: null,
    verifyUntil: null,
    ...overrides
  };
}

function keyring(overrides = {}) {
  return {
    schemaVersion: 1,
    issuer: "aicrm-agent-executor",
    revision: 1,
    activeKid: "server_key_1",
    generatedAt: "2026-07-13T00:00:00Z",
    refreshAfterSeconds: 30,
    maxTokenLifetimeSeconds: 600,
    desktopAudiences: [
      "aicrm-desktop",
      "aicrm-desktop-claim",
      "aicrm-desktop-activation",
      "aicrm-desktop-command"
    ],
    keyringDigest: "a".repeat(64),
    keys: [verificationKey()],
    ...overrides
  };
}

function baseClaims(aud, purpose, jti, ttl) {
  return {
    v: 1,
    iss: "aicrm-agent-executor",
    aud,
    jti,
    purpose,
    nonce: NONCE,
    iat: IAT,
    exp: IAT + ttl
  };
}

function purposeCases() {
  const executorId = "executor_1";
  const actorId = "user_1";
  const sessionId = "session_1";
  const operationId = "operation_1";
  const handoffId = "handoff_1";
  const activationId = "activation_1";
  const revocationId = "revocation_1";
  return [
    {
      name: "desktop handoff",
      claims: {
        ...baseClaims("aicrm-desktop", "authorization_handoff", handoffId, 120),
        actorId,
        sessionId,
        executorId,
        deviceId: DEVICE_ID,
        handoffId,
        expectedSessionRevision: 2
      },
      target: {
        audience: "aicrm-desktop",
        purpose: "authorization_handoff",
        executorId,
        actorId,
        sessionId,
        handoffId,
        expectedSessionRevision: 2
      }
    },
    {
      name: "claim",
      claims: {
        ...baseClaims("aicrm-desktop-claim", "authorization_claim", handoffId, 300),
        sessionId,
        executorId,
        deviceId: DEVICE_ID,
        handoffId,
        expectedSessionRevision: 3
      },
      target: {
        audience: "aicrm-desktop-claim",
        purpose: "authorization_claim",
        executorId,
        sessionId,
        handoffId,
        expectedSessionRevision: 3
      }
    },
    {
      name: "activation",
      claims: {
        ...baseClaims(
          "aicrm-desktop-activation",
          "credential_activation",
          activationId,
          600
        ),
        sessionId,
        executorId,
        deviceId: DEVICE_ID,
        activationId,
        operationId,
        bindingDigest: BINDING_DIGEST,
        credentialRevision: 4,
        leaseEpoch: 5,
        sourceCredentialRevision: 0,
        revocationEpoch: 0
      },
      target: {
        audience: "aicrm-desktop-activation",
        purpose: "credential_activation",
        executorId,
        sessionId,
        operationId,
        activationId,
        bindingDigest: BINDING_DIGEST,
        credentialRevision: 4,
        leaseEpoch: 5,
        sourceCredentialRevision: 0,
        revocationEpoch: 0
      }
    },
    ...["authorization_cancel", "authorization_reopen"].map((purpose) => ({
      name: purpose,
      claims: {
        ...baseClaims("aicrm-desktop-command", purpose, operationId, 120),
        actorId,
        sessionId,
        executorId,
        deviceId: DEVICE_ID,
        operationId,
        expectedSessionRevision: 6
      },
      target: {
        audience: "aicrm-desktop-command",
        purpose,
        executorId,
        actorId,
        sessionId,
        operationId,
        expectedSessionRevision: 6
      }
    })),
    {
      name: "credential verify",
      claims: {
        ...baseClaims("aicrm-desktop-command", "credential_verify", operationId, 120),
        actorId,
        executorId,
        deviceId: DEVICE_ID,
        operationId,
        expectedExecutorRevision: 7,
        expectedCredentialRevision: 8
      },
      target: {
        audience: "aicrm-desktop-command",
        purpose: "credential_verify",
        executorId,
        actorId,
        operationId,
        expectedExecutorRevision: 7,
        expectedCredentialRevision: 8
      }
    },
    {
      name: "model catalog refresh",
      claims: {
        ...baseClaims("aicrm-desktop-command", "model_catalog_refresh", operationId, 120),
        actorId,
        executorId,
        deviceId: DEVICE_ID,
        operationId,
        expectedExecutorRevision: 7,
        expectedCatalogRevision: 0
      },
      target: {
        audience: "aicrm-desktop-command",
        purpose: "model_catalog_refresh",
        executorId,
        actorId,
        operationId,
        expectedExecutorRevision: 7,
        expectedCatalogRevision: 0
      }
    },
    {
      name: "readiness check",
      claims: {
        ...baseClaims("aicrm-desktop-command", "readiness_check", operationId, 120),
        actorId,
        executorId,
        deviceId: DEVICE_ID,
        operationId,
        expectedExecutorRevision: 7,
        expectedCredentialRevision: 8,
        expectedCatalogRevision: 0
      },
      target: {
        audience: "aicrm-desktop-command",
        purpose: "readiness_check",
        executorId,
        actorId,
        operationId,
        expectedExecutorRevision: 7,
        expectedCredentialRevision: 8,
        expectedCatalogRevision: 0
      }
    },
    {
      name: "credential logout",
      claims: {
        ...baseClaims("aicrm-desktop-command", "credential_logout", revocationId, 120),
        actorId,
        executorId,
        deviceId: DEVICE_ID,
        operationId,
        revocationId,
        credentialRevision: 8,
        revocationEpoch: 9
      },
      target: {
        audience: "aicrm-desktop-command",
        purpose: "credential_logout",
        executorId,
        actorId,
        operationId,
        revocationId,
        credentialRevision: 8,
        revocationEpoch: 9
      }
    }
  ];
}

function issue(claims, header = { alg: "EdDSA", kid: "server_key_1", typ: "JWT" }) {
  return issueRaw(JSON.stringify(header), JSON.stringify(claims));
}

function issueRaw(headerJson, payloadJson) {
  const header = Buffer.from(headerJson, "utf8").toString("base64url");
  const payload = Buffer.from(payloadJson, "utf8").toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = signEd25519(null, Buffer.from(signingInput, "ascii"), PRIVATE_KEY);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function verify(testCase, overrides = {}) {
  return verifyDesktopTrustedToken({
    token: issue(testCase.claims),
    keyring: keyring(),
    now: NOW,
    registeredDeviceId: DEVICE_ID,
    expectedTarget: testCase.target,
    ...overrides
  });
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof DesktopTrustedTokenVerificationError);
    assert.equal(error.code, code);
    return true;
  });
}

function handoffInput(overrides = {}) {
  const current = purposeCases()[0];
  return {
    token: issue(current.claims),
    keyring: keyring(),
    now: NOW,
    registeredDeviceId: DEVICE_ID,
    sessionId: current.claims.sessionId,
    executorId: current.claims.executorId,
    handoffId: current.claims.handoffId,
    ...overrides
  };
}

test("fixed-seed Ed25519 vectors verify all locked Desktop purposes and six command purposes", () => {
  assert.equal(PUBLIC_KEY_X, "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg");
  const cases = purposeCases();
  assert.equal(issue(cases[0].claims), VECTOR_HANDOFF_TOKEN);
  assert.equal(
    cases.filter((item) => item.claims.aud === "aicrm-desktop-command").length,
    6
  );
  for (const testCase of cases) {
    const claims = verify(testCase);
    assert.equal(claims.jti, testCase.claims.jti, testCase.name);
    assert.equal(claims.deviceId, DEVICE_ID, testCase.name);
    assert.equal(Object.isFrozen(claims), true, testCase.name);
  }
});

test("tampering, unknown keys, non-canonical header and payload representations fail closed", () => {
  const current = purposeCases()[0];
  const token = issue(current.claims);
  const parts = token.split(".");
  const signature = Buffer.from(parts[2], "base64url");
  signature[0] ^= 1;
  expectCode("desktop_trusted_token_signature_invalid", () =>
    verify(current, { token: `${parts[0]}.${parts[1]}.${signature.toString("base64url")}` })
  );
  const payload = Buffer.from(parts[1], "base64url");
  payload[payload.length - 2] ^= 1;
  expectCode("desktop_trusted_token_signature_invalid", () =>
    verify(current, {
      token: `${parts[0]}.${payload.toString("base64url")}.${parts[2]}`
    })
  );
  expectCode("desktop_trusted_token_unknown_key", () =>
    verify(current, {
      keyring: keyring({ keys: [verificationKey({ kid: "server_key_2" })] })
    })
  );

  const extraHeader = issue(current.claims, {
    alg: "EdDSA",
    kid: "server_key_1",
    typ: "JWT",
    extra: true
  });
  expectCode("desktop_trusted_token_malformed", () => verify(current, { token: extraHeader }));
  const reorderedHeader = issueRaw(
    '{"kid":"server_key_1","alg":"EdDSA","typ":"JWT"}',
    JSON.stringify(current.claims)
  );
  expectCode("desktop_trusted_token_malformed", () =>
    verify(current, { token: reorderedHeader })
  );

  const extraPayload = issue({ ...current.claims, extra: true });
  expectCode("desktop_trusted_token_claims_invalid", () =>
    verify(current, { token: extraPayload })
  );
  const reorderedPayload = issueRaw(
    JSON.stringify({ alg: "EdDSA", kid: "server_key_1", typ: "JWT" }),
    JSON.stringify({ iss: current.claims.iss, v: current.claims.v, ...current.claims })
  );
  expectCode("desktop_trusted_token_claims_invalid", () =>
    verify(current, { token: reorderedPayload })
  );
  expectCode("desktop_trusted_token_malformed", () =>
    verify(current, { token: `${parts[0]}=.${parts[1]}.${parts[2]}` })
  );
  expectCode("desktop_trusted_token_malformed", () =>
    verify(current, { token: `a.${"a".repeat(16 << 10)}.a` })
  );
});

test("TTL, safe integers, token id relations, registered device and exact target CAS are mandatory", () => {
  const current = purposeCases()[7];
  expectCode("desktop_trusted_token_claims_invalid", () =>
    verify(current, { token: issue({ ...current.claims, exp: current.claims.exp + 1 }) })
  );
  expectCode("desktop_trusted_token_claims_invalid", () =>
    verify(current, {
      token: issue({ ...current.claims, expectedExecutorRevision: Number.MAX_SAFE_INTEGER + 1 })
    })
  );
  expectCode("desktop_trusted_token_claims_invalid", () =>
    verify(current, { token: issue({ ...current.claims, jti: "operation_other" }) })
  );
  expectCode("desktop_trusted_token_device_mismatch", () =>
    verify(current, { registeredDeviceId: "c".repeat(64) })
  );
  expectCode("desktop_trusted_token_target_mismatch", () =>
    verify(current, {
      expectedTarget: {
        ...current.target,
        expectedExecutorRevision: current.target.expectedExecutorRevision + 1
      }
    })
  );
  expectCode("desktop_trusted_token_unsupported", () =>
    verify(current, { expectedTarget: { ...current.target, unexpected: true } })
  );
});

test("signing windows are half-open and retired keys stop verifying at verifyUntil", () => {
  const current = purposeCases()[0];
  expectCode("desktop_trusted_token_key_window_mismatch", () =>
    verify(current, {
      keyring: keyring({
        keys: [
          verificationKey({
            signingNotBefore: "2026-07-12T23:00:00Z",
            signingNotAfter: "2026-07-13T00:00:00Z",
            verifyUntil: "2026-07-13T00:10:00Z"
          })
        ]
      })
    })
  );
  expectCode("desktop_trusted_token_key_retired", () =>
    verify(current, {
      now: new Date("2026-07-13T00:10:01Z"),
      keyring: keyring({
        keys: [
          verificationKey({
            signingNotBefore: "2026-07-12T23:00:00Z",
            signingNotAfter: "2026-07-13T00:00:01Z",
            verifyUntil: "2026-07-13T00:10:01Z"
          })
        ]
      })
    })
  );
});

test("operation-confirmation audience and purposes are never accepted by the Desktop verifier", () => {
  const supported = purposeCases()[5];
  const confirmationClaims = {
    ...baseClaims("aicrm-operation-confirmation", "force_revoke", "confirmation_1", 300),
    actorId: "user_1",
    sessionId: "session_1",
    executorId: "executor_1",
    expectedRevision: 2
  };
  expectCode("desktop_trusted_token_unsupported", () =>
    verify(supported, { token: issue(confirmationClaims) })
  );
  expectCode("desktop_trusted_token_unsupported", () =>
    verify(supported, {
      expectedTarget: {
        audience: "aicrm-operation-confirmation",
        purpose: "force_revoke",
        executorId: "executor_1"
      }
    })
  );
});

test("dedicated handoff verifier returns only server-signed actor and revision facts", () => {
  const facts = verifyDesktopAuthorizationHandoffToken(handoffInput());
  assert.deepEqual(facts, {
    actorId: "user_1",
    expectedSessionRevision: 2
  });
  assert.deepEqual(Object.keys(facts).sort(), ["actorId", "expectedSessionRevision"]);
  assert.equal(Object.isFrozen(facts), true);
  const serialized = JSON.stringify(facts);
  for (const forbidden of [VECTOR_HANDOFF_TOKEN, "server_key_1", PUBLIC_KEY_X, "signature"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("renderer actor and revision inputs are forbidden and unsigned claim forgery fails signature verification", () => {
  expectCode("desktop_trusted_token_input_invalid", () =>
    verifyDesktopAuthorizationHandoffToken({
      ...handoffInput(),
      actorId: "renderer_actor"
    })
  );
  expectCode("desktop_trusted_token_input_invalid", () =>
    verifyDesktopAuthorizationHandoffToken({
      ...handoffInput(),
      expectedSessionRevision: 999
    })
  );

  const current = purposeCases()[0];
  const token = issue(current.claims);
  const parts = token.split(".");
  const forgedClaims = {
    ...JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    actorId: "forged_actor",
    expectedSessionRevision: 999
  };
  const forgedPayload = Buffer.from(JSON.stringify(forgedClaims), "utf8").toString("base64url");
  expectCode("desktop_trusted_token_signature_invalid", () =>
    verifyDesktopAuthorizationHandoffToken(
      handoffInput({ token: `${parts[0]}.${forgedPayload}.${parts[2]}` })
    )
  );
});

test("dedicated handoff verifier binds session, executor, handoff, audience, and purpose", () => {
  for (const override of [
    { sessionId: "session_other" },
    { executorId: "executor_other" },
    { handoffId: "handoff_other" }
  ]) {
    expectCode("desktop_trusted_token_target_mismatch", () =>
      verifyDesktopAuthorizationHandoffToken(handoffInput(override))
    );
  }
  const claim = purposeCases()[1];
  expectCode("desktop_trusted_token_target_mismatch", () =>
    verifyDesktopAuthorizationHandoffToken(handoffInput({ token: issue(claim.claims) }))
  );
});

test("dedicated handoff verifier preserves unknown-kid as the recognizable refresh error", () => {
  const current = purposeCases()[0];
  const unknownKidToken = issue(current.claims, {
    alg: "EdDSA",
    kid: "server_key_missing",
    typ: "JWT"
  });
  expectCode("desktop_trusted_token_unknown_key", () =>
    verifyDesktopAuthorizationHandoffToken(handoffInput({ token: unknownKidToken }))
  );
});

test("dedicated handoff verifier rejects non-canonical compact JWS representations", () => {
  const current = purposeCases()[0];
  const token = issue(current.claims);
  const parts = token.split(".");
  expectCode("desktop_trusted_token_malformed", () =>
    verifyDesktopAuthorizationHandoffToken(
      handoffInput({ token: `${parts[0]}.${parts[1]}=.${parts[2]}` })
    )
  );
  const reorderedHeader = issueRaw(
    '{"kid":"server_key_1","alg":"EdDSA","typ":"JWT"}',
    JSON.stringify(current.claims)
  );
  expectCode("desktop_trusted_token_malformed", () =>
    verifyDesktopAuthorizationHandoffToken(handoffInput({ token: reorderedHeader }))
  );
  const reorderedPayload = issueRaw(
    JSON.stringify({ alg: "EdDSA", kid: "server_key_1", typ: "JWT" }),
    JSON.stringify({ iss: current.claims.iss, v: current.claims.v, ...current.claims })
  );
  expectCode("desktop_trusted_token_claims_invalid", () =>
    verifyDesktopAuthorizationHandoffToken(handoffInput({ token: reorderedPayload }))
  );
});
