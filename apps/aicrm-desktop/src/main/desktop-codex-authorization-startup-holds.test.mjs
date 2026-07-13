import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopCodexAuthorizationStartupHoldError,
  DesktopCodexAuthorizationStartupHoldRegistry
} from "./desktop-codex-authorization-startup-holds.ts";

const DEVICE_ID = "0".repeat(64);
const EVIDENCE_HASH = "e".repeat(64);
const STATUSES = [
  "accepted",
  "effect_started",
  "effect_durable",
  "ack_prepared",
  "acknowledged",
  "ack_rejected",
  "indeterminate"
];

function command(overrides = {}) {
  return {
    purpose: "authorization_cancel",
    status: "accepted",
    semanticKey: "1".repeat(64),
    tokenHash: "2".repeat(64),
    payloadHash: "3".repeat(64),
    effectRecoveryReference: "4".repeat(64),
    sessionId: "session_1",
    executorId: "executor_1",
    deviceId: DEVICE_ID,
    operationId: "operation_1",
    expectedSessionRevision: 7,
    ...overrides
  };
}

function expectCode(code, operation) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof DesktopCodexAuthorizationStartupHoldError);
    assert.equal(error.code, code);
    return true;
  });
}

test("every durable cancel status blocks resume until exact containment releases it", () => {
  for (const [index, status] of STATUSES.entries()) {
    const registry = new DesktopCodexAuthorizationStartupHoldRegistry();
    const input = command({
      status,
      sessionId: `session_${index + 1}`,
      operationId: `operation_${index + 1}`,
      semanticKey: (index + 1).toString(16).repeat(64)
    });
    const capability = registry.installFromDurableCommand(input);
    assert.equal(registry.installFromDurableCommand(input), capability);
    assert.deepEqual(registry.find(input.sessionId), {
      version: 1,
      state: "pending",
      journalStatus: status,
      semanticKey: input.semanticKey,
      tokenHash: input.tokenHash,
      payloadHash: input.payloadHash,
      effectRecoveryReference: input.effectRecoveryReference,
      sessionId: input.sessionId,
      executorId: input.executorId,
      deviceId: input.deviceId,
      operationId: input.operationId,
      expectedSessionRevision: input.expectedSessionRevision,
      containmentEvidenceHash: null
    });
    expectCode("desktop_codex_authorization_startup_hold_resume_blocked", () =>
      registry.assertResumeAllowed({ sessionId: input.sessionId })
    );
    assert.equal(registry.commit(capability).state, "committed");
    expectCode("desktop_codex_authorization_startup_hold_resume_blocked", () =>
      registry.assertResumeAllowed({ sessionId: input.sessionId })
    );
    const contained = registry.markContained(capability, EVIDENCE_HASH);
    assert.equal(contained.state, "contained");
    assert.equal(contained.containmentEvidenceHash, EVIDENCE_HASH);
    assert.equal(
      registry.markContained(capability, EVIDENCE_HASH).containmentEvidenceHash,
      EVIDENCE_HASH
    );
    registry.release(capability);
    registry.release(capability);
    assert.equal(registry.find(input.sessionId), null);
    registry.assertResumeAllowed({ sessionId: input.sessionId });
  }
});

test("one session and one semantic command can own only one exact hold", () => {
  const registry = new DesktopCodexAuthorizationStartupHoldRegistry();
  const first = command();
  registry.installFromDurableCommand(first);
  for (const conflicting of [
    command({ operationId: "operation_2", semanticKey: "5".repeat(64) }),
    command({ sessionId: "session_2" }),
    command({ status: "effect_started" })
  ]) {
    expectCode("desktop_codex_authorization_startup_hold_conflict", () =>
      registry.installFromDurableCommand(conflicting)
    );
  }
  assert.equal(registry.find("session_2"), null);
  assert.equal(registry.find("session_1")?.operationId, "operation_1");
});

test("reopen and malformed cancel projections never install a hold", () => {
  const registry = new DesktopCodexAuthorizationStartupHoldRegistry();
  for (const invalid of [
    command({ purpose: "authorization_reopen" }),
    command({ status: "unknown" }),
    command({ deviceId: "device_unsafe" }),
    command({ effectRecoveryReference: null }),
    command({ expectedSessionRevision: 0 }),
    { ...command(), extra: true },
    { ...command(), [Symbol("secret")]: "ticket-canary" },
    Object.assign(Object.create({ inherited: true }), command()),
    Object.defineProperty({ ...command() }, "deviceId", {
      value: DEVICE_ID,
      enumerable: false
    })
  ]) {
    expectCode("desktop_codex_authorization_startup_hold_invalid_input", () =>
      registry.installFromDurableCommand(invalid)
    );
  }
  assert.equal(registry.find("session_1"), null);
});

test("hostile descriptors are captured once without getters, traps, or secret leakage", () => {
  const registry = new DesktopCodexAuthorizationStartupHoldRegistry();
  const canary = "raw-ticket-auth-url-path-canary";
  for (const field of Object.keys(command())) {
    let getterReads = 0;
    const hostile = { ...command() };
    Object.defineProperty(hostile, field, {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(`${canary}:${field}`);
      }
    });
    let captured;
    assert.throws(
      () => registry.installFromDurableCommand(hostile),
      (error) => {
        captured = error;
        assert.equal(error.code, "desktop_codex_authorization_startup_hold_invalid_input");
        return true;
      }
    );
    assert.equal(getterReads, 0);
    assert.equal(`${captured}\n${captured.stack ?? ""}`.includes(canary), false);
  }

  for (const hostile of [
    new Proxy(command(), {
      ownKeys() {
        throw new Error(canary);
      }
    }),
    new Proxy(command(), {
      getOwnPropertyDescriptor(target, key) {
        if (key === "deviceId") throw new Error(canary);
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    })
  ]) {
    expectCode("desktop_codex_authorization_startup_hold_invalid_input", () =>
      registry.installFromDurableCommand(hostile)
    );
  }

  let descriptorReads = 0;
  let rawReads = 0;
  const capturedOnce = new Proxy(command(), {
    get() {
      rawReads += 1;
      throw new Error(canary);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== "deviceId" || !descriptor) return descriptor;
      descriptorReads += 1;
      return {
        ...descriptor,
        value: descriptorReads === 1 ? DEVICE_ID : "f".repeat(64)
      };
    }
  });
  const capability = registry.installFromDurableCommand(capturedOnce);
  assert.equal(descriptorReads, 1);
  assert.equal(rawReads, 0);
  const projection = registry.find("session_1");
  assert.equal(projection?.deviceId, DEVICE_ID);
  assert.equal(JSON.stringify({ capability, projection }).includes(canary), false);
});

test("capabilities are unforgeable and state transitions are fail closed", () => {
  const registry = new DesktopCodexAuthorizationStartupHoldRegistry();
  const capability = registry.installFromDurableCommand(command());
  expectCode("desktop_codex_authorization_startup_hold_invalid_capability", () =>
    registry.commit({ ...capability })
  );
  expectCode("desktop_codex_authorization_startup_hold_invalid_state", () =>
    registry.markContained(capability, EVIDENCE_HASH)
  );
  assert.equal(registry.commit(capability).state, "committed");
  expectCode("desktop_codex_authorization_startup_hold_invalid_state", () =>
    registry.release(capability)
  );
  registry.markContained(capability, EVIDENCE_HASH);
  expectCode("desktop_codex_authorization_startup_hold_conflict", () =>
    registry.markContained(capability, "f".repeat(64))
  );
  registry.release(capability);
  expectCode("desktop_codex_authorization_startup_hold_invalid_state", () =>
    registry.commit(capability)
  );
});

test("resume assertions reject hostile DTOs without reading accessors", () => {
  const registry = new DesktopCodexAuthorizationStartupHoldRegistry();
  registry.installFromDurableCommand(command());
  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, "sessionId", {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error("resume-canary");
    }
  });
  expectCode("desktop_codex_authorization_startup_hold_invalid_input", () =>
    registry.assertResumeAllowed(hostile)
  );
  assert.equal(reads, 0);
  expectCode("desktop_codex_authorization_startup_hold_invalid_input", () =>
    registry.assertResumeAllowed({ sessionId: "session_1", extra: true })
  );
  expectCode("desktop_codex_authorization_startup_hold_resume_blocked", () =>
    registry.assertResumeAllowed({ sessionId: "session_1" })
  );
});
