import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const apiUrl = new URL("./api.ts", import.meta.url);
const pageUrl = new URL("./pages/executors-page.tsx", import.meta.url);
const authorizationUrl = new URL("./components/executor-authorization-panel.tsx", import.meta.url);
const controlUrl = new URL("./components/executor-control-panel.tsx", import.meta.url);
const indexUrl = new URL("./index.tsx", import.meta.url);
const permissionsUrl = new URL("./permissions.ts", import.meta.url);
const coreDesktopContractUrl = new URL("../../../packages/ky-admin-core/src/ai-executor-desktop.ts", import.meta.url);
const desktopSharedTypesUrl = new URL("../../../apps/aicrm-desktop/src/shared/types.ts", import.meta.url);

test("executor API uses the canonical authorization session and CAS contracts", async () => {
  const source = await readFile(apiUrl, "utf8");
  for (const required of [
    "/authorization-sessions",
    "/user-action",
    "/events-stream",
    "expectedSessionRevision",
    "expectedRevision",
    "Idempotency-Key",
    "defaultModelKey",
    "credentialStatus",
    "readinessStatus",
    "scriptMaintenanceReady"
  ]) {
    assert.equal(source.includes(required), true, `canonical executor source is missing ${required}`);
  }
  for (const forbidden of ["/auth-status", '"/api/v1/ai-executors/codex"', "codexHome", "authAccountLabel"]) {
    assert.equal(source.includes(forbidden), false, `legacy executor contract contains ${forbidden}`);
  }
});

test("executor command routes stay fail closed until the service registers them", async () => {
  const [apiSource, controlSource] = await Promise.all([readFile(apiUrl, "utf8"), readFile(controlUrl, "utf8")]);
  assert.match(apiSource, /AI_EXECUTOR_COMMAND_ROUTES_READY\s*=\s*false/);
  assert.match(controlSource, /不会回退调用旧服务/);
  assert.match(controlSource, /disabled=\{!AI_EXECUTOR_COMMAND_ROUTES_READY/);
});

test("server device-code UI only opens exact official HTTPS origins", async () => {
  const source = await readFile(authorizationUrl, "utf8");
  assert.match(source, /url\.protocol !== "https:"/);
  assert.match(source, /url\.username \|\| url\.password/);
  assert.match(source, /"auth\.openai\.com"/);
  assert.match(source, /"platform\.openai\.com"/);
  assert.match(source, /"chatgpt\.com"/);
  assert.doesNotMatch(source, /"www\.chatgpt\.com"/);
  assert.match(source, /noopener,noreferrer/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|codexHome/);
});

test("Desktop authorization cannot start before device handoff is wired", async () => {
  const [apiSource, authorizationSource] = await Promise.all([readFile(apiUrl, "utf8"), readFile(authorizationUrl, "utf8")]);
  assert.match(apiSource, /AI_EXECUTOR_DESKTOP_HANDOFF_READY\s*=\s*false/);
  assert.match(authorizationSource, /!desktopBridgeReady \|\| !AI_EXECUTOR_DESKTOP_HANDOFF_READY/);
  assert.match(authorizationSource, /不会仅凭 capability 创建会话/);
});

test("connection-level authorization close is handled without advancing the persisted cursor", async () => {
  const source = await readFile(apiUrl, "utf8");
  assert.match(source, /if \(event\.id == null\)[\s\S]*applyAuthorizationConnectionClose/);
  assert.match(source, /data\.sessionId !== sessionId/);
  assert.match(source, /watcher\.onClosed\?\.\(data\.reason\)/);
});

test("workspace grant status matches the enabled-disabled database contract", async () => {
  const [apiSource, controlSource] = await Promise.all([readFile(apiUrl, "utf8"), readFile(controlUrl, "utf8")]);
  assert.match(apiSource, /status: "enabled" \| "disabled"/);
  assert.match(controlSource, /grant\.status === "enabled"/);
  assert.doesNotMatch(controlSource, /grant\.status === "active"/);
});

test("AI configuration uses one canonical menu key and action permissions", async () => {
  const [indexSource, permissionSource] = await Promise.all([readFile(indexUrl, "utf8"), readFile(permissionsUrl, "utf8")]);
  assert.match(permissionSource, /menu\.platform\.ai_configuration/);
  assert.match(permissionSource, /platform\.ai_executors\.change_account/);
  assert.match(permissionSource, /platform\.ai_executors\.force_revoke/);
  assert.equal(indexSource.includes('menuKey: "ai.executors.view"'), false);
  assert.equal(indexSource.includes('menuKey: "ai.executor_tasks.view"'), false);
});

test("executor editor submits only canonical fields and revision CAS", async () => {
  const source = await readFile(pageUrl, "utf8");
  assert.match(source, /expectedRevision:\s*item\.configRevision/);
  for (const forbidden of ["allowPageActions", "allowStorageRead", "allowCdpRuntime", "allowAutoActivate", "maxConcurrency", "priority"]) {
    assert.equal(source.includes(forbidden), false, `executor editor still writes ${forbidden}`);
  }
});

test("Core and Desktop use one canonical signed model catalog shape", async () => {
  const [coreSource, desktopSource] = await Promise.all([
    readFile(coreDesktopContractUrl, "utf8"),
    readFile(desktopSharedTypesUrl, "utf8")
  ]);
  for (const source of [coreSource, desktopSource]) {
    for (const field of [
      "credentialRevision: number",
      "catalogRevision: number",
      "models: CodexModelCatalogItem[]",
      "observedAt: string",
      "inputModalities: string[]",
      "supportedReasoningEfforts: string[]",
      "status: string"
    ]) {
      assert.equal(source.includes(field), true, `model catalog contract is missing ${field}`);
    }
    assert.equal(source.includes("reasoningEfforts: string[]"), false, "legacy model reasoning field remains");
  }
});
