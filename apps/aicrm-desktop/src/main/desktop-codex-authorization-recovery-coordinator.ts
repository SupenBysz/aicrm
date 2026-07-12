import { createHash } from "node:crypto";
import type { CodexAuthorizationSnapshot } from "../shared/types.ts";
import type { DesktopActivationLeaseFenceRecord } from "./desktop-activation-lease-fence-store.ts";
import type { DesktopAuthorizationTransportClient } from "./desktop-authorization-transport-client.ts";
import type { DesktopCodexAuthorizationEventBroadcaster } from "./desktop-codex-authorization-events.ts";
import {
  desktopCodexAuthorizationSessionData,
  projectDesktopCodexAuthorizationSnapshot,
  type DesktopCodexAuthorizationSessionData,
  type DesktopCodexAuthorizationSessionRecord,
  type DesktopCodexAuthorizationSessionStore
} from "./desktop-codex-authorization-session-store.ts";
import type { DesktopCredentialTreeManager } from "./desktop-credential-tree-manager.ts";
import type { DesktopExecutorBindingStateStore } from "./desktop-executor-binding-state.ts";
import type { DesktopActivationLeaseFenceStore } from "./desktop-activation-lease-fence-store.ts";

const DIGEST = /^[0-9a-f]{64}$/;

interface RecoverySessionStore
  extends Pick<
    DesktopCodexAuthorizationSessionStore,
    "list" | "recoverAll" | "transition" | "terminalize"
  > {}

interface RecoveryEventBroadcaster
  extends Pick<
    DesktopCodexAuthorizationEventBroadcaster,
    "restoreHighWater" | "broadcast"
  > {}

interface RecoveryTransport
  extends Pick<DesktopAuthorizationTransportClient, "completeRequestIfPresent"> {}

interface RecoveryCredentialManager
  extends Pick<
    DesktopCredentialTreeManager,
    | "completeAfterAcknowledgement"
    | "removeAcknowledged"
    | "quarantineStaging"
  > {}

interface RecoveryBindingStore
  extends Pick<DesktopExecutorBindingStateStore, "activate"> {}

interface RecoveryLeaseFenceStore
  extends Pick<DesktopActivationLeaseFenceStore, "inspect" | "remove"> {}

export type DesktopCodexExistingRecoveryArtifact =
  | {
      kind: "handoff_claim";
      sessionId: string;
      executorId: string;
      requestReference: string;
      requestHash: string;
    }
  | {
      kind: "authorization_proof";
      sessionId: string;
      executorId: string;
      requestReference: string;
      requestHash: string;
    }
  | {
      kind: "credential_activation_ack";
      sessionId: string;
      executorId: string;
      requestReference: string;
      requestHash: string;
    }
  | {
      kind: "credential_promotion";
      sessionId: string;
      executorId: string;
      operationId: string;
      credentialRevision: number;
      bindingDigest: string;
    };

export interface DesktopCodexRecoveryArtifactInspector {
  inspect(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<Readonly<DesktopCodexExistingRecoveryArtifact> | null>;
}

export interface DesktopCodexAuthorizationRecoveryCoordinatorOptions {
  sessions: RecoverySessionStore;
  events: RecoveryEventBroadcaster;
  transport: RecoveryTransport;
  credentials: RecoveryCredentialManager;
  bindings: RecoveryBindingStore;
  leases: RecoveryLeaseFenceStore;
  artifacts: DesktopCodexRecoveryArtifactInspector;
  resume(record: Readonly<DesktopCodexAuthorizationSessionRecord>): Promise<void>;
}

export type DesktopCodexAuthorizationRecoveryCoordinatorErrorCode =
  | "desktop_codex_authorization_recovery_conflict"
  | "desktop_codex_authorization_recovery_failed";

export class DesktopCodexAuthorizationRecoveryCoordinatorError extends Error {
  readonly code: DesktopCodexAuthorizationRecoveryCoordinatorErrorCode;

  constructor(
    code: DesktopCodexAuthorizationRecoveryCoordinatorErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DesktopCodexAuthorizationRecoveryCoordinatorError";
    this.code = code;
    this.stack = `${this.name}: ${message}`;
  }
}

/**
 * Startup-only owner for cross-store crash windows. It first restores event
 * high-water marks, adopts only exact existing artifacts, asks the session
 * store to CAS reconciled successors, and only then completes outbound
 * journals or removes ACK/lease tombstones.
 */
export class DesktopCodexAuthorizationRecoveryCoordinator {
  private readonly sessions: RecoverySessionStore;
  private readonly events: RecoveryEventBroadcaster;
  private readonly transport: RecoveryTransport;
  private readonly credentials: RecoveryCredentialManager;
  private readonly bindings: RecoveryBindingStore;
  private readonly leases: RecoveryLeaseFenceStore;
  private readonly artifacts: DesktopCodexRecoveryArtifactInspector;
  private readonly resumeFlow: DesktopCodexAuthorizationRecoveryCoordinatorOptions["resume"];
  private inFlight: Promise<ReadonlyArray<CodexAuthorizationSnapshot>> | null = null;
  private completed = false;

  constructor(options: DesktopCodexAuthorizationRecoveryCoordinatorOptions) {
    if (
      !options ||
      typeof options.sessions?.list !== "function" ||
      typeof options.sessions?.recoverAll !== "function" ||
      typeof options.sessions?.transition !== "function" ||
      typeof options.sessions?.terminalize !== "function" ||
      typeof options.events?.restoreHighWater !== "function" ||
      typeof options.events?.broadcast !== "function" ||
      typeof options.transport?.completeRequestIfPresent !== "function" ||
      typeof options.credentials?.completeAfterAcknowledgement !== "function" ||
      typeof options.credentials?.removeAcknowledged !== "function" ||
      typeof options.credentials?.quarantineStaging !== "function" ||
      typeof options.bindings?.activate !== "function" ||
      typeof options.leases?.inspect !== "function" ||
      typeof options.leases?.remove !== "function" ||
      typeof options.artifacts?.inspect !== "function" ||
      typeof options.resume !== "function"
    ) {
      throw coordinatorConflict();
    }
    this.sessions = options.sessions;
    this.events = options.events;
    this.transport = options.transport;
    this.credentials = options.credentials;
    this.bindings = options.bindings;
    this.leases = options.leases;
    this.artifacts = options.artifacts;
    this.resumeFlow = options.resume;
  }

  recoverOnStartup(): Promise<ReadonlyArray<CodexAuthorizationSnapshot>> {
    if (this.completed) return Promise.reject(coordinatorConflict());
    if (this.inFlight) return this.inFlight;
    const operation = this.performRecovery();
    this.inFlight = operation;
    void operation
      .then(() => {
        this.completed = true;
      })
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
      })
      .catch(() => undefined);
    return operation;
  }

  private async performRecovery(): Promise<ReadonlyArray<CodexAuthorizationSnapshot>> {
    try {
      const initial = await this.sessions.list();
      for (const record of initial) {
        await this.events.restoreHighWater(projectDesktopCodexAuthorizationSnapshot(record));
      }

      const adopted: DesktopCodexAuthorizationSessionRecord[] = [];
      for (const record of initial) adopted.push(await this.adoptExistingArtifact(record));

      const reconciled = await this.sessions.recoverAll();
      const adoptedGeneration = new Map(adopted.map((record) => [record.sessionId, record.generation]));
      for (const record of reconciled) {
        if (record.generation > (adoptedGeneration.get(record.sessionId) ?? 0)) {
          await this.publish(record);
        }
      }

      const settled: DesktopCodexAuthorizationSessionRecord[] = [];
      for (const record of reconciled) settled.push(await this.settleRecoveredRecord(record));
      return settled.map((record) => projectDesktopCodexAuthorizationSnapshot(record));
    } catch (error) {
      if (error instanceof DesktopCodexAuthorizationRecoveryCoordinatorError) throw error;
      throw coordinatorFailed();
    }
  }

  private async adoptExistingArtifact(
    record: DesktopCodexAuthorizationSessionRecord
  ): Promise<DesktopCodexAuthorizationSessionRecord> {
    const artifact = await this.artifacts.inspect(record);
    if (artifact === null) return record;
    assertArtifactTarget(artifact, record);

    let next: DesktopCodexAuthorizationSessionData;
    if (artifact.kind === "handoff_claim" && record.status === "accepted") {
      next = progress(record, "handoff_claim_starting", {
        claimRequestReference: requireDigest(artifact.requestReference),
        claimRequestHash: requireDigest(artifact.requestHash)
      });
    } else if (
      artifact.kind === "authorization_proof" &&
      record.status === "login_completed"
    ) {
      next = progress(record, "proof_submit_starting", {
        proofRequestReference: requireDigest(artifact.requestReference),
        proofRequestHash: requireDigest(artifact.requestHash)
      });
    } else if (
      artifact.kind === "credential_activation_ack" &&
      record.status === "credential_durable"
    ) {
      next = progress(record, "activation_ack_starting", {
        ackRequestReference: requireDigest(artifact.requestReference),
        ackRequestHash: requireDigest(artifact.requestHash)
      });
    } else if (
      artifact.kind === "credential_promotion" &&
      record.status === "activation_pending" &&
      artifact.operationId === record.activationOperationId &&
      artifact.credentialRevision === record.credentialRevision &&
      artifact.bindingDigest === record.bindingDigest
    ) {
      next = progress(record, "credential_promotion_starting");
    } else if (alreadyAdoptedArtifact(artifact, record)) {
      return record;
    } else {
      throw coordinatorConflict();
    }
    const adopted = await this.sessions.transition(record, next);
    await this.publish(adopted);
    return adopted;
  }

  private async settleRecoveredRecord(
    record: DesktopCodexAuthorizationSessionRecord
  ): Promise<DesktopCodexAuthorizationSessionRecord> {
    if (record.status === "accepted") {
      record = await this.sessions.terminalize(
        record,
        "interrupted",
        "desktop_authorization_start_interrupted"
      );
      await this.publish(record);
    } else if (record.status === "app_server_started" || record.status === "waiting_user") {
      await this.credentials.quarantineStaging(record.executorId, record.sessionId);
      record = await this.sessions.terminalize(
        record,
        "interrupted",
        "desktop_codex_app_server_restarted"
      );
      await this.publish(record);
    } else if (record.status === "activation_ack_response_received") {
      record = await this.settleActivationAck(record);
    } else if (record.status === "activation_acked") {
      await this.settleAckArtifacts(record);
    } else {
      await this.completeReconciledOutbound(record);
    }

    if (isResumable(record.status)) await this.resumeFlow(record);
    return record;
  }

  private async completeReconciledOutbound(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<void> {
    if (
      record.status === "handoff_claimed" ||
      (isTerminal(record.status) && record.lastProgressStatus === "handoff_claim_starting")
    ) {
      await completePair(this.transport, record.claimRequestReference, record.claimRequestHash);
      return;
    }
    if (
      record.status === "proof_prepared" ||
      (isTerminal(record.status) && record.lastProgressStatus === "proof_submit_starting")
    ) {
      await completePair(this.transport, record.proofRequestReference, record.proofRequestHash);
      return;
    }
    if (isTerminal(record.status) && record.lastProgressStatus === "activation_ack_starting") {
      await completePair(this.transport, record.ackRequestReference, record.ackRequestHash);
    }
  }

  private async settleActivationAck(
    record: DesktopCodexAuthorizationSessionRecord
  ): Promise<DesktopCodexAuthorizationSessionRecord> {
    const acknowledgement = acknowledgementInput(record);
    const fence = await this.loadExactLease(record, true);
    await this.bindings.activate({
      executorId: record.executorId,
      deviceId: record.deviceId,
      operationId: acknowledgement.operationId,
      activationId: requireId(record.activationId),
      authorizationSessionId: record.sessionId,
      activationAckRequestReference: acknowledgement.activationAckRequestReference,
      activationAckRequestHash: acknowledgement.activationAckRequestHash,
      credentialRevision: acknowledgement.revision,
      sourceCredentialRevision: requireNonNegative(record.sourceCredentialRevision),
      revocationEpoch: requireNonNegative(record.revocationEpoch),
      bindingDigest: acknowledgement.expectedDigest,
      accountFingerprint: requireDigest(record.accountFingerprint)
    });
    await this.credentials.completeAfterAcknowledgement(acknowledgement);
    const activated = await this.sessions.transition(record, {
      ...desktopCodexAuthorizationSessionData(record),
      status: "activation_acked",
      lastProgressStatus: "activation_acked",
      claimToken: null,
      activationToken: null,
      localFailureCode: null
    });
    await this.publish(activated);
    await completePair(this.transport, record.ackRequestReference, record.ackRequestHash);
    await this.credentials.removeAcknowledged(acknowledgement);
    if (fence.status !== "removed") await this.leases.remove(fence);
    return activated;
  }

  private async settleAckArtifacts(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<void> {
    const acknowledgement = acknowledgementInput(record);
    const fence = await this.loadExactLease(record, false);
    await completePair(this.transport, record.ackRequestReference, record.ackRequestHash);
    await this.credentials.removeAcknowledged(acknowledgement);
    if (fence.status !== "removed") await this.leases.remove(fence);
  }

  private async loadExactLease(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>,
    requireTokenHash: boolean
  ): Promise<DesktopActivationLeaseFenceRecord> {
    const activationId = requireId(record.activationId);
    const fence = await this.leases.inspect(activationId);
    if (
      fence === null ||
      fence.sessionId !== record.sessionId ||
      fence.executorId !== record.executorId ||
      fence.operationId !== record.activationOperationId ||
      fence.activationId !== activationId ||
      fence.credentialRevision !== record.credentialRevision ||
      fence.leaseEpoch !== record.leaseEpoch ||
      fence.sourceCredentialRevision !== record.sourceCredentialRevision ||
      fence.revocationEpoch !== record.revocationEpoch ||
      fence.bindingDigest !== record.bindingDigest ||
      (requireTokenHash && fence.status === "removed") ||
      (requireTokenHash &&
        fence.tokenHash !== sha256(requireTicket(record.activationToken)))
    ) {
      throw coordinatorConflict();
    }
    return fence;
  }

  private publish(record: DesktopCodexAuthorizationSessionRecord): Promise<unknown> {
    return this.events.broadcast(projectDesktopCodexAuthorizationSnapshot(record));
  }
}

function acknowledgementInput(record: Readonly<DesktopCodexAuthorizationSessionRecord>) {
  return {
    executorId: record.executorId,
    operationId: requireId(record.activationOperationId),
    revision: requirePositive(record.credentialRevision),
    expectedDigest: requireDigest(record.bindingDigest),
    authorizationSessionId: record.sessionId,
    activationAckRequestReference: requireDigest(record.ackRequestReference),
    activationAckRequestHash: requireDigest(record.ackRequestHash)
  };
}

function progress(
  record: DesktopCodexAuthorizationSessionRecord,
  status: DesktopCodexAuthorizationSessionData["lastProgressStatus"],
  patch: Partial<DesktopCodexAuthorizationSessionData> = {}
): DesktopCodexAuthorizationSessionData {
  return {
    ...desktopCodexAuthorizationSessionData(record),
    ...patch,
    status,
    lastProgressStatus: status,
    localFailureCode: null
  };
}

async function completePair(
  transport: RecoveryTransport,
  requestReference: string | null,
  requestHash: string | null
): Promise<void> {
  await transport.completeRequestIfPresent(
    requireDigest(requestReference),
    requireDigest(requestHash)
  );
}

function alreadyAdoptedArtifact(
  artifact: Readonly<DesktopCodexExistingRecoveryArtifact>,
  record: Readonly<DesktopCodexAuthorizationSessionRecord>
): boolean {
  if (artifact.kind === "handoff_claim") {
    return (
      record.claimRequestReference === artifact.requestReference &&
      record.claimRequestHash === artifact.requestHash &&
      (record.status === "handoff_claim_starting" ||
        record.status === "handoff_claimed" ||
        (isTerminal(record.status) && record.lastProgressStatus === "handoff_claim_starting"))
    );
  }
  if (artifact.kind === "authorization_proof") {
    return (
      record.proofRequestReference === artifact.requestReference &&
      record.proofRequestHash === artifact.requestHash &&
      (record.status === "proof_submit_starting" ||
        record.status === "proof_prepared" ||
        (isTerminal(record.status) && record.lastProgressStatus === "proof_submit_starting"))
    );
  }
  if (artifact.kind === "credential_activation_ack") {
    return (
      record.ackRequestReference === artifact.requestReference &&
      record.ackRequestHash === artifact.requestHash &&
      (record.status === "activation_ack_starting" ||
        record.status === "activation_ack_response_received" ||
        record.status === "activation_acked" ||
        (isTerminal(record.status) && record.lastProgressStatus === "activation_ack_starting"))
    );
  }
  return (
    artifact.operationId === record.activationOperationId &&
    artifact.credentialRevision === record.credentialRevision &&
    artifact.bindingDigest === record.bindingDigest &&
    [
      "credential_promotion_starting",
      "credential_durable",
      "activation_ack_starting",
      "activation_ack_response_received",
      "activation_acked"
    ].includes(record.status)
  );
}

function assertArtifactTarget(
  artifact: Readonly<DesktopCodexExistingRecoveryArtifact>,
  record: Readonly<DesktopCodexAuthorizationSessionRecord>
): void {
  if (artifact.sessionId !== record.sessionId || artifact.executorId !== record.executorId) {
    throw coordinatorConflict();
  }
}

function requireDigest(value: string | null): string {
  if (value === null || !DIGEST.test(value)) throw coordinatorConflict();
  return value;
}

function requireId(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw coordinatorConflict();
  return value;
}

function requireTicket(value: string | null): string {
  if (value === null || value.length < 1 || value.length > 8192) throw coordinatorConflict();
  return value;
}

function requirePositive(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value < 1) throw coordinatorConflict();
  return value;
}

function requireNonNegative(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) throw coordinatorConflict();
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isTerminal(status: DesktopCodexAuthorizationSessionRecord["status"]): boolean {
  return ["failed", "cancelled", "expired", "interrupted", "superseded", "indeterminate"].includes(status);
}

function isResumable(status: DesktopCodexAuthorizationSessionRecord["status"]): boolean {
  return [
    "handoff_claimed",
    "login_completed",
    "proof_prepared",
    "activation_pending",
    "credential_durable"
  ].includes(status);
}

function coordinatorConflict(): DesktopCodexAuthorizationRecoveryCoordinatorError {
  return new DesktopCodexAuthorizationRecoveryCoordinatorError(
    "desktop_codex_authorization_recovery_conflict",
    "Codex 授权启动恢复证据不匹配"
  );
}

function coordinatorFailed(): DesktopCodexAuthorizationRecoveryCoordinatorError {
  return new DesktopCodexAuthorizationRecoveryCoordinatorError(
    "desktop_codex_authorization_recovery_failed",
    "Codex 授权启动恢复失败"
  );
}
