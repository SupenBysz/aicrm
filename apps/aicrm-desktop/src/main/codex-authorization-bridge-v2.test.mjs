import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CODEX_AUTHORIZATION_INPUT_INVALID_ERROR,
  CODEX_AUTHORIZATION_RUNTIME_UNAVAILABLE_ERROR,
  cancelCodexAuthorization,
  checkCodexAuthorizationReadiness,
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
  assert.match(mainIpc, /invokeSingleArgument\(args, startCodexAuthorization\)/);
  assert.match(mainIpc, /invokeSingleArgument\(args, logoutCodexCredential\)/);
});

test("Bridge v2 contract exposes only safe snapshot and sequence envelope fields", async () => {
  const shared = await readFile(new URL("../shared/types.ts", import.meta.url), "utf8");
  assert.match(shared, /interface CodexAuthorizationCapabilities[\s\S]*bridgeVersion: 2/);
  assert.match(shared, /supportsAppServerAuth: true/);
  assert.match(shared, /supportsDeviceProof: true/);
  assert.match(shared, /supportsSignedCatalog: true/);
  const start = shared.indexOf("export interface CodexAuthorizationChangedEvent");
  const end = shared.indexOf("export type MatrixAccountPlatform", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const eventContract = shared.slice(start, end);
  for (const field of ["operationId", "runtimeSessionId", "runtimeEpoch", "nativeSequence", "scopeHash", "snapshot"]) {
    assert.match(eventContract, new RegExp(`${field}:`), `event envelope missing ${field}`);
  }
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
