import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR,
  DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR,
  DESKTOP_CODEX_AUTHORIZATION_EVENT_SINK_ERROR,
  DesktopCodexAuthorizationEventBroadcaster
} from "./desktop-codex-authorization-events.ts";

const occurredAt = "2026-07-13T12:00:00.000Z";

function snapshot(overrides = {}) {
  return {
    sessionId: "authsession_1",
    executorId: "executor_1",
    sequence: 1,
    status: "starting",
    canReopen: false,
    canCancel: true,
    ...overrides
  };
}

function fixture(options = {}) {
  const attempts = [];
  let id = 0;
  const sink = options.sink ?? (async (event) => {
    attempts.push(event);
  });
  const broadcaster = new DesktopCodexAuthorizationEventBroadcaster({
    sink,
    now: options.now ?? (() => new Date(occurredAt)),
    idFactory: options.idFactory ?? (() => {
      id += 1;
      return `00000000-0000-4000-8000-${id.toString(16).padStart(12, "0")}`;
    })
  });
  return { broadcaster, attempts };
}

async function rejectsFixed(execute, expected, forbidden = []) {
  await assert.rejects(execute, (error) => {
    assert.equal(error.code, expected.code);
    assert.equal(error.message, expected.message);
    const serialized = `${error.code}:${error.message}:${error.stack ?? ""}`;
    for (const canary of forbidden) assert.equal(serialized.includes(canary), false);
    return true;
  });
}

test("safe snapshot maps to the exact canonical system event envelope", async () => {
  const current = fixture();
  const input = snapshot({
    status: "waiting_user",
    canReopen: true,
    localFailureCode: "desktop_authorization_waiting"
  });
  const event = await current.broadcaster.broadcast(input);
  assert.deepEqual(event, {
    id: "00000000-0000-4000-8000-000000000001",
    name: "codex.authorization.changed",
    version: 1,
    source: "aicrm-desktop",
    scope: "system",
    occurredAt,
    correlationId: "authsession_1",
    payload: input
  });
  assert.strictEqual(current.attempts[0], event);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.payload), true);
  assert.deepEqual(Object.keys(event).sort(), [
    "correlationId",
    "id",
    "name",
    "occurredAt",
    "payload",
    "scope",
    "source",
    "version"
  ]);
});

test("per-session high-water is monotonic, exact duplicates are silent, and gaps remain publishable", async () => {
  const current = fixture();
  const first = snapshot();
  const firstEvent = await current.broadcaster.broadcast(first);
  assert.equal(await current.broadcaster.broadcast({ ...first }), null);
  assert.equal(current.attempts.length, 1);

  await rejectsFixed(
    () => current.broadcaster.broadcast({
      ...first,
      status: "verifying"
    }),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR
  );

  const gap = snapshot({
    sequence: 3,
    status: "verifying"
  });
  const gapEvent = await current.broadcaster.broadcast(gap);
  assert.equal(gapEvent.payload.sequence, 3);
  assert.equal(current.attempts.length, 2);
  assert.notEqual(gapEvent.id, firstEvent.id);
  await rejectsFixed(
    () => current.broadcaster.broadcast(snapshot({ sequence: 2 })),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR
  );

  const independent = snapshot({
    sessionId: "authsession_2",
    sequence: 1
  });
  assert.equal((await current.broadcaster.broadcast(independent)).payload.sequence, 1);
  assert.equal(current.attempts.length, 3);
});

test("restoreHighWater trusts a durable snapshot without emitting or treating event memory as business truth", async () => {
  const current = fixture();
  const durable = snapshot({
    sequence: 5,
    status: "verifying"
  });
  await current.broadcaster.restoreHighWater(durable);
  assert.equal(current.attempts.length, 0);
  assert.equal(await current.broadcaster.broadcast({ ...durable }), null);
  await rejectsFixed(
    () => current.broadcaster.restoreHighWater({
      ...durable,
      status: "failed",
      canCancel: false
    }),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR
  );

  const live = snapshot({
    sequence: 6,
    status: "succeeded",
    canCancel: false
  });
  assert.equal((await current.broadcaster.broadcast(live)).payload.sequence, 6);
  await current.broadcaster.restoreHighWater(snapshot({
    sequence: 9,
    status: "succeeded",
    canCancel: false
  }));
  assert.equal(current.attempts.length, 1);
  await rejectsFixed(
    () => current.broadcaster.broadcast(snapshot({
      sequence: 8,
      status: "succeeded",
      canCancel: false
    })),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR
  );
});

test("sink failure retains an exact pending envelope and exact retry is the only session successor", async () => {
  const canary = "/Users/private/.codex raw-claim-token";
  const attempts = [];
  let fail = true;
  const current = fixture({
    async sink(event) {
      attempts.push(event);
      if (fail) {
        fail = false;
        throw new Error(canary);
      }
    }
  });
  const input = snapshot();
  await rejectsFixed(
    () => current.broadcaster.broadcast(input),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_SINK_ERROR,
    [canary, "/Users/private", "raw-claim-token"]
  );
  await rejectsFixed(
    () => current.broadcaster.broadcast(snapshot({ sequence: 2 })),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR
  );
  await rejectsFixed(
    () => current.broadcaster.restoreHighWater(input),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR
  );
  await rejectsFixed(
    () => current.broadcaster.restoreHighWater(snapshot({ sequence: 2 })),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR
  );

  const retried = await current.broadcaster.broadcast({ ...input });
  assert.equal(attempts.length, 2);
  assert.strictEqual(attempts[0], attempts[1]);
  assert.strictEqual(retried, attempts[0]);
  assert.equal(await current.broadcaster.broadcast(input), null);
});

test("restore may confirm only the unchanged sent high-water while a failed successor remains pending", async () => {
  const attempts = [];
  let failSecond = true;
  const current = fixture({
    async sink(event) {
      attempts.push(event);
      if (event.payload.sequence === 2 && failSecond) {
        failSecond = false;
        throw new Error("pending-successor-private-canary");
      }
    }
  });
  const first = snapshot();
  const second = snapshot({ sequence: 2 });
  await current.broadcaster.broadcast(first);
  await rejectsFixed(
    () => current.broadcaster.broadcast(second),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_SINK_ERROR,
    ["pending-successor-private-canary"]
  );

  await current.broadcaster.restoreHighWater({ ...first });
  await rejectsFixed(
    () => current.broadcaster.restoreHighWater({ ...second }),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR
  );
  await rejectsFixed(
    () => current.broadcaster.restoreHighWater(snapshot({ sequence: 3 })),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR
  );
  assert.equal(attempts.length, 2);

  const retried = await current.broadcaster.broadcast({ ...second });
  assert.equal(attempts.length, 3);
  assert.strictEqual(attempts[1], attempts[2]);
  assert.strictEqual(retried, attempts[1]);
});

test("concurrent calls are serialized and capture a frozen clone before callers can mutate", async () => {
  let active = 0;
  let maximumActive = 0;
  const delivered = [];
  const current = fixture({
    async sink(event) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      assert.equal(Object.isFrozen(event), true);
      assert.equal(Object.isFrozen(event.payload), true);
      await new Promise((resolve) => setTimeout(resolve, 5));
      delivered.push(event);
      active -= 1;
    }
  });
  const mutable = snapshot();
  const first = current.broadcaster.broadcast(mutable);
  mutable.sessionId = "mutated_session";
  mutable.sequence = 99;
  mutable.status = "failed";
  mutable.canCancel = false;
  const second = current.broadcaster.broadcast(snapshot({ sequence: 2 }));
  const third = current.broadcaster.broadcast(snapshot({
    sessionId: "authsession_2",
    sequence: 1
  }));
  await Promise.all([first, second, third]);

  assert.equal(maximumActive, 1);
  assert.deepEqual(delivered.map((event) => [event.payload.sessionId, event.payload.sequence]), [
    ["authsession_1", 1],
    ["authsession_1", 2],
    ["authsession_2", 1]
  ]);
});

test("strict snapshot validation rejects extra secrets, paths, malformed fields, and unsafe can flags", async () => {
  const current = fixture();
  const rawTicket = "eyJhbGciOiJFZERTQSJ9.raw-ticket.signature";
  const privatePath = "/Users/private/.codex/auth.json";
  const invalid = [
    null,
    [],
    { ...snapshot(), token: rawTicket },
    { ...snapshot(), commandTicket: rawTicket },
    { ...snapshot(), authUrl: "https://secret.invalid/login" },
    { ...snapshot(), loginId: "login_secret" },
    { ...snapshot(), claimToken: rawTicket },
    { ...snapshot(), credentialPath: privatePath },
    { ...snapshot(), sessionId: "../authsession_1" },
    { ...snapshot(), executorId: "executor/1" },
    { ...snapshot(), sequence: 0 },
    { ...snapshot(), sequence: 1.5 },
    { ...snapshot(), status: "unknown" },
    { ...snapshot(), canReopen: true },
    { ...snapshot(), canCancel: false },
    { ...snapshot(), status: "waiting_user", canReopen: false },
    { ...snapshot(), status: "failed", canCancel: true },
    { ...snapshot(), localFailureCode: undefined },
    { ...snapshot(), localFailureCode: "../../secret" }
  ];
  for (const value of invalid) {
    await rejectsFixed(
      () => current.broadcaster.broadcast(value),
      DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR,
      [rawTicket, privatePath, "https://secret.invalid", "login_secret"]
    );
  }
  assert.equal(current.attempts.length, 0);

  const getterCanary = "getter-secret-token-/private/path";
  let getterCalls = 0;
  const hostile = { ...snapshot() };
  Object.defineProperty(hostile, "sessionId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(getterCanary);
    }
  });
  await rejectsFixed(
    () => current.broadcaster.broadcast(hostile),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR,
    [getterCanary]
  );
  assert.equal(getterCalls, 0);

  const nonEnumerable = { ...snapshot() };
  Object.defineProperty(nonEnumerable, "claimToken", {
    enumerable: false,
    value: rawTicket
  });
  await rejectsFixed(
    () => current.broadcaster.broadcast(nonEnumerable),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR,
    [rawTicket]
  );
  const symbolic = { ...snapshot(), [Symbol("raw-token")]: rawTicket };
  await rejectsFixed(
    () => current.broadcaster.broadcast(symbolic),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR,
    [rawTicket]
  );
  const inherited = Object.assign(
    Object.create({ authUrl: "https://secret.invalid/inherited" }),
    snapshot()
  );
  await rejectsFixed(
    () => current.broadcaster.broadcast(inherited),
    DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR,
    ["https://secret.invalid/inherited"]
  );
});

test("Proxy DTO capture uses each descriptor once and never performs a second property get", async () => {
  const current = fixture();
  const target = snapshot();
  const descriptorCalls = new Map();
  let getCalls = 0;
  const dto = new Proxy(target, {
    get(_target, key) {
      getCalls += 1;
      if (key === "sessionId") return "../../proxy-get-canary";
      return "raw-proxy-token-canary";
    },
    getOwnPropertyDescriptor(actual, key) {
      descriptorCalls.set(key, (descriptorCalls.get(key) ?? 0) + 1);
      return Reflect.getOwnPropertyDescriptor(actual, key);
    }
  });
  const event = await current.broadcaster.broadcast(dto);
  assert.deepEqual(event.payload, target);
  assert.equal(getCalls, 0);
  assert.deepEqual([...descriptorCalls.values()], Array(Object.keys(target).length).fill(1));

  for (const [trap, canary] of [
    ["ownKeys", "proxy-own-keys-private-canary"],
    ["getOwnPropertyDescriptor", "proxy-descriptor-private-canary"]
  ]) {
    const proxy = new Proxy(snapshot({ sessionId: `session_${trap}` }), {
      [trap]() {
        throw new Error(canary);
      }
    });
    await rejectsFixed(
      () => current.broadcaster.broadcast(proxy),
      DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR,
      [canary]
    );
  }
});

test("event id and time factories must produce canonical values without leaking factory failures", async (t) => {
  await t.test("id", async () => {
    const canary = "/private/id-factory-token";
    const current = fixture({
      idFactory() {
        throw new Error(canary);
      }
    });
    await rejectsFixed(
      () => current.broadcaster.broadcast(snapshot()),
      DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR,
      [canary]
    );
  });
  await t.test("malformed id", async () => {
    const current = fixture({ idFactory: () => "NOT-A-CANONICAL-UUID" });
    await rejectsFixed(
      () => current.broadcaster.broadcast(snapshot()),
      DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR,
      ["NOT-A-CANONICAL-UUID"]
    );
  });
  await t.test("time", async () => {
    const current = fixture({ now: () => new Date(Number.NaN) });
    await rejectsFixed(
      () => current.broadcaster.broadcast(snapshot()),
      DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR
    );
  });
});
