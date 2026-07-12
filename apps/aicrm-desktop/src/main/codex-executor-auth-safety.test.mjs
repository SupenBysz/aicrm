import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  LEGACY_CODEX_AUTHORIZATION_ERROR,
  queryLegacyCodexExecutorAuthStatus,
  rejectLegacyCodexExecutorAuthorization
} from "./codex-executor-auth-safety-policy.ts";

test("legacy Codex authorization bridge always fails closed", () => {
  const result = rejectLegacyCodexExecutorAuthorization();
  assert.deepEqual(result, {
    ok: false,
    error: LEGACY_CODEX_AUTHORIZATION_ERROR
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of ["codexHome", "command", "capabilities", "CODEX_HOME", "/.codex"]) {
    assert.equal(serialized.includes(forbidden), false, `legacy result exposed ${forbidden}`);
  }
});

test("legacy Codex status query only returns a no-argument safe projection", () => {
  assert.deepEqual(queryLegacyCodexExecutorAuthStatus([]), {
    ok: true,
    data: {
      bridgeVersion: 1,
      authStatus: "not_authorized",
      appServerListen: "stdio://",
      capabilities: { trustedAuthorization: false },
      message: "旧版 Codex 授权状态仅提供安全兼容投影，请升级到可信授权桥"
    }
  });
  for (const args of [[undefined], [{}], [{ executorId: "executor_1" }], ["/root/.codex"]]) {
    assert.deepEqual(queryLegacyCodexExecutorAuthStatus(args), {
      ok: false,
      error: LEGACY_CODEX_AUTHORIZATION_ERROR
    });
  }
});

test("legacy IPC registration contains no Codex process or credential probing implementation", async () => {
  const source = await readFile(new URL("./ipc/codex-executor-ipc.ts", import.meta.url), "utf8");
  assert.match(source, /codexExecutorAuthorize/);
  assert.match(source, /codexExecutorGetAuthStatus/);
  assert.match(source, /rejectLegacyCodexExecutorAuthorization/);
  assert.match(source, /queryLegacyCodexExecutorAuthStatus/);
  for (const forbidden of ["spawn(", "CODEX_HOME", "homedir(", "tmpdir(", "/.codex", "codex login", "codex exec"]) {
    assert.equal(source.includes(forbidden), false, `legacy IPC source contains ${forbidden}`);
  }
});

test("shared and preload contracts contain no legacy credential path or command DTO", async () => {
  const [sharedSource, preloadTypeSource] = await Promise.all([
    readFile(new URL("../shared/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/types.ts", import.meta.url), "utf8")
  ]);
  const contractSource = `${sharedSource}\n${preloadTypeSource}`;
  for (const forbidden of ["CodexExecutorAuthInput", "CodexExecutorAuthResult", "codexHome", "CODEX_HOME"]) {
    assert.equal(contractSource.includes(forbidden), false, `desktop contract contains ${forbidden}`);
  }
  assert.match(contractSource, /getAuthStatus:\s*\(\)\s*=>/);
});
