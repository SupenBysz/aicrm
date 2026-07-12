import assert from "node:assert/strict";
import test from "node:test";
import { IPC_CHANNELS } from "../../shared/constants.ts";
import {
  createDesktopExecutorDeviceBindingHandler,
  registerDesktopExecutorDeviceBindingIpc
} from "./desktop-executor-device-binding-ipc.ts";

const input = { executorId: "executor_binding_1", expectedRevision: 0 };
const binding = {
  executorId: input.executorId,
  deviceId: "a".repeat(64),
  status: "active",
  revision: 1,
  force: false,
  updatedAt: "2026-07-13T11:00:00.123456Z"
};

function clientFixture(implementation) {
  const calls = [];
  return {
    calls,
    client: {
      async bindExecutorDevice(value) {
        calls.push(value);
        return implementation(value);
      }
    }
  };
}

function successResult(overrides = {}) {
  return {
    requestReference: "request-reference-sensitive-canary",
    requestHash: "request-hash-sensitive-canary",
    recovered: false,
    data: { binding, replayed: false },
    ...overrides
  };
}

test("IPC accepts only exact executorId and expectedRevision input", async () => {
  const current = clientFixture(async () => successResult());
  const handler = createDesktopExecutorDeviceBindingHandler(current.client);
  for (const args of [
    [],
    [input, "extra"],
    [null],
    [{}],
    [{ ...input, unexpected: true }],
    [{ ...input, executorId: "bad/path" }],
    [{ ...input, expectedRevision: -1 }],
    [{ ...input, expectedRevision: Number.MAX_SAFE_INTEGER }],
    [{ ...input, expectedRevision: 0.5 }]
  ]) {
    const result = await handler({}, ...args);
    assert.deepEqual(result, {
      ok: false,
      error: { code: "validation_error", message: "执行器设备绑定参数无效" }
    });
  }
  assert.equal(current.calls.length, 0);
});

test("IPC returns only the safe binding projection and hides every Main fence", async () => {
  const current = clientFixture(async () => successResult());
  const result = await createDesktopExecutorDeviceBindingHandler(current.client)({}, input);
  assert.deepEqual(current.calls, [input]);
  assert.deepEqual(result, {
    ok: true,
    data: { binding, replayed: false }
  });
  const serialized = JSON.stringify(result);
  for (const canary of [
    "request-reference-sensitive-canary",
    "request-hash-sensitive-canary",
    "Bearer ",
    "privateKey",
    "apiBaseUrl",
    "signingInput"
  ]) {
    assert.equal(serialized.includes(canary), false);
  }
});

test("IPC rejects a widened or mismatched client response", async () => {
  for (const data of [
    { binding: { ...binding, privateKey: "secret" }, replayed: false },
    { binding: { ...binding, executorId: "other" }, replayed: false },
    { binding: { ...binding, revision: 2 }, replayed: false },
    { binding: { ...binding, updatedAt: "not-time" }, replayed: false },
    { binding, replayed: false, requestHash: "secret" }
  ]) {
    const current = clientFixture(async () => successResult({ data }));
    assert.deepEqual(
      await createDesktopExecutorDeviceBindingHandler(current.client)({}, input),
      {
        ok: false,
        error: {
          code: "desktop_executor_device_binding_response_invalid",
          message: "执行器设备绑定响应无效"
        }
      }
    );
  }
});

test("IPC error projection allowlists codes and never echoes sensitive messages", async () => {
  const sensitive = "Bearer sensitive-token-canary https://secret.invalid privateKey";
  for (const [rawCode, expectedCode] of [
    ["desktop_device_request_lane_pinned", "desktop_device_request_lane_pinned"],
    ["desktop_host_session_expired", "desktop_host_session_expired"],
    ["forged_sensitive_error", "desktop_executor_device_binding_failed"]
  ]) {
    const current = clientFixture(async () => {
      const error = new Error(sensitive);
      error.code = rawCode;
      error.serverCode = null;
      throw error;
    });
    const result = await createDesktopExecutorDeviceBindingHandler(current.client)({}, input);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, expectedCode);
    assert.equal(JSON.stringify(result).includes(sensitive), false);
  }

  for (const [serverCode, expectedCode] of [
    ["device_binding_active", "device_binding_active"],
    ["device_binding_conflict", "device_binding_conflict"],
    ["device_binding_replay_mismatch", "device_binding_replay_mismatch"],
    ["permission_denied", "permission_denied"],
    ["workspace_forbidden", "workspace_forbidden"],
    ["authorization_proof_invalid", "authorization_proof_invalid"],
    ["device_binding_unavailable", "device_binding_unavailable"],
    ["unauthorized", "desktop_executor_device_binding_failed"],
    ["forged_server_secret", "desktop_executor_device_binding_failed"]
  ]) {
    const current = clientFixture(async () => {
      const error = new Error(sensitive);
      error.code = "desktop_executor_device_binding_rejected";
      error.serverCode = serverCode;
      throw error;
    });
    const result = await createDesktopExecutorDeviceBindingHandler(current.client)({}, input);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, expectedCode);
    assert.equal(JSON.stringify(result).includes(sensitive), false);
    assert.equal(JSON.stringify(result).includes("forged_server_secret"), false);
  }
});

test("registration binds the exact channel to the injected singleton client", async () => {
  const current = clientFixture(async () => successResult());
  const registrations = [];
  registerDesktopExecutorDeviceBindingIpc(current.client, {
    handle(channel, listener) {
      registrations.push({ channel, listener });
    }
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].channel, IPC_CHANNELS.aiExecutorBindDevice);
  assert.deepEqual(await registrations[0].listener({}, input), {
    ok: true,
    data: { binding, replayed: false }
  });
});
