import { createHash } from "node:crypto";
import {
  validateDesktopActivationLeaseFenceRecord,
  type DesktopActivationLeaseFenceRecord
} from "./desktop-activation-lease-fence-store.ts";
import type { DesktopAuthorizationTransportClient } from "./desktop-authorization-transport-client.ts";
import {
  desktopCodexAuthorizationSessionData,
  type DesktopCodexAuthorizationSessionRecord,
  type DesktopCodexAuthorizationSessionStore
} from "./desktop-codex-authorization-session-store.ts";
import type { DesktopCredentialTreeManager } from "./desktop-credential-tree-manager.ts";
import type { DesktopExecutorBindingStateStore } from "./desktop-executor-binding-state.ts";
import type { DesktopActivationLeaseFenceStore } from "./desktop-activation-lease-fence-store.ts";

const DIGEST = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SERVER_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const INTERNAL_SETTLEMENT_CONFLICT = Object.freeze(Object.create(null));

const SESSION_RECORD_KEYS = [
  "version",
  "generation",
  "status",
  "lastProgressStatus",
  "sessionId",
  "executorId",
  "deviceId",
  "handoffId",
  "sessionRevision",
  "claimRequestReference",
  "claimRequestHash",
  "claimToken",
  "claimExpiresAt",
  "loginIdHash",
  "accountFingerprint",
  "candidateBindingDigest",
  "proofRequestReference",
  "proofRequestHash",
  "proofId",
  "activationOperationId",
  "activationId",
  "activationToken",
  "activationExpiresAt",
  "credentialRevision",
  "leaseEpoch",
  "sourceCredentialRevision",
  "revocationEpoch",
  "bindingDigest",
  "promotionReceipt",
  "ackRequestReference",
  "ackRequestHash",
  "localFailureCode",
  "createdAt",
  "updatedAt"
] as const;

const PROMOTION_RECEIPT_KEYS = [
  "executorId",
  "revision",
  "operationId",
  "digestAlgorithm",
  "digest",
  "fileCount",
  "totalBytes"
] as const;

const LEASE_RECORD_KEYS = [
  "version",
  "generation",
  "status",
  "semanticKey",
  "sessionId",
  "executorId",
  "operationId",
  "activationId",
  "credentialRevision",
  "leaseEpoch",
  "sourceCredentialRevision",
  "revocationEpoch",
  "bindingDigest",
  "tokenHash",
  "requestReference",
  "requestHash",
  "renewedAt",
  "leaseExpiresAt",
  "replayed",
  "recovered",
  "createdAt",
  "updatedAt",
  "removedAt"
] as const;

interface SettlementSessionStore
  extends Pick<DesktopCodexAuthorizationSessionStore, "transition"> {}

interface SettlementTransport
  extends Pick<DesktopAuthorizationTransportClient, "completeRequestIfPresent"> {}

interface SettlementCredentialManager
  extends Pick<
    DesktopCredentialTreeManager,
    "completeAfterAcknowledgement" | "removeAcknowledged"
  > {}

interface SettlementBindingStore
  extends Pick<DesktopExecutorBindingStateStore, "activate"> {}

interface SettlementLeaseFenceStore
  extends Pick<DesktopActivationLeaseFenceStore, "inspect" | "remove"> {}

export interface DesktopCodexAuthorizationRecoveredSettlementServiceOptions {
  sessions: SettlementSessionStore;
  transport: SettlementTransport;
  credentials: SettlementCredentialManager;
  bindings: SettlementBindingStore;
  leases: SettlementLeaseFenceStore;
}

export interface DesktopCodexAuthorizationRecoveredSettlementInput {
  /** The caller asks for, and remains the sole owner of, any later resume. */
  resume: boolean;
  /** Called after the activation_acked CAS and before cleanup. The service never publishes itself. */
  onTransition(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): void | Promise<void>;
}

export interface DesktopCodexAuthorizationRecoveredSettlementResult {
  record: Readonly<DesktopCodexAuthorizationSessionRecord>;
  resumeRequested: boolean;
}

export type DesktopCodexAuthorizationRecoveredSettlementErrorCode =
  | "desktop_codex_authorization_recovered_settlement_conflict"
  | "desktop_codex_authorization_recovered_settlement_failed";

export class DesktopCodexAuthorizationRecoveredSettlementError extends Error {
  readonly code: DesktopCodexAuthorizationRecoveredSettlementErrorCode;

  constructor(
    code: DesktopCodexAuthorizationRecoveredSettlementErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DesktopCodexAuthorizationRecoveredSettlementError";
    this.code = code;
    this.stack = `${this.name}: ${message}`;
  }
}

interface SettlementFlight {
  readonly signature: string;
  readonly resume: boolean;
  readonly onTransition: DesktopCodexAuthorizationRecoveredSettlementInput["onTransition"];
  readonly promise: Promise<Readonly<DesktopCodexAuthorizationRecoveredSettlementResult>>;
}

/**
 * Main-only settlement owner shared by startup recovery and trusted commands.
 * It may finish exact durable effects, but it never resumes an authorization
 * flow and never owns event publication. Callers explicitly retain both
 * decisions through `resumeRequested` and `onTransition`.
 */
export class DesktopCodexAuthorizationRecoveredSettlementService {
  private readonly sessions: SettlementSessionStore;
  private readonly transport: SettlementTransport;
  private readonly credentials: SettlementCredentialManager;
  private readonly bindings: SettlementBindingStore;
  private readonly leases: SettlementLeaseFenceStore;
  private readonly inFlight = new Map<string, SettlementFlight>();

  constructor(options: DesktopCodexAuthorizationRecoveredSettlementServiceOptions) {
    const captured = captureExactObject(options, [
      "sessions",
      "transport",
      "credentials",
      "bindings",
      "leases"
    ]);
    if (captured === null) {
      throw settlementConflict();
    }
    try {
      this.sessions = Object.freeze({
        transition: bindCallable(captured.sessions, "transition")
      }) as SettlementSessionStore;
      this.transport = Object.freeze({
        completeRequestIfPresent: bindCallable(
          captured.transport,
          "completeRequestIfPresent"
        )
      }) as SettlementTransport;
      this.credentials = Object.freeze({
        completeAfterAcknowledgement: bindCallable(
          captured.credentials,
          "completeAfterAcknowledgement"
        ),
        removeAcknowledged: bindCallable(captured.credentials, "removeAcknowledged")
      }) as SettlementCredentialManager;
      this.bindings = Object.freeze({
        activate: bindCallable(captured.bindings, "activate")
      }) as SettlementBindingStore;
      this.leases = Object.freeze({
        inspect: bindCallable(captured.leases, "inspect"),
        remove: bindCallable(captured.leases, "remove")
      }) as SettlementLeaseFenceStore;
    } catch {
      throw settlementConflict();
    }
  }

  settle(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>,
    input: Readonly<DesktopCodexAuthorizationRecoveredSettlementInput>
  ): Promise<Readonly<DesktopCodexAuthorizationRecoveredSettlementResult>> {
    let exactRecord: Readonly<DesktopCodexAuthorizationSessionRecord>;
    let exactInput: Readonly<DesktopCodexAuthorizationRecoveredSettlementInput>;
    try {
      exactRecord = captureSessionRecord(record);
      exactInput = captureSettlementInput(input);
    } catch {
      return Promise.reject(settlementConflict());
    }

    const signature = sessionSignature(exactRecord);
    const current = this.inFlight.get(exactRecord.sessionId);
    if (current) {
      if (
        current.signature !== signature ||
        current.resume !== exactInput.resume ||
        current.onTransition !== exactInput.onTransition
      ) {
        return Promise.reject(settlementConflict());
      }
      return current.promise;
    }

    const operation = this.performSettlement(exactRecord, exactInput).catch((error) => {
      if (error === INTERNAL_SETTLEMENT_CONFLICT) {
        throw settlementConflict();
      }
      throw settlementFailed();
    });
    const flight: SettlementFlight = {
      signature,
      resume: exactInput.resume,
      onTransition: exactInput.onTransition,
      promise: operation
    };
    this.inFlight.set(exactRecord.sessionId, flight);
    void operation
      .finally(() => {
        if (this.inFlight.get(exactRecord.sessionId) === flight) {
          this.inFlight.delete(exactRecord.sessionId);
        }
      })
      .catch(() => undefined);
    return operation;
  }

  private async performSettlement(
    initial: Readonly<DesktopCodexAuthorizationSessionRecord>,
    input: Readonly<DesktopCodexAuthorizationRecoveredSettlementInput>
  ): Promise<Readonly<DesktopCodexAuthorizationRecoveredSettlementResult>> {
    let record = initial;
    if (record.status === "activation_ack_response_received") {
      record = await this.settleActivationAck(record, input.onTransition);
    } else if (record.status === "activation_acked") {
      await this.settleAckArtifacts(record);
    } else {
      await this.completeReconciledOutbound(record);
    }
    return Object.freeze({
      record,
      resumeRequested: input.resume && isResumable(record.status)
    });
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
    record: Readonly<DesktopCodexAuthorizationSessionRecord>,
    onTransition: DesktopCodexAuthorizationRecoveredSettlementInput["onTransition"]
  ): Promise<Readonly<DesktopCodexAuthorizationSessionRecord>> {
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
    const desired = {
      ...desktopCodexAuthorizationSessionData(record),
      status: "activation_acked",
      lastProgressStatus: "activation_acked",
      claimToken: null,
      activationToken: null,
      localFailureCode: null
    } as const;
    const activated = captureSessionRecord(await this.sessions.transition(record, desired));
    assertExactTransitionSuccessor(record, desired, activated);
    await onTransition(activated);
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
  ): Promise<Readonly<DesktopActivationLeaseFenceRecord>> {
    const activationId = requireId(record.activationId);
    const fence = captureLeaseRecord(await this.leases.inspect(activationId));
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
      (requireTokenHash && fence.tokenHash !== sha256(requireTicket(record.activationToken)))
    ) {
      throw INTERNAL_SETTLEMENT_CONFLICT;
    }
    return fence;
  }
}

function captureSettlementInput(
  value: unknown
): Readonly<DesktopCodexAuthorizationRecoveredSettlementInput> {
  const captured = captureExactObject(value, ["resume", "onTransition"]);
  if (
    captured === null ||
    typeof captured.resume !== "boolean" ||
    typeof captured.onTransition !== "function"
  ) {
    throw INTERNAL_SETTLEMENT_CONFLICT;
  }
  return Object.freeze({
    resume: captured.resume,
    onTransition: captured.onTransition as DesktopCodexAuthorizationRecoveredSettlementInput["onTransition"]
  });
}

function captureSessionRecord(
  value: unknown
): Readonly<DesktopCodexAuthorizationSessionRecord> {
  const captured = captureExactObject(value, SESSION_RECORD_KEYS);
  if (captured === null) throw INTERNAL_SETTLEMENT_CONFLICT;
  let receipt = captured.promotionReceipt;
  if (receipt !== null) {
    const exactReceipt = captureExactObject(receipt, PROMOTION_RECEIPT_KEYS);
    if (exactReceipt === null) throw INTERNAL_SETTLEMENT_CONFLICT;
    receipt = Object.freeze({ ...exactReceipt });
  }
  try {
    const candidate = {
      ...captured,
      promotionReceipt: receipt
    } as unknown as DesktopCodexAuthorizationSessionRecord;
    const data = desktopCodexAuthorizationSessionData(candidate);
    const record: DesktopCodexAuthorizationSessionRecord = {
      version: 1,
      generation: candidate.generation,
      ...data,
      promotionReceipt: data.promotionReceipt
        ? Object.freeze({ ...data.promotionReceipt })
        : null,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt
    };
    return Object.freeze(record);
  } catch {
    throw INTERNAL_SETTLEMENT_CONFLICT;
  }
}

function captureLeaseRecord(value: unknown): Readonly<DesktopActivationLeaseFenceRecord> | null {
  if (value === null) return null;
  const captured = captureExactObject(value, LEASE_RECORD_KEYS);
  if (captured === null) throw INTERNAL_SETTLEMENT_CONFLICT;
  try {
    return Object.freeze(
      validateDesktopActivationLeaseFenceRecord(
        captured as unknown as DesktopActivationLeaseFenceRecord
      )
    );
  } catch {
    throw INTERNAL_SETTLEMENT_CONFLICT;
  }
}

function assertExactTransitionSuccessor(
  expected: Readonly<DesktopCodexAuthorizationSessionRecord>,
  desired: ReturnType<typeof desktopCodexAuthorizationSessionData>,
  actual: Readonly<DesktopCodexAuthorizationSessionRecord>
): void {
  let actualData: ReturnType<typeof desktopCodexAuthorizationSessionData>;
  try {
    actualData = desktopCodexAuthorizationSessionData(actual);
  } catch {
    throw INTERNAL_SETTLEMENT_CONFLICT;
  }
  if (
    actual.version !== expected.version ||
    actual.generation !== expected.generation + 1 ||
    actual.createdAt !== expected.createdAt ||
    Date.parse(actual.updatedAt) < Date.parse(expected.updatedAt) ||
    JSON.stringify(actualData) !== JSON.stringify(desired)
  ) {
    throw INTERNAL_SETTLEMENT_CONFLICT;
  }
}

function captureExactObject<const K extends readonly string[]>(
  value: unknown,
  keys: K
): { [P in K[number]]: unknown } | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
      return null;
    }
    const captured = Object.create(null) as { [P in K[number]]: unknown };
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      captured[key as K[number]] = descriptor.value;
    }
    return captured;
  } catch {
    return null;
  }
}

function bindCallable(value: unknown, key: string): (...args: any[]) => any {
  try {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      throw new Error();
    }
    let owner: object | null = value as object;
    for (let depth = 0; owner !== null && depth < 16; depth += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") {
          throw new Error();
        }
        return Function.prototype.bind.call(descriptor.value, value) as (...args: any[]) => any;
      }
      owner = Reflect.getPrototypeOf(owner);
    }
    throw new Error();
  } catch {
    throw INTERNAL_SETTLEMENT_CONFLICT;
  }
}

function acknowledgementInput(record: Readonly<DesktopCodexAuthorizationSessionRecord>) {
  return Object.freeze({
    executorId: record.executorId,
    operationId: requireId(record.activationOperationId),
    revision: requirePositive(record.credentialRevision),
    expectedDigest: requireDigest(record.bindingDigest),
    authorizationSessionId: record.sessionId,
    activationAckRequestReference: requireDigest(record.ackRequestReference),
    activationAckRequestHash: requireDigest(record.ackRequestHash)
  });
}

async function completePair(
  transport: SettlementTransport,
  requestReference: string | null,
  requestHash: string | null
): Promise<void> {
  await transport.completeRequestIfPresent(
    requireDigest(requestReference),
    requireDigest(requestHash)
  );
}

function requireDigest(value: string | null): string {
  if (value === null || !DIGEST.test(value)) throw INTERNAL_SETTLEMENT_CONFLICT;
  return value;
}

function requireId(value: string | null): string {
  if (value === null || !SAFE_ID.test(value)) throw INTERNAL_SETTLEMENT_CONFLICT;
  return value;
}

function requireTicket(value: string | null): string {
  if (value === null || value.length < 1 || value.length > 8192) {
    throw INTERNAL_SETTLEMENT_CONFLICT;
  }
  return value;
}

function requirePositive(value: number | null): number {
  if (value === null || !positive(value)) throw INTERNAL_SETTLEMENT_CONFLICT;
  return value;
}

function requireNonNegative(value: number | null): number {
  if (value === null || !nonNegative(value)) throw INTERNAL_SETTLEMENT_CONFLICT;
  return value;
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalTime(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function serverTime(value: unknown): value is string {
  return typeof value === "string" && SERVER_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sessionSignature(record: Readonly<DesktopCodexAuthorizationSessionRecord>): string {
  return sha256(JSON.stringify(record));
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

function settlementConflict(): DesktopCodexAuthorizationRecoveredSettlementError {
  return new DesktopCodexAuthorizationRecoveredSettlementError(
    "desktop_codex_authorization_recovered_settlement_conflict",
    "Codex 授权恢复结算证据不匹配"
  );
}

function settlementFailed(): DesktopCodexAuthorizationRecoveredSettlementError {
  return new DesktopCodexAuthorizationRecoveredSettlementError(
    "desktop_codex_authorization_recovered_settlement_failed",
    "Codex 授权恢复结算失败"
  );
}
