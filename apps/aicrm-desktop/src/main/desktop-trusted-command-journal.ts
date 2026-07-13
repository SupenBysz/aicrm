import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { SafeStorageLike } from "./desktop-device-identity.ts";
import type {
  DesktopTrustedTokenClaims,
  DesktopTrustedTokenPurpose
} from "./desktop-trusted-token-verifier.ts";

const ENVELOPE_MAGIC = Buffer.from("AICRM-TRUSTED-COMMAND-ENC-V1\n", "ascii");
const MAX_FILE_BYTES = 256 << 10;
const MAX_TOKEN_BYTES = 16 << 10;
const MAX_ENTRY_COUNT = 4_096;
export const DESKTOP_TRUSTED_COMMAND_TOMBSTONE_SAFETY_SECONDS = 24 * 60 * 60;
const DIGEST = /^[0-9a-f]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64_URL = /^[A-Za-z0-9_-]+$/;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const rootTails = new Map<string, Promise<void>>();

const TARGET_STRING_FIELDS = [
  "actorId",
  "sessionId",
  "executorId",
  "deviceId",
  "handoffId",
  "activationId",
  "operationId",
  "revocationId",
  "fromDeviceId",
  "targetDeviceId",
  "bindingDigest"
] as const;

const TARGET_REVISION_FIELDS = [
  "expectedRevision",
  "expectedSessionRevision",
  "expectedExecutorRevision",
  "expectedCredentialRevision",
  "expectedCatalogRevision",
  "credentialRevision",
  "leaseEpoch",
  "sourceCredentialRevision",
  "revocationEpoch"
] as const;

const CLAIM_FIELDS = [
  "v",
  "iss",
  "aud",
  "jti",
  "purpose",
  "nonce",
  "iat",
  "exp",
  ...TARGET_STRING_FIELDS,
  ...TARGET_REVISION_FIELDS
] as const;

export type DesktopTrustedCommandJournalStatus =
  | "accepted"
  | "effect_started"
  | "effect_durable"
  | "ack_prepared"
  | "acknowledged"
  | "indeterminate";

export type DesktopTrustedCommandEffectCompletionMode = "direct" | "recovered";
export type DesktopTrustedCommandEffectResult = "succeeded" | "failed" | "stale_target";

export interface DesktopTrustedCommandTarget {
  actorId: string | null;
  sessionId: string | null;
  executorId: string | null;
  deviceId: string | null;
  handoffId: string | null;
  activationId: string | null;
  operationId: string | null;
  revocationId: string | null;
  fromDeviceId: string | null;
  targetDeviceId: string | null;
  bindingDigest: string | null;
  expectedRevision: number | null;
  expectedSessionRevision: number | null;
  expectedExecutorRevision: number | null;
  expectedCredentialRevision: number | null;
  expectedCatalogRevision: number | null;
  credentialRevision: number | null;
  leaseEpoch: number | null;
  sourceCredentialRevision: number | null;
  revocationEpoch: number | null;
}

export interface DesktopTrustedCommandJournalRecord {
  version: 1;
  generation: number;
  status: DesktopTrustedCommandJournalStatus;
  semanticKey: string;
  token: string | null;
  tokenHash: string;
  payloadHash: string;
  kid: string;
  aud: DesktopTrustedTokenClaims["aud"];
  purpose: DesktopTrustedTokenPurpose;
  jti: string;
  claims: DesktopTrustedTokenClaims;
  target: DesktopTrustedCommandTarget;
  acceptedAt: string;
  effectStartedAt: string | null;
  effectRecoveryReference: string | null;
  effectDurableAt: string | null;
  effectCompletionMode: DesktopTrustedCommandEffectCompletionMode | null;
  effectRecoveryEvidenceHash: string | null;
  effectResult: DesktopTrustedCommandEffectResult | null;
  effectFailureCode: string | null;
  outboundAckReference: string | null;
  outboundAckRequestHash: string | null;
  ackPreparedAt: string | null;
  acknowledgedAt: string | null;
  indeterminateAt: string | null;
  indeterminateReasonHash: string | null;
}

export interface AcceptDesktopTrustedCommandInput {
  token: string;
  claims: Readonly<DesktopTrustedTokenClaims>;
}

export interface DesktopTrustedCommandReference {
  semanticKey: string;
  tokenHash: string;
  payloadHash: string;
}

export interface BeginDesktopTrustedCommandEffectInput
  extends DesktopTrustedCommandReference {
  effectRecoveryReference: string;
}

export interface BeginDesktopTrustedCommandEffectResult {
  record: DesktopTrustedCommandJournalRecord;
  /** Volatile capability. It is deliberately absent after a process/store restart. */
  effectAttemptToken: string;
}

export interface CompleteDesktopTrustedCommandEffectInput
  extends BeginDesktopTrustedCommandEffectInput {
  effectAttemptToken: string;
  result: DesktopTrustedCommandEffectResult;
  failureCode: string | null;
}

export interface RecoverDesktopTrustedCommandEffectInput
  extends BeginDesktopTrustedCommandEffectInput {
  recoveryEvidenceHash: string;
  result: DesktopTrustedCommandEffectResult;
  failureCode: string | null;
}

export interface MarkDesktopTrustedCommandIndeterminateInput
  extends BeginDesktopTrustedCommandEffectInput {
  reasonHash: string;
}

export interface PrepareDesktopTrustedCommandAcknowledgementInput
  extends DesktopTrustedCommandReference {
  outboundAckReference: string;
  outboundAckRequestHash: string;
}

export type DesktopTrustedCommandJournalErrorCode =
  | "desktop_trusted_command_conflict"
  | "desktop_trusted_command_corrupt"
  | "desktop_trusted_command_recovery_required"
  | "desktop_trusted_command_state_invalid"
  | "desktop_trusted_command_unsafe"
  | "desktop_secure_storage_unavailable";

export class DesktopTrustedCommandJournalError extends Error {
  readonly code: DesktopTrustedCommandJournalErrorCode;

  constructor(code: DesktopTrustedCommandJournalErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type DesktopTrustedCommandJournalFaultPoint =
  | "after_temporary_fsync"
  | "after_rename"
  | "before_directory_fsync";

export interface DesktopTrustedCommandJournalStoreOptions {
  root: string;
  safeStorage: SafeStorageLike;
  now?: () => Date;
  faultInjector?: (
    point: DesktopTrustedCommandJournalFaultPoint
  ) => void | Promise<void>;
  renameFile?: (source: string, target: string) => Promise<void>;
  syncDirectory?: (directory: string) => Promise<boolean>;
}

export interface DesktopTrustedCommandPruneResult {
  removed: number;
  retained: number;
}

/**
 * Main-only single-consumption journal for already verified inbound trusted
 * tokens. It deliberately performs no business effect itself.
 */
export class DesktopTrustedCommandJournalStore {
  private readonly root: string;
  private readonly safeStorage: SafeStorageLike;
  private readonly now: () => Date;
  private readonly faultInjector?: DesktopTrustedCommandJournalStoreOptions["faultInjector"];
  private readonly renameFile: (source: string, target: string) => Promise<void>;
  private readonly syncDirectory: (directory: string) => Promise<boolean>;
  private readonly effectAttempts = new Map<string, string>();

  constructor(options: DesktopTrustedCommandJournalStoreOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw journalError("desktop_trusted_command_unsafe", "受信命令日志目录无效");
    }
    this.safeStorage = options.safeStorage;
    this.now = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
    this.renameFile = options.renameFile ?? rename;
    this.syncDirectory = options.syncDirectory ?? syncDirectory;
  }

  acceptOrLoad(
    input: AcceptDesktopTrustedCommandInput
  ): Promise<DesktopTrustedCommandJournalRecord> {
    const candidate = acceptedRecord(input, this.now());
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      const records = await this.loadAllLocked();
      const existing = records.find((record) => record.semanticKey === candidate.semanticKey);
      if (existing) {
        if (!sameAcceptedIdentity(existing, candidate)) {
          throw journalError(
            "desktop_trusted_command_conflict",
            "同一受信命令语义键已绑定其他票据或目标"
          );
        }
        return cloneRecord(existing);
      }
      for (const record of records) {
        if (semanticScopeCollision(record, candidate)) {
          throw journalError(
            "desktop_trusted_command_conflict",
            "受信命令 jti 或 operation 已绑定其他票据"
          );
        }
      }
      await this.writeAtomic(candidate);
      return cloneRecord(candidate);
    });
  }

  read(
    reference: DesktopTrustedCommandReference
  ): Promise<DesktopTrustedCommandJournalRecord | null> {
    const fence = validateReference(reference);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.assertKnownEntries();
      await this.repairPending(fence.semanticKey);
      const record = await this.readTarget(fence.semanticKey);
      if (!record) return null;
      assertFence(record, fence);
      return cloneRecord(record);
    });
  }

  /** Startup-only inventory used by the command recovery coordinator. */
  listForRecovery(): Promise<DesktopTrustedCommandJournalRecord[]> {
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      return (await this.loadAllLocked()).map(cloneRecord);
    });
  }

  /**
   * Explicit capacity maintenance. Non-terminal and indeterminate records are
   * never removed. Acknowledged tombstones survive through token expiry plus
   * a full-day rollback/replay safety margin.
   */
  pruneAcknowledged(): Promise<DesktopTrustedCommandPruneResult> {
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      const records = await this.loadAllLocked();
      const currentSecond = currentUnixSecond(this.now());
      let removed = 0;
      for (const record of records) {
        const pruneAfter =
          record.claims.exp + DESKTOP_TRUSTED_COMMAND_TOMBSTONE_SAFETY_SECONDS;
        if (
          record.status !== "acknowledged" ||
          !Number.isSafeInteger(pruneAfter) ||
          currentSecond < pruneAfter
        ) {
          continue;
        }
        const commits = await this.readCommitStates(record.semanticKey);
        await rm(this.target(record.semanticKey));
        await rm(this.temporary(record.semanticKey), { force: true });
        for (const commit of commits) await rm(commit.file, { force: true });
        removed += 1;
      }
      if (removed > 0) await this.syncDirectory(this.root);
      return { removed, retained: records.length - removed };
    });
  }

  beginEffect(
    input: BeginDesktopTrustedCommandEffectInput
  ): Promise<BeginDesktopTrustedCommandEffectResult> {
    const candidate = validateBeginEffectInput(input);
    return this.exclusive(async () => {
      const current = await this.loadFencedLocked(candidate);
      if (current.status === "effect_started") {
        throw journalError(
          "desktop_trusted_command_recovery_required",
          "受信命令副作用已开始，禁止重新执行"
        );
      }
      if (current.status !== "accepted") {
        throw journalError("desktop_trusted_command_state_invalid", "受信命令不能再次开始副作用");
      }
      const next: DesktopTrustedCommandJournalRecord = {
        ...current,
        generation: current.generation + 1,
        status: "effect_started",
        effectStartedAt: canonicalNow(this.now()),
        effectRecoveryReference: candidate.effectRecoveryReference
      };
      await this.writeAtomic(next);
      const effectAttemptToken = randomBytes(32).toString("base64url");
      this.effectAttempts.set(next.semanticKey, effectAttemptToken);
      return { record: cloneRecord(next), effectAttemptToken };
    });
  }

  markEffectDurable(
    input: CompleteDesktopTrustedCommandEffectInput
  ): Promise<DesktopTrustedCommandJournalRecord> {
    const candidate = validateCompleteEffectInput(input);
    return this.exclusive(async () => {
      const current = await this.loadFencedLocked(candidate);
      assertRecoveryReference(current, candidate.effectRecoveryReference);
      if (
        current.status === "effect_durable" &&
        current.effectCompletionMode === "direct" &&
        current.effectResult === candidate.result &&
        current.effectFailureCode === candidate.failureCode
      ) {
        this.effectAttempts.delete(current.semanticKey);
        return cloneRecord(current);
      }
      if (current.status !== "effect_started") {
        throw journalError("desktop_trusted_command_state_invalid", "受信命令副作用状态无效");
      }
      const volatileAttempt = this.effectAttempts.get(current.semanticKey);
      if (volatileAttempt !== candidate.effectAttemptToken) {
        throw journalError(
          "desktop_trusted_command_recovery_required",
          "副作用执行能力已丢失，必须显式恢复"
        );
      }
      const next: DesktopTrustedCommandJournalRecord = {
        ...current,
        generation: current.generation + 1,
        status: "effect_durable",
        effectDurableAt: canonicalNow(this.now()),
        effectCompletionMode: "direct",
        effectRecoveryEvidenceHash: null,
        effectResult: candidate.result,
        effectFailureCode: candidate.failureCode
      };
      await this.writeAtomic(next);
      this.effectAttempts.delete(next.semanticKey);
      return cloneRecord(next);
    });
  }

  recoverEffectDurable(
    input: RecoverDesktopTrustedCommandEffectInput
  ): Promise<DesktopTrustedCommandJournalRecord> {
    const candidate = validateRecoverEffectInput(input);
    return this.exclusive(async () => {
      const current = await this.loadFencedLocked(candidate);
      assertRecoveryReference(current, candidate.effectRecoveryReference);
      if (
        current.status === "effect_durable" &&
        current.effectCompletionMode === "recovered" &&
        current.effectRecoveryEvidenceHash === candidate.recoveryEvidenceHash &&
        current.effectResult === candidate.result &&
        current.effectFailureCode === candidate.failureCode
      ) {
        return cloneRecord(current);
      }
      if (current.status !== "effect_started") {
        throw journalError("desktop_trusted_command_state_invalid", "受信命令不可恢复为完成");
      }
      const next: DesktopTrustedCommandJournalRecord = {
        ...current,
        generation: current.generation + 1,
        status: "effect_durable",
        effectDurableAt: canonicalNow(this.now()),
        effectCompletionMode: "recovered",
        effectRecoveryEvidenceHash: candidate.recoveryEvidenceHash,
        effectResult: candidate.result,
        effectFailureCode: candidate.failureCode
      };
      await this.writeAtomic(next);
      this.effectAttempts.delete(next.semanticKey);
      return cloneRecord(next);
    });
  }

  markIndeterminate(
    input: MarkDesktopTrustedCommandIndeterminateInput
  ): Promise<DesktopTrustedCommandJournalRecord> {
    const candidate = validateIndeterminateInput(input);
    return this.exclusive(async () => {
      const current = await this.loadFencedLocked(candidate);
      assertRecoveryReference(current, candidate.effectRecoveryReference);
      if (
        current.status === "indeterminate" &&
        current.indeterminateReasonHash === candidate.reasonHash
      ) {
        return cloneRecord(current);
      }
      if (current.status !== "effect_started") {
        throw journalError("desktop_trusted_command_state_invalid", "受信命令不能转为不确定状态");
      }
      const next: DesktopTrustedCommandJournalRecord = {
        ...current,
        generation: current.generation + 1,
        status: "indeterminate",
        token: null,
        indeterminateAt: canonicalNow(this.now()),
        indeterminateReasonHash: candidate.reasonHash
      };
      await this.writeAtomic(next);
      this.effectAttempts.delete(next.semanticKey);
      return cloneRecord(next);
    });
  }

  prepareAcknowledgement(
    input: PrepareDesktopTrustedCommandAcknowledgementInput
  ): Promise<DesktopTrustedCommandJournalRecord> {
    const candidate = validateAcknowledgementInput(input);
    return this.exclusive(async () => {
      const current = await this.loadFencedLocked(candidate);
      if (
        (current.status === "ack_prepared" || current.status === "acknowledged") &&
        current.outboundAckReference === candidate.outboundAckReference &&
        current.outboundAckRequestHash === candidate.outboundAckRequestHash
      ) {
        return cloneRecord(current);
      }
      if (current.status !== "effect_durable") {
        throw journalError("desktop_trusted_command_state_invalid", "受信命令尚不可准备确认");
      }
      const next: DesktopTrustedCommandJournalRecord = {
        ...current,
        generation: current.generation + 1,
        status: "ack_prepared",
        outboundAckReference: candidate.outboundAckReference,
        outboundAckRequestHash: candidate.outboundAckRequestHash,
        ackPreparedAt: canonicalNow(this.now())
      };
      await this.writeAtomic(next);
      return cloneRecord(next);
    });
  }

  markAcknowledged(
    input: PrepareDesktopTrustedCommandAcknowledgementInput
  ): Promise<DesktopTrustedCommandJournalRecord> {
    const candidate = validateAcknowledgementInput(input);
    return this.exclusive(async () => {
      const current = await this.loadFencedLocked(candidate);
      if (
        current.status === "acknowledged" &&
        current.outboundAckReference === candidate.outboundAckReference &&
        current.outboundAckRequestHash === candidate.outboundAckRequestHash
      ) {
        return cloneRecord(current);
      }
      if (
        current.status !== "ack_prepared" ||
        current.outboundAckReference !== candidate.outboundAckReference ||
        current.outboundAckRequestHash !== candidate.outboundAckRequestHash
      ) {
        throw journalError("desktop_trusted_command_state_invalid", "受信命令确认栅栏不匹配");
      }
      const next: DesktopTrustedCommandJournalRecord = {
        ...current,
        generation: current.generation + 1,
        status: "acknowledged",
        token: null,
        acknowledgedAt: canonicalNow(this.now())
      };
      await this.writeAtomic(next);
      return cloneRecord(next);
    });
  }

  private async loadFencedLocked(
    reference: DesktopTrustedCommandReference
  ): Promise<DesktopTrustedCommandJournalRecord> {
    this.assertSecureStorage();
    await this.ensureRoot();
    await this.assertKnownEntries();
    await this.repairPending(reference.semanticKey);
    const current = await this.readTarget(reference.semanticKey);
    if (!current) {
      throw journalError("desktop_trusted_command_conflict", "受信命令日志不存在");
    }
    assertFence(current, reference);
    return current;
  }

  private async loadAllLocked(): Promise<DesktopTrustedCommandJournalRecord[]> {
    const semanticKeys = await this.assertKnownEntries();
    const records: DesktopTrustedCommandJournalRecord[] = [];
    for (const semanticKey of semanticKeys) {
      await this.repairPending(semanticKey);
      const record = await this.readTarget(semanticKey);
      if (record) records.push(record);
    }
    return records;
  }

  private async assertKnownEntries(): Promise<string[]> {
    const children = await readdir(this.root, { withFileTypes: true });
    // One semantic record can temporarily have target + temp + generations 1..5.
    if (children.length > MAX_ENTRY_COUNT * 7) {
      throw journalError("desktop_trusted_command_unsafe", "受信命令日志条目过多");
    }
    const semanticKeys = new Set<string>();
    for (const child of children) {
      if (!child.isFile() || child.isSymbolicLink()) {
        throw journalError("desktop_trusted_command_unsafe", "受信命令日志含非法条目");
      }
      const match = /^([0-9a-f]{64})\.sec(?:\.tmp|\.commit-[1-5])?$/.exec(child.name);
      if (!match) {
        throw journalError("desktop_trusted_command_unsafe", "受信命令日志含未知文件");
      }
      const info = await lstat(path.join(this.root, child.name));
      assertSafeFile(info);
      semanticKeys.add(match[1]);
    }
    if (semanticKeys.size > MAX_ENTRY_COUNT) {
      throw journalError("desktop_trusted_command_unsafe", "受信命令日志超过安全上限");
    }
    return [...semanticKeys].sort();
  }

  private readTarget(
    semanticKey: string
  ): Promise<DesktopTrustedCommandJournalRecord | null> {
    return this.readPath(this.target(semanticKey), semanticKey, true);
  }

  private async readPath(
    file: string,
    expectedSemanticKey: string,
    missingAllowed = false
  ): Promise<DesktopTrustedCommandJournalRecord | null> {
    let pathInfo: Stats;
    try {
      pathInfo = await lstat(file);
    } catch (error) {
      if (missingAllowed && isErrorCode(error, "ENOENT")) return null;
      throw journalError("desktop_trusted_command_corrupt", "受信命令日志无法读取");
    }
    assertSafeFile(pathInfo);
    const flags =
      fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    let handle;
    try {
      handle = await open(file, flags);
      const before = await handle.stat();
      assertSafeFile(before);
      const raw = await handle.readFile();
      const after = await handle.stat();
      if (
        before.dev !== pathInfo.dev ||
        before.ino !== pathInfo.ino ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mode !== after.mode ||
        before.nlink !== after.nlink ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        raw.byteLength !== before.size ||
        !raw.subarray(0, ENVELOPE_MAGIC.byteLength).equals(ENVELOPE_MAGIC)
      ) {
        throw journalError("desktop_trusted_command_corrupt", "受信命令日志封套不稳定");
      }
      const plaintext = this.safeStorage.decryptString(raw.subarray(ENVELOPE_MAGIC.byteLength));
      const record = validateRecord(JSON.parse(plaintext) as unknown);
      if (record.semanticKey !== expectedSemanticKey) {
        throw journalError("desktop_trusted_command_corrupt", "受信命令日志语义键不匹配");
      }
      return record;
    } catch (error) {
      if (error instanceof DesktopTrustedCommandJournalError) throw error;
      throw journalError("desktop_trusted_command_corrupt", "受信命令日志无法解密");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeAtomic(record: DesktopTrustedCommandJournalRecord): Promise<void> {
    const validated = validateRecord(record);
    await this.ensureCommitMarker(validated);
    await this.ensureTemporary(validated);
    await this.faultInjector?.("after_temporary_fsync");
    await this.renameFile(
      this.temporary(validated.semanticKey),
      this.target(validated.semanticKey)
    );
    await this.faultInjector?.("after_rename");
    await this.finishDurability(validated, true);
  }

  private encryptEnvelope(record: DesktopTrustedCommandJournalRecord): Buffer {
    let ciphertext: Buffer;
    try {
      ciphertext = this.safeStorage.encryptString(JSON.stringify(record));
    } catch {
      throw journalError("desktop_secure_storage_unavailable", "受信命令日志加密失败");
    }
    if (!Buffer.isBuffer(ciphertext) || ciphertext.byteLength < 1) {
      throw journalError("desktop_secure_storage_unavailable", "受信命令日志密文无效");
    }
    const envelope = Buffer.concat([ENVELOPE_MAGIC, ciphertext]);
    if (envelope.byteLength > MAX_FILE_BYTES) {
      throw journalError("desktop_trusted_command_unsafe", "受信命令日志超过安全上限");
    }
    return envelope;
  }

  private async repairPending(semanticKey: string): Promise<void> {
    const target = await this.readTarget(semanticKey);
    const commits = await this.readCommitStates(semanticKey);
    const temporary = await this.readPath(this.temporary(semanticKey), semanticKey, true);
    if (commits.length === 0 && temporary === null) return;

    const recovery = new Map<number, DesktopTrustedCommandJournalRecord>();
    for (const commit of commits) addRecoveryRecord(recovery, commit.record);
    if (temporary) addRecoveryRecord(recovery, temporary);
    const ordered = [...recovery.values()].sort(
      (left, right) => left.generation - right.generation
    );
    let recovered: DesktopTrustedCommandJournalRecord | null = null;
    if (target === null) {
      if (
        ordered.length === 0 ||
        ordered[0].generation !== 1 ||
        ordered[0].status !== "accepted"
      ) {
        throw journalError("desktop_trusted_command_corrupt", "受信命令恢复缺少初始状态");
      }
      let cursor = ordered[0];
      for (const candidate of ordered.slice(1)) {
        if (!validSuccessor(cursor, candidate)) {
          throw journalError("desktop_trusted_command_corrupt", "受信命令恢复链不连续");
        }
        cursor = candidate;
      }
      recovered = cursor;
    } else {
      const sameGeneration = recovery.get(target.generation);
      if (sameGeneration && !sameRecord(sameGeneration, target)) {
        throw journalError("desktop_trusted_command_corrupt", "受信命令同代恢复状态冲突");
      }
      let cursor = target;
      for (const candidate of ordered) {
        if (candidate.generation < target.generation) {
          if (!sameImmutableFields(candidate, target)) {
            throw journalError("desktop_trusted_command_corrupt", "受信命令旧恢复状态冲突");
          }
          continue;
        }
        if (candidate.generation === cursor.generation) continue;
        if (!validSuccessor(cursor, candidate)) {
          throw journalError("desktop_trusted_command_corrupt", "受信命令恢复后继无效");
        }
        cursor = candidate;
      }
      if (cursor.generation > target.generation) recovered = cursor;
    }

    const durable = recovered ?? target;
    if (!durable) {
      throw journalError("desktop_trusted_command_corrupt", "受信命令恢复状态缺失");
    }
    if (recovered) {
      await this.ensureCommitMarker(recovered);
      await this.ensureTemporary(recovered);
      await this.renameFile(this.temporary(semanticKey), this.target(semanticKey));
    }
    await this.finishDurability(durable, false);
  }

  private async finishDurability(
    record: DesktopTrustedCommandJournalRecord,
    injectFaults: boolean
  ): Promise<void> {
    await this.syncRegularFile(this.target(record.semanticKey));
    const verified = await this.readTarget(record.semanticKey);
    if (!verified || !sameRecord(verified, record)) {
      throw journalError("desktop_trusted_command_corrupt", "受信命令替换结果不匹配");
    }
    if (injectFaults) await this.faultInjector?.("before_directory_fsync");
    const directoryDurable = await this.syncDirectory(this.root);
    const commits = await this.readCommitStates(record.semanticKey);
    await rm(this.temporary(record.semanticKey), { force: true });
    if (directoryDurable) {
      for (const commit of commits) await rm(commit.file, { force: true });
      const cleanupDurable = await this.syncDirectory(this.root);
      if (!cleanupDurable) {
        await this.ensureCommitMarker(record);
        await this.syncRegularFile(this.commit(record.semanticKey, record.generation));
      }
      return;
    }

    await this.ensureCommitMarker(record);
    await this.syncRegularFile(this.commit(record.semanticKey, record.generation));
    for (const commit of commits) {
      if (commit.record.generation !== record.generation) {
        await rm(commit.file, { force: true });
      }
    }
  }

  private async ensureCommitMarker(record: DesktopTrustedCommandJournalRecord): Promise<void> {
    const file = this.commit(record.semanticKey, record.generation);
    const existing = await this.readPath(file, record.semanticKey, true);
    if (existing) {
      if (!sameRecord(existing, record)) {
        throw journalError("desktop_trusted_command_corrupt", "受信命令提交标记冲突");
      }
      return;
    }
    await this.writeEnvelopeExclusive(file, record);
  }

  private async ensureTemporary(record: DesktopTrustedCommandJournalRecord): Promise<void> {
    const file = this.temporary(record.semanticKey);
    const existing = await this.readPath(file, record.semanticKey, true);
    if (existing) {
      if (!sameRecord(existing, record)) {
        throw journalError("desktop_trusted_command_corrupt", "受信命令临时状态冲突");
      }
      return;
    }
    await this.writeEnvelopeExclusive(file, record);
  }

  private async writeEnvelopeExclusive(
    file: string,
    record: DesktopTrustedCommandJournalRecord
  ): Promise<void> {
    const envelope = this.encryptEnvelope(record);
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
      await handle.writeFile(envelope);
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      const handleInfo = await handle.stat();
      const pathInfo = await lstat(file);
      assertSafeFile(handleInfo);
      assertSafeFile(pathInfo);
      if (handleInfo.dev !== pathInfo.dev || handleInfo.ino !== pathInfo.ino) {
        throw journalError("desktop_trusted_command_corrupt", "受信命令写入目标已变化");
      }
      await handle.close();
      handle = undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readCommitStates(
    semanticKey: string
  ): Promise<Array<{ file: string; record: DesktopTrustedCommandJournalRecord }>> {
    const children = await readdir(this.root, { withFileTypes: true });
    const prefix = `${semanticKey}.sec.commit-`;
    const commits: Array<{ file: string; record: DesktopTrustedCommandJournalRecord }> = [];
    for (const child of children) {
      if (!child.name.startsWith(prefix)) continue;
      const generation = Number(child.name.slice(prefix.length));
      if (!child.isFile() || child.isSymbolicLink() || !Number.isSafeInteger(generation)) {
        throw journalError("desktop_trusted_command_unsafe", "受信命令提交标记不安全");
      }
      const file = path.join(this.root, child.name);
      const record = await this.readPath(file, semanticKey);
      if (!record || record.generation !== generation) {
        throw journalError("desktop_trusted_command_corrupt", "受信命令提交代次不匹配");
      }
      commits.push({ file, record });
    }
    return commits.sort((left, right) => left.record.generation - right.record.generation);
  }

  private async syncRegularFile(file: string): Promise<void> {
    const pathInfo = await lstat(file);
    assertSafeFile(pathInfo);
    const flags = fsConstants.O_RDWR | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    let handle;
    try {
      handle = await open(file, flags);
      const before = await handle.stat();
      assertSafeFile(before);
      if (before.dev !== pathInfo.dev || before.ino !== pathInfo.ino) {
        throw journalError("desktop_trusted_command_corrupt", "受信命令持久化目标已变化");
      }
      await handle.sync();
      const after = await handle.stat();
      assertSafeFile(after);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mode !== after.mode ||
        before.nlink !== after.nlink ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        throw journalError("desktop_trusted_command_corrupt", "受信命令持久化目标不稳定");
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw journalError("desktop_trusted_command_unsafe", "受信命令日志目录不安全");
    }
    if (process.platform !== "win32") {
      await chmod(this.root, 0o700);
      info = await lstat(this.root);
      if ((info.mode & 0o077) !== 0) {
        throw journalError("desktop_trusted_command_unsafe", "受信命令日志目录权限不安全");
      }
    }
  }

  private assertSecureStorage(): void {
    let available = false;
    let backend = "";
    try {
      available = this.safeStorage.isEncryptionAvailable();
      backend = this.safeStorage.getSelectedStorageBackend?.() ?? "";
    } catch {
      available = false;
    }
    if (!available || backend.toLowerCase() === "basic_text") {
      throw journalError("desktop_secure_storage_unavailable", "系统安全存储不可用");
    }
  }

  private target(semanticKey: string): string {
    return path.join(this.root, `${semanticKey}.sec`);
  }

  private temporary(semanticKey: string): string {
    return path.join(this.root, `${semanticKey}.sec.tmp`);
  }

  private commit(semanticKey: string, generation: number): string {
    return path.join(this.root, `${semanticKey}.sec.commit-${generation}`);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = rootTails.get(this.root) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    rootTails.set(this.root, settled);
    void settled.then(() => {
      if (rootTails.get(this.root) === settled) rootTails.delete(this.root);
    });
    return result;
  }
}

function acceptedRecord(
  input: AcceptDesktopTrustedCommandInput,
  now: Date
): DesktopTrustedCommandJournalRecord {
  const captured = captureExactObject(input, ["token", "claims"]);
  if (!captured || typeof captured.token !== "string") {
    throw journalError("desktop_trusted_command_unsafe", "受信命令接收参数无效");
  }
  const claims = validateClaims(captured.claims);
  const parsed = parseCompactToken(captured.token, claims);
  const target = targetFromClaims(claims);
  const semanticKey = semanticKeyFor(claims, target);
  return validateRecord({
    version: 1,
    generation: 1,
    status: "accepted",
    semanticKey,
    token: captured.token,
    tokenHash: parsed.tokenHash,
    payloadHash: parsed.payloadHash,
    kid: parsed.kid,
    aud: claims.aud,
    purpose: claims.purpose,
    jti: claims.jti,
    claims,
    target,
    acceptedAt: canonicalNow(now),
    effectStartedAt: null,
    effectRecoveryReference: null,
    effectDurableAt: null,
    effectCompletionMode: null,
    effectRecoveryEvidenceHash: null,
    effectResult: null,
    effectFailureCode: null,
    outboundAckReference: null,
    outboundAckRequestHash: null,
    ackPreparedAt: null,
    acknowledgedAt: null,
    indeterminateAt: null,
    indeterminateReasonHash: null
  });
}

function validateRecord(value: unknown): DesktopTrustedCommandJournalRecord {
  if (
    !exactObject(value, [
      "version",
      "generation",
      "status",
      "semanticKey",
      "token",
      "tokenHash",
      "payloadHash",
      "kid",
      "aud",
      "purpose",
      "jti",
      "claims",
      "target",
      "acceptedAt",
      "effectStartedAt",
      "effectRecoveryReference",
      "effectDurableAt",
      "effectCompletionMode",
      "effectRecoveryEvidenceHash",
      "effectResult",
      "effectFailureCode",
      "outboundAckReference",
      "outboundAckRequestHash",
      "ackPreparedAt",
      "acknowledgedAt",
      "indeterminateAt",
      "indeterminateReasonHash"
    ])
  ) {
    throw journalError("desktop_trusted_command_corrupt", "受信命令日志结构无效");
  }
  const record = value as unknown as DesktopTrustedCommandJournalRecord;
  const claims = validateClaims(record.claims);
  const target = targetFromClaims(claims);
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.generation) ||
    record.generation < 1 ||
    !DIGEST.test(record.semanticKey) ||
    !DIGEST.test(record.tokenHash) ||
    !DIGEST.test(record.payloadHash) ||
    !KEY_ID.test(record.kid) ||
    record.aud !== claims.aud ||
    record.purpose !== claims.purpose ||
    record.jti !== claims.jti ||
    !sameTarget(record.target, target) ||
    record.semanticKey !== semanticKeyFor(claims, target) ||
    record.payloadHash !== sha256Hex(Buffer.from(JSON.stringify(claims), "utf8")) ||
    !canonicalTime(record.acceptedAt)
  ) {
    throw journalError("desktop_trusted_command_corrupt", "受信命令日志字段无效");
  }
  if (record.token !== null) {
    const parsed = parseCompactToken(record.token, claims);
    if (
      parsed.tokenHash !== record.tokenHash ||
      parsed.payloadHash !== record.payloadHash ||
      parsed.kid !== record.kid
    ) {
      throw journalError("desktop_trusted_command_corrupt", "受信命令票据与日志不匹配");
    }
  }
  if (!validStateShape(record)) {
    throw journalError("desktop_trusted_command_corrupt", "受信命令日志状态无效");
  }
  return cloneRecord({ ...record, claims, target });
}

function validStateShape(record: DesktopTrustedCommandJournalRecord): boolean {
  const started =
    canonicalNullableTime(record.effectStartedAt) &&
    timeAtOrAfter(record.effectStartedAt, record.acceptedAt) &&
    typeof record.effectRecoveryReference === "string" &&
    DIGEST.test(record.effectRecoveryReference);
  const durable =
    started &&
    canonicalNullableTime(record.effectDurableAt) &&
    timeAtOrAfter(record.effectDurableAt, record.effectStartedAt) &&
    (record.effectCompletionMode === "direct" || record.effectCompletionMode === "recovered") &&
    ((record.effectCompletionMode === "direct" && record.effectRecoveryEvidenceHash === null) ||
      (record.effectCompletionMode === "recovered" &&
        typeof record.effectRecoveryEvidenceHash === "string" &&
        DIGEST.test(record.effectRecoveryEvidenceHash))) &&
    validEffectOutcome(record.effectResult, record.effectFailureCode);
  const ackPrepared =
    durable &&
    typeof record.outboundAckReference === "string" &&
    DIGEST.test(record.outboundAckReference) &&
    typeof record.outboundAckRequestHash === "string" &&
    DIGEST.test(record.outboundAckRequestHash) &&
    canonicalNullableTime(record.ackPreparedAt) &&
    timeAtOrAfter(record.ackPreparedAt, record.effectDurableAt);
  const untouched =
    record.effectStartedAt === null &&
    record.effectRecoveryReference === null &&
    record.effectDurableAt === null &&
    record.effectCompletionMode === null &&
    record.effectRecoveryEvidenceHash === null &&
    record.effectResult === null &&
    record.effectFailureCode === null &&
    record.outboundAckReference === null &&
    record.outboundAckRequestHash === null &&
    record.ackPreparedAt === null &&
    record.acknowledgedAt === null &&
    record.indeterminateAt === null &&
    record.indeterminateReasonHash === null;
  const startedOnly =
    started &&
    record.effectDurableAt === null &&
    record.effectCompletionMode === null &&
    record.effectRecoveryEvidenceHash === null &&
    record.effectResult === null &&
    record.effectFailureCode === null &&
    record.outboundAckReference === null &&
    record.outboundAckRequestHash === null &&
    record.ackPreparedAt === null &&
    record.acknowledgedAt === null &&
    record.indeterminateAt === null &&
    record.indeterminateReasonHash === null;
  const durableOnly =
    durable &&
    record.outboundAckReference === null &&
    record.outboundAckRequestHash === null &&
    record.ackPreparedAt === null &&
    record.acknowledgedAt === null &&
    record.indeterminateAt === null &&
    record.indeterminateReasonHash === null;
  const ackPreparedOnly =
    ackPrepared &&
    record.acknowledgedAt === null &&
    record.indeterminateAt === null &&
    record.indeterminateReasonHash === null;
  const acknowledged =
    ackPrepared &&
    canonicalNullableTime(record.acknowledgedAt) &&
    timeAtOrAfter(record.acknowledgedAt, record.ackPreparedAt) &&
    record.indeterminateAt === null &&
    record.indeterminateReasonHash === null;
  const indeterminate =
    started &&
    record.effectDurableAt === null &&
    record.effectCompletionMode === null &&
    record.effectRecoveryEvidenceHash === null &&
    record.effectResult === null &&
    record.effectFailureCode === null &&
    record.outboundAckReference === null &&
    record.outboundAckRequestHash === null &&
    record.ackPreparedAt === null &&
    record.acknowledgedAt === null &&
    canonicalNullableTime(record.indeterminateAt) &&
    timeAtOrAfter(record.indeterminateAt, record.effectStartedAt) &&
    typeof record.indeterminateReasonHash === "string" &&
    DIGEST.test(record.indeterminateReasonHash);
  switch (record.status) {
    case "accepted":
      return record.generation === 1 && record.token !== null && untouched;
    case "effect_started":
      return record.generation === 2 && record.token !== null && startedOnly;
    case "effect_durable":
      return record.generation === 3 && record.token !== null && durableOnly;
    case "ack_prepared":
      return record.generation === 4 && record.token !== null && ackPreparedOnly;
    case "acknowledged":
      return record.generation === 5 && record.token === null && acknowledged;
    case "indeterminate":
      return record.generation === 3 && record.token === null && indeterminate;
    default:
      return false;
  }
}

function validEffectOutcome(result: unknown, failureCode: unknown): boolean {
  if (result === "failed") {
    return typeof failureCode === "string" && SAFE_FAILURE_CODE.test(failureCode);
  }
  return (result === "succeeded" || result === "stale_target") && failureCode === null;
}

function validateClaims(value: unknown): DesktopTrustedTokenClaims {
  const captured = captureObjectSubset(value, CLAIM_FIELDS, 8);
  if (!captured) {
    throw journalError("desktop_trusted_command_unsafe", "已验证受信声明结构无效");
  }
  const claims = captured as unknown as DesktopTrustedTokenClaims;
  if (
    claims.v !== 1 ||
    claims.iss !== "aicrm-agent-executor" ||
    !OPAQUE_ID.test(claims.jti) ||
    !validNonce(claims.nonce) ||
    !positiveSafeInteger(claims.iat) ||
    !positiveSafeInteger(claims.exp)
  ) {
    throw journalError("desktop_trusted_command_unsafe", "已验证受信声明字段无效");
  }
  const ttl = purposeLifetime(claims.aud, claims.purpose);
  if (ttl === null || claims.exp !== claims.iat + ttl) {
    throw journalError("desktop_trusted_command_unsafe", "已验证受信声明用途无效");
  }
  for (const field of TARGET_STRING_FIELDS) {
    const candidate = claims[field];
    if (candidate !== undefined && typeof candidate !== "string") {
      throw journalError("desktop_trusted_command_unsafe", "已验证受信目标字段无效");
    }
  }
  for (const field of TARGET_REVISION_FIELDS) {
    const candidate = claims[field];
    if (candidate !== undefined && !nonNegativeSafeInteger(candidate)) {
      throw journalError("desktop_trusted_command_unsafe", "已验证受信版本字段无效");
    }
  }
  const cloned = JSON.parse(JSON.stringify(captured)) as DesktopTrustedTokenClaims;
  targetFromClaims(cloned);
  return cloned;
}

function targetFromClaims(claims: DesktopTrustedTokenClaims): DesktopTrustedCommandTarget {
  const target = {} as DesktopTrustedCommandTarget;
  for (const field of TARGET_STRING_FIELDS) target[field] = claims[field] ?? null;
  for (const field of TARGET_REVISION_FIELDS) target[field] = claims[field] ?? null;
  const shape = purposeShape(claims.aud, claims.purpose);
  if (!shape) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令用途不受支持");
  }
  for (const field of TARGET_STRING_FIELDS) {
    const candidate = target[field];
    if (shape.strings.includes(field)) {
      if (typeof candidate !== "string" || !validTargetString(field, candidate)) {
        throw journalError("desktop_trusted_command_unsafe", "受信命令目标标识无效");
      }
    } else if (candidate !== null) {
      throw journalError("desktop_trusted_command_unsafe", "受信命令包含额外目标标识");
    }
  }
  for (const field of TARGET_REVISION_FIELDS) {
    const candidate = target[field];
    if (shape.positive.includes(field)) {
      if (!positiveSafeInteger(candidate)) {
        throw journalError("desktop_trusted_command_unsafe", "受信命令目标版本无效");
      }
    } else if (shape.nonNegative.includes(field)) {
      if (!nonNegativeSafeInteger(candidate)) {
        throw journalError("desktop_trusted_command_unsafe", "受信命令目标版本无效");
      }
    } else if (candidate !== null) {
      throw journalError("desktop_trusted_command_unsafe", "受信命令包含额外目标版本");
    }
  }
  if (!validJtiRelationship(claims, target)) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令 jti 关系无效");
  }
  return target;
}

type TargetStringField = (typeof TARGET_STRING_FIELDS)[number];
type TargetRevisionField = (typeof TARGET_REVISION_FIELDS)[number];

interface TargetShape {
  strings: readonly TargetStringField[];
  positive: readonly TargetRevisionField[];
  nonNegative: readonly TargetRevisionField[];
}

function purposeShape(audience: string, purpose: string): TargetShape | null {
  const none: readonly TargetRevisionField[] = [];
  if (audience === "aicrm-desktop" && purpose === "authorization_handoff") {
    return {
      strings: ["actorId", "sessionId", "executorId", "deviceId", "handoffId"],
      positive: ["expectedSessionRevision"],
      nonNegative: none
    };
  }
  if (audience === "aicrm-desktop-claim" && purpose === "authorization_claim") {
    return {
      strings: ["sessionId", "executorId", "deviceId", "handoffId"],
      positive: ["expectedSessionRevision"],
      nonNegative: none
    };
  }
  if (audience === "aicrm-desktop-activation" && purpose === "credential_activation") {
    return {
      strings: [
        "sessionId",
        "executorId",
        "deviceId",
        "activationId",
        "operationId",
        "bindingDigest"
      ],
      positive: ["credentialRevision", "leaseEpoch"],
      nonNegative: ["sourceCredentialRevision", "revocationEpoch"]
    };
  }
  if (
    audience === "aicrm-desktop-command" &&
    (purpose === "authorization_cancel" || purpose === "authorization_reopen")
  ) {
    return {
      strings: ["actorId", "sessionId", "executorId", "deviceId", "operationId"],
      positive: ["expectedSessionRevision"],
      nonNegative: none
    };
  }
  if (audience === "aicrm-desktop-command" && purpose === "credential_verify") {
    return {
      strings: ["actorId", "executorId", "deviceId", "operationId"],
      positive: ["expectedExecutorRevision", "expectedCredentialRevision"],
      nonNegative: none
    };
  }
  if (audience === "aicrm-desktop-command" && purpose === "model_catalog_refresh") {
    return {
      strings: ["actorId", "executorId", "deviceId", "operationId"],
      positive: ["expectedExecutorRevision"],
      nonNegative: ["expectedCatalogRevision"]
    };
  }
  if (audience === "aicrm-desktop-command" && purpose === "readiness_check") {
    return {
      strings: ["actorId", "executorId", "deviceId", "operationId"],
      positive: ["expectedExecutorRevision", "expectedCredentialRevision"],
      nonNegative: ["expectedCatalogRevision"]
    };
  }
  if (audience === "aicrm-desktop-command" && purpose === "credential_logout") {
    return {
      strings: ["actorId", "executorId", "deviceId", "operationId", "revocationId"],
      positive: ["credentialRevision", "revocationEpoch"],
      nonNegative: none
    };
  }
  return null;
}

function validTargetString(field: TargetStringField, value: string): boolean {
  if (["deviceId", "fromDeviceId", "targetDeviceId", "bindingDigest"].includes(field)) {
    return DIGEST.test(value);
  }
  return OPAQUE_ID.test(value);
}

function validJtiRelationship(
  claims: DesktopTrustedTokenClaims,
  target: DesktopTrustedCommandTarget
): boolean {
  switch (claims.purpose) {
    case "authorization_handoff":
    case "authorization_claim":
      return claims.jti === target.handoffId;
    case "credential_activation":
      return claims.jti === target.activationId;
    case "credential_logout":
      return claims.jti === target.revocationId;
    case "authorization_cancel":
    case "authorization_reopen":
    case "credential_verify":
    case "model_catalog_refresh":
    case "readiness_check":
      return claims.jti === target.operationId;
    default:
      return false;
  }
}

function purposeLifetime(audience: string, purpose: string): number | null {
  if (audience === "aicrm-desktop" && purpose === "authorization_handoff") return 120;
  if (audience === "aicrm-desktop-claim" && purpose === "authorization_claim") return 300;
  if (audience === "aicrm-desktop-activation" && purpose === "credential_activation") {
    return 600;
  }
  if (
    audience === "aicrm-desktop-command" &&
    [
      "authorization_cancel",
      "authorization_reopen",
      "credential_verify",
      "model_catalog_refresh",
      "readiness_check",
      "credential_logout"
    ].includes(purpose)
  ) {
    return 120;
  }
  return null;
}

function parseCompactToken(
  token: string,
  claims: DesktopTrustedTokenClaims
): { kid: string; tokenHash: string; payloadHash: string } {
  if (typeof token !== "string" || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令票据格式无效");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令票据格式无效");
  }
  const header = decodeCanonicalSegment(parts[0], 2 << 10);
  const payload = decodeCanonicalSegment(parts[1], 12 << 10);
  const signature = decodeCanonicalSegment(parts[2], 64);
  if (signature.byteLength !== 64) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令票据签名格式无效");
  }
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(decodeUtf8(header));
  } catch {
    throw journalError("desktop_trusted_command_unsafe", "受信命令票据头无效");
  }
  if (
    !exactObject(headerValue, ["alg", "kid", "typ"]) ||
    headerValue.alg !== "EdDSA" ||
    headerValue.typ !== "JWT" ||
    typeof headerValue.kid !== "string" ||
    !KEY_ID.test(headerValue.kid) ||
    decodeUtf8(header) !==
      JSON.stringify({ alg: headerValue.alg, kid: headerValue.kid, typ: headerValue.typ })
  ) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令票据头无效");
  }
  const payloadText = decodeUtf8(payload);
  if (payloadText !== JSON.stringify(claims)) {
    throw journalError("desktop_trusted_command_unsafe", "票据与已验证声明不一致");
  }
  return {
    kid: headerValue.kid,
    tokenHash: sha256Hex(Buffer.from(token, "ascii")),
    payloadHash: sha256Hex(payload)
  };
}

function decodeCanonicalSegment(value: string, maximum: number): Buffer {
  if (!value || value.includes("=") || !BASE64_URL.test(value)) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令票据编码无效");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength > maximum || decoded.toString("base64url") !== value) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令票据编码无效");
  }
  return decoded;
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw journalError("desktop_trusted_command_unsafe", "受信命令票据 JSON 编码无效");
  }
}

function semanticKeyFor(
  claims: DesktopTrustedTokenClaims,
  target: DesktopTrustedCommandTarget
): string {
  return sha256Hex(
    Buffer.from(
      [
        "AICRM-TRUSTED-COMMAND-V1",
        claims.aud,
        claims.purpose,
        claims.jti,
        target.operationId ?? ""
      ].join("\n"),
      "utf8"
    )
  );
}

function semanticScopeCollision(
  existing: DesktopTrustedCommandJournalRecord,
  candidate: DesktopTrustedCommandJournalRecord
): boolean {
  if (existing.jti === candidate.jti) return true;
  return (
    existing.target.operationId !== null &&
    existing.target.operationId === candidate.target.operationId
  );
}

function sameAcceptedIdentity(
  existing: DesktopTrustedCommandJournalRecord,
  candidate: DesktopTrustedCommandJournalRecord
): boolean {
  return (
    existing.semanticKey === candidate.semanticKey &&
    existing.tokenHash === candidate.tokenHash &&
    existing.payloadHash === candidate.payloadHash &&
    existing.kid === candidate.kid &&
    existing.aud === candidate.aud &&
    existing.purpose === candidate.purpose &&
    existing.jti === candidate.jti &&
    JSON.stringify(existing.claims) === JSON.stringify(candidate.claims) &&
    sameTarget(existing.target, candidate.target) &&
    (existing.token === null || existing.token === candidate.token)
  );
}

function validSuccessor(
  current: DesktopTrustedCommandJournalRecord,
  next: DesktopTrustedCommandJournalRecord
): boolean {
  if (
    next.generation !== current.generation + 1 ||
    !sameImmutableFields(current, next)
  ) {
    return false;
  }
  switch (current.status) {
    case "accepted":
      return next.status === "effect_started";
    case "effect_started":
      return (
        sameEffectStart(current, next) &&
        (next.status === "effect_durable" || next.status === "indeterminate")
      );
    case "effect_durable":
      return sameDurableEffect(current, next) && next.status === "ack_prepared";
    case "ack_prepared":
      return (
        sameDurableEffect(current, next) &&
        current.outboundAckReference === next.outboundAckReference &&
        current.outboundAckRequestHash === next.outboundAckRequestHash &&
        current.ackPreparedAt === next.ackPreparedAt &&
        next.status === "acknowledged"
      );
    default:
      return false;
  }
}

function sameEffectStart(
  left: DesktopTrustedCommandJournalRecord,
  right: DesktopTrustedCommandJournalRecord
): boolean {
  return (
    left.effectStartedAt === right.effectStartedAt &&
    left.effectRecoveryReference === right.effectRecoveryReference
  );
}

function sameDurableEffect(
  left: DesktopTrustedCommandJournalRecord,
  right: DesktopTrustedCommandJournalRecord
): boolean {
  return (
    sameEffectStart(left, right) &&
    left.effectDurableAt === right.effectDurableAt &&
    left.effectCompletionMode === right.effectCompletionMode &&
    left.effectRecoveryEvidenceHash === right.effectRecoveryEvidenceHash &&
    left.effectResult === right.effectResult &&
    left.effectFailureCode === right.effectFailureCode
  );
}

function sameImmutableFields(
  left: DesktopTrustedCommandJournalRecord,
  right: DesktopTrustedCommandJournalRecord
): boolean {
  return (
    left.version === right.version &&
    left.semanticKey === right.semanticKey &&
    left.tokenHash === right.tokenHash &&
    left.payloadHash === right.payloadHash &&
    left.kid === right.kid &&
    left.aud === right.aud &&
    left.purpose === right.purpose &&
    left.jti === right.jti &&
    left.acceptedAt === right.acceptedAt &&
    JSON.stringify(left.claims) === JSON.stringify(right.claims) &&
    sameTarget(left.target, right.target) &&
    (right.token === left.token ||
      ((right.status === "acknowledged" || right.status === "indeterminate") &&
        right.token === null))
  );
}

function sameRecord(
  left: DesktopTrustedCommandJournalRecord,
  right: DesktopTrustedCommandJournalRecord
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addRecoveryRecord(
  records: Map<number, DesktopTrustedCommandJournalRecord>,
  candidate: DesktopTrustedCommandJournalRecord
): void {
  const existing = records.get(candidate.generation);
  if (existing && !sameRecord(existing, candidate)) {
    throw journalError("desktop_trusted_command_corrupt", "受信命令恢复记录冲突");
  }
  records.set(candidate.generation, candidate);
}

function cloneRecord(record: DesktopTrustedCommandJournalRecord): DesktopTrustedCommandJournalRecord {
  return {
    ...record,
    claims: { ...record.claims },
    target: { ...record.target }
  };
}

function sameTarget(left: unknown, right: DesktopTrustedCommandTarget): boolean {
  const captured = captureExactObject(left, [
    ...TARGET_STRING_FIELDS,
    ...TARGET_REVISION_FIELDS
  ]);
  if (!captured) return false;
  return [...TARGET_STRING_FIELDS, ...TARGET_REVISION_FIELDS].every(
    (field) => captured[field] === right[field]
  );
}

function validateReference(
  value: DesktopTrustedCommandReference
): DesktopTrustedCommandReference {
  const captured = captureExactObject(value, ["semanticKey", "tokenHash", "payloadHash"]);
  if (
    !captured ||
    !isDigest(captured.semanticKey) ||
    !isDigest(captured.tokenHash) ||
    !isDigest(captured.payloadHash)
  ) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令日志引用无效");
  }
  return {
    semanticKey: captured.semanticKey,
    tokenHash: captured.tokenHash,
    payloadHash: captured.payloadHash
  };
}

function validateBeginEffectInput(
  value: BeginDesktopTrustedCommandEffectInput
): BeginDesktopTrustedCommandEffectInput {
  const captured = captureExactObject(value, [
    "semanticKey", "tokenHash", "payloadHash", "effectRecoveryReference"
  ]);
  if (!captured || !isDigest(captured.effectRecoveryReference)) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令副作用参数无效");
  }
  const reference = validateReference({
    semanticKey: captured.semanticKey as string,
    tokenHash: captured.tokenHash as string,
    payloadHash: captured.payloadHash as string
  });
  return { ...reference, effectRecoveryReference: captured.effectRecoveryReference };
}

function validateCompleteEffectInput(
  value: CompleteDesktopTrustedCommandEffectInput
): CompleteDesktopTrustedCommandEffectInput {
  const captured = captureExactObject(value, [
    "semanticKey",
    "tokenHash",
    "payloadHash",
    "effectRecoveryReference",
    "effectAttemptToken",
    "result",
    "failureCode"
  ]);
  if (
    !captured ||
    !canonicalAttemptToken(captured.effectAttemptToken) ||
    !validEffectOutcome(captured.result, captured.failureCode)
  ) {
    throw journalError("desktop_trusted_command_unsafe", "副作用完成参数无效");
  }
  const begin = validateBeginEffectInput({
    semanticKey: captured.semanticKey as string,
    tokenHash: captured.tokenHash as string,
    payloadHash: captured.payloadHash as string,
    effectRecoveryReference: captured.effectRecoveryReference as string
  });
  return {
    ...begin,
    effectAttemptToken: captured.effectAttemptToken,
    result: captured.result as DesktopTrustedCommandEffectResult,
    failureCode: captured.failureCode as string | null
  };
}

function validateRecoverEffectInput(
  value: RecoverDesktopTrustedCommandEffectInput
): RecoverDesktopTrustedCommandEffectInput {
  const captured = captureExactObject(value, [
    "semanticKey",
    "tokenHash",
    "payloadHash",
    "effectRecoveryReference",
    "recoveryEvidenceHash",
    "result",
    "failureCode"
  ]);
  if (
    !captured ||
    !isDigest(captured.recoveryEvidenceHash) ||
    !validEffectOutcome(captured.result, captured.failureCode)
  ) {
    throw journalError("desktop_trusted_command_unsafe", "副作用恢复参数无效");
  }
  const begin = validateBeginEffectInput({
    semanticKey: captured.semanticKey as string,
    tokenHash: captured.tokenHash as string,
    payloadHash: captured.payloadHash as string,
    effectRecoveryReference: captured.effectRecoveryReference as string
  });
  return {
    ...begin,
    recoveryEvidenceHash: captured.recoveryEvidenceHash,
    result: captured.result as DesktopTrustedCommandEffectResult,
    failureCode: captured.failureCode as string | null
  };
}

function validateIndeterminateInput(
  value: MarkDesktopTrustedCommandIndeterminateInput
): MarkDesktopTrustedCommandIndeterminateInput {
  const captured = captureExactObject(value, [
    "semanticKey", "tokenHash", "payloadHash", "effectRecoveryReference", "reasonHash"
  ]);
  if (
    !captured ||
    !isDigest(captured.reasonHash)
  ) {
    throw journalError("desktop_trusted_command_unsafe", "不确定状态参数无效");
  }
  const begin = validateBeginEffectInput({
    semanticKey: captured.semanticKey as string,
    tokenHash: captured.tokenHash as string,
    payloadHash: captured.payloadHash as string,
    effectRecoveryReference: captured.effectRecoveryReference as string
  });
  return { ...begin, reasonHash: captured.reasonHash };
}

function validateAcknowledgementInput(
  value: PrepareDesktopTrustedCommandAcknowledgementInput
): PrepareDesktopTrustedCommandAcknowledgementInput {
  const captured = captureExactObject(value, [
    "semanticKey", "tokenHash", "payloadHash", "outboundAckReference",
    "outboundAckRequestHash"
  ]);
  if (
    !captured ||
    !isDigest(captured.outboundAckReference) ||
    !isDigest(captured.outboundAckRequestHash)
  ) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令确认参数无效");
  }
  const reference = validateReference({
    semanticKey: captured.semanticKey as string,
    tokenHash: captured.tokenHash as string,
    payloadHash: captured.payloadHash as string
  });
  return {
    ...reference,
    outboundAckReference: captured.outboundAckReference,
    outboundAckRequestHash: captured.outboundAckRequestHash
  };
}

function assertFence(
  record: DesktopTrustedCommandJournalRecord,
  reference: DesktopTrustedCommandReference
): void {
  if (
    record.semanticKey !== reference.semanticKey ||
    record.tokenHash !== reference.tokenHash ||
    record.payloadHash !== reference.payloadHash
  ) {
    throw journalError("desktop_trusted_command_conflict", "受信命令日志栅栏不匹配");
  }
}

function assertRecoveryReference(
  record: DesktopTrustedCommandJournalRecord,
  reference: string
): void {
  if (record.effectRecoveryReference !== reference) {
    throw journalError("desktop_trusted_command_conflict", "副作用恢复引用不匹配");
  }
}

function assertSafeFile(info: Stats): void {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < ENVELOPE_MAGIC.byteLength + 1 ||
    info.size > MAX_FILE_BYTES ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  ) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令日志文件不安全");
  }
}

function canonicalAttemptToken(value: unknown): value is string {
  if (typeof value !== "string" || !BASE64_URL.test(value)) return false;
  const raw = Buffer.from(value, "base64url");
  return raw.byteLength === 32 && raw.toString("base64url") === value;
}

function validNonce(value: string): boolean {
  if (typeof value !== "string" || !BASE64_URL.test(value)) return false;
  const raw = Buffer.from(value, "base64url");
  return raw.byteLength === 16 && raw.toString("base64url") === value;
}

function canonicalNow(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令日志时间无效");
  }
  return value.toISOString();
}

function currentUnixSecond(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw journalError("desktop_trusted_command_unsafe", "受信命令清理时间无效");
  }
  return Math.floor(value.getTime() / 1000);
}

function canonicalTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CANONICAL_UTC.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function canonicalNullableTime(value: unknown): value is string {
  return value !== null && canonicalTime(value);
}

function timeAtOrAfter(later: string | null, earlier: string | null): boolean {
  return (
    typeof later === "string" &&
    typeof earlier === "string" &&
    Date.parse(later) >= Date.parse(earlier)
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  return captureExactObject(value, expectedKeys) !== null;
}

function captureExactObject(
  value: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  const captured = captureOwnDataObject(value);
  if (!captured) return null;
  const actual = Object.keys(captured);
  return actual.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(captured, key))
    ? captured
    : null;
}

function captureObjectSubset(
  value: unknown,
  allowedKeys: readonly string[],
  minimumKeys: number
): Readonly<Record<string, unknown>> | null {
  const captured = captureOwnDataObject(value);
  if (!captured) return null;
  const keys = Object.keys(captured);
  const allowed = new Set(allowedKeys);
  return keys.length >= minimumKeys && keys.every((key) => allowed.has(key))
    ? captured
    : null;
}

function captureOwnDataObject(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    const captured: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function syncDirectory(directory: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].some((code) =>
        isErrorCode(error, code)
      )
    ) {
      return false;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isErrorCode(error: unknown, expected: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === expected
  );
}

function journalError(
  code: DesktopTrustedCommandJournalErrorCode,
  message: string
): DesktopTrustedCommandJournalError {
  return new DesktopTrustedCommandJournalError(code, message);
}
