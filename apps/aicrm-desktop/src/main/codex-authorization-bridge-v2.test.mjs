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

function runtimeFixture(implementation = async (method, input) => ({
  ok: true,
  data: { method, input }
})) {
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

test("Bridge v2 true-gated runtime delegates every exact DTO asynchronously without cloning", async () => {
  const results = new Map();
  const current = runtimeFixture(async (method, input) => {
    await Promise.resolve();
    const result = { ok: true, data: { delegatedBy: method } };
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
    assert.strictEqual(result, results.get(method));
    expectedCalls.push([method, input]);
  }
  assert.deepEqual(current.calls, expectedCalls);
  for (let index = 0; index < expectedCalls.length; index += 1) {
    assert.strictEqual(current.calls[index][1], expectedCalls[index][1]);
  }
});

test("Bridge v2 exact validators run before true-gated delegation", async () => {
  const current = runtimeFixture();
  const handlers = createCodexAuthorizationBridgeV2Handlers({ ready: true, runtime: current.runtime });
  const invalidCases = [
    () => handlers.start({ ...validStart, extra: true }),
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

test("Bridge v2 rejects raw IDs, missing tickets, extra fields, and malformed revisions", () => {
  const invalidCases = [
    queryCodexAuthorizationCapabilities([undefined]),
    startCodexAuthorization({ executorId: "aiexec_1" }),
    startCodexAuthorization({ ...validStart, deviceId: "renderer_claimed_device" }),
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

test("Bridge v2 physical channels, preload surface, and unsubscribe are explicit", async () => {
  const [constants, preloadTypes, preloadBridge, mainIpc] = await Promise.all([
    readFile(new URL("../shared/constants.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("./ipc/codex-executor-ipc.ts", import.meta.url), "utf8")
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
});

test("Bridge v2 contract uses the standard system event envelope and safe snapshot", async () => {
  const shared = await readFile(new URL("../shared/types.ts", import.meta.url), "utf8");
  assert.match(shared, /interface CodexAuthorizationCapabilities[\s\S]*bridgeVersion: 2/);
  assert.match(shared, /supportsAppServerAuth: true/);
  assert.match(shared, /supportsDeviceProof: true/);
  assert.match(shared, /supportsSignedCatalog: true/);
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
