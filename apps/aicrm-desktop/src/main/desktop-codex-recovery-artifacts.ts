import type {
  DesktopDeviceRequestJournalRecord,
  DesktopDeviceRequestJournalStore,
  DesktopTrustedRequestKind
} from "./desktop-device-request-journal.ts";
import { desktopTrustedRequestReference } from "./desktop-device-request-journal.ts";
import { hashAuthorizationToken, sha256Hex } from "./desktop-device-proof.ts";
import type { DesktopCodexAuthorizationSessionRecord } from "./desktop-codex-authorization-session-store.ts";
import type {
  DesktopCodexExistingRecoveryArtifact,
  DesktopCodexRecoveryArtifactInspector
} from "./desktop-codex-authorization-recovery-coordinator.ts";
import type { DesktopCredentialTreeManager } from "./desktop-credential-tree-manager.ts";

interface RecoveryRequestJournal
  extends Pick<DesktopDeviceRequestJournalStore, "load"> {}

interface RecoveryCredentialJournal
  extends Pick<DesktopCredentialTreeManager, "listPendingOperations"> {}

export interface DesktopCodexRecoveryArtifactInspectorOptions {
  requests: RecoveryRequestJournal;
  credentials: RecoveryCredentialJournal;
}

export class DesktopCodexRecoveryArtifactInspectorError extends Error {
  readonly code = "desktop_codex_recovery_artifact_conflict" as const;

  constructor() {
    super("Codex 授权恢复 artifact 不匹配");
    this.name = "DesktopCodexRecoveryArtifactInspectorError";
    this.stack = `${this.name}: ${this.message}`;
  }
}

/** Reads existing encrypted artifacts only; it never signs or creates work. */
export class DesktopCodexExactRecoveryArtifactInspector
  implements DesktopCodexRecoveryArtifactInspector {
  private readonly requests: RecoveryRequestJournal;
  private readonly credentials: RecoveryCredentialJournal;

  constructor(options: DesktopCodexRecoveryArtifactInspectorOptions) {
    if (
      !options ||
      typeof options.requests?.load !== "function" ||
      typeof options.credentials?.listPendingOperations !== "function"
    ) {
      throw artifactConflict();
    }
    this.requests = options.requests;
    this.credentials = options.credentials;
  }

  async inspect(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<Readonly<DesktopCodexExistingRecoveryArtifact> | null> {
    try {
      const kind = pendingRequestKind(record);
      if (kind !== null) return this.inspectRequest(record, kind);
      if (
        record.status === "activation_pending" ||
        record.status === "credential_promotion_starting"
      ) {
        return this.inspectPromotion(record);
      }
      return null;
    } catch (error) {
      if (error instanceof DesktopCodexRecoveryArtifactInspectorError) throw error;
      throw artifactConflict();
    }
  }

  private async inspectRequest(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>,
    kind: "handoff_claim" | "authorization_proof" | "credential_activation_ack"
  ): Promise<Readonly<DesktopCodexExistingRecoveryArtifact> | null> {
    const reference = expectedReference(record, kind);
    const pending = await this.requests.load(reference);
    if (pending === null) return null;
    assertExactRequest(pending, record, kind, reference);
    const artifact = {
      kind,
      sessionId: record.sessionId,
      executorId: record.executorId,
      requestReference: reference,
      requestHash: pending.signed.requestHash
    } as const;
    const frozenReference = recordedRequestReference(record, kind);
    const frozenHash = recordedRequestHash(record, kind);
    if (
      (frozenReference !== null && frozenReference !== artifact.requestReference) ||
      (frozenHash !== null && frozenHash !== artifact.requestHash) ||
      (frozenReference === null) !== (frozenHash === null)
    ) {
      throw artifactConflict();
    }
    return Object.freeze(artifact);
  }

  private async inspectPromotion(
    record: Readonly<DesktopCodexAuthorizationSessionRecord>
  ): Promise<Readonly<DesktopCodexExistingRecoveryArtifact> | null> {
    const operationId = requireId(record.activationOperationId);
    const revision = requirePositive(record.credentialRevision);
    const bindingDigest = requireDigest(record.bindingDigest);
    const pending = await this.credentials.listPendingOperations(record.executorId);
    if (pending.length === 0) return null;
    if (pending.length !== 1) throw artifactConflict();
    const operation = pending[0];
    if (
      operation.executorId !== record.executorId ||
      operation.operationId !== operationId ||
      operation.sourceKind !== "staging" ||
      operation.sourceId !== record.sessionId ||
      operation.targetRevision !== revision ||
      operation.expectedDigest !== bindingDigest ||
      !["prepared", "source_durable", "reserved", "renamed", "immutable", "verified"]
        .includes(operation.phase)
    ) {
      throw artifactConflict();
    }
    return Object.freeze({
      kind: "credential_promotion" as const,
      sessionId: record.sessionId,
      executorId: record.executorId,
      operationId,
      credentialRevision: revision,
      bindingDigest
    });
  }
}

function pendingRequestKind(
  record: Readonly<DesktopCodexAuthorizationSessionRecord>
): "handoff_claim" | "authorization_proof" | "credential_activation_ack" | null {
  if (
    record.status === "activation_ack_starting" ||
    record.status === "activation_ack_response_received" ||
    record.status === "activation_acked" ||
    (isTerminal(record.status) && record.lastProgressStatus === "activation_ack_starting")
  ) {
    return "credential_activation_ack";
  }
  if (
    record.status === "login_completed" ||
    record.status === "proof_submit_starting" ||
    record.status === "proof_prepared" ||
    (isTerminal(record.status) && record.lastProgressStatus === "proof_submit_starting")
  ) {
    return "authorization_proof";
  }
  if (
    record.status === "accepted" ||
    record.status === "handoff_claim_starting" ||
    record.status === "handoff_claimed" ||
    (isTerminal(record.status) && record.lastProgressStatus === "handoff_claim_starting")
  ) {
    return "handoff_claim";
  }
  return null;
}

function expectedReference(
  record: Readonly<DesktopCodexAuthorizationSessionRecord>,
  kind: "handoff_claim" | "authorization_proof" | "credential_activation_ack"
): string {
  const path = kind === "handoff_claim"
    ? `/api/v1/ai-executor-authorization-sessions/${record.sessionId}/desktop-handoffs/${record.handoffId}/claim`
    : kind === "authorization_proof"
      ? `/api/v1/ai-executor-authorization-sessions/${record.sessionId}/desktop-proofs`
      : `/api/v1/ai-executor-authorization-sessions/${record.sessionId}/desktop-activations/${requireId(record.activationId)}/ack`;
  return desktopTrustedRequestReference(kind, path);
}

function assertExactRequest(
  pending: DesktopDeviceRequestJournalRecord,
  record: Readonly<DesktopCodexAuthorizationSessionRecord>,
  kind: DesktopTrustedRequestKind,
  reference: string
): void {
  if (
    pending.reference !== reference ||
    pending.kind !== kind ||
    pending.method !== "POST" ||
    pending.path !== expectedPath(record, kind) ||
    pending.signed.deviceId !== record.deviceId ||
    !/^[0-9a-f]{64}$/.test(pending.signed.requestHash)
  ) {
    throw artifactConflict();
  }
  if (kind === "handoff_claim") {
    assertClaimBody(pending, record);
  } else if (kind === "authorization_proof") {
    assertProofBodyAndAuthorization(pending, record);
  } else if (kind === "credential_activation_ack") {
    assertAckBodyAndAuthorization(pending, record);
  } else {
    throw artifactConflict();
  }
}

function assertClaimBody(
  pending: DesktopDeviceRequestJournalRecord,
  record: Readonly<DesktopCodexAuthorizationSessionRecord>
): void {
  const body = decodeBody(pending.bodyBase64);
  if (
    !exactObject(body, ["handoffId", "claimedAt"]) ||
    body.handoffId !== record.handoffId ||
    !canonicalServerTime(body.claimedAt)
  ) {
    throw artifactConflict();
  }
  requireCanonicalBody(pending.bodyBase64, {
    handoffId: record.handoffId,
    claimedAt: body.claimedAt
  });
}

function assertProofBodyAndAuthorization(
  pending: DesktopDeviceRequestJournalRecord,
  record: Readonly<DesktopCodexAuthorizationSessionRecord>
): void {
  const body = decodeBody(pending.bodyBase64);
  if (
    !exactObject(body, [
      "handoffId",
      "sessionRevision",
      "loginIdHash",
      "result",
      "checkedAt",
      "accountFingerprint",
      "candidateBindingDigest"
    ]) ||
    body.handoffId !== record.handoffId ||
    body.sessionRevision !== record.sessionRevision ||
    body.loginIdHash !== record.loginIdHash ||
    body.result !== "succeeded" ||
    body.accountFingerprint !== record.accountFingerprint ||
    body.candidateBindingDigest !== record.candidateBindingDigest ||
    !canonicalServerTime(body.checkedAt) ||
    !authorizationMatchesOrFrozen(
      pending,
      "AiCRM-Claim",
      record.claimToken,
      record.proofRequestReference,
      record.proofRequestHash
    )
  ) {
    throw artifactConflict();
  }
  requireCanonicalBody(pending.bodyBase64, {
    handoffId: record.handoffId,
    sessionRevision: record.sessionRevision,
    loginIdHash: record.loginIdHash,
    result: "succeeded",
    checkedAt: body.checkedAt,
    accountFingerprint: record.accountFingerprint,
    candidateBindingDigest: record.candidateBindingDigest
  });
}

function assertAckBodyAndAuthorization(
  pending: DesktopDeviceRequestJournalRecord,
  record: Readonly<DesktopCodexAuthorizationSessionRecord>
): void {
  const body = decodeBody(pending.bodyBase64);
  if (
    !exactObject(body, [
      "operationId",
      "activationId",
      "credentialRevision",
      "leaseEpoch",
      "sourceCredentialRevision",
      "revocationEpoch",
      "durableBarrierCompletedAt",
      "bindingDigest"
    ]) ||
    body.operationId !== record.activationOperationId ||
    body.activationId !== record.activationId ||
    body.credentialRevision !== record.credentialRevision ||
    body.leaseEpoch !== record.leaseEpoch ||
    body.sourceCredentialRevision !== record.sourceCredentialRevision ||
    body.revocationEpoch !== record.revocationEpoch ||
    body.bindingDigest !== record.bindingDigest ||
    !canonicalServerTime(body.durableBarrierCompletedAt) ||
    !authorizationMatchesOrFrozen(
      pending,
      "AiCRM-Activation",
      record.activationToken,
      record.ackRequestReference,
      record.ackRequestHash
    )
  ) {
    throw artifactConflict();
  }
  requireCanonicalBody(pending.bodyBase64, {
    operationId: record.activationOperationId,
    activationId: record.activationId,
    credentialRevision: record.credentialRevision,
    leaseEpoch: record.leaseEpoch,
    sourceCredentialRevision: record.sourceCredentialRevision,
    revocationEpoch: record.revocationEpoch,
    durableBarrierCompletedAt: body.durableBarrierCompletedAt,
    bindingDigest: record.bindingDigest
  });
}

function authorizationMatchesOrFrozen(
  pending: DesktopDeviceRequestJournalRecord,
  scheme: "AiCRM-Claim" | "AiCRM-Activation",
  token: string | null,
  frozenReference: string | null,
  frozenHash: string | null
): boolean {
  if (token === null) {
    return (
      frozenReference === pending.reference &&
      frozenHash === pending.signed.requestHash
    );
  }
  try {
    return (
      hashAuthorizationToken(pending.authorization, [scheme]) ===
      sha256Hex(Buffer.from(token, "ascii"))
    );
  } catch {
    return false;
  }
}

function decodeBody(bodyBase64: string): Record<string, unknown> {
  try {
    if (typeof bodyBase64 !== "string" || bodyBase64.length > 128 << 10) {
      throw new Error();
    }
    const raw = Buffer.from(bodyBase64, "base64");
    if (raw.toString("base64") !== bodyBase64) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw artifactConflict();
  }
}

function requireCanonicalBody(bodyBase64: string, value: Record<string, unknown>): void {
  if (Buffer.from(JSON.stringify(value), "utf8").toString("base64") !== bodyBase64) {
    throw artifactConflict();
  }
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalServerTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function expectedPath(
  record: Readonly<DesktopCodexAuthorizationSessionRecord>,
  kind: DesktopTrustedRequestKind
): string {
  if (kind === "handoff_claim") {
    return `/api/v1/ai-executor-authorization-sessions/${record.sessionId}/desktop-handoffs/${record.handoffId}/claim`;
  }
  if (kind === "authorization_proof") {
    return `/api/v1/ai-executor-authorization-sessions/${record.sessionId}/desktop-proofs`;
  }
  if (kind === "credential_activation_ack") {
    return `/api/v1/ai-executor-authorization-sessions/${record.sessionId}/desktop-activations/${requireId(record.activationId)}/ack`;
  }
  throw artifactConflict();
}

function recordedRequestReference(
  record: Readonly<DesktopCodexAuthorizationSessionRecord>,
  kind: "handoff_claim" | "authorization_proof" | "credential_activation_ack"
): string | null {
  return kind === "handoff_claim"
    ? record.claimRequestReference
    : kind === "authorization_proof"
      ? record.proofRequestReference
      : record.ackRequestReference;
}

function recordedRequestHash(
  record: Readonly<DesktopCodexAuthorizationSessionRecord>,
  kind: "handoff_claim" | "authorization_proof" | "credential_activation_ack"
): string | null {
  return kind === "handoff_claim"
    ? record.claimRequestHash
    : kind === "authorization_proof"
      ? record.proofRequestHash
      : record.ackRequestHash;
}

function requireId(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw artifactConflict();
  return value;
}

function requireDigest(value: string | null): string {
  if (value === null || !/^[0-9a-f]{64}$/.test(value)) throw artifactConflict();
  return value;
}

function requirePositive(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value < 1) throw artifactConflict();
  return value;
}

function isTerminal(status: DesktopCodexAuthorizationSessionRecord["status"]): boolean {
  return ["failed", "cancelled", "expired", "interrupted", "superseded", "indeterminate"]
    .includes(status);
}

function artifactConflict(): DesktopCodexRecoveryArtifactInspectorError {
  return new DesktopCodexRecoveryArtifactInspectorError();
}
