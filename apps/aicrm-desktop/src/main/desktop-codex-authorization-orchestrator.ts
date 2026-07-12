import type {
  CodexAuthorizationSnapshot,
  CodexAuthorizationStartInput
} from "../shared/types.ts";
import type { CodexAccountReadResult, CodexChatGPTAccount } from "./codex-app-server-auth-client.ts";
import { codexAccountFingerprint } from "./codex-account-fingerprint.ts";
import type {
  DesktopActivationLeaseFenceRecord
} from "./desktop-activation-lease-fence-store.ts";
import type {
  AcknowledgeDesktopCredentialActivationInput,
  AcknowledgeDesktopCredentialActivationResponse,
  ClaimDesktopHandoffInput,
  ClaimDesktopHandoffResponse,
  DesktopAuthorizationTransportClient,
  DesktopTrustedRequestHooks,
  DesktopTrustedRequestPrepared,
  DesktopTrustedTransportResult,
  RenewDesktopCredentialActivationLeaseInput,
  RenewDesktopCredentialActivationLeaseResponse,
  SubmitDesktopAuthorizationProofInput,
  SubmitDesktopAuthorizationProofSucceededResponse
} from "./desktop-authorization-transport-client.ts";
import type {
  DesktopCodexAppServerBinding,
  DesktopCodexAppServerLoginCompletion,
  DesktopCodexAppServerReceipt,
  DesktopCodexAppServerSnapshot,
  DesktopCodexAppServerSupervisor
} from "./desktop-codex-app-server-supervisor.ts";
import {
  desktopCodexAuthorizationSessionData,
  projectDesktopCodexAuthorizationSnapshot,
  type DesktopCodexAuthorizationSessionData,
  type DesktopCodexAuthorizationSessionRecord,
  type DesktopCodexAuthorizationSessionStore,
  type DesktopCodexAuthorizationTerminalStatus
} from "./desktop-codex-authorization-session-store.ts";
import type {
  DesktopCredentialRevisionProjection,
  DesktopCredentialStagingCreationResult,
  DesktopCredentialTreeManager
} from "./desktop-credential-tree-manager.ts";
import type { DesktopCredentialTreeDigest } from "./desktop-credential-tree-digest.ts";
import type {
  ActivateDesktopExecutorBindingInput,
  DesktopExecutorBindingStateStore
} from "./desktop-executor-binding-state.ts";

const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const DEVICE_ID = /^[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DETERMINISTIC_REJECTIONS = new Set([400, 401, 403, 409, 410, 422, 426]);

export type DesktopCodexAuthorizationOrchestratorErrorCode =
  | "desktop_codex_authorization_orchestrator_conflict"
  | "desktop_codex_authorization_orchestrator_invalid_input"
  | "desktop_codex_authorization_orchestrator_operation_failed"
  | "desktop_codex_authorization_orchestrator_stopped";

export class DesktopCodexAuthorizationOrchestratorError extends Error {
  readonly code: DesktopCodexAuthorizationOrchestratorErrorCode;

  constructor(code: DesktopCodexAuthorizationOrchestratorErrorCode, message: string) {
    super(message);
    this.name = "DesktopCodexAuthorizationOrchestratorError";
    this.code = code;
    this.stack = `${this.name}: ${message}`;
  }
}

export interface DesktopCodexRegisteredIdentity {
  deviceId: string;
  registrationStatus: "registered";
}

export interface DesktopCodexAuthorizationHandoffVerificationInput {
  token: string;
  registeredDeviceId: string;
  sessionId: string;
  executorId: string;
  handoffId: string;
}

export interface DesktopCodexAuthorizationHandoffFacts {
  actorId: string;
  expectedSessionRevision: number;
}

export interface DesktopCodexAuthorizationFreshSessionInput {
  sessionId: string;
  executorId: string;
  sessionRevision: number;
  generation: number;
}

export interface DesktopCodexAuthorizationLeaseRuntime {
  start(
    target: RenewDesktopCredentialActivationLeaseInput
  ): Promise<RenewDesktopCredentialActivationLeaseResponse>;
  stop(): Promise<void>;
  stopAndRenewFresh(): Promise<RenewDesktopCredentialActivationLeaseResponse>;
  clear(): void;
  readFence(activationId: string): Promise<DesktopActivationLeaseFenceRecord | null>;
  requireFresh(
    expected: DesktopActivationLeaseFenceRecord
  ): Promise<DesktopActivationLeaseFenceRecord>;
  remove(expected: DesktopActivationLeaseFenceRecord): Promise<void>;
}

interface AuthorizationSessionStore extends Pick<
  DesktopCodexAuthorizationSessionStore,
  "create" | "read" | "transition" | "terminalize"
> {}

interface AuthorizationTransport extends Pick<
  DesktopAuthorizationTransportClient,
  | "claimDesktopHandoff"
  | "submitAuthorizationProof"
  | "acknowledgeCredentialActivation"
  | "completeRequest"
  | "cancel"
> {}

interface AuthorizationSupervisor extends Pick<
  DesktopCodexAppServerSupervisor,
  | "start"
  | "startBrowserLogin"
  | "waitForLogin"
  | "readAccount"
  | "stop"
  | "stopByBinding"
  | "shutdownAll"
> {}

interface AuthorizationCredentialTree extends Pick<
  DesktopCredentialTreeManager,
  | "createOrRecoverStaging"
  | "measure"
  | "promoteStaging"
  | "completeAfterAcknowledgement"
  | "removeAcknowledged"
  | "quarantineStaging"
  | "quarantinePromotion"
> {}

interface AuthorizationBindingState extends Pick<DesktopExecutorBindingStateStore, "activate"> {}

export interface DesktopCodexAuthorizationOrchestratorOptions {
  identityRegistration: {
    register(): Promise<DesktopCodexRegisteredIdentity>;
  };
  verifyHandoff(
    input: Readonly<DesktopCodexAuthorizationHandoffVerificationInput>
  ): Readonly<DesktopCodexAuthorizationHandoffFacts> |
    Promise<Readonly<DesktopCodexAuthorizationHandoffFacts>>;
  sessionStore: AuthorizationSessionStore;
  publishSnapshot(snapshot: Readonly<CodexAuthorizationSnapshot>): Promise<unknown>;
  transport: AuthorizationTransport;
  supervisor: AuthorizationSupervisor;
  credentialTree: AuthorizationCredentialTree;
  bindingState: AuthorizationBindingState;
  createLeaseRuntime(
    input: Readonly<{ sessionId: string; executorId: string }>
  ): DesktopCodexAuthorizationLeaseRuntime;
  requireFreshSession(
    input: Readonly<DesktopCodexAuthorizationFreshSessionInput>
  ): Promise<void>;
  now?: () => Date;
}

interface PendingRequest {
  readonly kind: "claim" | "proof" | "ack";
  readonly requestReference: string;
  readonly requestHash: string;
}

interface AuthorizationRuntimeInput {
  readonly sessionId: string;
  readonly executorId: string;
  readonly sessionRevision: number;
  readonly handoffId: string;
  readonly handoffTicket: string | null;
}

interface RuntimeInstance {
  readonly input: Readonly<AuthorizationRuntimeInput>;
  startPromise: Promise<Readonly<CodexAuthorizationSnapshot>>;
  flow: Promise<void> | null;
  record: DesktopCodexAuthorizationSessionRecord | null;
  accepted: Readonly<CodexAuthorizationSnapshot> | null;
  publishedGeneration: number;
  staging: DesktopCredentialStagingCreationResult | null;
  appServerReceipt: Readonly<DesktopCodexAppServerReceipt> | null;
  appServerStartAttempted: boolean;
  appServerStopped: boolean;
  lease: DesktopCodexAuthorizationLeaseRuntime | null;
  leaseFence: DesktopActivationLeaseFenceRecord | null;
  promotion: DesktopCredentialRevisionProjection | null;
  pendingRequest: PendingRequest | null;
  stagingQuarantined: boolean;
  promotionQuarantined: boolean;
}

interface ResumeOperation {
  readonly expected: DesktopCodexAuthorizationSessionRecord;
  readonly promise: Promise<void>;
}

class ShutdownSignal extends Error {}

/**
 * Main-only P2A happy-path owner. It deliberately exposes no IPC or feature
 * flag surface; production wiring is a separate reviewed change.
 */
export class DesktopCodexAuthorizationOrchestrator {
  private readonly identityRegistration: DesktopCodexAuthorizationOrchestratorOptions["identityRegistration"];
  private readonly verifyHandoff: DesktopCodexAuthorizationOrchestratorOptions["verifyHandoff"];
  private readonly sessionStore: AuthorizationSessionStore;
  private readonly publishSnapshot: DesktopCodexAuthorizationOrchestratorOptions["publishSnapshot"];
  private readonly transport: AuthorizationTransport;
  private readonly supervisor: AuthorizationSupervisor;
  private readonly credentialTree: AuthorizationCredentialTree;
  private readonly bindingState: AuthorizationBindingState;
  private readonly createLeaseRuntime: DesktopCodexAuthorizationOrchestratorOptions["createLeaseRuntime"];
  private readonly requireFreshSession: DesktopCodexAuthorizationOrchestratorOptions["requireFreshSession"];
  private readonly now: () => Date;
  private readonly instances = new Map<string, RuntimeInstance>();
  private readonly activeSessionByExecutor = new Map<string, string>();
  private readonly resumeOperations = new Map<string, ResumeOperation>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: DesktopCodexAuthorizationOrchestratorOptions) {
    validateOptions(options);
    this.identityRegistration = options.identityRegistration;
    this.verifyHandoff = options.verifyHandoff;
    this.sessionStore = options.sessionStore;
    this.publishSnapshot = options.publishSnapshot;
    this.transport = options.transport;
    this.supervisor = options.supervisor;
    this.credentialTree = options.credentialTree;
    this.bindingState = options.bindingState;
    this.createLeaseRuntime = options.createLeaseRuntime;
    this.requireFreshSession = options.requireFreshSession;
    this.now = options.now ?? (() => new Date());
  }

  start(
    input: CodexAuthorizationStartInput
  ): Promise<Readonly<CodexAuthorizationSnapshot>> {
    let value: Readonly<CodexAuthorizationStartInput>;
    try {
      value = validateStartInput(input);
    } catch {
      return Promise.reject(orchestratorError(
        "desktop_codex_authorization_orchestrator_invalid_input",
        "Codex 授权启动参数无效"
      ));
    }
    if (this.shuttingDown) {
      return Promise.reject(orchestratorError(
        "desktop_codex_authorization_orchestrator_stopped",
        "Codex 授权编排器已停止"
      ));
    }
    const existing = this.instances.get(value.sessionId);
    if (existing) {
      if (!sameStart(existing.input, value)) {
        return Promise.reject(orchestratorError(
          "desktop_codex_authorization_orchestrator_conflict",
          "Codex 授权会话已绑定其他启动参数"
        ));
      }
      return existing.startPromise;
    }
    const activeSessionId = this.activeSessionByExecutor.get(value.executorId);
    if (activeSessionId !== undefined) {
      return Promise.reject(orchestratorError(
        "desktop_codex_authorization_orchestrator_conflict",
        "Codex 执行器已有活动授权会话"
      ));
    }

    const instance: RuntimeInstance = {
      input: value,
      startPromise: Promise.resolve(Object.freeze({} as CodexAuthorizationSnapshot)),
      flow: null,
      record: null,
      accepted: null,
      publishedGeneration: 0,
      staging: null,
      appServerReceipt: null,
      appServerStartAttempted: false,
      appServerStopped: false,
      lease: null,
      leaseFence: null,
      promotion: null,
      pendingRequest: null,
      stagingQuarantined: false,
      promotionQuarantined: false
    };
    this.instances.set(value.sessionId, instance);
    this.activeSessionByExecutor.set(value.executorId, value.sessionId);
    const operation = this.bootstrap(instance);
    instance.startPromise = operation;
    void operation.catch(() => {
      if (instance.record === null && this.instances.get(value.sessionId) === instance) {
        this.instances.delete(value.sessionId);
        if (this.activeSessionByExecutor.get(value.executorId) === value.sessionId) {
          this.activeSessionByExecutor.delete(value.executorId);
        }
      }
    });
    return operation;
  }

  /**
   * Startup-only continuation for a session already reconciled by the durable
   * recovery coordinator. It never reuses a handoff ticket or replays an
   * already-completed effect.
   */
  resume(input: Readonly<DesktopCodexAuthorizationSessionRecord>): Promise<void> {
    let expected: DesktopCodexAuthorizationSessionRecord;
    try {
      expected = validateResumeRecord(input);
    } catch {
      return Promise.reject(invalidInputError());
    }
    if (this.shuttingDown) {
      return Promise.reject(orchestratorError(
        "desktop_codex_authorization_orchestrator_stopped",
        "Codex 授权编排器已停止"
      ));
    }
    const pending = this.resumeOperations.get(expected.sessionId);
    if (pending) {
      return sameResumeRecord(pending.expected, expected)
        ? pending.promise
        : Promise.reject(conflictError());
    }
    const operation = this.resumeOnce(expected);
    const tracked = Object.freeze({ expected, promise: operation });
    this.resumeOperations.set(expected.sessionId, tracked);
    void operation
      .finally(() => {
        if (this.resumeOperations.get(expected.sessionId) === tracked) {
          this.resumeOperations.delete(expected.sessionId);
        }
      })
      .catch(() => undefined);
    return operation;
  }

  async waitForIdle(sessionId: string): Promise<Readonly<CodexAuthorizationSnapshot>> {
    if (!safeId(sessionId)) throw invalidInputError();
    const instance = this.instances.get(sessionId);
    if (!instance) throw conflictError();
    try {
      await instance.startPromise;
      await instance.flow;
      const current = await this.sessionStore.read(sessionId);
      if (!current) throw conflictError();
      instance.record = current;
      return safeSnapshot(current);
    } catch (error) {
      if (error instanceof DesktopCodexAuthorizationOrchestratorError) throw error;
      throw operationFailedError();
    }
  }

  settle(sessionId: string): Promise<Readonly<CodexAuthorizationSnapshot>> {
    return this.waitForIdle(sessionId);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    try {
      this.transport.cancel();
    } catch {
      // Cancellation is advisory; exact journals remain authoritative.
    }
    const operation = this.performShutdown();
    this.shutdownPromise = operation;
    return operation;
  }

  private async bootstrap(
    instance: RuntimeInstance
  ): Promise<Readonly<CodexAuthorizationSnapshot>> {
    try {
      const identity = validateRegisteredIdentity(await this.identityRegistration.register());
      this.assertOpen();
      const facts = validateHandoffFacts(await this.verifyHandoff(Object.freeze({
        token: requireHandoffTicket(instance.input.handoffTicket),
        registeredDeviceId: identity.deviceId,
        sessionId: instance.input.sessionId,
        executorId: instance.input.executorId,
        handoffId: instance.input.handoffId
      })));
      if (facts.expectedSessionRevision !== instance.input.sessionRevision) {
        throw conflictError();
      }
      this.assertOpen();
      const record = await this.sessionStore.create({
        sessionId: instance.input.sessionId,
        executorId: instance.input.executorId,
        deviceId: identity.deviceId,
        handoffId: instance.input.handoffId,
        sessionRevision: instance.input.sessionRevision
      });
      instance.record = record;
      await this.publish(instance, record);
      const accepted = safeSnapshot(record);
      if (accepted.status !== "starting") throw operationFailedError();
      instance.accepted = accepted;
      const flow = Promise.resolve().then(() => this.run(instance));
      instance.flow = flow;
      void flow.catch(() => undefined);
      return accepted;
    } catch (error) {
      throw normalizePublicError(error);
    }
  }

  private async run(instance: RuntimeInstance): Promise<void> {
    try {
      await this.claim(instance);
      await this.login(instance);
      await this.proveAndLease(instance);
      await this.promote(instance);
      await this.acknowledge(instance);
      this.releaseExecutor(instance);
    } catch (error) {
      await this.handleFlowFailure(instance, error);
      throw normalizePublicError(error);
    }
  }

  private async resumeOnce(
    expected: DesktopCodexAuthorizationSessionRecord
  ): Promise<void> {
    const current = await this.sessionStore.read(expected.sessionId);
    if (this.shuttingDown) {
      throw orchestratorError(
        "desktop_codex_authorization_orchestrator_stopped",
        "Codex 授权编排器已停止"
      );
    }
    if (
      current === null ||
      current.sessionId !== expected.sessionId ||
      current.executorId !== expected.executorId ||
      current.generation !== expected.generation ||
      current.status !== expected.status
    ) {
      throw conflictError();
    }
    const existing = this.instances.get(current.sessionId);
    if (existing) {
      if (
        existing.input.handoffTicket === null &&
        existing.input.executorId === current.executorId &&
        existing.record?.generation === current.generation &&
        existing.record.status === current.status
      ) {
        return;
      }
      throw conflictError();
    }
    const activeSessionId = this.activeSessionByExecutor.get(current.executorId);
    if (activeSessionId !== undefined) throw conflictError();

    const snapshot = safeSnapshot(current);
    const instance: RuntimeInstance = {
      input: Object.freeze({
        sessionId: current.sessionId,
        executorId: current.executorId,
        sessionRevision: current.sessionRevision,
        handoffId: current.handoffId,
        handoffTicket: null
      }),
      startPromise: Promise.resolve(snapshot),
      flow: null,
      record: current,
      accepted: snapshot,
      publishedGeneration: current.generation,
      staging: null,
      appServerReceipt: null,
      appServerStartAttempted: false,
      appServerStopped: false,
      lease: null,
      leaseFence: null,
      promotion: null,
      pendingRequest: null,
      stagingQuarantined: false,
      promotionQuarantined: false
    };
    this.instances.set(current.sessionId, instance);
    this.activeSessionByExecutor.set(current.executorId, current.sessionId);
    const flow = Promise.resolve().then(() => this.runResumed(instance));
    instance.flow = flow;
    void flow.catch(() => undefined);
  }

  private async runResumed(instance: RuntimeInstance): Promise<void> {
    try {
      const status = this.requireRecord(instance).status;
      if (status === "handoff_claimed") {
        await this.login(instance);
        await this.proveAndLease(instance);
        await this.promote(instance);
        await this.acknowledge(instance);
      } else if (status === "login_completed") {
        await this.recoverStaging(instance);
        await this.proveAndLease(instance);
        await this.promote(instance);
        await this.acknowledge(instance);
      } else if (status === "proof_prepared") {
        await this.recoverStaging(instance);
        await this.startLease(instance, true);
        await this.promote(instance);
        await this.acknowledge(instance);
      } else if (status === "activation_pending") {
        await this.recoverStaging(instance);
        await this.startLease(instance, false);
        await this.promote(instance);
        await this.acknowledge(instance);
      } else if (status === "credential_durable") {
        await this.startLease(instance, false);
        await this.acknowledge(instance);
      } else {
        throw conflictError();
      }
      this.releaseExecutor(instance);
    } catch (error) {
      await this.handleFlowFailure(instance, error);
      throw normalizePublicError(error);
    }
  }

  private async claim(instance: RuntimeInstance): Promise<void> {
    let record = this.requireRecord(instance);
    const result = validateClaimResult(await this.transport.claimDesktopHandoff(
      {
        sessionId: instance.input.sessionId,
        handoffId: instance.input.handoffId,
        handoffTicket: requireHandoffTicket(instance.input.handoffTicket)
      },
      this.preparedHook(instance, "claim", "handoff_claim_starting")
    ));
    record = this.requireRecord(instance);
    requirePendingResult(instance, "claim", result);
    if (
      result.data.handoffId !== instance.input.handoffId ||
      result.data.executorId !== instance.input.executorId ||
      result.data.sessionRevision !== record.sessionRevision + 1
    ) {
      throw operationFailedError();
    }
    record = await this.advance(instance, record, "handoff_claimed", {
      claimToken: result.data.claimToken,
      claimExpiresAt: result.data.expiresAt,
      sessionRevision: result.data.sessionRevision
    });
    await this.completePending(instance);
    instance.record = record;
  }

  private async login(instance: RuntimeInstance): Promise<void> {
    let record = await this.advance(
      instance,
      this.requireRecord(instance),
      "app_server_starting"
    );
    this.assertOpen();
    instance.staging = validateStaging(await this.credentialTree.createOrRecoverStaging(
      record.executorId,
      record.sessionId
    ));
    this.assertOpen();
    instance.appServerStartAttempted = true;
    const receipt = await this.supervisor.start({
      executorId: record.executorId,
      sessionId: record.sessionId,
      stagingOwnershipDigest: instance.staging.ownershipDigest
    });
    instance.appServerReceipt = receipt;
    record = await this.advance(instance, record, "app_server_started");
    record = await this.advance(instance, record, "login_starting");
    this.assertOpen();
    const waiting = await this.supervisor.startBrowserLogin(receipt);
    requireSupervisorState(waiting, "waiting_user", receipt);
    record = await this.advance(instance, record, "waiting_user");
    this.assertOpen();
    const completion = validateLoginCompletion(await this.supervisor.waitForLogin(receipt), receipt);
    const accountResult = validateAccountResult(await this.supervisor.readAccount(receipt, true));
    if (accountResult.account === null || accountResult.requiresOpenaiAuth) {
      throw operationFailedError();
    }
    const accountFingerprint = validateDigest(codexAccountFingerprint(accountResult.account));
    const stopped = await this.supervisor.stop(receipt);
    requireSupervisorState(stopped, "stopped", receipt);
    instance.appServerStopped = true;
    const measured = validateMeasurement(await this.credentialTree.measure(instance.staging.ref));
    record = await this.advance(instance, record, "login_completed", {
      loginIdHash: completion.loginIdHash,
      accountFingerprint,
      candidateBindingDigest: measured.digest
    });
    instance.record = record;
  }

  private async proveAndLease(instance: RuntimeInstance): Promise<void> {
    let record = this.requireRecord(instance);
    const result = validateProofResult(await this.transport.submitAuthorizationProof(
      {
        sessionId: record.sessionId,
        claimToken: requireString(record.claimToken),
        handoffId: record.handoffId,
        sessionRevision: record.sessionRevision,
        loginIdHash: requireDigest(record.loginIdHash),
        result: "succeeded",
        checkedAt: this.canonicalNow(),
        accountFingerprint: requireDigest(record.accountFingerprint),
        candidateBindingDigest: requireDigest(record.candidateBindingDigest)
      },
      this.preparedHook(instance, "proof", "proof_submit_starting")
    ));
    record = this.requireRecord(instance);
    requirePendingResult(instance, "proof", result);
    const proof = result.data;
    if (proof.result !== "succeeded" || proof.bindingDigest !== record.candidateBindingDigest ||
        proof.sessionRevision !== record.sessionRevision + 1) {
      throw operationFailedError();
    }
    record = await this.advance(instance, record, "proof_prepared", {
      proofId: proof.proofId,
      activationOperationId: proof.operationId,
      activationId: proof.activationId,
      activationToken: proof.activationToken,
      activationExpiresAt: proof.expiresAt,
      credentialRevision: proof.credentialRevision,
      leaseEpoch: proof.leaseEpoch,
      sourceCredentialRevision: proof.sourceCredentialRevision,
      revocationEpoch: proof.revocationEpoch,
      bindingDigest: proof.bindingDigest,
      sessionRevision: proof.sessionRevision
    });
    await this.completePending(instance);
    await this.startLease(instance, true);
  }

  private async recoverStaging(instance: RuntimeInstance): Promise<void> {
    if (instance.staging !== null) return;
    const record = this.requireRecord(instance);
    this.assertOpen();
    instance.staging = validateStaging(await this.credentialTree.createOrRecoverStaging(
      record.executorId,
      record.sessionId
    ));
  }

  private async startLease(
    instance: RuntimeInstance,
    advanceToActivationPending: boolean
  ): Promise<void> {
    let record = this.requireRecord(instance);
    this.assertOpen();
    if (instance.lease !== null) throw conflictError();
    const lease = this.createLeaseRuntime(Object.freeze({
      sessionId: record.sessionId,
      executorId: record.executorId
    }));
    validateLeaseRuntime(lease);
    instance.lease = lease;
    await lease.start(activationTarget(record));
    const fence = await lease.readFence(requireString(record.activationId));
    if (!fence) throw operationFailedError();
    instance.leaseFence = await lease.requireFresh(fence);
    if (advanceToActivationPending) {
      record = await this.advance(instance, record, "activation_pending");
      instance.record = record;
    }
  }

  private async promote(instance: RuntimeInstance): Promise<void> {
    let record = this.requireRecord(instance);
    await this.requireFreshSession(Object.freeze({
      sessionId: record.sessionId,
      executorId: record.executorId,
      sessionRevision: record.sessionRevision,
      generation: record.generation
    }));
    this.assertOpen();
    record = await this.advance(instance, record, "credential_promotion_starting");
    const promotion = await this.credentialTree.promoteStaging({
      executorId: record.executorId,
      sessionId: record.sessionId,
      operationId: requireString(record.activationOperationId),
      revision: requirePositiveNumber(record.credentialRevision),
      expectedDigest: requireDigest(record.bindingDigest),
      ackReplay: null
    });
    instance.promotion = validatePromotion(promotion, record);
    record = await this.advance(instance, record, "credential_durable", {
      promotionReceipt: {
        executorId: instance.promotion.executorId,
        revision: instance.promotion.revision,
        operationId: instance.promotion.operationId,
        digestAlgorithm: instance.promotion.digestAlgorithm,
        digest: instance.promotion.digest,
        fileCount: instance.promotion.fileCount,
        totalBytes: instance.promotion.totalBytes
      }
    });
    instance.record = record;
  }

  private async acknowledge(instance: RuntimeInstance): Promise<void> {
    let record = this.requireRecord(instance);
    const lease = requireLease(instance);
    await lease.stopAndRenewFresh();
    const latest = await lease.readFence(requireString(record.activationId));
    if (!latest) throw operationFailedError();
    instance.leaseFence = await lease.requireFresh(latest);
    this.assertOpen();
    const result = validateAckResult(await this.transport.acknowledgeCredentialActivation(
      {
        ...activationTarget(record),
        durableBarrierCompletedAt: this.canonicalNow()
      },
      this.preparedHook(instance, "ack", "activation_ack_starting")
    ));
    record = this.requireRecord(instance);
    requirePendingResult(instance, "ack", result);
    if (
      result.data.activationId !== record.activationId ||
      result.data.executorId !== record.executorId ||
      result.data.credentialRevision !== record.credentialRevision ||
      result.data.sessionRevision !== record.sessionRevision + 1
    ) {
      throw operationFailedError();
    }
    record = await this.advance(instance, record, "activation_ack_response_received", {
      sessionRevision: result.data.sessionRevision
    });
    const acknowledgement = {
      executorId: record.executorId,
      operationId: requireString(record.activationOperationId),
      revision: requirePositiveNumber(record.credentialRevision),
      expectedDigest: requireDigest(record.bindingDigest),
      authorizationSessionId: record.sessionId,
      activationAckRequestReference: result.requestReference,
      activationAckRequestHash: result.requestHash
    };
    const bindingInput: ActivateDesktopExecutorBindingInput = {
      executorId: record.executorId,
      deviceId: record.deviceId,
      operationId: requireString(record.activationOperationId),
      activationId: requireString(record.activationId),
      authorizationSessionId: record.sessionId,
      activationAckRequestReference: result.requestReference,
      activationAckRequestHash: result.requestHash,
      credentialRevision: requirePositiveNumber(record.credentialRevision),
      sourceCredentialRevision: requireNonNegativeNumber(record.sourceCredentialRevision),
      revocationEpoch: requireNonNegativeNumber(record.revocationEpoch),
      bindingDigest: requireDigest(record.bindingDigest),
      accountFingerprint: requireDigest(record.accountFingerprint)
    };
    await this.bindingState.activate(bindingInput);
    await this.credentialTree.completeAfterAcknowledgement(acknowledgement);
    record = await this.advance(instance, record, "activation_acked", {
      claimToken: null,
      activationToken: null
    });
    await this.completePending(instance);
    await this.credentialTree.removeAcknowledged(acknowledgement);
    const fence = instance.leaseFence;
    if (!fence) throw operationFailedError();
    await lease.remove(fence);
    lease.clear();
    instance.record = record;
  }

  private preparedHook(
    instance: RuntimeInstance,
    kind: PendingRequest["kind"],
    status: "handoff_claim_starting" | "proof_submit_starting" | "activation_ack_starting"
  ): DesktopTrustedRequestHooks {
    return {
      onPrepared: async (raw) => {
        const prepared = validatePrepared(raw);
        if (instance.pendingRequest !== null) {
          if (!samePending(instance.pendingRequest, kind, prepared)) throw conflictError();
          return;
        }
        instance.pendingRequest = Object.freeze({
          kind,
          requestReference: prepared.requestReference,
          requestHash: prepared.requestHash
        });
        const changes = kind === "claim"
          ? {
              claimRequestReference: prepared.requestReference,
              claimRequestHash: prepared.requestHash
            }
          : kind === "proof"
            ? {
                proofRequestReference: prepared.requestReference,
                proofRequestHash: prepared.requestHash
              }
            : {
                ackRequestReference: prepared.requestReference,
                ackRequestHash: prepared.requestHash
              };
        await this.advance(instance, this.requireRecord(instance), status, changes);
      }
    };
  }

  private async completePending(instance: RuntimeInstance): Promise<void> {
    const pending = instance.pendingRequest;
    if (!pending) throw conflictError();
    await this.transport.completeRequest(pending.requestReference, pending.requestHash);
    if (instance.pendingRequest === pending) instance.pendingRequest = null;
  }

  private async advance(
    instance: RuntimeInstance,
    expected: DesktopCodexAuthorizationSessionRecord,
    status: DesktopCodexAuthorizationSessionData["status"],
    changes: Partial<DesktopCodexAuthorizationSessionData> = {}
  ): Promise<DesktopCodexAuthorizationSessionRecord> {
    this.assertOpenUnlessTerminal(status);
    const next = await this.sessionStore.transition(expected, {
      ...desktopCodexAuthorizationSessionData(expected),
      status,
      lastProgressStatus: status as DesktopCodexAuthorizationSessionData["lastProgressStatus"],
      ...changes
    });
    instance.record = next;
    await this.publish(instance, next);
    return next;
  }

  private async publish(
    instance: RuntimeInstance,
    record: DesktopCodexAuthorizationSessionRecord
  ): Promise<void> {
    if (record.generation <= instance.publishedGeneration) return;
    await this.publishSnapshot(safeSnapshot(record));
    instance.publishedGeneration = record.generation;
  }

  private async handleFlowFailure(instance: RuntimeInstance, error: unknown): Promise<void> {
    await this.refresh(instance);
    const current = instance.record;
    if (!current || isTerminal(current.status) || current.status === "activation_acked") return;
    const deterministic = deterministicRejection(error) && instance.pendingRequest !== null;
    const shutdown = error instanceof ShutdownSignal || this.shuttingDown;
    if (!deterministic && unresolvedTransportFailure(error)) return;
    if (!deterministic && instance.pendingRequest !== null) return;
    if (current.status === "credential_promotion_starting" ||
        current.status === "activation_ack_response_received") return;
    if (!deterministic && !shutdown && current.status === "activation_ack_starting") return;
    const reconciled = await this.reconcileLocalFailure(instance, current);
    if (!reconciled) return;
    const latest = instance.record ?? current;
    const terminalStatus: DesktopCodexAuthorizationTerminalStatus = shutdown
      ? "interrupted"
      : "failed";
    const code = shutdown ? "desktop_orchestrator_shutdown" : "desktop_orchestrator_local_failure";
    const terminal = await this.sessionStore.terminalize(latest, terminalStatus, code);
    instance.record = terminal;
    await this.publish(instance, terminal);
    if (deterministic && instance.pendingRequest !== null) {
      await this.completePending(instance);
    }
    this.releaseExecutor(instance);
  }

  private async reconcileLocalFailure(
    instance: RuntimeInstance,
    record: DesktopCodexAuthorizationSessionRecord
  ): Promise<boolean> {
    try {
      if (instance.lease) await instance.lease.stop();
      if (instance.appServerReceipt && !instance.appServerStopped) {
        const stopped = await this.supervisor.stop(instance.appServerReceipt);
        requireSupervisorState(stopped, "stopped", instance.appServerReceipt);
        instance.appServerStopped = true;
      } else if (
        instance.appServerStartAttempted &&
        instance.staging &&
        !instance.appServerStopped
      ) {
        const binding = {
          executorId: record.executorId,
          sessionId: record.sessionId,
          stagingOwnershipDigest: instance.staging.ownershipDigest
        };
        const stopped = await this.supervisor.stopByBinding(binding);
        requireSupervisorBindingState(stopped, "stopped", binding);
        instance.appServerStopped = true;
      }
      if (instance.promotion || record.promotionReceipt) {
        if (!instance.promotionQuarantined) {
          await this.credentialTree.quarantinePromotion({
            executorId: record.executorId,
            operationId: requireString(record.activationOperationId),
            revision: requirePositiveNumber(record.credentialRevision),
            expectedDigest: requireDigest(record.bindingDigest)
          });
          instance.promotionQuarantined = true;
        }
      } else if (instance.staging && !instance.stagingQuarantined) {
        await this.credentialTree.quarantineStaging(record.executorId, record.sessionId);
        instance.stagingQuarantined = true;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async refresh(instance: RuntimeInstance): Promise<void> {
    try {
      const current = await this.sessionStore.read(instance.input.sessionId);
      if (current) {
        instance.record = current;
        await this.publish(instance, current);
      }
    } catch {
      // The durable store remains the recovery authority.
    }
  }

  private async performShutdown(): Promise<void> {
    const resumePromises = [...this.resumeOperations.values()]
      .map((operation) => operation.promise);
    await Promise.allSettled(resumePromises);
    const startPromises = [...this.instances.values()].map((instance) => instance.startPromise);
    const stopResults = await Promise.allSettled([
      this.supervisor.shutdownAll(),
      ...[...this.instances.values()]
        .map((instance) => instance.lease?.stop())
        .filter((value): value is Promise<void> => value !== undefined)
    ]);
    await Promise.allSettled(startPromises);
    const flows = [...this.instances.values()]
      .map((instance) => instance.flow)
      .filter((value): value is Promise<void> => value !== null);
    await Promise.allSettled(flows);
    if (stopResults.some((result) => result.status === "rejected")) {
      throw operationFailedError();
    }
  }

  private releaseExecutor(instance: RuntimeInstance): void {
    if (this.activeSessionByExecutor.get(instance.input.executorId) === instance.input.sessionId) {
      this.activeSessionByExecutor.delete(instance.input.executorId);
    }
  }

  private requireRecord(instance: RuntimeInstance): DesktopCodexAuthorizationSessionRecord {
    if (!instance.record) throw conflictError();
    return instance.record;
  }

  private assertOpen(): void {
    if (this.shuttingDown) throw new ShutdownSignal();
  }

  private assertOpenUnlessTerminal(status: DesktopCodexAuthorizationSessionData["status"]): void {
    if (this.shuttingDown && !isTerminal(status)) throw new ShutdownSignal();
  }

  private canonicalNow(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw operationFailedError();
    return value.toISOString();
  }
}

function validateOptions(options: DesktopCodexAuthorizationOrchestratorOptions): void {
  if (!options ||
      typeof options.identityRegistration?.register !== "function" ||
      typeof options.verifyHandoff !== "function" ||
      typeof options.sessionStore?.create !== "function" ||
      typeof options.sessionStore?.read !== "function" ||
      typeof options.sessionStore?.transition !== "function" ||
      typeof options.sessionStore?.terminalize !== "function" ||
      typeof options.publishSnapshot !== "function" ||
      typeof options.transport?.claimDesktopHandoff !== "function" ||
      typeof options.transport?.submitAuthorizationProof !== "function" ||
      typeof options.transport?.acknowledgeCredentialActivation !== "function" ||
      typeof options.transport?.completeRequest !== "function" ||
      typeof options.transport?.cancel !== "function" ||
      typeof options.supervisor?.start !== "function" ||
      typeof options.supervisor?.startBrowserLogin !== "function" ||
      typeof options.supervisor?.waitForLogin !== "function" ||
      typeof options.supervisor?.readAccount !== "function" ||
      typeof options.supervisor?.stop !== "function" ||
      typeof options.supervisor?.stopByBinding !== "function" ||
      typeof options.supervisor?.shutdownAll !== "function" ||
      typeof options.credentialTree?.createOrRecoverStaging !== "function" ||
      typeof options.credentialTree?.measure !== "function" ||
      typeof options.credentialTree?.promoteStaging !== "function" ||
      typeof options.credentialTree?.completeAfterAcknowledgement !== "function" ||
      typeof options.credentialTree?.removeAcknowledged !== "function" ||
      typeof options.credentialTree?.quarantineStaging !== "function" ||
      typeof options.credentialTree?.quarantinePromotion !== "function" ||
      typeof options.bindingState?.activate !== "function" ||
      typeof options.createLeaseRuntime !== "function" ||
      typeof options.requireFreshSession !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")) {
    throw invalidInputError();
  }
}

function validateStartInput(value: unknown): Readonly<CodexAuthorizationStartInput> {
  const captured = captureExact(value, [
    "sessionId", "executorId", "sessionRevision", "handoffId", "handoffTicket"
  ]);
  const sessionId = captured.sessionId;
  const executorId = captured.executorId;
  const sessionRevision = captured.sessionRevision;
  const handoffId = captured.handoffId;
  const handoffTicket = captured.handoffTicket;
  if (!safeId(sessionId) || !safeId(executorId) || !positiveInteger(sessionRevision) ||
      !safeId(handoffId) ||
      typeof handoffTicket !== "string" || handoffTicket.length > 16_384 ||
      !COMPACT_JWS.test(handoffTicket)) {
    throw invalidInputError();
  }
  return Object.freeze({ sessionId, executorId, sessionRevision, handoffId, handoffTicket });
}

function validateResumeRecord(
  value: unknown
): DesktopCodexAuthorizationSessionRecord {
  const record = value as DesktopCodexAuthorizationSessionRecord;
  const data = desktopCodexAuthorizationSessionData(record);
  const metadata = captureRequired(value, [
    "version", "generation", "createdAt", "updatedAt"
  ]);
  const candidate = {
    version: metadata.version,
    generation: metadata.generation,
    ...data,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt
  } as DesktopCodexAuthorizationSessionRecord;
  projectDesktopCodexAuthorizationSnapshot(candidate);
  if (![
    "handoff_claimed",
    "login_completed",
    "proof_prepared",
    "activation_pending",
    "credential_durable"
  ].includes(candidate.status)) {
    throw invalidInputError();
  }
  return candidate;
}

function validateRegisteredIdentity(value: unknown): DesktopCodexRegisteredIdentity {
  const captured = captureRequired(value, ["deviceId", "registrationStatus"]);
  if (typeof captured.deviceId !== "string" || !DEVICE_ID.test(captured.deviceId) ||
      captured.registrationStatus !== "registered") throw operationFailedError();
  return Object.freeze({ deviceId: captured.deviceId, registrationStatus: "registered" });
}

function validateHandoffFacts(value: unknown): DesktopCodexAuthorizationHandoffFacts {
  const captured = captureExact(value, ["actorId", "expectedSessionRevision"]);
  if (!safeId(captured.actorId) || !positiveInteger(captured.expectedSessionRevision)) {
    throw operationFailedError();
  }
  return Object.freeze({
    actorId: captured.actorId,
    expectedSessionRevision: captured.expectedSessionRevision
  });
}

function validatePrepared(value: unknown): Readonly<DesktopTrustedRequestPrepared> {
  const captured = captureExact(value, [
    "requestReference", "requestHash", "recovered", "responseAvailable"
  ]);
  if (!digest(captured.requestReference) || !digest(captured.requestHash) ||
      typeof captured.recovered !== "boolean" ||
      typeof captured.responseAvailable !== "boolean") throw operationFailedError();
  return Object.freeze({
    requestReference: captured.requestReference,
    requestHash: captured.requestHash,
    recovered: captured.recovered,
    responseAvailable: captured.responseAvailable
  });
}

function validateClaimResult(
  value: unknown
): DesktopTrustedTransportResult<ClaimDesktopHandoffResponse> {
  const outer = captureExact(value, ["requestReference", "requestHash", "recovered", "data"]);
  const data = captureExact(outer.data, [
    "handoffId", "executorId", "claimToken", "expiresAt", "sessionRevision", "replayed"
  ]);
  if (!digest(outer.requestReference) || !digest(outer.requestHash) ||
      typeof outer.recovered !== "boolean" || !safeId(data.handoffId) ||
      !safeId(data.executorId) || typeof data.claimToken !== "string" ||
      !COMPACT_JWS.test(data.claimToken) || typeof data.expiresAt !== "string" ||
      !serverTime(data.expiresAt) || !positiveInteger(data.sessionRevision) ||
      typeof data.replayed !== "boolean") throw operationFailedError();
  return {
    requestReference: outer.requestReference,
    requestHash: outer.requestHash,
    recovered: outer.recovered,
    data: data as unknown as ClaimDesktopHandoffResponse
  };
}

function validateProofResult(
  value: unknown
): DesktopTrustedTransportResult<SubmitDesktopAuthorizationProofSucceededResponse> {
  const outer = captureExact(value, ["requestReference", "requestHash", "recovered", "data"]);
  const data = captureExact(outer.data, [
    "proofId", "result", "sessionRevision", "replayed", "operationId", "activationId",
    "credentialRevision", "leaseEpoch", "sourceCredentialRevision", "revocationEpoch",
    "bindingDigest", "activationToken", "expiresAt"
  ]);
  if (!digest(outer.requestReference) || !digest(outer.requestHash) ||
      typeof outer.recovered !== "boolean" || !safeId(data.proofId) ||
      data.result !== "succeeded" || !positiveInteger(data.sessionRevision) ||
      typeof data.replayed !== "boolean" || !safeId(data.operationId) ||
      !safeId(data.activationId) || !positiveInteger(data.credentialRevision) ||
      !positiveInteger(data.leaseEpoch) || !nonNegativeInteger(data.sourceCredentialRevision) ||
      !nonNegativeInteger(data.revocationEpoch) || !digest(data.bindingDigest) ||
      typeof data.activationToken !== "string" || !COMPACT_JWS.test(data.activationToken) ||
      typeof data.expiresAt !== "string" || !serverTime(data.expiresAt)) {
    throw operationFailedError();
  }
  return {
    requestReference: outer.requestReference,
    requestHash: outer.requestHash,
    recovered: outer.recovered,
    data: data as unknown as SubmitDesktopAuthorizationProofSucceededResponse
  };
}

function validateAckResult(
  value: unknown
): DesktopTrustedTransportResult<AcknowledgeDesktopCredentialActivationResponse> {
  const outer = captureExact(value, ["requestReference", "requestHash", "recovered", "data"]);
  const data = captureExact(outer.data, [
    "activationId", "executorId", "credentialRevision", "sessionRevision", "replayed"
  ]);
  if (!digest(outer.requestReference) || !digest(outer.requestHash) ||
      typeof outer.recovered !== "boolean" || !safeId(data.activationId) ||
      !safeId(data.executorId) || !positiveInteger(data.credentialRevision) ||
      !positiveInteger(data.sessionRevision) || typeof data.replayed !== "boolean") {
    throw operationFailedError();
  }
  return {
    requestReference: outer.requestReference,
    requestHash: outer.requestHash,
    recovered: outer.recovered,
    data: data as unknown as AcknowledgeDesktopCredentialActivationResponse
  };
}

function validateStaging(value: unknown): DesktopCredentialStagingCreationResult {
  const outer = captureExact(value, ["ref", "recovered", "ownershipDigest"]);
  const ref = captureExact(outer.ref, ["kind", "executorId", "sessionId"]);
  if (ref.kind !== "staging" || !safeId(ref.executorId) || !safeId(ref.sessionId) ||
      typeof outer.recovered !== "boolean" || !digest(outer.ownershipDigest)) {
    throw operationFailedError();
  }
  return {
    ref: { kind: "staging", executorId: ref.executorId, sessionId: ref.sessionId },
    recovered: outer.recovered,
    ownershipDigest: outer.ownershipDigest
  };
}

function validateMeasurement(value: unknown): DesktopCredentialTreeDigest {
  const captured = captureExact(value, ["algorithm", "digest", "fileCount", "totalBytes"]);
  if (captured.algorithm !== "aicrm-credential-tree-rfc8785-nfc-v1" ||
      !digest(captured.digest) || !nonNegativeInteger(captured.fileCount) ||
      !nonNegativeInteger(captured.totalBytes)) throw operationFailedError();
  return captured as unknown as DesktopCredentialTreeDigest;
}

function validatePromotion(
  value: unknown,
  record: DesktopCodexAuthorizationSessionRecord
): DesktopCredentialRevisionProjection {
  const captured = captureExact(value, [
    "executorId", "revision", "operationId", "digestAlgorithm", "digest", "fileCount", "totalBytes"
  ]);
  if (captured.executorId !== record.executorId || captured.revision !== record.credentialRevision ||
      captured.operationId !== record.activationOperationId ||
      captured.digestAlgorithm !== "aicrm-credential-tree-rfc8785-nfc-v1" ||
      captured.digest !== record.bindingDigest || !nonNegativeInteger(captured.fileCount) ||
      !nonNegativeInteger(captured.totalBytes)) throw operationFailedError();
  return captured as unknown as DesktopCredentialRevisionProjection;
}

function validateLoginCompletion(
  value: unknown,
  receipt: Readonly<DesktopCodexAppServerReceipt>
): DesktopCodexAppServerLoginCompletion {
  const captured = captureExact(value, [
    "version", "bootIdHash", "instanceIdHash", "executorId", "sessionId",
    "stagingOwnershipDigest", "state", "errorCode", "loginIdHash"
  ]);
  if (captured.version !== receipt.version || captured.bootIdHash !== receipt.bootIdHash ||
      captured.instanceIdHash !== receipt.instanceIdHash || captured.executorId !== receipt.executorId ||
      captured.sessionId !== receipt.sessionId ||
      captured.stagingOwnershipDigest !== receipt.stagingOwnershipDigest ||
      captured.state !== "login_completed" || captured.errorCode !== null ||
      !digest(captured.loginIdHash)) throw operationFailedError();
  return captured as unknown as DesktopCodexAppServerLoginCompletion;
}

function validateAccountResult(value: unknown): CodexAccountReadResult {
  const captured = captureExact(value, ["account", "requiresOpenaiAuth"]);
  if (typeof captured.requiresOpenaiAuth !== "boolean") throw operationFailedError();
  if (captured.account === null) {
    return { account: null, requiresOpenaiAuth: captured.requiresOpenaiAuth };
  }
  const account = captureExact(captured.account, ["type", "email", "planType"]);
  if (account.type !== "chatgpt" || typeof account.email !== "string" ||
      typeof account.planType !== "string") throw operationFailedError();
  return {
    account: account as unknown as CodexChatGPTAccount,
    requiresOpenaiAuth: captured.requiresOpenaiAuth
  };
}

function requireSupervisorState(
  value: Readonly<DesktopCodexAppServerSnapshot>,
  state: "waiting_user" | "stopped",
  receipt: Readonly<DesktopCodexAppServerReceipt>
): void {
  if (value.state !== state || value.version !== receipt.version ||
      value.bootIdHash !== receipt.bootIdHash || value.instanceIdHash !== receipt.instanceIdHash ||
      value.executorId !== receipt.executorId || value.sessionId !== receipt.sessionId ||
      value.stagingOwnershipDigest !== receipt.stagingOwnershipDigest) throw operationFailedError();
}

function requireSupervisorBindingState(
  value: Readonly<DesktopCodexAppServerSnapshot>,
  state: "stopped",
  binding: Readonly<DesktopCodexAppServerBinding>
): void {
  if (
    value.state !== state ||
    value.executorId !== binding.executorId ||
    value.sessionId !== binding.sessionId ||
    value.stagingOwnershipDigest !== binding.stagingOwnershipDigest
  ) {
    throw operationFailedError();
  }
}

function activationTarget(
  record: DesktopCodexAuthorizationSessionRecord
): RenewDesktopCredentialActivationLeaseInput {
  return {
    sessionId: record.sessionId,
    activationToken: requireString(record.activationToken),
    operationId: requireString(record.activationOperationId),
    activationId: requireString(record.activationId),
    credentialRevision: requirePositiveNumber(record.credentialRevision),
    leaseEpoch: requirePositiveNumber(record.leaseEpoch),
    sourceCredentialRevision: requireNonNegativeNumber(record.sourceCredentialRevision),
    revocationEpoch: requireNonNegativeNumber(record.revocationEpoch),
    bindingDigest: requireDigest(record.bindingDigest)
  };
}

function validateLeaseRuntime(value: unknown): asserts value is DesktopCodexAuthorizationLeaseRuntime {
  if (!value || typeof value !== "object" ||
      typeof (value as DesktopCodexAuthorizationLeaseRuntime).start !== "function" ||
      typeof (value as DesktopCodexAuthorizationLeaseRuntime).stop !== "function" ||
      typeof (value as DesktopCodexAuthorizationLeaseRuntime).stopAndRenewFresh !== "function" ||
      typeof (value as DesktopCodexAuthorizationLeaseRuntime).clear !== "function" ||
      typeof (value as DesktopCodexAuthorizationLeaseRuntime).readFence !== "function" ||
      typeof (value as DesktopCodexAuthorizationLeaseRuntime).requireFresh !== "function" ||
      typeof (value as DesktopCodexAuthorizationLeaseRuntime).remove !== "function") {
    throw operationFailedError();
  }
}

function requireLease(instance: RuntimeInstance): DesktopCodexAuthorizationLeaseRuntime {
  if (!instance.lease) throw operationFailedError();
  return instance.lease;
}

function requirePendingResult<T>(
  instance: RuntimeInstance,
  kind: PendingRequest["kind"],
  result: DesktopTrustedTransportResult<T>
): void {
  const pending = instance.pendingRequest;
  if (!pending || pending.kind !== kind || pending.requestReference !== result.requestReference ||
      pending.requestHash !== result.requestHash) throw conflictError();
}

function samePending(
  pending: PendingRequest,
  kind: PendingRequest["kind"],
  prepared: Readonly<DesktopTrustedRequestPrepared>
): boolean {
  return pending.kind === kind && pending.requestReference === prepared.requestReference &&
    pending.requestHash === prepared.requestHash;
}

function deterministicRejection(error: unknown): boolean {
  try {
    if (!error || typeof error !== "object") return false;
    const code = Reflect.getOwnPropertyDescriptor(error, "code");
    const status = Reflect.getOwnPropertyDescriptor(error, "status");
    return !!code && "value" in code && code.value === "desktop_authorization_transport_rejected" &&
      !!status && "value" in status && DETERMINISTIC_REJECTIONS.has(status.value as number);
  } catch {
    return false;
  }
}

function unresolvedTransportFailure(error: unknown): boolean {
  try {
    if (!error || typeof error !== "object") return false;
    const descriptor = Reflect.getOwnPropertyDescriptor(error, "code");
    return !!descriptor && "value" in descriptor &&
      typeof descriptor.value === "string" &&
      descriptor.value.startsWith("desktop_authorization_transport_");
  } catch {
    return false;
  }
}

function safeSnapshot(
  record: DesktopCodexAuthorizationSessionRecord
): Readonly<CodexAuthorizationSnapshot> {
  return Object.freeze({ ...projectDesktopCodexAuthorizationSnapshot(record) });
}

function captureExact(value: unknown, keys: readonly string[]): Record<string, any> {
  const captured = captureDescriptors(value, keys, false);
  return captured;
}

function captureRequired(value: unknown, keys: readonly string[]): Record<string, any> {
  return captureDescriptors(value, keys, true);
}

function captureDescriptors(
  value: unknown,
  keys: readonly string[],
  allowAdditional: boolean
): Record<string, any> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) throw new Error();
    const actual = ownKeys as string[];
    if ((!allowAdditional && actual.length !== keys.length) ||
        keys.some((key) => !actual.includes(key))) throw new Error();
    const captured: Record<string, any> = Object.create(null);
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      captured[key] = descriptor.value;
    }
    return captured;
  } catch {
    throw operationFailedError();
  }
}

function sameStart(
  left: Readonly<AuthorizationRuntimeInput>,
  right: Readonly<CodexAuthorizationStartInput>
): boolean {
  return left.sessionId === right.sessionId && left.executorId === right.executorId &&
    left.sessionRevision === right.sessionRevision && left.handoffId === right.handoffId &&
    left.handoffTicket === right.handoffTicket;
}

function sameResumeRecord(
  left: DesktopCodexAuthorizationSessionRecord,
  right: DesktopCodexAuthorizationSessionRecord
): boolean {
  if (
    left.version !== right.version ||
    left.generation !== right.generation ||
    left.createdAt !== right.createdAt ||
    left.updatedAt !== right.updatedAt
  ) {
    return false;
  }
  const leftData = desktopCodexAuthorizationSessionData(left) as unknown as Record<string, unknown>;
  const rightData = desktopCodexAuthorizationSessionData(right) as unknown as Record<string, unknown>;
  const keys = Object.keys(leftData);
  if (keys.length !== Object.keys(rightData).length) return false;
  return keys.every((key) => {
    if (key !== "promotionReceipt") return leftData[key] === rightData[key];
    return samePromotionReceipt(leftData[key], rightData[key]);
  });
}

function samePromotionReceipt(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  try {
    const keys = [
      "executorId", "revision", "operationId", "digestAlgorithm",
      "digest", "fileCount", "totalBytes"
    ];
    const leftValue = captureExact(left, keys);
    const rightValue = captureExact(right, keys);
    return keys.every((key) => leftValue[key] === rightValue[key]);
  } catch {
    return false;
  }
}

function isTerminal(value: string): boolean {
  return ["failed", "cancelled", "expired", "interrupted", "superseded", "indeterminate"]
    .includes(value);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function validateDigest(value: unknown): string {
  if (!digest(value)) throw operationFailedError();
  return value;
}

function requireDigest(value: string | null): string {
  if (!digest(value)) throw operationFailedError();
  return value;
}

function requireString(value: string | null): string {
  if (typeof value !== "string" || value.length === 0) throw operationFailedError();
  return value;
}

function requireHandoffTicket(value: string | null): string {
  if (typeof value !== "string" || !COMPACT_JWS.test(value)) throw conflictError();
  return value;
}

function requirePositiveNumber(value: number | null): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) throw operationFailedError();
  return value as number;
}

function requireNonNegativeNumber(value: number | null): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 0) throw operationFailedError();
  return value as number;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function serverTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizePublicError(error: unknown): DesktopCodexAuthorizationOrchestratorError {
  if (error instanceof DesktopCodexAuthorizationOrchestratorError) return error;
  if (error instanceof ShutdownSignal) {
    return orchestratorError(
      "desktop_codex_authorization_orchestrator_stopped",
      "Codex 授权编排器已停止"
    );
  }
  return operationFailedError();
}

function invalidInputError(): DesktopCodexAuthorizationOrchestratorError {
  return orchestratorError(
    "desktop_codex_authorization_orchestrator_invalid_input",
    "Codex 授权编排参数无效"
  );
}

function conflictError(): DesktopCodexAuthorizationOrchestratorError {
  return orchestratorError(
    "desktop_codex_authorization_orchestrator_conflict",
    "Codex 授权编排状态冲突"
  );
}

function operationFailedError(): DesktopCodexAuthorizationOrchestratorError {
  return orchestratorError(
    "desktop_codex_authorization_orchestrator_operation_failed",
    "Codex 授权编排执行失败"
  );
}

function orchestratorError(
  code: DesktopCodexAuthorizationOrchestratorErrorCode,
  message: string
): DesktopCodexAuthorizationOrchestratorError {
  return new DesktopCodexAuthorizationOrchestratorError(code, message);
}
