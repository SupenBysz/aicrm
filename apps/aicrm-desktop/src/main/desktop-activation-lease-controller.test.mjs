import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_ACTIVATION_LEASE_RENEWAL_INTERVAL_MS,
  DESKTOP_ACTIVATION_LEASE_REQUEST_TIMEOUT_MS,
  DesktopActivationLeaseController
} from "./desktop-activation-lease-controller.ts";

const DIGEST = "d".repeat(64);

function target(overrides = {}) {
  return {
    sessionId: "session_1",
    activationToken: "activation.header.signature",
    operationId: "operation_1",
    activationId: "activation_1",
    credentialRevision: 2,
    leaseEpoch: 3,
    sourceCredentialRevision: 1,
    revocationEpoch: 0,
    bindingDigest: DIGEST,
    ...overrides
  };
}

function result(overrides = {}) {
  const { data: dataOverrides = {}, ...resultOverrides } = overrides;
  return {
    requestReference: "a".repeat(64),
    requestHash: "b".repeat(64),
    recovered: false,
    data: {
      activationId: "activation_1",
      executorId: "executor_1",
      operationId: "operation_1",
      credentialRevision: 2,
      leaseEpoch: 3,
      sourceCredentialRevision: 1,
      revocationEpoch: 0,
      renewedAt: "2026-07-13T09:00:00.000Z",
      leaseExpiresAt: "2026-07-13T09:00:30.000Z",
      replayed: false,
      ...dataOverrides
    },
    ...resultOverrides
  };
}

function fixture(responses = [result()]) {
  const queue = [...responses];
  const order = [];
  const renewCalls = [];
  const completeCalls = [];
  const persisted = [];
  const scheduled = [];
  const cleared = [];
  const transport = {
    async renewCredentialActivationLease(value) {
      renewCalls.push({ ...value });
      order.push("renew");
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next();
      if (!next) throw new Error("missing fake renewal");
      return next;
    },
    async completeRequest(reference, hash) {
      order.push("complete");
      completeCalls.push([reference, hash]);
    }
  };
  const fenceStore = {
    async persistRenewal(value, renewal) {
      order.push("persist");
      persisted.push([{ ...value }, structuredClone(renewal)]);
    }
  };
  const controller = new DesktopActivationLeaseController({
    transport,
    fenceStore,
    setTimer(callback, delay) {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimer(timer) {
      cleared.push(timer);
    }
  });
  return {
    controller,
    transport,
    fenceStore,
    queue,
    order,
    renewCalls,
    completeCalls,
    persisted,
    scheduled,
    cleared
  };
}

test("first renewal is fenced and completed before the fixed 10 second schedule", async () => {
  assert.equal(DESKTOP_ACTIVATION_LEASE_RENEWAL_INTERVAL_MS, 10_000);
  assert.equal(DESKTOP_ACTIVATION_LEASE_REQUEST_TIMEOUT_MS, 5_000);
  const current = fixture();
  const renewed = await current.controller.start(target());
  assert.equal(renewed.leaseExpiresAt, "2026-07-13T09:00:30.000Z");
  assert.deepEqual(current.order, ["renew", "persist", "complete"]);
  assert.equal(current.persisted.length, 1);
  assert.equal(current.completeCalls.length, 1);
  assert.equal(current.scheduled.length, 1);
  assert.equal(current.scheduled[0].delay, 10_000);
});

test("a recovered or server-replayed renewal is only a fence before a fresh sequence", async () => {
  const current = fixture([
    result({ recovered: true }),
    result({
      requestReference: "c".repeat(64),
      requestHash: "e".repeat(64),
      data: {
        renewedAt: "2026-07-13T09:00:01.000Z",
        leaseExpiresAt: "2026-07-13T09:00:31.000Z"
      }
    })
  ]);
  const renewed = await current.controller.start(target());
  assert.equal(renewed.renewedAt, "2026-07-13T09:00:01.000Z");
  assert.equal(current.renewCalls.length, 2);
  assert.deepEqual(current.order, [
    "renew",
    "persist",
    "complete",
    "renew",
    "persist",
    "complete"
  ]);

  const repeated = fixture([
    result({ data: { replayed: true } }),
    result({ recovered: true })
  ]);
  await assert.rejects(repeated.controller.start(target()), {
    code: "desktop_activation_lease_fresh_required"
  });
  assert.equal(repeated.completeCalls.length, 2);
});

test("singleflight shares one exact renewal and rejects a competing activation tuple", async () => {
  let resolveRenewal;
  const pending = new Promise((resolve) => {
    resolveRenewal = resolve;
  });
  const current = fixture([() => pending]);
  const first = current.controller.start(target());
  const shared = current.controller.renewNow();
  await assert.rejects(
    current.controller.start(target({ activationId: "activation_2" })),
    { code: "desktop_activation_lease_conflict" }
  );
  await assert.rejects(
    current.controller.start({ ...target(), rendererOverride: true }),
    { code: "desktop_activation_lease_conflict" }
  );
  assert.equal(current.renewCalls.length, 1);
  resolveRenewal(result());
  assert.deepEqual(await first, await shared);
  assert.equal(current.renewCalls.length, 1);
  assert.equal(current.scheduled.length, 1);
});

test("a failed durable fence never completes the outbound journal and can recover safely", async () => {
  const recovered = result({ recovered: true });
  const fresh = result({
    requestReference: "f".repeat(64),
    requestHash: "1".repeat(64),
    data: {
      renewedAt: "2026-07-13T09:00:01.000Z",
      leaseExpiresAt: "2026-07-13T09:00:31.000Z"
    }
  });
  const current = fixture([result(), recovered, fresh]);
  let failOnce = true;
  current.fenceStore.persistRenewal = async () => {
    current.order.push("persist");
    if (failOnce) {
      failOnce = false;
      throw new Error("durable fence failed");
    }
  };
  await assert.rejects(current.controller.start(target()), /durable fence failed/);
  assert.equal(current.completeCalls.length, 0);

  await current.controller.start(target());
  assert.equal(current.completeCalls.length, 2);
  assert.equal(current.renewCalls.length, 3);
});

test("ACK preparation stops the ticker, waits for work, then performs one final fresh renewal", async () => {
  const current = fixture([
    result(),
    result({
      requestReference: "2".repeat(64),
      requestHash: "3".repeat(64),
      data: {
        renewedAt: "2026-07-13T09:00:02.000Z",
        leaseExpiresAt: "2026-07-13T09:00:32.000Z"
      }
    })
  ]);
  await current.controller.start(target());
  const finalRenewal = await current.controller.stopAndRenewFresh();
  assert.equal(finalRenewal.renewedAt, "2026-07-13T09:00:02.000Z");
  assert.equal(current.cleared.length, 1);
  assert.equal(current.scheduled.length, 1);
  assert.equal(current.renewCalls.length, 2);
  current.controller.clear();
  await assert.rejects(current.controller.renewNow(), {
    code: "desktop_activation_lease_not_started"
  });
});
