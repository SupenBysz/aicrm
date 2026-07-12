import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("./pages/executors-page.tsx", import.meta.url);
const apiUrl = new URL("./api.ts", import.meta.url);

test("executor UI keeps legacy authorization actions disabled during trusted bridge upgrade", async () => {
  const source = await readFile(pageUrl, "utf8");

  assert.match(source, /<Button disabled[^>]*>[\s\S]*?可信授权升级中[\s\S]*?<\/Button>/);
  assert.match(source, /历史已授权（待复核）/);
  assert.match(source, /当前授权状态仅为历史记录/);
});

test("executor configuration plugin contains no legacy authorization polling or DTO contract", async () => {
  const [pageSource, apiSource] = await Promise.all([readFile(pageUrl, "utf8"), readFile(apiUrl, "utf8")]);
  const combined = `${pageSource}\n${apiSource}`;

  for (const forbidden of [
    "authorizeAiExecutor",
    "syncAiExecutorAuthStatus",
    "AiExecutorAuthSession",
    "AiExecutorAuthStatusInput",
    "/auth-status",
    "getDesktopCodexBridge",
    "startDesktopAuthPolling",
    "authPollTimerRef",
    "authSession.command",
    "codexHome",
    "boundDeviceId",
    "capabilities",
    "updateCodexExecutorConfig"
  ]) {
    assert.equal(combined.includes(forbidden), false, `legacy executor authorization source contains ${forbidden}`);
  }
});

test("executor App Server transport is read-only stdio and absent from UI writes", async () => {
  const [pageSource, apiSource] = await Promise.all([readFile(pageUrl, "utf8"), readFile(apiUrl, "utf8")]);
  assert.equal(pageSource.includes("appServerListen"), false);
  assert.match(apiSource, /appServerListen:\s*"stdio:\/\/"/);
  assert.doesNotMatch(apiSource, /\|\s*"appServerListen"/);
  assert.equal(apiSource.includes('method: "PATCH", body: input });\n}'), true);
  assert.equal(apiSource.includes('"/api/v1/ai-executors/codex", { method: "PATCH"'), false);
});
