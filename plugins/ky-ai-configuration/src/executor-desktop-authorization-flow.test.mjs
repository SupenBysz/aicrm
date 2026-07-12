import assert from "node:assert/strict";
import test from "node:test";
import {
  AiExecutorDesktopAuthorizationFlowError,
  DESKTOP_BINDING_ACTIVE,
  DESKTOP_HANDOFF_TARGET_MISMATCH,
  startAiExecutorDesktopAuthorization
} from "./executor-desktop-authorization-flow.ts";
import { createAiExecutorDesktopHandoff } from "./api.ts";

const SESSION = Object.freeze({
  id: "auth_session_1",
  executorId: "executor_1",
  runtimeType: "desktop",
  flowType: "codex_app_server",
  intent: "authorize",
  status: "starting",
  sequence: 1,
  revision: 3,
  userActionRequired: false,
  sessionDeadlineAt: "2026-07-13T02:00:00Z",
  accountSummary: {},
  failure: null,
  startedAt: "2026-07-13T01:00:00Z",
  finishedAt: null,
  createdAt: "2026-07-13T01:00:00Z",
  updatedAt: "2026-07-13T01:00:00Z"
});

const HANDOFF_TICKET = `eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJjYW5hcnkifQ.${"A".repeat(86)}`;
const HANDOFF_NONCE = "AQIDBAUGBwgJCgsMDQ4PEA";
const HANDOFF = Object.freeze({
  handoffId: "handoff_1",
  handoffTicket: HANDOFF_TICKET,
  nonce: HANDOFF_NONCE,
  expiresAt: "2026-07-13T01:02:00Z"
});

function registeredProjection() {
  return {
    status: "registered",
    deviceId: "device_1",
    registrationStatus: "registered",
    errorCode: null,
    updatedAt: "2026-07-13T01:00:00Z",
    backendRebindRequired: false,
    message: "registered"
  };
}

function trustBridge(overrides = {}) {
  return {
    ensureRegistration: async () => ({ ok: true, data: registeredProjection() }),
    bindExecutorDevice: async ({ executorId }) => ({
      ok: true,
      data: {
        binding: {
          executorId,
          deviceId: "device_1",
          status: "active",
          revision: 1,
          force: false,
          updatedAt: "2026-07-13T01:00:01Z"
        },
        replayed: false
      }
    }),
    ...overrides
  };
}

function authorizationBridge(overrides = {}) {
  return {
    start: async ({ sessionId, executorId }) => ({
      ok: true,
      data: {
        sessionId,
        executorId,
        sequence: 1,
        status: "starting",
        canReopen: false,
        canCancel: true
      }
    }),
    ...overrides
  };
}

function dependencies(overrides = {}) {
  return {
    createSession: async () => ({ ...SESSION }),
    createHandoff: async () => ({ ...HANDOFF }),
    getSession: async () => ({ ...SESSION, revision: 7 }),
    cancelSession: async (current) => ({ ...SESSION, ...current, status: "cancelled" }),
    createIdempotencyKey: () => "handoff-idempotency-key-0001",
    now: () => Date.parse("2026-07-13T01:01:00Z"),
    ...overrides
  };
}

function flowInput(overrides = {}) {
  return {
    executorId: SESSION.executorId,
    intent: SESSION.intent,
    trustBridge: trustBridge(),
    authorizationBridge: authorizationBridge(),
    ...overrides
  };
}

test("Desktop flow performs registration, server handoff, and bridge.start without returning bearer material", async () => {
  const calls = [];
  let startInput;
  const input = flowInput({
    trustBridge: trustBridge({
      ensureRegistration: async () => {
        calls.push("ensureRegistration");
        return { ok: true, data: registeredProjection() };
      },
      bindExecutorDevice: async () => {
        assert.fail("a successful handoff must not bind the executor");
      }
    }),
    authorizationBridge: authorizationBridge({
      start: async (value) => {
        calls.push("authorization.start");
        startInput = value;
        return {
          ok: true,
          data: {
            sessionId: value.sessionId,
            executorId: value.executorId,
            sequence: 1,
            status: "starting",
            canReopen: false,
            canCancel: true
          }
        };
      }
    })
  });
  const result = await startAiExecutorDesktopAuthorization(
    input,
    dependencies({
      createSession: async () => {
        calls.push("createSession");
        return { ...SESSION };
      },
      createHandoff: async (sessionId, deviceId, revision, key) => {
        calls.push("createHandoff");
        assert.deepEqual(
          { sessionId, deviceId, revision, key },
          {
            sessionId: SESSION.id,
            deviceId: "device_1",
            revision: SESSION.revision,
            key: "handoff-idempotency-key-0001"
          }
        );
        return { ...HANDOFF };
      }
    })
  );

  assert.deepEqual(calls, ["ensureRegistration", "createSession", "createHandoff", "authorization.start"]);
  assert.deepEqual(startInput, {
    sessionId: SESSION.id,
    executorId: SESSION.executorId,
    sessionRevision: SESSION.revision,
    handoffId: HANDOFF.handoffId,
    handoffTicket: HANDOFF_TICKET
  });
  assert.deepEqual(result, SESSION);
  assert.equal(JSON.stringify(result).includes(HANDOFF_TICKET), false);
  assert.equal(JSON.stringify(result).includes(HANDOFF_NONCE), false);
});

test("a capability-shaped surface without both trusted bridges never creates a session", async () => {
  for (const missing of ["trust", "authorization"]) {
    let createCalls = 0;
    const input = flowInput(
      missing === "trust" ? { trustBridge: null } : { authorizationBridge: null }
    );
    await assert.rejects(
      startAiExecutorDesktopAuthorization(
        input,
        dependencies({
          createSession: async () => {
            createCalls += 1;
            return { ...SESSION };
          }
        })
      ),
      (error) =>
        error instanceof AiExecutorDesktopAuthorizationFlowError &&
        error.code === "desktop_bridge_unavailable"
    );
    assert.equal(createCalls, 0, `${missing} bridge absence created a server session`);
  }
});

test("an incomplete registration fails before server session creation", async () => {
  let createCalls = 0;
  await assert.rejects(
    startAiExecutorDesktopAuthorization(
      flowInput({
        trustBridge: trustBridge({
          ensureRegistration: async () => ({
            ok: true,
            data: { ...registeredProjection(), status: "failed", deviceId: null }
          })
        })
      }),
      dependencies({
        createSession: async () => {
          createCalls += 1;
          return { ...SESSION };
        }
      })
    ),
    (error) =>
      error instanceof AiExecutorDesktopAuthorizationFlowError &&
      error.code === "desktop_registration_unavailable"
  );
  assert.equal(createCalls, 0);
});

test("a server session for another executor or runtime fails closed and is cancelled", async (t) => {
  for (const invalidSession of [
    { ...SESSION, executorId: "executor_other" },
    { ...SESSION, runtimeType: "server" },
    { ...SESSION, intent: "change_account" }
  ]) {
    await t.test(`${invalidSession.executorId}:${invalidSession.runtimeType}:${invalidSession.intent}`, async () => {
      let handoffCalls = 0;
      let cancelInput;
      await assert.rejects(
        startAiExecutorDesktopAuthorization(
          flowInput(),
          dependencies({
            createSession: async () => invalidSession,
            createHandoff: async () => {
              handoffCalls += 1;
              return { ...HANDOFF };
            },
            getSession: async () => ({ ...invalidSession, revision: 8 }),
            cancelSession: async (current) => {
              cancelInput = current;
              return { ...invalidSession, status: "cancelled", revision: current.revision };
            }
          })
        ),
        (error) =>
          error instanceof AiExecutorDesktopAuthorizationFlowError &&
          error.code === "desktop_session_invalid"
      );
      assert.equal(handoffCalls, 0);
      assert.deepEqual(cancelInput, { id: SESSION.id, revision: 8 });
    });
  }
});

test("only exact target mismatch performs one initial bind and retries with the same idempotency key", async () => {
  const calls = [];
  const handoffKeys = [];
  let handoffCalls = 0;
  let bindInput;
  const mismatch = Object.assign(new Error("redacted server failure"), {
    code: DESKTOP_HANDOFF_TARGET_MISMATCH
  });
  const result = await startAiExecutorDesktopAuthorization(
    flowInput({
      trustBridge: trustBridge({
        ensureRegistration: async () => {
          calls.push("ensureRegistration");
          return { ok: true, data: registeredProjection() };
        },
        bindExecutorDevice: async (value) => {
          calls.push("bindExecutorDevice");
          bindInput = value;
          return {
            ok: true,
            data: {
              binding: {
                executorId: SESSION.executorId,
                deviceId: "device_1",
                status: "active",
                revision: 1,
                force: false,
                updatedAt: "2026-07-13T01:00:01Z"
              },
              replayed: false
            }
          };
        }
      }),
      authorizationBridge: authorizationBridge({
        start: async (value) => {
          calls.push("authorization.start");
          return {
            ok: true,
            data: {
              sessionId: value.sessionId,
              executorId: value.executorId,
              sequence: 1,
              status: "starting",
              canReopen: false,
              canCancel: true
            }
          };
        }
      })
    }),
    dependencies({
      createSession: async () => {
        calls.push("createSession");
        return { ...SESSION };
      },
      createHandoff: async (_sessionId, _deviceId, _revision, key) => {
        calls.push("createHandoff");
        handoffKeys.push(key);
        handoffCalls += 1;
        if (handoffCalls === 1) throw mismatch;
        return { ...HANDOFF };
      }
    })
  );

  assert.deepEqual(calls, [
    "ensureRegistration",
    "createSession",
    "createHandoff",
    "bindExecutorDevice",
    "createHandoff",
    "authorization.start"
  ]);
  assert.deepEqual(bindInput, { executorId: SESSION.executorId, expectedRevision: 0 });
  assert.equal(handoffKeys.length, 2);
  assert.equal(handoffKeys[0], handoffKeys[1]);
  assert.deepEqual(result, SESSION);
});

test("offline, permission, and message-only mismatch errors never bind and preserve the original error", async (t) => {
  for (const original of [
    Object.assign(new Error("offline"), { code: "desktop_device_offline" }),
    Object.assign(new Error("forbidden"), { code: "permission_denied" }),
    new Error(DESKTOP_HANDOFF_TARGET_MISMATCH)
  ]) {
    await t.test(original.code ?? "message_only", async () => {
      let bindCalls = 0;
      let cancelInput;
      await assert.rejects(
        startAiExecutorDesktopAuthorization(
          flowInput({
            trustBridge: trustBridge({
              bindExecutorDevice: async () => {
                bindCalls += 1;
                throw new Error("must not bind");
              }
            })
          }),
          dependencies({
            createHandoff: async () => {
              throw original;
            },
            getSession: async () => ({ ...SESSION, revision: 9 }),
            cancelSession: async (current) => {
              cancelInput = current;
              throw new Error("cleanup failure must be swallowed");
            }
          })
        ),
        (error) => error === original
      );
      assert.equal(bindCalls, 0);
      assert.deepEqual(cancelInput, { id: SESSION.id, revision: 9 });
    });
  }
});

test("device_binding_active requests assisted rebind, never automatic rebind, and cleans up", async () => {
  let handoffCalls = 0;
  let cancelInput;
  await assert.rejects(
    startAiExecutorDesktopAuthorization(
      flowInput({
        trustBridge: trustBridge({
          bindExecutorDevice: async (value) => {
            assert.deepEqual(value, { executorId: SESSION.executorId, expectedRevision: 0 });
            return {
              ok: false,
              error: { code: DESKTOP_BINDING_ACTIVE, message: HANDOFF_TICKET }
            };
          }
        })
      }),
      dependencies({
        createHandoff: async () => {
          handoffCalls += 1;
          throw Object.assign(new Error("target mismatch"), {
            code: DESKTOP_HANDOFF_TARGET_MISMATCH
          });
        },
        getSession: async () => ({ ...SESSION, revision: 11 }),
        cancelSession: async (current) => {
          cancelInput = current;
          return { ...SESSION, status: "cancelled", revision: current.revision };
        }
      })
    ),
    (error) => {
      assert.equal(error instanceof AiExecutorDesktopAuthorizationFlowError, true);
      assert.equal(error.code, "desktop_binding_requires_assistance");
      assert.doesNotMatch(error.message, new RegExp(HANDOFF_TICKET.replaceAll(".", "\\.")));
      return true;
    }
  );
  assert.equal(handoffCalls, 1);
  assert.deepEqual(cancelInput, { id: SESSION.id, revision: 11 });
});

test("a failed local bridge result is redacted and cancelled with the freshly fetched revision", async () => {
  let cancelInput;
  await assert.rejects(
    startAiExecutorDesktopAuthorization(
      flowInput({
        authorizationBridge: authorizationBridge({
          start: async () => ({
            ok: false,
            error: { code: "local_start_failed", message: `${HANDOFF_TICKET}:${HANDOFF_NONCE}` }
          })
        })
      }),
      dependencies({
        getSession: async () => ({ ...SESSION, revision: 13 }),
        cancelSession: async (current) => {
          cancelInput = current;
          return { ...SESSION, status: "cancelled", revision: current.revision };
        }
      })
    ),
    (error) => {
      assert.equal(error instanceof AiExecutorDesktopAuthorizationFlowError, true);
      assert.equal(error.code, "desktop_authorization_start_failed");
      assert.doesNotMatch(error.message, /sensitive\.ticket\.canary|sensitive_nonce_canary/);
      return true;
    }
  );
  assert.deepEqual(cancelInput, { id: SESSION.id, revision: 13 });
});

test("an expired handoff never reaches bridge.start and is cancelled", async () => {
  let startCalls = 0;
  let cancelInput;
  await assert.rejects(
    startAiExecutorDesktopAuthorization(
      flowInput({
        authorizationBridge: authorizationBridge({
          start: async () => {
            startCalls += 1;
            return { ok: true };
          }
        })
      }),
      dependencies({
        createHandoff: async () => ({ ...HANDOFF, expiresAt: "2026-07-13T01:00:54Z" }),
        getSession: async () => ({ ...SESSION, revision: 15 }),
        cancelSession: async (current) => {
          cancelInput = current;
          return { ...SESSION, status: "cancelled", revision: current.revision };
        }
      })
    ),
    (error) =>
      error instanceof AiExecutorDesktopAuthorizationFlowError &&
      error.code === "desktop_authorization_start_failed"
  );
  assert.equal(startCalls, 0);
  assert.deepEqual(cancelInput, { id: SESSION.id, revision: 15 });
});

test("canonical handoff API sends strict CAS input and returns only the validated projection", async () => {
  let request;
  const client = {
    request: async (path, options) => {
      request = { path, options };
      return { ...HANDOFF };
    }
  };
  const result = await createAiExecutorDesktopHandoff(
    client,
    SESSION.id,
    "device_1",
    SESSION.revision,
    "handoff-idempotency-key-0001"
  );
  assert.deepEqual(request, {
    path: `/api/v1/ai-executor-authorization-sessions/${SESSION.id}/desktop-handoffs`,
    options: {
      method: "POST",
      headers: { "Idempotency-Key": "handoff-idempotency-key-0001" },
      body: { deviceId: "device_1", expectedSessionRevision: SESSION.revision }
    }
  });
  assert.deepEqual(result, HANDOFF);
});

test("canonical handoff API rejects extra fields and malformed bearer projections without echoing secrets", async (t) => {
  for (const response of [
    { ...HANDOFF, ignored: "not-allowed" },
    { ...HANDOFF, handoffTicket: `bad ticket ${HANDOFF_TICKET}` },
    { ...HANDOFF, handoffTicket: "one.two" },
    { ...HANDOFF, nonce: "too_short" }
  ]) {
    await t.test(Object.keys(response).join(":"), async () => {
      const client = { request: async () => response };
      await assert.rejects(
        createAiExecutorDesktopHandoff(
          client,
          SESSION.id,
          "device_1",
          SESSION.revision,
          "handoff-idempotency-key-0001"
        ),
        (error) => {
          assert.equal(error.message, "Desktop handoff 响应无效");
          assert.equal(error.message.includes(HANDOFF_TICKET), false);
          return true;
        }
      );
    });
  }
});
