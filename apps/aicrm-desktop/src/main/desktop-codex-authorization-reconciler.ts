import {
  DesktopAuthorizationTransportError,
  type DesktopAuthorizationTransportClient,
  type DesktopTrustedTransportResult,
  type SubmitDesktopAuthorizationProofSucceededResponse
} from "./desktop-authorization-transport-client.ts";
import {
  desktopCodexAuthorizationSessionData,
  type DesktopCodexAuthorizationRecoveryCapability,
  type DesktopCodexAuthorizationRecoveryReconciler,
  type DesktopCodexAuthorizationSessionData,
  type DesktopCodexAuthorizationSessionRecord
} from "./desktop-codex-authorization-session-store.ts";
import type {
  DesktopCredentialRevisionProjection,
  DesktopCredentialTreeManager
} from "./desktop-credential-tree-manager.ts";

const DETERMINISTIC_REJECTION_STATUSES = new Set([400, 401, 403, 409, 410, 422, 426]);

export type DesktopCodexRecoverableAppServerState =
  | "ready"
  | "waiting_user"
  | "absent";

export interface DesktopCodexCurrentBootAppServerObservation {
  executorId: string;
  sessionId: string;
  state: DesktopCodexRecoverableAppServerState;
}

export interface DesktopCodexCurrentBootRecovery {
  observe(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<Readonly<DesktopCodexCurrentBootAppServerObservation>>;
  stop(
    observation: Readonly<DesktopCodexCurrentBootAppServerObservation>
  ): Promise<void>;
}

interface AuthorizationRecoveryTransport
  extends Pick<
    DesktopAuthorizationTransportClient,
    | "recoverDesktopHandoffClaim"
    | "recoverAuthorizationProof"
    | "recoverCredentialActivationAck"
  > {}

interface CredentialRecoveryManager
  extends Pick<
    DesktopCredentialTreeManager,
    | "recoverOperation"
    | "quarantinePromotion"
    | "quarantineStaging"
    | "quarantineStagingIfPresent"
  > {}

export interface DesktopCodexAuthorizationReconcilerOptions {
  transport: AuthorizationRecoveryTransport;
  credentials: CredentialRecoveryManager;
  appServer: DesktopCodexCurrentBootRecovery;
}

export type DesktopCodexAuthorizationReconcilerErrorCode =
  | "desktop_codex_authorization_recovery_ambiguous"
  | "desktop_codex_authorization_recovery_conflict";

export class DesktopCodexAuthorizationReconcilerError extends Error {
  readonly code: DesktopCodexAuthorizationReconcilerErrorCode;

  constructor(code: DesktopCodexAuthorizationReconcilerErrorCode, message: string) {
    super(message);
    this.name = "DesktopCodexAuthorizationReconcilerError";
    this.code = code;
    this.stack = `${this.name}: ${message}`;
  }
}

/**
 * Reconciles only an already-durable external-effect fence. It never creates a
 * session, writes a session generation, completes an outbound request, or
 * starts a new unknown effect. The session store owns the successor CAS; the
 * startup coordinator may settle exact journals only after that CAS succeeds.
 */
export class DesktopCodexAuthorizationReconciler
  implements DesktopCodexAuthorizationRecoveryReconciler {
  private readonly transport: AuthorizationRecoveryTransport;
  private readonly credentials: CredentialRecoveryManager;
  private readonly appServer: DesktopCodexCurrentBootRecovery;

  constructor(options: DesktopCodexAuthorizationReconcilerOptions) {
    if (
      !options ||
      typeof options.transport?.recoverDesktopHandoffClaim !== "function" ||
      typeof options.transport?.recoverAuthorizationProof !== "function" ||
      typeof options.transport?.recoverCredentialActivationAck !== "function" ||
      typeof options.credentials?.recoverOperation !== "function" ||
      typeof options.credentials?.quarantinePromotion !== "function" ||
      typeof options.credentials?.quarantineStaging !== "function" ||
      typeof options.credentials?.quarantineStagingIfPresent !== "function" ||
      typeof options.appServer?.observe !== "function" ||
      typeof options.appServer?.stop !== "function"
    ) {
      throw recoveryConflict();
    }
    this.transport = options.transport;
    this.credentials = options.credentials;
    this.appServer = options.appServer;
  }

  async reconcile(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<DesktopCodexAuthorizationRecoveryCapability> {
    try {
      let successor: DesktopCodexAuthorizationSessionData;
      switch (record.status) {
        case "handoff_claim_starting":
          successor = await this.recoverClaim(record);
          break;
        case "app_server_starting":
          successor = await this.recoverAppServerStart(record);
          break;
        case "login_starting":
          successor = await this.recoverLoginStart(record);
          break;
        case "proof_submit_starting":
          successor = await this.recoverProof(record);
          break;
        case "credential_promotion_starting":
          successor = await this.recoverPromotion(record);
          break;
        case "activation_ack_starting":
          successor = await this.recoverActivationAck(record);
          break;
        default:
          throw recoveryConflict();
      }
      return recoveryCapability(record, successor);
    } catch (error) {
      if (error instanceof DesktopCodexAuthorizationReconcilerError) throw error;
      if (isDeterministicTransportRejection(error)) {
        try {
          return recoveryCapability(
            record,
            await this.reconcileDeterministicRejection(record)
          );
        } catch {
          throw recoveryConflict();
        }
      }
      if (error instanceof DesktopAuthorizationTransportError) throw recoveryAmbiguous();
      throw recoveryConflict();
    }
  }

  private async recoverClaim(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<DesktopCodexAuthorizationSessionData> {
    const reference = requireDigestPair(record.claimRequestReference, record.claimRequestHash);
    const result = await this.transport.recoverDesktopHandoffClaim({
      sessionId: record.sessionId,
      handoffId: record.handoffId,
      expectedRequestReference: reference.requestReference,
      expectedRequestHash: reference.requestHash
    });
    assertRecoveredFence(result, reference);
    const response = result.data;
    if (
      response.handoffId !== record.handoffId ||
      response.executorId !== record.executorId ||
      !isExactNextRevision(record.sessionRevision, response.sessionRevision)
    ) {
      throw recoveryConflict();
    }
    return progress(record, "handoff_claimed", {
      sessionRevision: response.sessionRevision,
      claimToken: response.claimToken,
      claimExpiresAt: response.expiresAt
    });
  }

  private async recoverAppServerStart(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<DesktopCodexAuthorizationSessionData> {
    const observation = await this.observeExact(record);
    if (observation.state === "ready") return progress(record, "app_server_started");
    await this.releaseAndQuarantine(record, observation);
    return interruptedSuccessor(record, "desktop_codex_app_server_restarted");
  }

  private async recoverLoginStart(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<DesktopCodexAuthorizationSessionData> {
    const observation = await this.observeExact(record);
    if (observation.state === "waiting_user") return progress(record, "waiting_user");
    await this.releaseAndQuarantine(record, observation);
    return interruptedSuccessor(record, "desktop_codex_login_restarted");
  }

  private async recoverProof(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<DesktopCodexAuthorizationSessionData> {
    const reference = requireDigestPair(record.proofRequestReference, record.proofRequestHash);
    const loginIdHash = requireDigest(record.loginIdHash);
    const accountFingerprint = requireDigest(record.accountFingerprint);
    const candidateBindingDigest = requireDigest(record.candidateBindingDigest);
    const result = await this.transport.recoverAuthorizationProof({
      sessionId: record.sessionId,
      handoffId: record.handoffId,
      sessionRevision: record.sessionRevision,
      loginIdHash,
      result: "succeeded",
      accountFingerprint,
      candidateBindingDigest,
      expectedRequestReference: reference.requestReference,
      expectedRequestHash: reference.requestHash
    });
    assertRecoveredFence(result, reference);
    const response = result.data;
    if (!isExactNextRevision(record.sessionRevision, response.sessionRevision)) {
      throw recoveryConflict();
    }
    if (response.result === "failed") {
      await this.credentials.quarantineStaging(record.executorId, record.sessionId);
      return failedSuccessor(record, "desktop_authorization_proof_rejected");
    }
    if (response.result === "cancelled") {
      await this.credentials.quarantineStaging(record.executorId, record.sessionId);
      return cancelledSuccessor(record);
    }
    if (response.result !== "succeeded") throw recoveryConflict();
    const succeeded = response as SubmitDesktopAuthorizationProofSucceededResponse;
    if (succeeded.bindingDigest !== record.candidateBindingDigest) {
      throw recoveryConflict();
    }
    return progress(record, "proof_prepared", {
      sessionRevision: succeeded.sessionRevision,
      proofId: succeeded.proofId,
      activationOperationId: succeeded.operationId,
      activationId: succeeded.activationId,
      activationToken: succeeded.activationToken,
      activationExpiresAt: succeeded.expiresAt,
      credentialRevision: succeeded.credentialRevision,
      leaseEpoch: succeeded.leaseEpoch,
      sourceCredentialRevision: succeeded.sourceCredentialRevision,
      revocationEpoch: succeeded.revocationEpoch,
      bindingDigest: succeeded.bindingDigest
    });
  }

  private async recoverPromotion(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<DesktopCodexAuthorizationSessionData> {
    const operationId = requireId(record.activationOperationId);
    const credentialRevision = requirePositiveRevision(record.credentialRevision);
    const bindingDigest = requireDigest(record.bindingDigest);
    const result = await this.credentials.recoverOperation(record.executorId, operationId);
    assertPromotion(result, record.executorId, operationId, credentialRevision, bindingDigest);
    return progress(record, "credential_durable", {
      promotionReceipt: {
        executorId: result.executorId,
        revision: result.revision,
        operationId: result.operationId,
        digestAlgorithm: result.digestAlgorithm,
        digest: result.digest,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes
      }
    });
  }

  private async recoverActivationAck(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<DesktopCodexAuthorizationSessionData> {
    const reference = requireDigestPair(record.ackRequestReference, record.ackRequestHash);
    const result = await this.transport.recoverCredentialActivationAck({
      sessionId: record.sessionId,
      operationId: requireId(record.activationOperationId),
      activationId: requireId(record.activationId),
      credentialRevision: requirePositiveRevision(record.credentialRevision),
      leaseEpoch: requirePositiveRevision(record.leaseEpoch),
      sourceCredentialRevision: requireNonNegativeRevision(record.sourceCredentialRevision),
      revocationEpoch: requireNonNegativeRevision(record.revocationEpoch),
      bindingDigest: requireDigest(record.bindingDigest),
      expectedRequestReference: reference.requestReference,
      expectedRequestHash: reference.requestHash
    });
    assertRecoveredFence(result, reference);
    const response = result.data;
    if (
      response.activationId !== record.activationId ||
      response.executorId !== record.executorId ||
      response.credentialRevision !== record.credentialRevision ||
      !isExactNextRevision(record.sessionRevision, response.sessionRevision)
    ) {
      throw recoveryConflict();
    }
    return progress(record, "activation_ack_response_received", {
      sessionRevision: response.sessionRevision
    });
  }

  private async observeExact(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<Readonly<DesktopCodexCurrentBootAppServerObservation>> {
    const observation = await this.appServer.observe(record);
    if (
      !observation ||
      observation.executorId !== record.executorId ||
      observation.sessionId !== record.sessionId ||
      !(["ready", "waiting_user", "absent"] as const).includes(observation.state)
    ) {
      throw recoveryConflict();
    }
    return observation;
  }

  private async releaseAndQuarantine(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>,
    observation: Readonly<DesktopCodexCurrentBootAppServerObservation>
  ): Promise<void> {
    if (observation.state !== "absent") await this.appServer.stop(observation);
    await this.credentials.quarantineStagingIfPresent(record.executorId, record.sessionId);
  }

  private async reconcileDeterministicRejection(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<DesktopCodexAuthorizationSessionData> {
    if (record.status === "proof_submit_starting") {
      await this.credentials.quarantineStaging(record.executorId, record.sessionId);
    } else if (record.status === "activation_ack_starting") {
      await this.credentials.quarantinePromotion({
        executorId: record.executorId,
        operationId: requireId(record.activationOperationId),
        revision: requirePositiveRevision(record.credentialRevision),
        expectedDigest: requireDigest(record.bindingDigest)
      });
    } else if (record.status !== "handoff_claim_starting") {
      throw recoveryConflict();
    }
    return rejectedSuccessor(record);
  }
}

function recoveryCapability(
  record: Readonly<DesktopCodexAuthorizationSessionRecord>,
  successor: DesktopCodexAuthorizationSessionData
): DesktopCodexAuthorizationRecoveryCapability {
  return {
    sessionId: record.sessionId,
    executorId: record.executorId,
    deviceId: record.deviceId,
    generation: record.generation,
    claimRequestReference: record.claimRequestReference,
    claimRequestHash: record.claimRequestHash,
    proofRequestReference: record.proofRequestReference,
    proofRequestHash: record.proofRequestHash,
    ackRequestReference: record.ackRequestReference,
    ackRequestHash: record.ackRequestHash,
    activationOperationId: record.activationOperationId,
    activationId: record.activationId,
    credentialRevision: record.credentialRevision,
    leaseEpoch: record.leaseEpoch,
    sourceCredentialRevision: record.sourceCredentialRevision,
    revocationEpoch: record.revocationEpoch,
    bindingDigest: record.bindingDigest,
    outboundJournalReconciled: true,
    successor
  };
}

function progress(
  record: Readonly<DesktopCodexAuthorizationSessionRecord>,
  status: DesktopCodexAuthorizationSessionData["lastProgressStatus"],
  patch: Partial<DesktopCodexAuthorizationSessionData> = {}
): DesktopCodexAuthorizationSessionData {
  return {
    ...desktopCodexAuthorizationSessionData(record as DesktopCodexAuthorizationSessionRecord),
    ...patch,
    status,
    lastProgressStatus: status,
    localFailureCode: null
  };
}

function failedSuccessor(
  record: Readonly<DesktopCodexAuthorizationSessionRecord>,
  code: string
): DesktopCodexAuthorizationSessionData {
  return {
    ...desktopCodexAuthorizationSessionData(record as DesktopCodexAuthorizationSessionRecord),
    status: "failed",
    claimToken: null,
    activationToken: null,
    localFailureCode: code
  };
}

function interruptedSuccessor(
  record: Readonly<DesktopCodexAuthorizationSessionRecord>,
  code: string
): DesktopCodexAuthorizationSessionData {
  return {
    ...desktopCodexAuthorizationSessionData(record as DesktopCodexAuthorizationSessionRecord),
    status: "interrupted",
    claimToken: null,
    activationToken: null,
    localFailureCode: code
  };
}

function cancelledSuccessor(
  record: Readonly<DesktopCodexAuthorizationSessionRecord>
): DesktopCodexAuthorizationSessionData {
  return {
    ...desktopCodexAuthorizationSessionData(record as DesktopCodexAuthorizationSessionRecord),
    status: "cancelled",
    claimToken: null,
    activationToken: null,
    localFailureCode: null
  };
}

function rejectedSuccessor(
  record: Readonly<DesktopCodexAuthorizationSessionRecord>
): DesktopCodexAuthorizationSessionData {
  return failedSuccessor(record, rejectionFailureCode(record.status));
}

function rejectionFailureCode(status: DesktopCodexAuthorizationSessionRecord["status"]): string {
  switch (status) {
    case "handoff_claim_starting":
      return "desktop_handoff_claim_rejected";
    case "proof_submit_starting":
      return "desktop_authorization_proof_rejected";
    case "activation_ack_starting":
      return "desktop_activation_ack_rejected";
    default:
      throw recoveryConflict();
  }
}

function assertRecoveredFence<T>(
  result: DesktopTrustedTransportResult<T>,
  expected: { requestReference: string; requestHash: string }
): void {
  if (
    result.requestReference !== expected.requestReference ||
    result.requestHash !== expected.requestHash ||
    result.recovered !== true
  ) {
    throw recoveryConflict();
  }
}

function assertPromotion(
  value: DesktopCredentialRevisionProjection,
  executorId: string,
  operationId: string,
  revision: number,
  digest: string
): void {
  if (
    value.executorId !== executorId ||
    value.operationId !== operationId ||
    value.revision !== revision ||
    value.digestAlgorithm !== "aicrm-credential-tree-rfc8785-nfc-v1" ||
    value.digest !== digest ||
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 0 ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0
  ) {
    throw recoveryConflict();
  }
}

function requireDigestPair(
  requestReference: string | null,
  requestHash: string | null
): { requestReference: string; requestHash: string } {
  return {
    requestReference: requireDigest(requestReference),
    requestHash: requireDigest(requestHash)
  };
}

function requireDigest(value: string | null): string {
  if (value === null || !/^[0-9a-f]{64}$/.test(value)) throw recoveryConflict();
  return value;
}

function requireId(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw recoveryConflict();
  return value;
}

function requirePositiveRevision(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value < 1) throw recoveryConflict();
  return value;
}

function requireNonNegativeRevision(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) throw recoveryConflict();
  return value;
}

function isDeterministicTransportRejection(error: unknown): boolean {
  return (
    error instanceof DesktopAuthorizationTransportError &&
    error.code === "desktop_authorization_transport_rejected" &&
    error.status !== null &&
    DETERMINISTIC_REJECTION_STATUSES.has(error.status)
  );
}

function isExactNextRevision(current: number, next: number): boolean {
  return Number.isSafeInteger(current) && current < Number.MAX_SAFE_INTEGER && next === current + 1;
}

function recoveryAmbiguous(): DesktopCodexAuthorizationReconcilerError {
  return new DesktopCodexAuthorizationReconcilerError(
    "desktop_codex_authorization_recovery_ambiguous",
    "Codex 授权外部结果仍不确定"
  );
}

function recoveryConflict(): DesktopCodexAuthorizationReconcilerError {
  return new DesktopCodexAuthorizationReconcilerError(
    "desktop_codex_authorization_recovery_conflict",
    "Codex 授权恢复证据不匹配"
  );
}
