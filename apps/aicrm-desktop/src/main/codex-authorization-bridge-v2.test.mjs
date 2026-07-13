import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CODEX_AUTHORIZATION_INPUT_INVALID_ERROR,
  CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR,
  CODEX_AUTHORIZATION_RUNTIME_UNAVAILABLE_ERROR,
  CODEX_DESKTOP_AUTHORIZATION_RUNTIME_READY,
  cancelCodexAuthorization,
  checkCodexAuthorizationReadiness,
  createCodexAuthorizationBridgeV2Handlers,
  logoutCodexCredential,
  queryCodexAuthorizationCapabilities,
  queryCodexAuthorizationSnapshot,
  queryCodexModelCatalog,
  refreshCodexModelCatalog,
  reopenCodexAuthorization,
  startCodexAuthorization,
  verifyCodexAuthorization
} from "./codex-authorization-bridge-v2-policy.ts";

const handoffTicket = "eyJhbGciOiJFZERTQSJ9.eyJwdXJwb3NlIjoiYXV0aG9yaXphdGlvbiJ9.c2lnbmF0dXJl";
const commandTicket = "eyJhbGciOiJFZERTQSJ9.eyJwdXJwb3NlIjoiY29tbWFuZCJ9.c2lnbmF0dXJl";

const validStart = {
  sessionId: "authsession_1",
  executorId: "aiexec_1",
  sessionRevision: 1,
  handoffId: "handoff_1",
  handoffTicket
};
const validSessionCommand = {
  sessionId: "authsession_1",
  operationId: "operation_1",
  expectedSessionRevision: 3,
  commandTicket
};
const validVerify = {
  executorId: "aiexec_1",
  operationId: "operation_2",
  expectedExecutorRevision: 4,
  expectedCredentialRevision: 2,
  commandTicket
};
const validReadiness = {
  ...validVerify,
  expectedCatalogRevision: 0
};
const validCatalogRefresh = {
  executorId: "aiexec_1",
  operationId: "operation_3",
  expectedExecutorRevision: 4,
  expectedCatalogRevision: 0,
  commandTicket
};
const validLogout = {
  executorId: "aiexec_1",
  revocationId: "revocation_1",
  operationId: "operation_4",
  credentialRevision: 2,
  commandTicket
};

const validSnapshot = {
  sessionId: "authsession_1",
  executorId: "aiexec_1",
  sequence: 3,
  status: "waiting_user",
  canReopen: true,
  canCancel: true
};
const validCatalog = {
  executorId: "aiexec_1",
  credentialRevision: 2,
  catalogRevision: 4,
  models: [{
    modelKey: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    inputModalities: ["text"],
    supportedReasoningEfforts: ["medium"],
    hidden: false,
    status: "available"
  }],
  observedAt: "2026-07-13T00:00:00.000Z"
};
const validVerification = {
  executorId: "aiexec_1",
  operationId: "operation_2",
  credentialRevision: 2,
  accountFingerprint: "a".repeat(64),
  checkedAt: "2026-07-13T00:00:00.000Z",
  authorized: true
};
const validReadinessResult = {
  executorId: "aiexec_1",
  operationId: "operation_2",
  credentialRevision: 2,
  catalogRevision: 4,
  status: "ready",
  observedAt: "2026-07-13T00:00:00.000Z"
};
const validLogoutResult = {
  executorId: "aiexec_1",
  operationId: "operation_4",
  revocationId: "revocation_1",
  credentialRevision: 2,
  revocationEpoch: 1,
  result: "succeeded",
  completedAt: "2026-07-13T00:00:00.000Z"
};

function validOutput(method) {
  const data = method === "capabilities"
    ? {
        bridgeVersion: 2,
        supportsAppServerAuth: true,
        supportsDeviceProof: true,
        supportsSignedCatalog: true
      }
    : ["start", "getSnapshot", "cancel", "reopen"].includes(method)
      ? validSnapshot
      : method === "verify"
        ? validVerification
        : method === "readiness"
          ? validReadinessResult
          : ["getCatalog", "refresh"].includes(method)
            ? validCatalog
            : validLogoutResult;
  return { ok: true, data: structuredClone(data) };
}

function runtimeFixture(implementation = async (method) => validOutput(method)) {
  const calls = [];
  const invoke = async (method, input) => {
    calls.push([method, input]);
    return implementation(method, input);
  };
  return {
    calls,
    runtime: {
      capabilities: () => invoke("capabilities", undefined),
      start: (input) => invoke("start", input),
      getSnapshot: (input) => invoke("getSnapshot", input),
      cancel: (input) => invoke("cancel", input),
      reopen: (input) => invoke("reopen", input),
      verify: (input) => invoke("verify", input),
      readiness: (input) => invoke("readiness", input),
      getCatalog: (input) => invoke("getCatalog", input),
      refresh: (input) => invoke("refresh", input),
      logout: (input) => invoke("logout", input)
    }
  };
}

function handlerCases(handlers) {
  return [
    ["capabilities", () => handlers.getCapabilities(), undefined],
    ["start", () => handlers.start(validStart), validStart],
    ["getSnapshot", () => handlers.getSnapshot("authsession_1"), "authsession_1"],
    ["cancel", () => handlers.cancel(validSessionCommand), validSessionCommand],
    ["reopen", () => handlers.reopen(validSessionCommand), validSessionCommand],
    ["verify", () => handlers.verify(validVerify), validVerify],
    ["readiness", () => handlers.readiness(validReadiness), validReadiness],
    ["getCatalog", () => handlers.getCatalog("aiexec_1"), "aiexec_1"],
    ["refresh", () => handlers.refresh(validCatalogRefresh), validCatalogRefresh],
    ["logout", () => handlers.logout(validLogout), validLogout]
  ];
}

test("Bridge v2 methods exist but never advertise or execute an unavailable trusted runtime", () => {
  const cases = [
    ["capabilities", () => queryCodexAuthorizationCapabilities([])],
    ["start", () => startCodexAuthorization(validStart)],
    ["snapshot", () => queryCodexAuthorizationSnapshot("authsession_1")],
    ["cancel", () => cancelCodexAuthorization(validSessionCommand)],
    ["reopen", () => reopenCodexAuthorization(validSessionCommand)],
    ["verify", () => verifyCodexAuthorization(validVerify)],
    ["readiness", () => checkCodexAuthorizationReadiness(validReadiness)],
    ["catalog", () => queryCodexModelCatalog("aiexec_1")],
    ["catalog refresh", () => refreshCodexModelCatalog(validCatalogRefresh)],
    ["logout", () => logoutCodexCredential(validLogout)]
  ];

  for (const [name, execute] of cases) {
    const result = execute();
    assert.deepEqual(result, { ok: false, error: CODEX_AUTHORIZATION_RUNTIME_UNAVAILABLE_ERROR }, String(name));
    assert.equal("data" in result, false, `${name} fabricated trusted data`);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(handoffTicket), false, `${name} echoed handoff ticket`);
    assert.equal(serialized.includes(commandTicket), false, `${name} echoed command ticket`);
  }
});

test("Bridge v2 independent production gate is source-locked false and never consults an injected runtime", async () => {
  assert.equal(CODEX_DESKTOP_AUTHORIZATION_RUNTIME_READY, false);
  const current = runtimeFixture();
  let providerCalls = 0;
  const handlers = createCodexAuthorizationBridgeV2Handlers({
    ready: CODEX_DESKTOP_AUTHORIZATION_RUNTIME_READY,
    runtimeProvider() {
      providerCalls += 1;
      return current.runtime;
    }
  });

  for (const [name, execute] of handlerCases(handlers)) {
    assert.deepEqual(
      await execute(),
      { ok: false, error: CODEX_AUTHORIZATION_RUNTIME_UNAVAILABLE_ERROR },
      String(name)
    );
  }
  assert.equal(providerCalls, 0);
  assert.deepEqual(current.calls, []);

  const missingRuntime = createCodexAuthorizationBridgeV2Handlers({
    ready: true,
    runtime: null
  });
  for (const [name, execute] of handlerCases(missingRuntime)) {
    assert.deepEqual(
      await execute(),
      { ok: false, error: CODEX_AUTHORIZATION_RUNTIME_UNAVAILABLE_ERROR },
      `missing ${name}`
    );
  }

  const [policy, index] = await Promise.all([
    readFile(new URL("./codex-authorization-bridge-v2-policy.ts", import.meta.url), "utf8"),
    readFile(new URL("./index.ts", import.meta.url), "utf8")
  ]);
  assert.match(
    policy,
    /export const CODEX_DESKTOP_AUTHORIZATION_RUNTIME_READY = false;/
  );
  assert.match(index, /registerCodexExecutorIpc\(\);/);
});

test("Bridge v2 true-gated runtime delegates every exact DTO and returns validated clones", async () => {
  const results = new Map();
  const current = runtimeFixture(async (method) => {
    await Promise.resolve();
    const result = validOutput(method);
    results.set(method, result);
    return result;
  });
  const handlers = createCodexAuthorizationBridgeV2Handlers({
    ready: true,
    runtime: current.runtime
  });

  const expectedCalls = [];
  for (const [method, execute, input] of handlerCases(handlers)) {
    const result = await execute();
    assert.deepEqual(result, results.get(method));
    assert.notStrictEqual(result, results.get(method));
    assert.notStrictEqual(result.data, results.get(method).data);
    expectedCalls.push([method, input]);
  }
  assert.deepEqual(current.calls, expectedCalls);
  for (let index = 0; index < expectedCalls.length; index += 1) {
    const actualInput = current.calls[index][1];
    const expectedInput = expectedCalls[index][1];
    if (expectedInput !== null && typeof expectedInput === "object") {
      assert.deepEqual(actualInput, expectedInput);
      assert.notStrictEqual(actualInput, expectedInput);
      assert.equal(Object.isFrozen(actualInput), true);
    } else {
      assert.strictEqual(actualInput, expectedInput);
    }
  }
});

test("Bridge v2 captures hostile input descriptors once and never delegates raw renderer objects", async () => {
  const current = runtimeFixture();
  const handlers = createCodexAuthorizationBridgeV2Handlers({ ready: true, runtime: current.runtime });

  let accessorReads = 0;
  const accessorInput = { ...validStart };
  Object.defineProperty(accessorInput, "executorId", {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error(`${handoffTicket} /private/renderer-home`);
    }
  });
  assert.deepEqual(await handlers.start(accessorInput), {
    ok: false,
    error: CODEX_AUTHORIZATION_INPUT_INVALID_ERROR
  });

  const nonEnumerableInput = { ...validStart };
  Object.defineProperty(nonEnumerableInput, "executorId", {
    value: validStart.executorId,
    enumerable: false
  });
  const symbolInput = { ...validStart, [Symbol("secret")]: handoffTicket };
  const inheritedInput = Object.assign(Object.create({ inherited: true }), validStart);
  for (const input of [nonEnumerableInput, symbolInput, inheritedInput]) {
    assert.deepEqual(await handlers.start(input), {
      ok: false,
      error: CODEX_AUTHORIZATION_INPUT_INVALID_ERROR
    });
  }
  assert.equal(accessorReads, 0);

  for (const trap of ["ownKeys", "getOwnPropertyDescriptor"]) {
    const throwingInput = new Proxy({ ...validStart }, {
      [trap]() {
        throw new Error(`${commandTicket} /private/renderer-home`);
      }
    });
    const result = await handlers.start(throwingInput);
    assert.deepEqual(result, { ok: false, error: CODEX_AUTHORIZATION_INPUT_INVALID_ERROR });
    assert.equal(JSON.stringify(result).includes(commandTicket), false);
    assert.equal(JSON.stringify(result).includes("/private/renderer-home"), false);
  }

  let executorDescriptorReads = 0;
  let rawInputReads = 0;
  const alternatingInput = new Proxy({ ...validStart }, {
    get() {
      rawInputReads += 1;
      throw new Error(`canary_${commandTicket}`);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== "executorId" || !descriptor) return descriptor;
      executorDescriptorReads += 1;
      return {
        ...descriptor,
        value: executorDescriptorReads === 1 ? validStart.executorId : `canary_${handoffTicket}`
      };
    }
  });
  const result = await handlers.start(alternatingInput);
  assert.equal(result.ok, true);
  assert.equal(executorDescriptorReads, 1);
  assert.equal(rawInputReads, 0);
  assert.equal(current.calls.length, 1);
  assert.deepEqual(current.calls[0][1], validStart);
  assert.notStrictEqual(current.calls[0][1], alternatingInput);
  assert.equal(Object.isFrozen(current.calls[0][1]), true);
});

test("Bridge v2 captures hostile runtime projections once without getter, Proxy, or prototype leakage", async () => {
  let outerDataDescriptorReads = 0;
  let executorDescriptorReads = 0;
  let rawOutputReads = 0;
  const hostileSnapshot = new Proxy({ ...validSnapshot }, {
    get() {
      rawOutputReads += 1;
      throw new Error(`canary_${handoffTicket}`);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== "executorId" || !descriptor) return descriptor;
      executorDescriptorReads += 1;
      return {
        ...descriptor,
        value: executorDescriptorReads === 1 ? validSnapshot.executorId : `canary_${handoffTicket}`
      };
    }
  });
  const hostileResult = new Proxy({ ok: true, data: hostileSnapshot }, {
    get(target, key, receiver) {
      if (key === "then") return Reflect.get(target, key, receiver);
      rawOutputReads += 1;
      throw new Error(`canary_${commandTicket}`);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== "data" || !descriptor) return descriptor;
      outerDataDescriptorReads += 1;
      return {
        ...descriptor,
        value: outerDataDescriptorReads === 1
          ? hostileSnapshot
          : { ...validSnapshot, executorId: `canary_${commandTicket}` }
      };
    }
  });
  const current = runtimeFixture(async () => hostileResult);
  const handlers = createCodexAuthorizationBridgeV2Handlers({ ready: true, runtime: current.runtime });
  const result = await handlers.start(validStart);
  assert.equal(result.ok, true);
  assert.equal(result.data.executorId, validSnapshot.executorId);
  assert.equal(outerDataDescriptorReads, 1);
  assert.equal(executorDescriptorReads, 1);
  assert.equal(rawOutputReads, 0);
  assert.equal(JSON.stringify(result).includes("canary_"), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.data), true);

  let malformedAccessorReads = 0;
  const malformedOutputs = [
    Object.defineProperty({ ...validSnapshot }, "executorId", {
      enumerable: true,
      get() {
        malformedAccessorReads += 1;
        return `canary_${handoffTicket}`;
      }
    }),
    Object.defineProperty({ ...validSnapshot }, "executorId", {
      value: validSnapshot.executorId,
      enumerable: false
    }),
    { ...validSnapshot, [Symbol("secret")]: commandTicket },
    Object.assign(Object.create({ inherited: true }), validSnapshot)
  ].map((data) => ({ ok: true, data }));
  malformedOutputs.push(new Proxy({ ok: true, data: { ...validSnapshot } }, {
    getOwnPropertyDescriptor() {
      throw new Error(`canary_${commandTicket}`);
    }
  }));
  for (const malformedOutput of malformedOutputs) {
    const malformed = runtimeFixture(async () => malformedOutput);
    const malformedHandlers = createCodexAuthorizationBridgeV2Handlers({
      ready: true,
      runtime: malformed.runtime
    });
    const rejected = await malformedHandlers.start(validStart);
    assert.deepEqual(rejected, { ok: false, error: CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR });
    assert.equal(JSON.stringify(rejected).includes(handoffTicket), false);
    assert.equal(JSON.stringify(rejected).includes(commandTicket), false);
  }
  assert.equal(malformedAccessorReads, 0);
});

test("Bridge v2 captures nested catalog arrays and model descriptors once", async () => {
  let modelDescriptorReads = 0;
  let arrayItemDescriptorReads = 0;
  let rawCatalogReads = 0;
  const hostileModel = new Proxy({ ...validCatalog.models[0] }, {
    get() {
      rawCatalogReads += 1;
      throw new Error(`canary_${handoffTicket}`);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== "modelKey" || !descriptor) return descriptor;
      modelDescriptorReads += 1;
      return {
        ...descriptor,
        value: modelDescriptorReads === 1 ? validCatalog.models[0].modelKey : `canary_${handoffTicket}`
      };
    }
  });
  const hostileModels = new Proxy([hostileModel], {
    get() {
      rawCatalogReads += 1;
      throw new Error(`canary_${commandTicket}`);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== "0" || !descriptor) return descriptor;
      arrayItemDescriptorReads += 1;
      return {
        ...descriptor,
        value: arrayItemDescriptorReads === 1
          ? hostileModel
          : { ...validCatalog.models[0], modelKey: `canary_${commandTicket}` }
      };
    }
  });
  const current = runtimeFixture(async () => ({
    ok: true,
    data: { ...validCatalog, models: hostileModels }
  }));
  const handlers = createCodexAuthorizationBridgeV2Handlers({ ready: true, runtime: current.runtime });
  const result = await handlers.getCatalog(validCatalog.executorId);
  assert.equal(result.ok, true);
  assert.equal(result.data.models[0].modelKey, validCatalog.models[0].modelKey);
  assert.equal(arrayItemDescriptorReads, 1);
  assert.equal(modelDescriptorReads, 1);
  assert.equal(rawCatalogReads, 0);
  assert.equal(JSON.stringify(result).includes("canary_"), false);
  assert.equal(Object.isFrozen(result.data.models), true);
  assert.equal(Object.isFrozen(result.data.models[0]), true);

  let arrayAccessorReads = 0;
  const accessorModels = [];
  Object.defineProperty(accessorModels, "0", {
    enumerable: true,
    get() {
      arrayAccessorReads += 1;
      return { canary: handoffTicket };
    }
  });
  const symbolModels = [{ ...validCatalog.models[0] }];
  symbolModels[Symbol("secret")] = commandTicket;
  const nonEnumerableModels = [{ ...validCatalog.models[0] }];
  Object.defineProperty(nonEnumerableModels, "0", {
    value: nonEnumerableModels[0],
    enumerable: false
  });
  class ForeignModels extends Array {}
  const foreignModels = new ForeignModels({ ...validCatalog.models[0] });
  for (const models of [accessorModels, symbolModels, nonEnumerableModels, foreignModels, new Array(1)]) {
    const malformed = runtimeFixture(async () => ({
      ok: true,
      data: { ...validCatalog, models }
    }));
    const malformedHandlers = createCodexAuthorizationBridgeV2Handlers({
      ready: true,
      runtime: malformed.runtime
    });
    const rejected = await malformedHandlers.getCatalog(validCatalog.executorId);
    assert.deepEqual(rejected, { ok: false, error: CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR });
  }
  assert.equal(arrayAccessorReads, 0);
});

test("Bridge v2 exact validators run before true-gated delegation", async () => {
  const current = runtimeFixture();
  const handlers = createCodexAuthorizationBridgeV2Handlers({ ready: true, runtime: current.runtime });
  const invalidCases = [
    () => handlers.start({ ...validStart, extra: true }),
    () => handlers.start({ ...validStart, sessionRevision: 0 }),
    () => handlers.getSnapshot("../authsession_1"),
    () => handlers.cancel({ ...validSessionCommand, commandTicket: "raw-ticket" }),
    () => handlers.reopen({ ...validSessionCommand, expectedSessionRevision: 0 }),
    () => handlers.verify({ ...validVerify, expectedCredentialRevision: 0 }),
    () => handlers.readiness({ ...validReadiness, expectedCatalogRevision: -1 }),
    () => handlers.getCatalog("https://example.invalid"),
    () => handlers.refresh({ ...validCatalogRefresh, result: "ready" }),
    () => handlers.logout({ ...validLogout, credentialRevision: 1.5 })
  ];
  for (const execute of invalidCases) {
    assert.deepEqual(await execute(), {
      ok: false,
      error: CODEX_AUTHORIZATION_INPUT_INVALID_ERROR
    });
  }
  assert.deepEqual(current.calls, []);
});

test("Bridge v2 normalizes every runtime exception without ticket, path, or raw message leakage", async () => {
  const sensitive = `${handoffTicket} ${commandTicket} /Users/private/.codex raw runtime failure`;
  const current = runtimeFixture(async () => {
    await Promise.resolve();
    throw new Error(sensitive);
  });
  const handlers = createCodexAuthorizationBridgeV2Handlers({ ready: true, runtime: current.runtime });
  for (const [name, execute] of handlerCases(handlers)) {
    const result = await execute();
    assert.deepEqual(
      result,
      { ok: false, error: CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR },
      String(name)
    );
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(handoffTicket), false);
    assert.equal(serialized.includes(commandTicket), false);
    assert.equal(serialized.includes("/Users/private"), false);
    assert.equal(serialized.includes("raw runtime failure"), false);
  }
  assert.equal(current.calls.length, 10);

  const providerFailure = createCodexAuthorizationBridgeV2Handlers({
    ready: true,
    runtimeProvider() {
      throw new Error(sensitive);
    }
  });
  assert.deepEqual(await providerFailure.getCapabilities(), {
    ok: false,
    error: CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR
  });
});

test("Bridge v2 rejects malformed success and failure projections without leaking runtime data", async () => {
  const sensitive = `${handoffTicket} ${commandTicket} /private/codex/home`;
  for (const implementation of [
    async () => ({ ok: true, data: { ticket: sensitive, path: "/private/codex/home" } }),
    async () => ({ ok: false, error: { code: "raw_error", message: sensitive } }),
    async (method) => {
      const output = validOutput(method);
      output.data.extra = sensitive;
      return output;
    }
  ]) {
    const current = runtimeFixture(implementation);
    const handlers = createCodexAuthorizationBridgeV2Handlers({
      ready: true,
      runtime: current.runtime
    });
    for (const [name, execute] of handlerCases(handlers)) {
      const result = await execute();
      assert.deepEqual(
        result,
        { ok: false, error: CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR },
        String(name)
      );
      assert.equal(JSON.stringify(result).includes(sensitive), false);
      assert.equal(JSON.stringify(result).includes("/private/codex/home"), false);
    }
  }
});

test("Bridge v2 enforces verification, readiness, catalog, and logout output invariants", async () => {
  const invalidData = {
    verify: { ...validVerification, authorized: false },
    readiness: { ...validReadinessResult, status: "degraded" },
    getCatalog: {
      ...validCatalog,
      models: [{ ...validCatalog.models[0], rawPath: "/private/codex/home" }]
    },
    refresh: { ...validCatalog, observedAt: "2026-07-13T00:00:00Z" },
    logout: { ...validLogoutResult, result: "failed" }
  };
  const current = runtimeFixture(async (method) => ({
    ok: true,
    data: structuredClone(invalidData[method] ?? validSnapshot)
  }));
  const handlers = createCodexAuthorizationBridgeV2Handlers({ ready: true, runtime: current.runtime });
  for (const [method, execute] of handlerCases(handlers)) {
    const result = await execute();
    if (method === "capabilities" || ["start", "getSnapshot", "cancel", "reopen"].includes(method)) {
      if (method === "capabilities") {
        assert.deepEqual(result, { ok: false, error: CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR });
      } else {
        assert.equal(result.ok, true);
      }
    } else {
      assert.deepEqual(result, { ok: false, error: CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR });
    }
  }
});

test("Bridge v2 never coerces or returns object-valued status fields", async () => {
  const sensitive = `${commandTicket} /private/runtime-home`;
  const objectStatus = {
    toString() {
      return "degraded";
    },
    canary: sensitive
  };
  for (const [method, data, execute] of [
    ["readiness", { ...validReadinessResult, status: objectStatus, reasonCode: "model_unavailable" },
      (handlers) => handlers.readiness(validReadiness)],
    ["logout", { ...validLogoutResult, result: objectStatus },
      (handlers) => handlers.logout(validLogout)]
  ]) {
    const current = runtimeFixture(async (calledMethod) => ({
      ok: true,
      data: calledMethod === method ? data : validOutput(calledMethod).data
    }));
    const handlers = createCodexAuthorizationBridgeV2Handlers({ ready: true, runtime: current.runtime });
    const result = await execute(handlers);
    assert.deepEqual(result, { ok: false, error: CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR });
    assert.equal(JSON.stringify(result).includes(sensitive), false);
  }
});

test("Bridge v2 accepts exact negative command outcomes and rejects impossible snapshot flags", async () => {
  const exactNegative = {
    verify: {
      ...validVerification,
      authorized: false,
      failureCode: "credential_expired"
    },
    readiness: {
      ...validReadinessResult,
      status: "degraded",
      reasonCode: "model_unavailable"
    },
    logout: {
      ...validLogoutResult,
      result: "failed",
      failureCode: "credential_logout_failed"
    },
    getCatalog: {
      ...validCatalog,
      models: [{ ...validCatalog.models[0], upgradeModelKey: "gpt-5.1-codex" }]
    },
    refresh: validCatalog
  };
  const current = runtimeFixture(async (method) => ({
    ok: true,
    data: structuredClone(exactNegative[method] ?? {
      ...validSnapshot,
      canCancel: method === "capabilities" ? true : false
    })
  }));
  const handlers = createCodexAuthorizationBridgeV2Handlers({ ready: true, runtime: current.runtime });
  for (const [method, execute] of handlerCases(handlers)) {
    const result = await execute();
    if (["verify", "readiness", "getCatalog", "refresh", "logout"].includes(method)) {
      assert.equal(result.ok, true, method);
    } else {
      assert.deepEqual(result, { ok: false, error: CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR });
    }
  }
});

test("Bridge v2 rejects raw IDs, missing tickets, extra fields, and malformed revisions", () => {
  const invalidCases = [
    queryCodexAuthorizationCapabilities([undefined]),
    startCodexAuthorization({ executorId: "aiexec_1" }),
    startCodexAuthorization({ ...validStart, deviceId: "renderer_claimed_device" }),
    startCodexAuthorization({ ...validStart, sessionRevision: 1.5 }),
    queryCodexAuthorizationSnapshot("../authsession_1"),
    cancelCodexAuthorization({ ...validSessionCommand, commandTicket: "raw-ticket" }),
    reopenCodexAuthorization({ sessionId: "authsession_1", operationId: "operation_1" }),
    verifyCodexAuthorization({ ...validVerify, expectedCredentialRevision: 0 }),
    checkCodexAuthorizationReadiness({ ...validReadiness, expectedCatalogRevision: -1 }),
    queryCodexModelCatalog("https://example.invalid"),
    refreshCodexModelCatalog({ ...validCatalogRefresh, result: "ready" }),
    logoutCodexCredential({ ...validLogout, credentialRevision: 1.5 })
  ];

  for (const result of invalidCases) {
    assert.deepEqual(result, { ok: false, error: CODEX_AUTHORIZATION_INPUT_INVALID_ERROR });
  }
});

test("Bridge v2 physical channels, Core/preload surface, and unsubscribe are explicit", async () => {
  const [constants, preloadTypes, preloadBridge, mainIpc, coreTypes] = await Promise.all([
    readFile(new URL("../shared/constants.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("./ipc/codex-executor-ipc.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../../../../packages/ky-admin-core/src/ai-executor-desktop.ts", import.meta.url),
      "utf8"
    )
  ]);

  for (const channel of [
    "codexAuthorizationGetCapabilities",
    "codexAuthorizationStart",
    "codexAuthorizationGetSnapshot",
    "codexAuthorizationCancel",
    "codexAuthorizationReopen",
    "codexAuthorizationVerify",
    "codexAuthorizationCheckReadiness",
    "codexAuthorizationGetModelCatalog",
    "codexAuthorizationRefreshModelCatalog",
    "codexAuthorizationLogout",
    "codexAuthorizationChanged"
  ]) {
    assert.match(constants, new RegExp(`${channel}:`), `missing constant ${channel}`);
  }
  for (const method of [
    "getCapabilities",
    "start",
    "getSnapshot",
    "cancel",
    "reopen",
    "verify",
    "checkReadiness",
    "getModelCatalog",
    "refreshModelCatalog",
    "logout",
    "onChanged"
  ]) {
    assert.match(preloadTypes, new RegExp(`${method}:`), `missing preload type ${method}`);
  }
  assert.match(preloadBridge, /ipcRenderer\.off\(IPC_CHANNELS\.codexAuthorizationChanged, handler\)/);
  assert.match(preloadBridge, /try\s*{\s*listener\(payload\)/);
  assert.match(mainIpc, /bridgeV2Handlers\?: CodexAuthorizationBridgeV2Handlers/);
  assert.match(mainIpc, /runtimeProvider\?: CodexAuthorizationBridgeV2RuntimeProvider/);
  assert.match(mainIpc, /return args\.length === 0 \? invokeSafely\(handler\) : Promise\.resolve\(invalid\(\)\)/);
  assert.match(mainIpc, /return args\.length === 1/);
  assert.match(mainIpc, /catch\s*{\s*return runtimeFailed\(\)/);
  assert.match(mainIpc, /invokeNoArguments\(args, bridge\.getCapabilities\)/);
  assert.match(mainIpc, /invokeSingleArgument\(args, bridge\.start\)/);
  assert.match(mainIpc, /invokeSingleArgument\(args, bridge\.logout\)/);
  assert.match(mainIpc, /rejectLegacyCodexExecutorAuthorization\(\)/);
  assert.match(mainIpc, /queryLegacyCodexExecutorAuthStatus\(args\)/);
  for (const contract of [preloadTypes, coreTypes]) {
    assert.match(contract, /CodexCredentialVerificationResult/);
    assert.match(contract, /CodexReadinessCheckResult/);
    assert.match(contract, /CodexCredentialLogoutResult/);
    assert.match(contract, /verify:[\s\S]*DesktopCommandResult<CodexCredentialVerificationResult>/);
    assert.match(contract, /checkReadiness:[\s\S]*DesktopCommandResult<CodexReadinessCheckResult>/);
    assert.match(contract, /logout:[\s\S]*DesktopCommandResult<CodexCredentialLogoutResult>/);
  }
});

test("Bridge v2 contract uses the standard system event envelope and safe snapshot", async () => {
  const shared = await readFile(new URL("../shared/types.ts", import.meta.url), "utf8");
  assert.match(shared, /interface CodexAuthorizationCapabilities[\s\S]*bridgeVersion: 2/);
  assert.match(shared, /supportsAppServerAuth: true/);
  assert.match(shared, /supportsDeviceProof: true/);
  assert.match(shared, /supportsSignedCatalog: true/);
  assert.match(shared, /interface CodexCredentialVerificationResult/);
  assert.match(shared, /interface CodexReadinessCheckResult/);
  assert.match(shared, /interface CodexCredentialLogoutResult/);
  assert.match(shared, /supportedReasoningEfforts: string\[\]/);
  assert.match(shared, /status: string/);
  assert.equal(shared.includes("reasoningEfforts: string[]"), false);
  const start = shared.indexOf("export interface CodexAuthorizationChangedEvent");
  const end = shared.indexOf("export type MatrixAccountPlatform", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const eventContract = shared.slice(start, end);
  for (const field of ["id", "name", "version", "source", "scope", "occurredAt", "correlationId", "payload"]) {
    assert.match(eventContract, new RegExp(`${field}:`), `event envelope missing ${field}`);
  }
  assert.match(eventContract, /version: 1/);
  assert.match(eventContract, /source: "aicrm-desktop"/);
  assert.match(eventContract, /scope: "system"/);
  assert.match(eventContract, /correlationId: string/);
  assert.match(eventContract, /payload: CodexAuthorizationSnapshot/);
  for (const forbidden of ["nextActions", "bindingDecision", "receipt", "qrCodeDataUrl", "cookie", "storage", "dom", "screenshot"] ) {
    assert.equal(eventContract.toLowerCase().includes(forbidden.toLowerCase()), false, `event contract contains ${forbidden}`);
  }
});

test("Bridge v2 fail-closed main policy contains no process, filesystem, browser, or credential implementation", async () => {
  const [policy, mainIpc] = await Promise.all([
    readFile(new URL("./codex-authorization-bridge-v2-policy.ts", import.meta.url), "utf8"),
    readFile(new URL("./ipc/codex-executor-ipc.ts", import.meta.url), "utf8")
  ]);
  const source = `${policy}\n${mainIpc}`;
  for (const forbidden of [
    "spawn(",
    "exec(",
    "CODEX_HOME",
    "/.codex",
    "readFile(",
    "writeFile(",
    "shell.openExternal",
    "account/login/start",
    "account/logout"
  ]) {
    assert.equal(source.includes(forbidden), false, `fail-closed skeleton contains ${forbidden}`);
  }
});
