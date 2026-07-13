import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DesktopCodexAuthorizationOrchestrator,
  desktopCodexTrustedEffectRecoveryReference
} from "./desktop-codex-authorization-orchestrator.ts";
import {
  desktopCodexAuthorizationSessionData,
  projectDesktopCodexAuthorizationSnapshot
} from "./desktop-codex-authorization-session-store.ts";

const DEVICE_ID = "0".repeat(64);
const OWNERSHIP = "a".repeat(64);
const BINDING_DIGEST = "b".repeat(64);
const BOOT_HASH = "c".repeat(64);
const INSTANCE_HASH = "d".repeat(64);
const LOGIN_HASH = "e".repeat(64);
const CLAIM_REFERENCE = "1".repeat(64);
const CLAIM_HASH = "2".repeat(64);
const PROOF_REFERENCE = "3".repeat(64);
const PROOF_HASH = "4".repeat(64);
const ACK_REFERENCE = "5".repeat(64);
const ACK_HASH = "6".repeat(64);
const TICKET = "aaa.bbb.ccc";
const CLAIM_TOKEN = "ddd.eee.fff";
const ACTIVATION_TOKEN = "ggg.hhh.iii";

function startInput(overrides = {}) {
  return {
    sessionId: "session_1",
    executorId: "executor_1",
    sessionRevision: 1,
    handoffId: "handoff_1",
    handoffTicket: TICKET,
    ...overrides
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function initialData(input) {
  return {
    status: "accepted",
    lastProgressStatus: "accepted",
    sessionId: input.sessionId,
    executorId: input.executorId,
    deviceId: input.deviceId,
    handoffId: input.handoffId,
    sessionRevision: input.sessionRevision,
    claimRequestReference: null,
    claimRequestHash: null,
    claimToken: null,
    claimExpiresAt: null,
    loginIdHash: null,
    accountFingerprint: null,
    candidateBindingDigest: null,
    proofRequestReference: null,
    proofRequestHash: null,
    proofId: null,
    activationOperationId: null,
    activationId: null,
    activationToken: null,
    activationExpiresAt: null,
    credentialRevision: null,
    leaseEpoch: null,
    sourceCredentialRevision: null,
    revocationEpoch: null,
    bindingDigest: null,
    promotionReceipt: null,
    ackRequestReference: null,
    ackRequestHash: null,
    localFailureCode: null
  };
}

class FakeSessionStore {
  constructor(calls, options = {}) {
    this.calls = calls;
    this.options = options;
    this.records = new Map();
    this.createCalls = 0;
  }

  async create(input) {
    this.createCalls += 1;
    const existing = this.records.get(input.sessionId);
    if (existing) return structuredClone(existing);
    const record = {
      version: 1,
      generation: 1,
      ...initialData(input),
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z"
    };
    this.records.set(input.sessionId, record);
    this.calls.push("session:accepted");
    return structuredClone(record);
  }

  async read(sessionId) {
    if (this.options.readGate) await this.options.readGate.promise;
    const value = this.records.get(sessionId);
    return value ? structuredClone(value) : null;
  }

  async transition(expected, data) {
    const current = this.records.get(expected.sessionId);
    if (!current || current.generation !== expected.generation) {
      const error = new Error("stale transition");
      error.code = "desktop_codex_authorization_conflict";
      throw error;
    }
    if (this.options.failBefore === data.status) throw new Error("transition failed before commit");
    const next = {
      version: 1,
      generation: current.generation + 1,
      ...structuredClone(data),
      createdAt: current.createdAt,
      updatedAt: new Date(Date.parse(current.createdAt) + current.generation).toISOString()
    };
    this.records.set(next.sessionId, next);
    this.calls.push(`session:${next.status}`);
    if (this.options.crashAfter === data.status) throw new Error("crash after durable transition");
    return structuredClone(next);
  }

  async terminalize(expected, status, localFailureCode) {
    const current = this.records.get(expected.sessionId);
    assert.equal(current.generation, expected.generation);
    const next = {
      version: 1,
      generation: current.generation + 1,
      ...desktopCodexAuthorizationSessionData(current),
      status,
      lastProgressStatus: current.lastProgressStatus,
      claimToken: null,
      activationToken: null,
      localFailureCode,
      createdAt: current.createdAt,
      updatedAt: new Date(Date.parse(current.createdAt) + current.generation).toISOString()
    };
    this.records.set(next.sessionId, next);
    this.calls.push(`session:${status}`);
    return structuredClone(next);
  }

  async recover(sessionId) {
    this.calls.push("session:recover");
    if (this.options.recoverGate) await this.options.recoverGate.promise;
    if (this.options.recoverError) throw this.options.recoverError;
    let current = this.records.get(sessionId);
    if (current && this.options.recoverRecord) {
      current = typeof this.options.recoverRecord === "function"
        ? await this.options.recoverRecord(structuredClone(current))
        : structuredClone(this.options.recoverRecord);
      this.records.set(sessionId, structuredClone(current));
    }
    return current ? structuredClone(current) : null;
  }
}

class FakeTransport {
  constructor(calls, options = {}) {
    this.calls = calls;
    this.options = options;
    this.completed = [];
    this.cancelCalls = 0;
  }

  async claimDesktopHandoff(input, hooks) {
    return this.perform("claim", hooks, {
      requestReference: CLAIM_REFERENCE,
      requestHash: CLAIM_HASH,
      recovered: false,
      data: {
        handoffId: input.handoffId,
        executorId: this.options.executorByHandoff?.[input.handoffId] ?? "executor_1",
        claimToken: CLAIM_TOKEN,
        expiresAt: "2026-07-13T00:30:00Z",
        sessionRevision: this.options.claimSessionRevision ?? 2,
        replayed: false
      }
    });
  }

  async submitAuthorizationProof(_input, hooks) {
    return this.perform("proof", hooks, {
      requestReference: PROOF_REFERENCE,
      requestHash: PROOF_HASH,
      recovered: false,
      data: {
        proofId: "proof_1",
        result: "succeeded",
        sessionRevision: this.options.proofSessionRevision ?? 3,
        replayed: false,
        operationId: "operation_1",
        activationId: "activation_1",
        credentialRevision: 3,
        leaseEpoch: 2,
        sourceCredentialRevision: 1,
        revocationEpoch: 4,
        bindingDigest: BINDING_DIGEST,
        activationToken: ACTIVATION_TOKEN,
        expiresAt: "2026-07-13T00:30:00Z"
      }
    });
  }

  async acknowledgeCredentialActivation(_input, hooks) {
    return this.perform("ack", hooks, {
      requestReference: ACK_REFERENCE,
      requestHash: ACK_HASH,
      recovered: false,
      data: {
        activationId: "activation_1",
        executorId: "executor_1",
        credentialRevision: 3,
        sessionRevision: this.options.ackSessionRevision ?? 4,
        replayed: false
      }
    });
  }

  async perform(kind, hooks, result) {
    this.calls.push(`${kind}:prepared`);
    await hooks.onPrepared({
      requestReference: result.requestReference,
      requestHash: result.requestHash,
      recovered: false,
      responseAvailable: false
    });
    this.calls.push(`${kind}:network`);
    const gate = this.options.gateByKind?.[kind];
    if (gate) await gate.promise;
    if (this.options.failAt === kind) throw this.options.error;
    return structuredClone(result);
  }

  async completeRequest(reference, hash) {
    const kind = reference === CLAIM_REFERENCE ? "claim" : reference === PROOF_REFERENCE ? "proof" : "ack";
    this.calls.push(`complete:${kind}`);
    this.completed.push({ reference, hash });
  }

  cancel() {
    this.cancelCalls += 1;
    this.calls.push("transport:cancel");
  }
}

class FakeSupervisor {
  constructor(calls, options = {}) {
    this.calls = calls;
    this.options = options;
    this.receipt = null;
    this.states = new Map();
    this.reopenCalls = 0;
  }

  async start(binding) {
    this.calls.push("supervisor:start");
    this.receipt = Object.freeze({
      version: 1,
      bootIdHash: BOOT_HASH,
      instanceIdHash: INSTANCE_HASH,
      ...binding
    });
    this.states.set(binding.sessionId, "ready");
    if (this.options.failAt === "start") throw new Error("start failed");
    return this.receipt;
  }

  async startBrowserLogin(receipt) {
    this.calls.push("supervisor:start_login");
    if (this.options.failAt === "start_login") throw new Error("login effect failed");
    this.states.set(receipt.sessionId, "waiting_user");
    return this.snapshot(receipt, "waiting_user");
  }

  async reopenBrowserLogin(receipt) {
    this.reopenCalls += 1;
    this.calls.push(`supervisor:reopen_login:${receipt.sessionId}:begin`);
    if (this.states.get(receipt.sessionId) !== "waiting_user") {
      throw Object.assign(new Error("runtime target moved"), {
        code: "desktop_codex_app_server_stopped"
      });
    }
    const gate = this.options.reopenGateBySession?.[receipt.sessionId] ??
      this.options.reopenGate;
    if (gate) await gate.promise;
    if (this.states.get(receipt.sessionId) !== "waiting_user") {
      throw Object.assign(new Error("runtime target moved"), {
        code: "desktop_codex_app_server_stopped"
      });
    }
    if (this.options.failAt === "reopen_login") {
      throw new Error(this.options.reopenFailureCanary ?? "reopen failed");
    }
    this.calls.push(`supervisor:reopen_login:${receipt.sessionId}:opened`);
    return this.snapshot(receipt, "waiting_user");
  }

  async waitForLogin(receipt) {
    this.calls.push("supervisor:wait_login");
    const gate = this.options.waitGateBySession?.[receipt.sessionId] ?? this.options.waitGate;
    if (gate) await gate.promise;
    this.states.set(receipt.sessionId, "login_completed");
    return {
      ...this.snapshot(receipt, "login_completed"),
      errorCode: null,
      loginIdHash: LOGIN_HASH
    };
  }

  async readAccount(_receipt, refreshToken) {
    this.calls.push(`supervisor:read_account:${refreshToken}`);
    if (this.options.readAccountGate) await this.options.readAccountGate.promise;
    return {
      account: { type: "chatgpt", email: "owner@example.com", planType: "plus" },
      requiresOpenaiAuth: false
    };
  }

  async stop(receipt) {
    this.calls.push("supervisor:stop");
    if (this.options.failAt === "stop") throw new Error("stop failed");
    await this.options.onStop?.();
    this.states.set(receipt.sessionId, "stopped");
    const gate = this.options.waitGateBySession?.[receipt.sessionId] ?? this.options.waitGate;
    gate?.reject(new Error("supervisor stopped"));
    return this.snapshot(receipt, "stopped");
  }

  async stopByBinding(value) {
    this.calls.push("supervisor:stop_by_binding");
    if (this.options.failAt === "stop_by_binding") throw new Error("stop unconfirmed");
    this.states.set(value.sessionId, "stopped");
    return this.snapshot({
      version: 1,
      bootIdHash: BOOT_HASH,
      instanceIdHash: INSTANCE_HASH,
      ...value
    }, "stopped");
  }

  async shutdownAll() {
    this.calls.push("supervisor:shutdown_all");
    this.options.waitGate?.reject(new Error("supervisor shutdown"));
    for (const gate of Object.values(this.options.waitGateBySession ?? {})) {
      gate.reject(new Error("supervisor shutdown"));
    }
  }

  snapshot(receipt, state) {
    return { ...receipt, state, errorCode: null };
  }
}

class FakeCredentialTree {
  constructor(calls, options = {}) {
    this.calls = calls;
    this.options = options;
  }

  async createOrRecoverStaging(executorId, sessionId) {
    this.calls.push("credential:create_staging");
    return {
      ref: { kind: "staging", executorId, sessionId },
      recovered: false,
      ownershipDigest: OWNERSHIP
    };
  }

  async measure() {
    this.calls.push("credential:measure");
    return {
      algorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
      digest: BINDING_DIGEST,
      fileCount: 2,
      totalBytes: 128
    };
  }

  async promoteStaging(input) {
    this.calls.push("credential:promote");
    if (this.options.promoteGate) await this.options.promoteGate.promise;
    if (this.options.failAt === "promote_after_effect") {
      throw new Error("promotion response lost after durable effect");
    }
    return {
      executorId: input.executorId,
      revision: input.revision,
      operationId: input.operationId,
      digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
      digest: input.expectedDigest,
      fileCount: 2,
      totalBytes: 128
    };
  }

  async completeAfterAcknowledgement() {
    this.calls.push("credential:complete_ack");
  }

  async removeAcknowledged() {
    this.calls.push("credential:remove_ack");
    if (this.options.failAt === "remove_ack") throw new Error("cleanup failure");
  }

  async quarantineStaging() {
    this.calls.push("credential:quarantine_staging");
  }

  async quarantineStagingIfPresent() {
    this.calls.push("credential:quarantine_staging_if_present");
    return null;
  }

  async quarantinePromotion() {
    this.calls.push("credential:quarantine_promotion");
  }
}

class FakeLeaseRuntime {
  constructor(calls) {
    this.calls = calls;
    this.fence = null;
  }

  async start(target) {
    this.calls.push("lease:start");
    this.target = structuredClone(target);
    this.fence = leaseFence(target, 1);
    return leaseResponse(target);
  }

  async stop() {
    this.calls.push("lease:stop");
  }

  async stopAndRenewFresh() {
    this.calls.push("lease:stop_and_renew");
    this.fence = leaseFence(this.target, 2);
    return leaseResponse(this.target);
  }

  clear() {
    this.calls.push("lease:clear");
  }

  async readFence() {
    this.calls.push("lease:read");
    return this.fence;
  }

  async requireFresh(expected) {
    this.calls.push("lease:require");
    assert.equal(expected, this.fence);
    return expected;
  }

  async remove(expected) {
    this.calls.push("lease:remove");
    assert.equal(expected, this.fence);
  }
}

function leaseResponse(target) {
  return {
    activationId: target.activationId,
    executorId: "executor_1",
    operationId: target.operationId,
    credentialRevision: target.credentialRevision,
    leaseEpoch: target.leaseEpoch,
    sourceCredentialRevision: target.sourceCredentialRevision,
    revocationEpoch: target.revocationEpoch,
    renewedAt: "2026-07-13T00:00:00Z",
    leaseExpiresAt: "2026-07-13T00:00:30Z",
    replayed: false
  };
}

function leaseFence(target, generation) {
  const semanticKey = createHash("sha256")
    .update(`AICRM-ACTIVATION-LEASE-FENCE-V1\n${target.sessionId}\n${target.activationId}`)
    .digest("hex");
  const requestReference = createHash("sha256")
    .update(
      "AICRM-TRUSTED-REQUEST-V1\ncredential_activation_lease_renewal\n" +
        `/api/v1/ai-executor-authorization-sessions/${target.sessionId}` +
        `/desktop-activations/${target.activationId}/lease-renewals`
    )
    .digest("hex");
  return {
    version: 1,
    generation,
    status: "fresh",
    semanticKey,
    sessionId: target.sessionId,
    executorId: "executor_1",
    operationId: target.operationId,
    activationId: target.activationId,
    credentialRevision: target.credentialRevision,
    leaseEpoch: target.leaseEpoch,
    sourceCredentialRevision: target.sourceCredentialRevision,
    revocationEpoch: target.revocationEpoch,
    bindingDigest: target.bindingDigest,
    tokenHash: createHash("sha256").update(target.activationToken).digest("hex"),
    requestReference,
    requestHash: "a".repeat(64),
    renewedAt: "2026-07-13T00:00:00Z",
    leaseExpiresAt: "2026-07-13T00:00:30Z",
    replayed: false,
    recovered: false,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    removedAt: null
  };
}

function fixture(options = {}) {
  const calls = [];
  const sessionStore = new FakeSessionStore(calls, options.sessionStore);
  const transport = new FakeTransport(calls, options.transport);
  const supervisor = new FakeSupervisor(calls, options.supervisor);
  const credentialTree = new FakeCredentialTree(calls, options.credentialTree);
  const leaseRuntimes = [];
  let registerCalls = 0;
  let verifyCalls = 0;
  const recoveredSettlement = {
    async settle(record, input) {
      calls.push("settlement:settle");
      if (options.settlement?.gate) await options.settlement.gate.promise;
      if (options.settlement?.error) throw options.settlement.error;
      const transitioned = typeof options.settlement?.transitionedRecord === "function"
        ? await options.settlement.transitionedRecord(record)
        : options.settlement?.transitionedRecord;
      if (transitioned) {
        sessionStore.records.set(transitioned.sessionId, structuredClone(transitioned));
      }
      if (transitioned) await input.onTransition(structuredClone(transitioned));
      const result = {
        record: structuredClone(transitioned ?? record),
        resumeRequested: false
      };
      return typeof options.settlement?.rawResult === "function"
        ? options.settlement.rawResult(result)
        : options.settlement?.rawResult ?? result;
    }
  };
  const leaseFences = {
    async inspect(activationId) {
      calls.push("lease:fence_inspect");
      if (options.leaseFences?.inspectError) throw options.leaseFences.inspectError;
      if (options.leaseFences?.rawRecord !== undefined) {
        return options.leaseFences.rawRecord;
      }
      if (options.leaseFences?.record !== undefined) {
        return structuredClone(options.leaseFences.record);
      }
      const runtime = leaseRuntimes.findLast(
        (candidate) => candidate.fence?.activationId === activationId
      );
      return runtime?.fence ? structuredClone(runtime.fence) : null;
    },
    async remove(fence) {
      calls.push("lease:fence_remove");
      if (options.leaseFences?.removeError) throw options.leaseFences.removeError;
      const runtime = leaseRuntimes.findLast(
        (candidate) => candidate.fence?.activationId === fence.activationId
      );
      if (runtime?.fence) {
        runtime.fence = {
          ...runtime.fence,
          generation: runtime.fence.generation + 1,
          status: "removed",
          updatedAt: "2026-07-13T00:00:01.000Z",
          removedAt: "2026-07-13T00:00:01.000Z"
        };
      }
    }
  };
  const orchestrator = new DesktopCodexAuthorizationOrchestrator({
    identityRegistration: {
      async register() {
        registerCalls += 1;
        calls.push("identity:register");
        return { deviceId: DEVICE_ID, registrationStatus: "registered" };
      }
    },
    async verifyHandoff(input) {
      verifyCalls += 1;
      calls.push("handoff:verify");
      return {
        actorId: "actor_1",
        expectedSessionRevision: 1
      };
    },
    sessionStore,
    async publishSnapshot(snapshot) {
      calls.push(`event:${snapshot.status}:${snapshot.sequence}`);
      const expected = [
        "canCancel", "canReopen", "executorId", "sequence", "sessionId", "status"
      ];
      if ("localFailureCode" in snapshot) expected.push("localFailureCode");
      assert.deepEqual(Object.keys(snapshot).sort(), expected.sort());
    },
    transport,
    supervisor,
    credentialTree,
    bindingState: {
      async activate() {
        calls.push("binding:activate");
        return {};
      }
    },
    recoveredSettlement,
    leaseFences,
    createLeaseRuntime() {
      calls.push("lease:create");
      const lease = new FakeLeaseRuntime(calls);
      leaseRuntimes.push(lease);
      return lease;
    },
    async requireFreshSession() {
      calls.push("fresh_session");
    },
    now: () => new Date("2026-07-13T00:00:00.000Z")
  });
  return {
    orchestrator,
    calls,
    sessionStore,
    transport,
    supervisor,
    credentialTree,
    leaseRuntimes,
    counts: () => ({ registerCalls, verifyCalls })
  };
}

async function seedResumableRecord(current, targetStatus) {
  let record = await current.sessionStore.create({
    sessionId: "session_1",
    executorId: "executor_1",
    deviceId: DEVICE_ID,
    handoffId: "handoff_1",
    sessionRevision: 1
  });
  const advance = async (status, changes = {}) => {
    record = await current.sessionStore.transition(record, {
      ...desktopCodexAuthorizationSessionData(record),
      status,
      lastProgressStatus: status,
      ...changes
    });
  };
  await advance("handoff_claim_starting", {
    claimRequestReference: CLAIM_REFERENCE,
    claimRequestHash: CLAIM_HASH
  });
  await advance("handoff_claimed", {
    claimToken: CLAIM_TOKEN,
    claimExpiresAt: "2026-07-13T00:30:00Z",
    sessionRevision: 2
  });
  if (targetStatus === "handoff_claimed") return record;
  await advance("app_server_starting");
  await advance("app_server_started");
  await advance("login_starting");
  await advance("waiting_user");
  if (targetStatus === "waiting_user") return record;
  await advance("login_completed", {
    loginIdHash: LOGIN_HASH,
    accountFingerprint: BINDING_DIGEST,
    candidateBindingDigest: BINDING_DIGEST
  });
  if (targetStatus === "login_completed") return record;
  await advance("proof_submit_starting", {
    proofRequestReference: PROOF_REFERENCE,
    proofRequestHash: PROOF_HASH
  });
  await advance("proof_prepared", {
    proofId: "proof_1",
    activationOperationId: "operation_1",
    activationId: "activation_1",
    activationToken: ACTIVATION_TOKEN,
    activationExpiresAt: "2026-07-13T00:30:00Z",
    credentialRevision: 3,
    leaseEpoch: 2,
    sourceCredentialRevision: 1,
    revocationEpoch: 4,
    bindingDigest: BINDING_DIGEST,
    sessionRevision: 3
  });
  if (targetStatus === "proof_prepared") return record;
  await advance("activation_pending");
  if (targetStatus === "activation_pending") return record;
  await advance("credential_promotion_starting");
  await advance("credential_durable", {
    promotionReceipt: {
      executorId: "executor_1",
      revision: 3,
      operationId: "operation_1",
      digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
      digest: BINDING_DIGEST,
      fileCount: 2,
      totalBytes: 128
    }
  });
  assert.equal(targetStatus, "credential_durable");
  return record;
}

async function waitForStatus(current, status, sessionId = "session_1") {
  for (let index = 0; index < 100; index += 1) {
    const record = await current.sessionStore.read(sessionId);
    if (record?.status === status) return record;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`status ${status} not reached`);
}

test("strict start DTO and twenty same-session callers share one accepted bootstrap", async () => {
  const current = fixture();
  await assert.rejects(current.orchestrator.start({ ...startInput(), extra: true }), {
    code: "desktop_codex_authorization_orchestrator_invalid_input"
  });
  await assert.rejects(current.orchestrator.start({
    sessionId: "session_1",
    executorId: "executor_1",
    handoffId: "handoff_1",
    handoffTicket: TICKET
  }), { code: "desktop_codex_authorization_orchestrator_invalid_input" });

  const starts = Array.from({ length: 20 }, () => current.orchestrator.start(startInput()));
  await assert.rejects(current.orchestrator.start(startInput({ sessionId: "session_2" })), {
    code: "desktop_codex_authorization_orchestrator_conflict"
  });
  const values = await Promise.all(starts);
  for (const value of values) assert.equal(value, values[0]);
  assert.equal(values[0].status, "starting");
  assert.equal(values[0].sequence, 1);
  assert.deepEqual(current.counts(), { registerCalls: 1, verifyCalls: 1 });
  assert.equal(current.sessionStore.createCalls, 1);
  await current.orchestrator.waitForIdle("session_1");
});

test("happy path publishes every durable generation and preserves the locked call order", async () => {
  const current = fixture();
  const accepted = await current.orchestrator.start(startInput());
  assert.deepEqual(accepted, {
    sessionId: "session_1",
    executorId: "executor_1",
    sequence: 1,
    status: "starting",
    canReopen: false,
    canCancel: true
  });
  const completed = await current.orchestrator.waitForIdle("session_1");
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.sequence, 16);
  assert.deepEqual(current.calls, [
    "identity:register", "handoff:verify", "session:accepted", "event:starting:1",
    "claim:prepared", "session:handoff_claim_starting", "event:starting:2", "claim:network",
    "session:handoff_claimed", "event:starting:3", "complete:claim",
    "session:app_server_starting", "event:starting:4", "credential:create_staging",
    "supervisor:start", "session:app_server_started", "event:starting:5",
    "session:login_starting", "event:starting:6", "supervisor:start_login",
    "session:waiting_user", "event:waiting_user:7", "supervisor:wait_login",
    "supervisor:read_account:true", "supervisor:stop", "credential:measure",
    "session:login_completed", "event:verifying:8", "proof:prepared",
    "session:proof_submit_starting", "event:verifying:9", "proof:network",
    "session:proof_prepared", "event:verifying:10", "complete:proof", "lease:create",
    "lease:start", "lease:read", "lease:require", "session:activation_pending",
    "event:verifying:11", "fresh_session", "session:credential_promotion_starting",
    "event:verifying:12", "credential:promote", "session:credential_durable",
    "event:verifying:13", "lease:stop_and_renew", "lease:read", "lease:require",
    "ack:prepared", "session:activation_ack_starting", "event:verifying:14", "ack:network",
    "session:activation_ack_response_received", "event:verifying:15", "binding:activate",
    "credential:complete_ack", "session:activation_acked", "event:succeeded:16",
    "complete:ack", "credential:remove_ack", "lease:remove", "lease:clear"
  ]);
  const record = await current.sessionStore.read("session_1");
  assert.equal(record.claimToken, null);
  assert.equal(record.activationToken, null);
  assert.equal(record.ackRequestReference, ACK_REFERENCE);
  assert.equal(record.ackRequestHash, ACK_HASH);
});

test("startup resume singleflights and continues each durable resumable state without replaying prior effects", async (t) => {
  const cases = [
    {
      status: "handoff_claimed",
      required: ["supervisor:start", "proof:network", "credential:promote", "ack:network"],
      forbidden: ["identity:register", "handoff:verify", "claim:network"]
    },
    {
      status: "login_completed",
      required: ["credential:create_staging", "proof:network", "credential:promote", "ack:network"],
      forbidden: ["identity:register", "handoff:verify", "claim:network", "supervisor:start"]
    },
    {
      status: "proof_prepared",
      required: ["credential:create_staging", "lease:start", "credential:promote", "ack:network"],
      forbidden: ["identity:register", "handoff:verify", "claim:network", "proof:network"]
    },
    {
      status: "activation_pending",
      required: ["credential:create_staging", "lease:start", "credential:promote", "ack:network"],
      forbidden: ["identity:register", "handoff:verify", "claim:network", "proof:network"]
    },
    {
      status: "credential_durable",
      required: ["lease:start", "ack:network"],
      forbidden: [
        "identity:register", "handoff:verify", "claim:network", "proof:network",
        "credential:create_staging", "credential:promote"
      ]
    }
  ];
  for (const scenario of cases) {
    await t.test(scenario.status, async () => {
      const current = fixture();
      const record = await seedResumableRecord(current, scenario.status);
      current.calls.length = 0;
      await Promise.all(Array.from({ length: 20 }, () => current.orchestrator.resume(record)));
      const completed = await current.orchestrator.waitForIdle("session_1");
      assert.equal(completed.status, "succeeded");
      for (const call of scenario.required) assert.equal(current.calls.includes(call), true, call);
      for (const call of scenario.forbidden) assert.equal(current.calls.includes(call), false, call);
      assert.equal(current.leaseRuntimes.length, 1);
    });
  }
});

test("resume rejects stale or non-resumable records before starting any effect", async () => {
  const current = fixture();
  const record = await seedResumableRecord(current, "login_completed");
  current.calls.length = 0;
  await assert.rejects(current.orchestrator.resume({
    ...record,
    status: "waiting_user",
    lastProgressStatus: "waiting_user"
  }), { code: "desktop_codex_authorization_orchestrator_invalid_input" });
  await assert.rejects(current.orchestrator.resume({
    ...record,
    generation: record.generation + 1
  }), { code: "desktop_codex_authorization_orchestrator_conflict" });
  assert.deepEqual(current.calls, []);
});

test("resume singleflight rejects a competing full recovery tuple", async () => {
  const readGate = deferred();
  const current = fixture({ sessionStore: { readGate } });
  const record = await seedResumableRecord(current, "handoff_claimed");
  current.calls.length = 0;
  const exact = current.orchestrator.resume(record);
  await Promise.resolve();
  await assert.rejects(current.orchestrator.resume({
    ...record,
    generation: record.generation + 1
  }), { code: "desktop_codex_authorization_orchestrator_conflict" });
  await assert.rejects(current.orchestrator.resume({
    ...record,
    executorId: "executor_competing"
  }), { code: "desktop_codex_authorization_orchestrator_conflict" });
  readGate.resolve();
  await exact;
  assert.equal((await current.orchestrator.waitForIdle("session_1")).status, "succeeded");
});

test("shutdown waits for a pending resume read and prevents any late instance admission", async () => {
  const readGate = deferred();
  const current = fixture({ sessionStore: { readGate } });
  const record = await seedResumableRecord(current, "handoff_claimed");
  current.calls.length = 0;
  const resume = current.orchestrator.resume(record);
  await Promise.resolve();
  const shutdown = current.orchestrator.shutdown();
  readGate.resolve();
  await assert.rejects(resume, {
    code: "desktop_codex_authorization_orchestrator_stopped"
  });
  await shutdown;
  assert.equal(current.calls.includes("supervisor:start"), false);
  assert.equal(current.calls.includes("session:app_server_starting"), false);
  assert.equal((await current.sessionStore.read("session_1")).status, "handoff_claimed");
});

function reopenTarget(overrides = {}) {
  return {
    sessionId: "session_1",
    executorId: "executor_1",
    deviceId: DEVICE_ID,
    operationId: "operation_reopen_1",
    expectedSessionRevision: 2,
    ...overrides
  };
}

function cancelTarget(overrides = {}) {
  return {
    sessionId: "session_1",
    executorId: "executor_1",
    deviceId: DEVICE_ID,
    operationId: "operation_cancel_1",
    expectedSessionRevision: 2,
    ...overrides
  };
}

test("trusted reopen target and recovery reference are exact, descriptor-safe, and deterministic", async () => {
  const expected = desktopCodexTrustedEffectRecoveryReference(
    "authorization_reopen",
    reopenTarget()
  );
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.equal(
    desktopCodexTrustedEffectRecoveryReference("authorization_reopen", reopenTarget()),
    expected
  );
  assert.notEqual(
    desktopCodexTrustedEffectRecoveryReference("authorization_cancel", reopenTarget()),
    expected
  );
  assert.notEqual(
    desktopCodexTrustedEffectRecoveryReference("authorization_reopen", reopenTarget({
      deviceId: "1".repeat(64)
    })),
    expected
  );
  assert.throws(
    () => desktopCodexTrustedEffectRecoveryReference("authorization_reopen", reopenTarget({
      deviceId: "device_unsafe"
    })),
    { code: "desktop_codex_authorization_orchestrator_invalid_input" }
  );
  assert.throws(
    () => desktopCodexTrustedEffectRecoveryReference(
      "authorization_reopen",
      { ...reopenTarget(), extra: true }
    ),
    { code: "desktop_codex_authorization_orchestrator_invalid_input" }
  );

  const accessor = reopenTarget();
  Object.defineProperty(accessor, "executorId", {
    enumerable: true,
    get() {
      throw new Error("private accessor canary");
    }
  });
  assert.throws(
    () => desktopCodexTrustedEffectRecoveryReference("authorization_reopen", accessor),
    { code: "desktop_codex_authorization_orchestrator_invalid_input" }
  );

  let operationReads = 0;
  const descriptorOnly = new Proxy(reopenTarget(), {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== "operationId" || !descriptor || !("value" in descriptor)) return descriptor;
      operationReads += 1;
      return {
        ...descriptor,
        value: operationReads === 1 ? "operation_reopen_1" : "private_canary"
      };
    }
  });
  assert.equal(
    desktopCodexTrustedEffectRecoveryReference("authorization_reopen", descriptorOnly),
    expected
  );
  assert.equal(operationReads, 1);

  const waitGate = deferred();
  const current = fixture({ supervisor: { waitGate } });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "waiting_user");
  await assert.rejects(current.orchestrator.reopenTrusted(accessor), {
    code: "desktop_codex_authorization_orchestrator_invalid_input"
  });
  assert.equal(current.supervisor.reopenCalls, 0);
  waitGate.resolve();
  await current.orchestrator.waitForIdle("session_1");
});

test("a cross-device trusted target is stale before every reopen or cancel effect", async () => {
  const waitGate = deferred();
  const current = fixture({ supervisor: { waitGate } });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "waiting_user");

  const foreignDevice = { deviceId: "1".repeat(64) };
  assert.equal((await current.orchestrator.reopenTrusted(reopenTarget(foreignDevice))).result,
    "stale_target");
  assert.equal((await current.orchestrator.cancelTrusted(cancelTarget(foreignDevice))).result,
    "stale_target");
  assert.equal(current.supervisor.reopenCalls, 0);
  assert.equal(current.calls.includes("supervisor:stop"), false);

  assert.equal((await current.orchestrator.reopenTrusted(reopenTarget())).result, "succeeded");
  assert.equal(current.supervisor.reopenCalls, 1);
  waitGate.resolve();
  await current.orchestrator.waitForIdle("session_1");
});

test("twenty exact trusted reopen callers share one effect and conflicting operations serialize", async () => {
  const waitGate = deferred();
  const firstGate = deferred();
  const current = fixture({ supervisor: { waitGate, reopenGate: firstGate } });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "waiting_user");

  const operations = Array.from(
    { length: 20 },
    () => current.orchestrator.reopenTrusted(reopenTarget())
  );
  assert.ok(operations.every((operation) => operation === operations[0]));
  const competing = current.orchestrator.reopenTrusted(reopenTarget({
    operationId: "operation_reopen_2"
  }));
  for (let index = 0; index < 100 && current.supervisor.reopenCalls === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(current.supervisor.reopenCalls, 1);
  firstGate.resolve();
  const results = await Promise.all(operations);
  for (const result of results) assert.equal(result, results[0]);
  assert.deepEqual(results[0], {
    result: "succeeded",
    failureCode: null,
    snapshot: {
      sessionId: "session_1",
      executorId: "executor_1",
      sequence: 7,
      status: "waiting_user",
      canReopen: true,
      canCancel: true
    }
  });
  assert.equal((await competing).result, "succeeded");
  assert.equal(current.supervisor.reopenCalls, 2);
  assert.deepEqual(
    current.calls.filter((call) => call.includes("supervisor:reopen_login")),
    [
      "supervisor:reopen_login:session_1:begin",
      "supervisor:reopen_login:session_1:opened",
      "supervisor:reopen_login:session_1:begin",
      "supervisor:reopen_login:session_1:opened"
    ]
  );
  waitGate.resolve();
  await current.orchestrator.waitForIdle("session_1");
});

test("trusted reopen lanes execute different sessions in parallel", async () => {
  const firstWait = deferred();
  const secondWait = deferred();
  const firstReopen = deferred();
  const secondReopen = deferred();
  const current = fixture({
    transport: { executorByHandoff: { handoff_2: "executor_2" } },
    supervisor: {
      waitGateBySession: { session_1: firstWait, session_2: secondWait },
      reopenGateBySession: { session_1: firstReopen, session_2: secondReopen }
    }
  });
  await Promise.all([
    current.orchestrator.start(startInput()),
    current.orchestrator.start(startInput({
      sessionId: "session_2",
      executorId: "executor_2",
      handoffId: "handoff_2"
    }))
  ]);
  await Promise.all([
    waitForStatus(current, "waiting_user", "session_1"),
    waitForStatus(current, "waiting_user", "session_2")
  ]);
  const first = current.orchestrator.reopenTrusted(reopenTarget());
  const second = current.orchestrator.reopenTrusted(reopenTarget({
    sessionId: "session_2",
    executorId: "executor_2",
    operationId: "operation_reopen_2"
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    current.calls.filter((call) => call.endsWith(":begin")),
    [
      "supervisor:reopen_login:session_1:begin",
      "supervisor:reopen_login:session_2:begin"
    ]
  );
  firstReopen.resolve();
  secondReopen.resolve();
  assert.equal((await first).result, "succeeded");
  assert.equal((await second).result, "succeeded");
  firstWait.resolve();
  secondWait.resolve();
  await Promise.allSettled([
    current.orchestrator.waitForIdle("session_1"),
    current.orchestrator.waitForIdle("session_2")
  ]);
});

test("scan completion wins a pending reopen as stale_target", async () => {
  const waitGate = deferred();
  const reopenGate = deferred();
  const current = fixture({ supervisor: { waitGate, reopenGate } });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "waiting_user");
  const reopening = current.orchestrator.reopenTrusted(reopenTarget());
  await new Promise((resolve) => setImmediate(resolve));
  waitGate.resolve();
  for (let index = 0; index < 100; index += 1) {
    if ((await current.sessionStore.read("session_1"))?.status !== "waiting_user") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  reopenGate.resolve();
  const result = await reopening;
  assert.equal(result.result, "stale_target");
  assert.equal(result.failureCode, null);
  assert.notEqual(result.snapshot.status, "waiting_user");
  assert.equal(JSON.stringify(result).includes("http"), false);
  await current.orchestrator.waitForIdle("session_1");
});

test("trusted reopen returns safe stale and runtime failure results without leaking URLs", async () => {
  const missing = fixture();
  await assert.rejects(missing.orchestrator.reopenTrusted(reopenTarget()), {
    code: "desktop_codex_authorization_orchestrator_conflict"
  });
  assert.equal(missing.supervisor.reopenCalls, 0);

  const current = fixture();
  const waiting = await seedResumableRecord(current, "waiting_user");
  current.calls.length = 0;
  assert.deepEqual(await current.orchestrator.reopenTrusted(reopenTarget()), {
    result: "failed",
    failureCode: "desktop_codex_authorization_runtime_missing",
    snapshot: projectDesktopCodexAuthorizationSnapshot(waiting)
  });
  assert.equal(current.supervisor.reopenCalls, 0);
  assert.equal((await current.orchestrator.reopenTrusted(reopenTarget({
    expectedSessionRevision: 99
  }))).result, "stale_target");

  const waitGate = deferred();
  const canary = "https://auth.example.invalid/private?token=secret";
  const failed = fixture({ supervisor: {
    waitGate,
    failAt: "reopen_login",
    reopenFailureCanary: canary
  } });
  await failed.orchestrator.start(startInput());
  await waitForStatus(failed, "waiting_user");
  const result = await failed.orchestrator.reopenTrusted(reopenTarget());
  assert.deepEqual(result, {
    result: "failed",
    failureCode: "desktop_codex_authorization_reopen_failed",
    snapshot: {
      sessionId: "session_1",
      executorId: "executor_1",
      sequence: 7,
      status: "waiting_user",
      canReopen: true,
      canCancel: true
    }
  });
  assert.equal(JSON.stringify(result).includes(canary), false);
  waitGate.resolve();
  await failed.orchestrator.waitForIdle("session_1");
});

test("twenty trusted cancels share one exact stop, never use global transport cancel, and serialize competitors", async () => {
  const waitGate = deferred();
  const current = fixture({ supervisor: { waitGate } });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "waiting_user");

  const cancellations = Array.from(
    { length: 20 },
    () => current.orchestrator.cancelTrusted(cancelTarget())
  );
  assert.ok(cancellations.every((operation) => operation === cancellations[0]));
  const competing = current.orchestrator.cancelTrusted(cancelTarget({
    operationId: "operation_cancel_2"
  }));
  const results = await Promise.all(cancellations);
  for (const result of results) assert.equal(result, results[0]);
  assert.deepEqual(results[0], {
    result: "succeeded",
    failureCode: null,
    snapshot: {
      sessionId: "session_1",
      executorId: "executor_1",
      sequence: 8,
      status: "cancelled",
      canReopen: false,
      canCancel: false
    }
  });
  assert.equal((await competing).result, "stale_target");
  assert.equal(current.transport.cancelCalls, 0);
  assert.equal(current.calls.filter((value) => value === "supervisor:stop").length, 1);
  const stopped = current.calls.indexOf("supervisor:stop");
  const recovered = current.calls.indexOf("session:recover");
  const settled = current.calls.indexOf("settlement:settle");
  const quarantined = current.calls.indexOf("credential:quarantine_staging");
  const terminal = current.calls.indexOf("session:cancelled");
  assert.ok(recovered > stopped, current.calls.join(" -> "));
  assert.ok(settled > recovered, current.calls.join(" -> "));
  assert.ok(quarantined > settled, current.calls.join(" -> "));
  assert.ok(terminal > quarantined, current.calls.join(" -> "));
});

test("a synchronously fenced cancel makes an already-running and a queued reopen stale", async () => {
  const waitGate = deferred();
  const reopenGate = deferred();
  const current = fixture({ supervisor: { waitGate, reopenGate } });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "waiting_user");

  const reopening = current.orchestrator.reopenTrusted(reopenTarget());
  for (let index = 0; index < 100 && current.supervisor.reopenCalls === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const cancelling = current.orchestrator.cancelTrusted(cancelTarget());
  const queuedReopen = current.orchestrator.reopenTrusted(reopenTarget({
    operationId: "operation_reopen_after_cancel"
  }));
  reopenGate.resolve();

  assert.equal((await reopening).result, "stale_target");
  assert.equal((await cancelling).result, "succeeded");
  assert.equal((await queuedReopen).result, "stale_target");
  assert.equal(current.supervisor.reopenCalls, 1);
  assert.equal(current.transport.cancelCalls, 0);
});

test("a foreign queued cancel cannot release the exact pending cancel fence", async () => {
  const waitGate = deferred();
  const reopenGate = deferred();
  const exactReadGate = deferred();
  const exactReadStarted = deferred();
  const current = fixture({ supervisor: { waitGate, reopenGate } });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "waiting_user");

  const reopening = current.orchestrator.reopenTrusted(reopenTarget());
  for (let index = 0; index < 100 && current.supervisor.reopenCalls === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(current.supervisor.reopenCalls, 1);

  const originalRead = current.sessionStore.read.bind(current.sessionStore);
  let readsAfterReopenStarted = 0;
  current.sessionStore.read = async (sessionId) => {
    readsAfterReopenStarted += 1;
    if (readsAfterReopenStarted === 3) {
      exactReadStarted.resolve();
      await exactReadGate.promise;
    }
    return originalRead(sessionId);
  };

  const foreignCancel = current.orchestrator.cancelTrusted(cancelTarget({
    deviceId: "1".repeat(64),
    operationId: "operation_foreign_cancel"
  }));
  const exactCancel = current.orchestrator.cancelTrusted(cancelTarget());
  waitGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current.calls.includes("supervisor:read_account:true"), false);

  reopenGate.resolve();
  assert.equal((await reopening).result, "stale_target");
  assert.equal((await foreignCancel).result, "stale_target");
  await exactReadStarted.promise;
  assert.equal(readsAfterReopenStarted, 3);
  assert.equal(current.calls.includes("supervisor:read_account:true"), false);
  assert.equal(current.calls.includes("credential:measure"), false);

  exactReadGate.resolve();
  assert.equal((await exactCancel).result, "succeeded");
  assert.equal(current.calls.includes("session:cancelled"), true);
  assert.equal(current.transport.cancelCalls, 0);
});

test("an authoritative stale read releases the pending cancel hold and the original flow continues", async () => {
  const waitGate = deferred();
  const current = fixture({ supervisor: { waitGate } });
  await current.orchestrator.start(startInput());
  const waiting = await waitForStatus(current, "waiting_user");
  const originalRead = current.sessionStore.read.bind(current.sessionStore);
  let reads = 0;
  current.sessionStore.read = async (sessionId) => {
    reads += 1;
    if (reads === 1) return { ...waiting, sessionRevision: 3 };
    return originalRead(sessionId);
  };

  const result = await current.orchestrator.cancelTrusted(cancelTarget());
  assert.equal(result.result, "stale_target");
  waitGate.resolve();
  assert.equal((await current.orchestrator.waitForIdle("session_1")).status, "succeeded");
  assert.equal(current.calls.includes("proof:network"), true);
  assert.equal(current.calls.includes("session:cancelled"), false);
});

test("shutdown releases a queued pending cancel hold and converges without deadlock", async () => {
  const waitGate = deferred();
  const reopenGate = deferred();
  const current = fixture({ supervisor: { waitGate, reopenGate } });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "waiting_user");
  const reopening = current.orchestrator.reopenTrusted(reopenTarget());
  for (let index = 0; index < 100 && current.supervisor.reopenCalls === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const cancelling = current.orchestrator.cancelTrusted(cancelTarget());
  const shutdown = current.orchestrator.shutdown();
  reopenGate.resolve();

  assert.equal((await reopening).result, "stale_target");
  await assert.rejects(cancelling, {
    code: "desktop_codex_authorization_orchestrator_stopped"
  });
  await shutdown;
  assert.equal((await current.sessionStore.read("session_1")).status, "interrupted");
});

test("cancel fences an in-flight claim but lets its exact response persist before recovery", async () => {
  const claimGate = deferred();
  const current = fixture({ transport: { gateByKind: { claim: claimGate } } });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "handoff_claim_starting");
  const cancelling = current.orchestrator.cancelTrusted(cancelTarget({
    expectedSessionRevision: 1
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current.transport.cancelCalls, 0);
  claimGate.resolve();

  const result = await cancelling;
  assert.equal(result.result, "succeeded");
  assert.equal(result.snapshot.status, "cancelled");
  assert.equal(current.calls.includes("complete:claim"), true);
  assert.equal(current.calls.includes("supervisor:start"), false);
  assert.ok(
    current.calls.indexOf("session:recover") > current.calls.indexOf("complete:claim"),
    current.calls.join(" -> ")
  );
});

test("cancel during account read prevents a second stop, measurement, and login completion", async () => {
  const readAccountGate = deferred();
  const current = fixture({ supervisor: { readAccountGate } });
  await current.orchestrator.start(startInput());
  for (let index = 0; index < 100; index += 1) {
    if (current.calls.includes("supervisor:read_account:true")) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(current.calls.includes("supervisor:read_account:true"), true);
  const cancelling = current.orchestrator.cancelTrusted(cancelTarget());
  await new Promise((resolve) => setImmediate(resolve));
  readAccountGate.resolve();

  const result = await cancelling;
  assert.equal(result.result, "succeeded");
  assert.equal(current.calls.filter((value) => value === "supervisor:stop").length, 1);
  assert.equal(current.calls.includes("credential:measure"), false);
  assert.equal(current.calls.includes("session:login_completed"), false);
});

test("cancel waits for an in-flight promotion and quarantines the promoted revision before terminalizing", async () => {
  const promoteGate = deferred();
  const current = fixture({ credentialTree: { promoteGate } });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "credential_promotion_starting");
  const cancelling = current.orchestrator.cancelTrusted(cancelTarget({
    expectedSessionRevision: 3
  }));
  await new Promise((resolve) => setImmediate(resolve));
  promoteGate.resolve();

  const result = await cancelling;
  assert.equal(result.result, "succeeded");
  assert.equal(result.snapshot.status, "cancelled");
  assert.equal(current.calls.includes("ack:network"), false);
  const durable = current.calls.indexOf("session:credential_durable");
  const recovered = current.calls.indexOf("session:recover");
  const quarantined = current.calls.indexOf("credential:quarantine_promotion");
  const fenceRemoved = current.calls.indexOf("lease:fence_remove");
  const leaseCleared = current.calls.indexOf("lease:clear");
  const terminal = current.calls.indexOf("session:cancelled");
  assert.ok(recovered > durable, current.calls.join(" -> "));
  assert.ok(quarantined > recovered, current.calls.join(" -> "));
  assert.ok(fenceRemoved > quarantined, current.calls.join(" -> "));
  assert.ok(leaseCleared > fenceRemoved, current.calls.join(" -> "));
  assert.ok(terminal > leaseCleared, current.calls.join(" -> "));
});

test("an ambiguous promotion attempt is quarantined as promotion and never mistaken for staging", async () => {
  const promoteGate = deferred();
  const current = fixture({ credentialTree: {
    promoteGate,
    failAt: "promote_after_effect"
  } });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "credential_promotion_starting");
  const cancelling = current.orchestrator.cancelTrusted(cancelTarget({
    expectedSessionRevision: 3
  }));
  promoteGate.resolve();

  const result = await cancelling;
  assert.equal(result.result, "failed");
  assert.equal(result.failureCode, "desktop_codex_authorization_cancel_failed");
  assert.equal(current.calls.includes("credential:quarantine_promotion"), true);
  assert.equal(current.calls.includes("credential:quarantine_staging"), false);
  assert.equal(current.calls.includes("credential:quarantine_staging_if_present"), false);
  assert.equal(current.calls.includes("lease:fence_remove"), true);
  assert.equal(current.calls.includes("session:cancelled"), false);
});

test("a state that guarantees a lease refuses cancellation when exact lease evidence is absent", async () => {
  const promoteGate = deferred();
  const current = fixture({
    credentialTree: { promoteGate },
    leaseFences: { record: null }
  });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "credential_promotion_starting");
  const cancelling = current.orchestrator.cancelTrusted(cancelTarget({
    expectedSessionRevision: 3
  }));
  promoteGate.resolve();

  const result = await cancelling;
  assert.equal(result.result, "failed");
  assert.equal(result.failureCode, "desktop_codex_authorization_cancel_cleanup_failed");
  assert.equal(current.calls.includes("session:cancelled"), false);
  assert.equal(current.calls.includes("lease:clear"), false);
});

test("lease cleanup captures hostile descriptors once before full invariant validation", async () => {
  const promoteGate = deferred();
  const leaseFences = {};
  const current = fixture({
    credentialTree: { promoteGate },
    leaseFences
  });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "credential_promotion_starting");
  const fence = current.leaseRuntimes[0].fence;
  let descriptorReads = 0;
  leaseFences.rawRecord = new Proxy(fence, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== "bindingDigest" || !descriptor || !("value" in descriptor)) return descriptor;
      descriptorReads += 1;
      return {
        ...descriptor,
        value: descriptorReads === 1 ? BINDING_DIGEST : "f".repeat(64)
      };
    }
  });
  const cancelling = current.orchestrator.cancelTrusted(cancelTarget({
    expectedSessionRevision: 3
  }));
  promoteGate.resolve();

  const result = await cancelling;
  assert.equal(result.result, "succeeded");
  assert.equal(descriptorReads, 1);
  assert.equal(current.calls.includes("lease:fence_remove"), true);
});

test("an activation ACK response wins cancellation and settles to safe stale_target", async () => {
  const ackGate = deferred();
  const current = fixture({
    transport: { gateByKind: { ack: ackGate } },
    settlement: {
      transitionedRecord(record) {
        assert.equal(record.status, "activation_ack_response_received");
        return {
          ...record,
          generation: record.generation + 1,
          status: "activation_acked",
          lastProgressStatus: "activation_acked",
          claimToken: null,
          activationToken: null,
          updatedAt: "2026-07-13T00:00:01.000Z"
        };
      }
    }
  });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "activation_ack_starting");
  const cancelling = current.orchestrator.cancelTrusted(cancelTarget({
    expectedSessionRevision: 3
  }));
  ackGate.resolve();

  const result = await cancelling;
  assert.equal(result.result, "stale_target");
  assert.equal(result.failureCode, null);
  assert.equal(result.snapshot.status, "succeeded");
  assert.equal(current.calls.includes("session:cancelled"), false);
  assert.equal(current.transport.cancelCalls, 0);
  assert.equal(current.calls.includes("lease:clear"), true);
  const next = await current.orchestrator.start(startInput({
    sessionId: "session_2",
    handoffId: "handoff_2"
  }));
  assert.equal(next.sessionId, "session_2");
  assert.equal((await current.orchestrator.waitForIdle("session_2")).status, "succeeded");
});

test("a proof recovered as cancelled is a successful cancel after exact local cleanup", async () => {
  const proofGate = deferred();
  const current = fixture({
    transport: {
      gateByKind: { proof: proofGate },
      failAt: "proof",
      error: new Error("ambiguous proof transport")
    },
    sessionStore: {
      recoverRecord(record) {
        assert.equal(record.status, "proof_submit_starting");
        return {
          ...record,
          generation: record.generation + 1,
          status: "cancelled",
          claimToken: null,
          activationToken: null,
          localFailureCode: null,
          updatedAt: "2026-07-13T00:00:01.000Z"
        };
      }
    }
  });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "proof_submit_starting");
  const cancelling = current.orchestrator.cancelTrusted(cancelTarget({
    expectedSessionRevision: 2
  }));
  proofGate.resolve();

  const result = await cancelling;
  assert.equal(result.result, "succeeded");
  assert.equal(result.snapshot.status, "cancelled");
  assert.equal(current.calls.includes("credential:quarantine_staging"), true);
  assert.equal(current.calls.includes("session:cancelled"), false);
  assert.equal(current.transport.cancelCalls, 0);
});

test("recovery rejects a structurally valid terminal that advances lastProgress and artifacts", async () => {
  const proofGate = deferred();
  const current = fixture({
    transport: {
      gateByKind: { proof: proofGate },
      failAt: "proof",
      error: new Error("ambiguous proof transport")
    },
    sessionStore: {
      recoverRecord(record) {
        assert.equal(record.status, "proof_submit_starting");
        return {
          ...record,
          generation: record.generation + 1,
          status: "failed",
          lastProgressStatus: "credential_durable",
          claimToken: null,
          activationToken: null,
          localFailureCode: "forged_recovery_failure",
          proofId: "proof_forged",
          activationOperationId: "operation_forged",
          activationId: "activation_forged",
          activationExpiresAt: "2026-07-13T00:30:00Z",
          credentialRevision: 3,
          leaseEpoch: 2,
          sourceCredentialRevision: 1,
          revocationEpoch: 4,
          bindingDigest: BINDING_DIGEST,
          promotionReceipt: {
            executorId: "executor_1",
            revision: 3,
            operationId: "operation_forged",
            digestAlgorithm: "aicrm-credential-tree-rfc8785-nfc-v1",
            digest: BINDING_DIGEST,
            fileCount: 2,
            totalBytes: 128
          },
          updatedAt: "2026-07-13T00:00:01.000Z"
        };
      }
    }
  });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "proof_submit_starting");
  const cancelling = current.orchestrator.cancelTrusted(cancelTarget({
    expectedSessionRevision: 2
  }));
  proofGate.resolve();

  const result = await cancelling;
  assert.equal(result.result, "failed");
  assert.equal(result.failureCode, "desktop_codex_authorization_cancel_failed");
  assert.equal(current.calls.includes("settlement:settle"), false);
  assert.equal(current.calls.some((value) => value.includes("quarantine")), false);
  assert.equal(current.calls.includes("lease:fence_inspect"), false);
  assert.equal(current.calls.includes("session:cancelled"), false);
});

test("trusted cancel returns fixed safe failures for missing runtime and unresolved recovery", async () => {
  const missing = fixture();
  const waiting = await seedResumableRecord(missing, "waiting_user");
  missing.calls.length = 0;
  assert.deepEqual(await missing.orchestrator.cancelTrusted(cancelTarget()), {
    result: "failed",
    failureCode: "desktop_codex_authorization_runtime_missing",
    snapshot: projectDesktopCodexAuthorizationSnapshot(waiting)
  });

  const waitGate = deferred();
  const failed = fixture({
    supervisor: { waitGate },
    sessionStore: { recoverError: new Error("private recovery canary") }
  });
  await failed.orchestrator.start(startInput());
  await waitForStatus(failed, "waiting_user");
  const result = await failed.orchestrator.cancelTrusted(cancelTarget());
  assert.equal(result.result, "failed");
  assert.equal(result.failureCode, "desktop_codex_authorization_cancel_failed");
  assert.equal(JSON.stringify(result).includes("canary"), false);
  assert.equal(failed.calls.includes("session:cancelled"), false);
});

test("trusted cancel descriptor-captures recovery and rejects hostile settlement output safely", async () => {
  const waitGate = deferred();
  const current = fixture({
    supervisor: { waitGate },
    settlement: {
      rawResult(result) {
        let getterReads = 0;
        Object.defineProperty(result, "resumeRequested", {
          enumerable: true,
          get() {
            getterReads += 1;
            throw new Error("settlement getter canary");
          }
        });
        current.settlementGetterReads = () => getterReads;
        return result;
      }
    }
  });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "waiting_user");

  const originalRecover = current.sessionStore.recover.bind(current.sessionStore);
  let descriptorReads = 0;
  current.sessionStore.recover = async (sessionId) => {
    const record = await originalRecover(sessionId);
    return new Proxy(record, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== "executorId" || !descriptor || !("value" in descriptor)) return descriptor;
        descriptorReads += 1;
        return {
          ...descriptor,
          value: descriptorReads === 1 ? "executor_1" : "executor_private_canary"
        };
      }
    });
  };

  const result = await current.orchestrator.cancelTrusted(cancelTarget());
  assert.equal(result.result, "failed");
  assert.equal(result.failureCode, "desktop_codex_authorization_cancel_failed");
  assert.equal(JSON.stringify(result).includes("canary"), false);
  assert.equal(descriptorReads, 1);
  assert.equal(current.settlementGetterReads(), 0);
  assert.equal(current.calls.includes("session:cancelled"), false);
});

test("flow refresh rejects hostile session output before publication while cancel still recovers", async () => {
  const waitGate = deferred();
  const current = fixture({ supervisor: { waitGate } });
  await current.orchestrator.start(startInput());
  const waiting = await waitForStatus(current, "waiting_user");
  const originalRead = current.sessionStore.read.bind(current.sessionStore);
  let reads = 0;
  let getterReads = 0;
  current.sessionStore.read = async (sessionId) => {
    reads += 1;
    if (reads !== 2) return originalRead(sessionId);
    const hostile = { ...waiting };
    Object.defineProperty(hostile, "executorId", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("refresh getter canary");
      }
    });
    return hostile;
  };

  const result = await current.orchestrator.cancelTrusted(cancelTarget());
  assert.equal(result.result, "succeeded");
  assert.equal(getterReads, 0);
  assert.equal(JSON.stringify(result).includes("canary"), false);
});

test("a converged executor admits a different session while the original session stays idempotent", async () => {
  const current = fixture();
  const originalAccepted = await current.orchestrator.start(startInput());
  await current.orchestrator.waitForIdle("session_1");
  assert.equal(await current.orchestrator.start(startInput()), originalAccepted);

  const nextInput = startInput({ sessionId: "session_2", handoffId: "handoff_2" });
  const nextAccepted = await current.orchestrator.start(nextInput);
  assert.equal(nextAccepted.sessionId, "session_2");
  assert.equal(nextAccepted.sequence, 1);
  assert.equal((await current.orchestrator.waitForIdle("session_2")).status, "succeeded");
  assert.equal(current.sessionStore.createCalls, 2);
});

test("hook crash after durable starting transition publishes the recovered fence and sends no network", async () => {
  const current = fixture({
    sessionStore: { crashAfter: "handoff_claim_starting" }
  });
  await current.orchestrator.start(startInput());
  await assert.rejects(current.orchestrator.waitForIdle("session_1"), {
    code: "desktop_codex_authorization_orchestrator_operation_failed"
  });
  const record = await current.sessionStore.read("session_1");
  assert.equal(record.status, "handoff_claim_starting");
  assert.equal(record.claimRequestReference, CLAIM_REFERENCE);
  assert.equal(current.calls.includes("claim:network"), false);
  assert.equal(current.calls.includes("complete:claim"), false);
  assert.equal(current.calls.includes("event:starting:2"), true);
  assert.equal(current.calls.some((value) => value.startsWith("session:failed")), false);
});

test("ambiguous network failure keeps the exact starting journal and performs no cleanup", async () => {
  const error = Object.assign(new Error("ambiguous private path"), {
    code: "desktop_authorization_transport_failed",
    status: null
  });
  const current = fixture({ transport: { failAt: "claim", error } });
  await current.orchestrator.start(startInput());
  await assert.rejects(current.orchestrator.waitForIdle("session_1"), {
    code: "desktop_codex_authorization_orchestrator_operation_failed"
  });
  const record = await current.sessionStore.read("session_1");
  assert.equal(record.status, "handoff_claim_starting");
  assert.equal(current.calls.includes("complete:claim"), false);
  assert.equal(current.calls.some((value) => value.includes("quarantine")), false);
  assert.equal(current.calls.some((value) => value === "session:failed"), false);
});

test("claim, proof, and ACK responses require the exact next server session revision", async (t) => {
  for (const scenario of [
    {
      name: "claim",
      options: { claimSessionRevision: 3 },
      status: "handoff_claim_starting",
      completed: "complete:claim"
    },
    {
      name: "proof",
      options: { proofSessionRevision: 4 },
      status: "proof_submit_starting",
      completed: "complete:proof"
    },
    {
      name: "ack",
      options: { ackSessionRevision: 5 },
      status: "activation_ack_starting",
      completed: "complete:ack"
    }
  ]) {
    await t.test(scenario.name, async () => {
      const current = fixture({ transport: scenario.options });
      await current.orchestrator.start(startInput());
      await assert.rejects(current.orchestrator.waitForIdle("session_1"));
      assert.equal((await current.sessionStore.read("session_1")).status, scenario.status);
      assert.equal(current.calls.includes(scenario.completed), false);
      assert.equal(current.calls.includes("session:failed"), false);
    });
  }
});

test("deterministic proof 4xx reconciles staging before terminalizing and completing its journal", async () => {
  const error = Object.assign(new Error("server private rejection"), {
    code: "desktop_authorization_transport_rejected",
    status: 409,
    serverCode: "authorization_conflict"
  });
  const current = fixture({ transport: { failAt: "proof", error } });
  await current.orchestrator.start(startInput());
  await assert.rejects(current.orchestrator.waitForIdle("session_1"), {
    code: "desktop_codex_authorization_orchestrator_operation_failed"
  });
  const record = await current.sessionStore.read("session_1");
  assert.equal(record.status, "failed");
  assert.equal(record.lastProgressStatus, "proof_submit_starting");
  const quarantine = current.calls.indexOf("credential:quarantine_staging");
  const terminal = current.calls.indexOf("session:failed");
  const completed = current.calls.indexOf("complete:proof");
  assert.ok(quarantine > current.calls.indexOf("proof:network"));
  assert.ok(terminal > quarantine);
  assert.ok(completed > terminal, current.calls.join(" -> "));
});

test("local app-server effect failure stops the exact receipt, quarantines staging, then terminates safely", async () => {
  const current = fixture({ supervisor: { failAt: "start_login" } });
  const originalAccepted = await current.orchestrator.start(startInput());
  await assert.rejects(current.orchestrator.waitForIdle("session_1"));
  const record = await current.sessionStore.read("session_1");
  assert.equal(record.status, "failed");
  const stop = current.calls.lastIndexOf("supervisor:stop");
  const quarantine = current.calls.indexOf("credential:quarantine_staging");
  const terminal = current.calls.indexOf("session:failed");
  assert.ok(stop > current.calls.indexOf("supervisor:start_login"));
  assert.ok(quarantine > stop);
  assert.ok(terminal > quarantine);
  assert.equal(await current.orchestrator.start(startInput()), originalAccepted);
  current.supervisor.options.failAt = null;
  const next = await current.orchestrator.start(startInput({
    sessionId: "session_2",
    handoffId: "handoff_2"
  }));
  assert.equal(next.sessionId, "session_2");
  assert.equal((await current.orchestrator.waitForIdle("session_2")).status, "succeeded");
});

test("App Server start rejection requires binding-bound stop proof before staging cleanup", async () => {
  const current = fixture({ supervisor: { failAt: "start" } });
  await current.orchestrator.start(startInput());
  await assert.rejects(current.orchestrator.waitForIdle("session_1"));
  assert.equal((await current.sessionStore.read("session_1")).status, "failed");
  const stopped = current.calls.indexOf("supervisor:stop_by_binding");
  const quarantine = current.calls.indexOf("credential:quarantine_staging");
  assert.ok(stopped > current.calls.indexOf("supervisor:start"));
  assert.ok(quarantine > stopped);

  const unconfirmed = fixture({ supervisor: { failAt: "stop_by_binding" } });
  unconfirmed.supervisor.options.failAt = "start";
  const originalStop = unconfirmed.supervisor.stopByBinding.bind(unconfirmed.supervisor);
  unconfirmed.supervisor.stopByBinding = async (value) => {
    unconfirmed.calls.push("supervisor:stop_by_binding");
    throw new Error(`unconfirmed:${value.sessionId}`);
  };
  await unconfirmed.orchestrator.start(startInput());
  await assert.rejects(unconfirmed.orchestrator.waitForIdle("session_1"));
  assert.equal(
    (await unconfirmed.sessionStore.read("session_1")).status,
    "app_server_starting"
  );
  assert.equal(unconfirmed.calls.includes("credential:quarantine_staging"), false);
  assert.equal(unconfirmed.calls.includes("session:failed"), false);
  unconfirmed.supervisor.stopByBinding = originalStop;
});

test("a failed App Server stop never measures a still-mutable staging tree", async () => {
  const current = fixture({ supervisor: { failAt: "stop" } });
  await current.orchestrator.start(startInput());
  await assert.rejects(current.orchestrator.waitForIdle("session_1"));
  const record = await current.sessionStore.read("session_1");
  assert.equal(record.status, "waiting_user");
  assert.equal(current.calls.includes("credential:measure"), false);
  assert.equal(current.calls.includes("session:failed"), false);
  assert.equal(current.calls.filter((value) => value === "supervisor:stop").length, 2);
});

test("shutdown cancels admission, stops the waiter, quarantines staging, and publishes interrupted", async () => {
  const waitGate = deferred();
  const current = fixture({ supervisor: { waitGate } });
  await current.orchestrator.start(startInput());
  await waitForStatus(current, "waiting_user");
  await current.orchestrator.shutdown();
  const record = await current.sessionStore.read("session_1");
  assert.equal(record.status, "interrupted");
  assert.equal(current.transport.cancelCalls, 1);
  assert.equal(current.calls.includes("supervisor:shutdown_all"), true);
  assert.equal(current.calls.includes("supervisor:stop"), true);
  assert.equal(current.calls.includes("credential:quarantine_staging"), true);
  assert.equal(current.calls.some((value) => value.startsWith("event:interrupted:")), true);
  await assert.rejects(current.orchestrator.start(startInput({
    sessionId: "session_2",
    executorId: "executor_2"
  })), { code: "desktop_codex_authorization_orchestrator_stopped" });
});

test("post-success cleanup failure retains activation ACK and exact lease evidence", async () => {
  const current = fixture({ credentialTree: { failAt: "remove_ack" } });
  await current.orchestrator.start(startInput());
  await assert.rejects(current.orchestrator.waitForIdle("session_1"), {
    code: "desktop_codex_authorization_orchestrator_operation_failed"
  });
  const record = await current.sessionStore.read("session_1");
  assert.equal(projectDesktopCodexAuthorizationSnapshot(record).status, "succeeded");
  assert.equal(current.calls.includes("complete:ack"), true);
  assert.equal(current.calls.includes("credential:remove_ack"), true);
  assert.equal(current.calls.includes("lease:remove"), false);
  assert.equal(current.leaseRuntimes[0].fence.status, "fresh");
});
