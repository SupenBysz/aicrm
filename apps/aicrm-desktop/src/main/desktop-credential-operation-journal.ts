import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { SafeStorageLike } from "./desktop-device-identity.ts";

const ENVELOPE_MAGIC = Buffer.from("AICRM-CREDENTIAL-OP-ENC-V2\n", "ascii");
const RECORD_DIGEST_DOMAIN = "AICRM-CREDENTIAL-OPERATION-RECORD-V2\n";
const MAX_JOURNAL_BYTES = 64 << 10;
const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const AUTHORIZATION_SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COMMIT_SUFFIX = /^\.commit-([1-9][0-9]{0,15})$/;
const rootTails = new Map<string, Promise<void>>();

export type DesktopCredentialPromotionSourceKind = "staging" | "operation";
export type DesktopCredentialOperationPhase =
  | "prepared"
  | "source_durable"
  | "reserved"
  | "renamed"
  | "immutable"
  | "verified"
  | "acknowledged"
  | "removed"
  | "quarantined";

/** A future ACK replay may retain only a hash or an opaque secret-store reference. */
export interface DesktopCredentialAckReplayReference {
  tokenHash: string | null;
  tokenReference: string | null;
}

export interface DesktopCredentialAcknowledgementProvenance {
  authorizationSessionId: string;
  activationAckRequestReference: string;
  activationAckRequestHash: string;
}

export interface DesktopCredentialOperationRecord {
  version: 2;
  generation: number;
  recordDigest: string;
  executorId: string;
  operationId: string;
  sourceKind: DesktopCredentialPromotionSourceKind;
  sourceId: string;
  sourceOwnershipDigest: string | null;
  targetRevision: number;
  expectedDigest: string;
  phase: DesktopCredentialOperationPhase;
  createdAt: string;
  updatedAt: string;
  ackReplay: DesktopCredentialAckReplayReference | null;
  authorizationSessionId: string | null;
  activationAckRequestReference: string | null;
  activationAckRequestHash: string | null;
  acknowledgedAt: string | null;
}

export type CreateDesktopCredentialOperationInput = Omit<
  DesktopCredentialOperationRecord,
  | "version"
  | "generation"
  | "recordDigest"
  | "phase"
  | "updatedAt"
  | "authorizationSessionId"
  | "activationAckRequestReference"
  | "activationAckRequestHash"
  | "acknowledgedAt"
>;

export interface DesktopCredentialOperationProjection {
  generation: number;
  recordDigest: string;
  executorId: string;
  operationId: string;
  sourceKind: DesktopCredentialPromotionSourceKind;
  sourceId: string;
  sourceOwnershipDigest: string | null;
  targetRevision: number;
  expectedDigest: string;
  phase: DesktopCredentialOperationPhase;
  createdAt: string;
  updatedAt: string;
  ackReplay: DesktopCredentialAckReplayReference | null;
  authorizationSessionId: string | null;
  activationAckRequestReference: string | null;
  activationAckRequestHash: string | null;
  acknowledgedAt: string | null;
}

export type DesktopCredentialJournalErrorCode =
  | "desktop_credential_secure_storage_unavailable"
  | "desktop_credential_journal_conflict"
  | "desktop_credential_journal_corrupt"
  | "desktop_credential_journal_unsafe";

export class DesktopCredentialJournalError extends Error {
  readonly code: DesktopCredentialJournalErrorCode;

  constructor(code: DesktopCredentialJournalErrorCode, message: string) {
    super(message);
    this.name = "DesktopCredentialJournalError";
    this.code = code;
  }
}

export interface DesktopCredentialOperationJournalOptions {
  root: string;
  safeStorage: SafeStorageLike;
  platform?: NodeJS.Platform;
  now?: () => Date;
  faultInjector?: (point: DesktopCredentialOperationJournalFaultPoint) => void | Promise<void>;
  renameFile?: (source: string, target: string) => Promise<void>;
  directorySync?: (directory: string) => Promise<void>;
}

export type DesktopCredentialOperationJournalFaultPoint =
  | "after_commit_fsync"
  | "after_temporary_fsync"
  | "after_rename"
  | "before_directory_fsync";

/** Encrypted, generation-CAS promotion recovery journal. */
export class DesktopCredentialOperationJournalStore {
  private readonly root: string;
  private readonly safeStorage: SafeStorageLike;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private readonly faultInjector?: DesktopCredentialOperationJournalOptions["faultInjector"];
  private readonly renameFile: (source: string, target: string) => Promise<void>;
  private readonly directorySync: (directory: string) => Promise<void>;

  constructor(options: DesktopCredentialOperationJournalOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw journalError("desktop_credential_journal_unsafe", "凭据操作日志目录无效");
    }
    this.safeStorage = options.safeStorage;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
    this.renameFile = options.renameFile ?? rename;
    this.directorySync = options.directorySync ?? syncDirectoryStrict;
  }

  create(input: CreateDesktopCredentialOperationInput): Promise<DesktopCredentialOperationRecord> {
    return this.exclusive(() => this.boundary(async () => {
      this.assertSecureStorage();
      const createdAt = canonicalTime(input.createdAt);
      const next = withRecordDigest({
        version: 2,
        generation: 1,
        recordDigest: "",
        ...input,
        phase: "prepared",
        createdAt,
        updatedAt: createdAt,
        authorizationSessionId: null,
        activationAckRequestReference: null,
        activationAckRequestHash: null,
        acknowledgedAt: null
      });
      await this.ensureRoot();
      await this.repairPending(next.operationId);
      const current = await this.readTarget(next.operationId);
      if (current) {
        if (sameRecord(current, next)) return cloneRecord(current);
        throw journalError("desktop_credential_journal_conflict", "凭据操作日志已被其他事务占用");
      }
      await this.writeAtomic(next, null);
      return cloneRecord(next);
    }));
  }

  transition(
    expected: DesktopCredentialOperationRecord,
    phase: DesktopCredentialOperationPhase,
    acknowledgement?: DesktopCredentialAcknowledgementProvenance
  ): Promise<DesktopCredentialOperationRecord> {
    const fence = validateRecord(expected);
    return this.exclusive(() => this.boundary(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairPending(fence.operationId);
      const current = await this.readTarget(fence.operationId);
      if (!current) {
        throw journalError("desktop_credential_journal_conflict", "凭据操作日志 CAS 前代不存在");
      }
      if (!sameRecord(current, fence)) {
        if (
          current.generation === fence.generation + 1 &&
          validSuccessor(fence, current) &&
          current.phase === phase &&
          sameRequestedAcknowledgement(current, phase, acknowledgement)
        ) {
          return cloneRecord(current);
        }
        throw journalError("desktop_credential_journal_conflict", "凭据操作日志 CAS 栅栏不匹配");
      }
      if (!validRequestedTransition(current.phase, phase, acknowledgement)) {
        throw journalError("desktop_credential_journal_conflict", "凭据操作日志阶段迁移无效");
      }
      const generation = current.generation + 1;
      if (!Number.isSafeInteger(generation)) {
        throw journalError("desktop_credential_journal_conflict", "凭据操作日志代次已耗尽");
      }
      const updatedAt = monotonicNow(this.now, current.updatedAt);
      const next = withRecordDigest({
        ...current,
        generation,
        recordDigest: "",
        phase,
        updatedAt,
        authorizationSessionId:
          phase === "acknowledged"
            ? validateAcknowledgement(acknowledgement).authorizationSessionId
            : phase === "removed"
              ? current.authorizationSessionId
              : null,
        activationAckRequestReference:
          phase === "acknowledged"
            ? validateAcknowledgement(acknowledgement).activationAckRequestReference
            : phase === "removed"
              ? current.activationAckRequestReference
              : null,
        activationAckRequestHash:
          phase === "acknowledged"
            ? validateAcknowledgement(acknowledgement).activationAckRequestHash
            : phase === "removed"
              ? current.activationAckRequestHash
              : null,
        acknowledgedAt:
          phase === "acknowledged"
            ? updatedAt
            : phase === "removed"
              ? current.acknowledgedAt
              : null
      });
      await this.writeAtomic(next, current);
      return cloneRecord(next);
    }));
  }

  load(operationId: string): Promise<DesktopCredentialOperationRecord | null> {
    assertSafeId(operationId);
    return this.exclusive(() => this.boundary(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairPending(operationId);
      return cloneNullable(await this.readTarget(operationId));
    }));
  }

  listOperationIds(): Promise<string[]> {
    return this.listIds(false);
  }

  listPendingOperationIds(): Promise<string[]> {
    return this.listIds(true);
  }

  removeAcknowledged(
    expected: DesktopCredentialOperationRecord
  ): Promise<DesktopCredentialOperationRecord> {
    const fence = validateRecord(expected);
    if (fence.phase === "removed") {
      return this.load(fence.operationId).then((current) => {
        if (!current || !sameRecord(current, fence)) {
          throw journalError("desktop_credential_journal_conflict", "凭据 ACK 删除高水位不匹配");
        }
        return current;
      });
    }
    if (fence.phase !== "acknowledged") {
      throw journalError("desktop_credential_journal_unsafe", "仅 ACK 墓碑可被精确清理");
    }
    return this.transition(fence, "removed");
  }

  projection(record: DesktopCredentialOperationRecord): DesktopCredentialOperationProjection {
    const value = validateRecord(record);
    return {
      generation: value.generation,
      recordDigest: value.recordDigest,
      executorId: value.executorId,
      operationId: value.operationId,
      sourceKind: value.sourceKind,
      sourceId: value.sourceId,
      sourceOwnershipDigest: value.sourceOwnershipDigest,
      targetRevision: value.targetRevision,
      expectedDigest: value.expectedDigest,
      phase: value.phase,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ackReplay: value.ackReplay ? { ...value.ackReplay } : null,
      authorizationSessionId: value.authorizationSessionId,
      activationAckRequestReference: value.activationAckRequestReference,
      activationAckRequestHash: value.activationAckRequestHash,
      acknowledgedAt: value.acknowledgedAt
    };
  }

  private listIds(pendingOnly: boolean): Promise<string[]> {
    return this.exclusive(() => this.boundary(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      const children = await readdir(this.root, { withFileTypes: true });
      const ids = new Set<string>();
      for (const child of children) {
        if (!child.isFile() || child.isSymbolicLink()) {
          throw journalError("desktop_credential_journal_unsafe", "凭据操作日志目录包含非法条目");
        }
        const match = /^([A-Za-z0-9_-]{1,120})\.sec(?:\.tmp|\.commit-[1-9][0-9]{0,15})?$/.exec(child.name);
        if (!match) {
          throw journalError("desktop_credential_journal_unsafe", "凭据操作日志目录包含非法文件");
        }
        ids.add(match[1]);
      }
      const result: string[] = [];
      for (const id of [...ids].sort()) {
        await this.repairPending(id);
        const record = await this.readTarget(id);
        if (!record) continue;
        if (record.phase === "removed") continue;
        if (!pendingOnly || record.phase !== "acknowledged") result.push(id);
      }
      return result;
    }));
  }

  private async writeAtomic(
    record: DesktopCredentialOperationRecord,
    expected: DesktopCredentialOperationRecord | null
  ): Promise<void> {
    const value = validateRecord(record);
    await this.ensureCommitMarker(value);
    // The immutable generation claim must itself be a durable directory entry
    // before any temporary file or target replacement can become observable.
    await this.directorySync(this.root);
    await this.faultInjector?.("after_commit_fsync");
    await this.ensureTemporary(value);
    await this.faultInjector?.("after_temporary_fsync");
    const current = await this.readTarget(value.operationId);
    if (current && sameRecord(current, value)) {
      await this.finishDurability(value, true);
      return;
    }
    if (
      (expected === null && current !== null) ||
      (expected !== null && (current === null || !sameRecord(current, expected)))
    ) {
      throw journalError("desktop_credential_journal_conflict", "凭据操作日志持久化 CAS 已变化");
    }
    const [targetBeforeRename, temporary, claim] = await Promise.all([
      this.readTarget(value.operationId),
      this.readPath(this.temporary(value.operationId), value.operationId),
      this.readPath(this.commit(value.operationId, value.generation), value.operationId)
    ]);
    if (targetBeforeRename && sameRecord(targetBeforeRename, value)) {
      await this.finishDurability(value, true);
      return;
    }
    if (
      (expected === null && targetBeforeRename !== null) ||
      (expected !== null &&
        (targetBeforeRename === null || !sameRecord(targetBeforeRename, expected))) ||
      !temporary ||
      !claim ||
      !sameRecord(temporary, value) ||
      !sameRecord(claim, value)
    ) {
      throw journalError("desktop_credential_journal_corrupt", "凭据操作日志重命名前证据不匹配");
    }
    await this.renameFile(this.temporary(value.operationId), this.target(value.operationId));
    await this.faultInjector?.("after_rename");
    await this.finishDurability(value, true);
  }

  private async repairPending(operationId: string): Promise<void> {
    const target = await this.readTarget(operationId);
    const commits = await this.readCommitRecords(operationId);
    const temporary = await this.readPath(this.temporary(operationId), operationId, true);
    if (target === null && commits.length === 0 && temporary === null) return;
    if (commits.length === 0) {
      throw journalError("desktop_credential_journal_corrupt", "凭据操作日志缺少永久代际声明");
    }
    if (
      temporary &&
      !commits.some((commit) => sameRecord(commit.record, temporary))
    ) {
      throw journalError("desktop_credential_journal_corrupt", "凭据操作临时日志缺少提交影子");
    }

    const recoveries = new Map<number, DesktopCredentialOperationRecord>();
    for (const commit of commits) addRecoveryRecord(recoveries, commit.record);
    if (temporary) addRecoveryRecord(recoveries, temporary);
    const ordered = [...recoveries.values()].sort((left, right) => left.generation - right.generation);
    if (ordered[0].generation !== 1 || ordered[0].phase !== "prepared") {
      throw journalError("desktop_credential_journal_corrupt", "凭据操作日志恢复缺少初始代");
    }
    for (let index = 1; index < ordered.length; index += 1) {
      if (!validSuccessor(ordered[index - 1], ordered[index])) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志代次或阶段不连续");
      }
    }
    let recovered: DesktopCredentialOperationRecord | null = null;
    if (!target) {
      if (ordered.length !== 1 || ordered[0].generation !== 1 || ordered[0].phase !== "prepared") {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志恢复缺少前代状态");
      }
      recovered = ordered[0];
    } else {
      const targetClaim = recoveries.get(target.generation);
      if (!targetClaim || !sameRecord(targetClaim, target)) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志目标代声明不匹配");
      }
      const newest = ordered.at(-1)!;
      if (temporary && newest.generation > target.generation && !sameRecord(temporary, newest)) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作临时日志不是最新连续代");
      }
      if (newest.generation > target.generation) recovered = newest;
    }
    if (recovered) {
      await this.ensureCommitMarker(recovered);
      await this.directorySync(this.root);
      await this.ensureTemporary(recovered);
      const current = await this.readTarget(operationId);
      if (current && sameRecord(current, recovered)) {
        await this.finishDurability(recovered, false);
        return;
      }
      if (
        (target === null && current !== null) ||
        (target !== null && (current === null || !sameRecord(current, target)))
      ) {
        throw journalError("desktop_credential_journal_conflict", "凭据操作日志恢复 CAS 已变化");
      }
      const [targetNow, temporaryNow, claimNow] = await Promise.all([
        this.readTarget(operationId),
        this.readPath(this.temporary(operationId), operationId),
        this.readPath(this.commit(operationId, recovered.generation), operationId)
      ]);
      if (targetNow && sameRecord(targetNow, recovered)) {
        await this.finishDurability(recovered, false);
        return;
      }
      if (
        (target === null && targetNow !== null) ||
        (target !== null && (targetNow === null || !sameRecord(targetNow, target))) ||
        !temporaryNow ||
        !claimNow ||
        !sameRecord(temporaryNow, recovered) ||
        !sameRecord(claimNow, recovered)
      ) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志恢复重命名证据不匹配");
      }
      await this.renameFile(this.temporary(operationId), this.target(operationId));
      await this.finishDurability(recovered, false);
    } else if (target) {
      await this.finishDurability(target, false);
    }
  }

  private async finishDurability(
    record: DesktopCredentialOperationRecord,
    injectFaults: boolean
  ): Promise<void> {
    await this.syncRegularFile(this.target(record.operationId));
    const verified = await this.readTarget(record.operationId);
    if (!verified || !sameRecord(verified, record)) {
      throw journalError("desktop_credential_journal_corrupt", "凭据操作日志替换结果不匹配");
    }
    if (injectFaults) await this.faultInjector?.("before_directory_fsync");
    await this.directorySync(this.root);
    const temporary = await this.readPath(this.temporary(record.operationId), record.operationId, true);
    if (temporary === null || temporary.generation > record.generation) return;
    const commits = await this.readCommitRecords(record.operationId);
    if (!commits.some((commit) => sameRecord(commit.record, temporary))) {
      throw journalError("desktop_credential_journal_corrupt", "凭据操作临时日志无永久声明");
    }
    if (temporary.generation === record.generation && !sameRecord(temporary, record)) {
      throw journalError("desktop_credential_journal_corrupt", "凭据操作临时日志同代分支冲突");
    }
    await rm(this.temporary(record.operationId));
    try {
      await this.directorySync(this.root);
    } catch {
      // The permanent generation claim and target remain. A retry can safely
      // observe either the pre-cleanup or post-cleanup directory entry state.
      throw journalError("desktop_credential_journal_corrupt", "凭据操作日志清理持久化失败");
    }
  }

  private async ensureCommitMarker(record: DesktopCredentialOperationRecord): Promise<void> {
    const file = this.commit(record.operationId, record.generation);
    const existing = await this.readPath(file, record.operationId, true);
    if (existing) {
      if (!sameRecord(existing, record)) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作提交影子同代冲突");
      }
      return;
    }
    await this.writeEnvelopeExclusive(file, record);
  }

  private async ensureTemporary(record: DesktopCredentialOperationRecord): Promise<void> {
    const file = this.temporary(record.operationId);
    const existing = await this.readPath(file, record.operationId, true);
    if (existing) {
      if (!sameRecord(existing, record)) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作临时日志分支冲突");
      }
      return;
    }
    await this.writeEnvelopeExclusive(file, record);
  }

  private async writeEnvelopeExclusive(file: string, record: DesktopCredentialOperationRecord): Promise<void> {
    const envelope = this.encryptEnvelope(record);
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
      const opened = await handle.stat();
      const linked = await lstat(file);
      assertSafeNewFile(opened, this.platform);
      assertSafeNewFile(linked, this.platform);
      if (!sameStableFile(opened, linked)) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志新文件链接不稳定");
      }
      await handle.writeFile(envelope);
      if (this.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      const written = await handle.stat();
      assertSafeFile(written, this.platform);
      if (
        written.dev !== opened.dev ||
        written.ino !== opened.ino ||
        written.nlink !== opened.nlink ||
        written.size !== envelope.byteLength
      ) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志新文件写入不稳定");
      }
      await handle.close();
      handle = undefined;
      const relinked = await lstat(file);
      assertSafeFile(relinked, this.platform);
      if (!sameStableFile(written, relinked)) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志新文件关闭后变化");
      }
      const readback = await this.readPath(file, record.operationId);
      if (!readback || !sameRecord(readback, record)) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志新文件回读不匹配");
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private encryptEnvelope(record: DesktopCredentialOperationRecord): Buffer {
    let encrypted: Buffer;
    try {
      encrypted = this.safeStorage.encryptString(JSON.stringify(validateRecord(record)));
    } catch {
      throw journalError("desktop_credential_secure_storage_unavailable", "凭据操作日志加密失败");
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.byteLength < 1) {
      throw journalError("desktop_credential_secure_storage_unavailable", "凭据操作日志密文无效");
    }
    const envelope = Buffer.concat([ENVELOPE_MAGIC, encrypted]);
    if (envelope.byteLength > MAX_JOURNAL_BYTES) {
      throw journalError("desktop_credential_journal_unsafe", "凭据操作日志超过安全上限");
    }
    return envelope;
  }

  private async readCommitRecords(
    operationId: string
  ): Promise<Array<{ file: string; record: DesktopCredentialOperationRecord }>> {
    const prefix = `${operationId}.sec`;
    const result: Array<{ file: string; record: DesktopCredentialOperationRecord }> = [];
    for (const child of await readdir(this.root, { withFileTypes: true })) {
      if (!child.name.startsWith(`${prefix}.commit`)) continue;
      if (!child.isFile() || child.isSymbolicLink()) {
        throw journalError("desktop_credential_journal_unsafe", "凭据操作提交影子不安全");
      }
      const match = COMMIT_SUFFIX.exec(child.name.slice(prefix.length));
      const generation = match ? Number(match[1]) : Number.NaN;
      if (!Number.isSafeInteger(generation)) {
        throw journalError("desktop_credential_journal_unsafe", "凭据操作提交影子代次无效");
      }
      const file = path.join(this.root, child.name);
      const record = await this.readPath(file, operationId);
      if (!record || record.generation !== generation) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作提交影子代次不匹配");
      }
      result.push({ file, record });
    }
    return result.sort((left, right) => left.record.generation - right.record.generation);
  }

  private readTarget(operationId: string): Promise<DesktopCredentialOperationRecord | null> {
    return this.readPath(this.target(operationId), operationId, true);
  }

  private async readPath(
    file: string,
    expectedOperationId: string,
    missingAllowed = false
  ): Promise<DesktopCredentialOperationRecord | null> {
    let info: Stats;
    try {
      info = await lstat(file);
    } catch (error) {
      if (missingAllowed && isErrorCode(error, "ENOENT")) return null;
      throw journalError("desktop_credential_journal_corrupt", "凭据操作日志无法读取");
    }
    assertSafeFile(info, this.platform);
    const flags = fsConstants.O_RDONLY | (this.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    let handle;
    try {
      handle = await open(file, flags);
      const before = await handle.stat();
      assertSafeFile(before, this.platform);
      if (!sameStableFile(info, before)) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志打开前已变化");
      }
      const raw = await handle.readFile();
      const after = await handle.stat();
      assertSafeFile(after, this.platform);
      if (
        !sameStableFile(before, after) ||
        raw.byteLength !== before.size ||
        !raw.subarray(0, ENVELOPE_MAGIC.byteLength).equals(ENVELOPE_MAGIC)
      ) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志封套不稳定");
      }
      await handle.close();
      handle = undefined;
      const relinked = await lstat(file);
      assertSafeFile(relinked, this.platform);
      if (!sameStableFile(after, relinked)) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志读取后链接变化");
      }
      const plaintext = this.safeStorage.decryptString(raw.subarray(ENVELOPE_MAGIC.byteLength));
      const record = validateRecord(JSON.parse(plaintext) as unknown);
      if (record.operationId !== expectedOperationId) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志归属不匹配");
      }
      return record;
    } catch (error) {
      if (error instanceof DesktopCredentialJournalError) throw error;
      throw journalError("desktop_credential_journal_corrupt", "凭据操作日志无法解密");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async syncRegularFile(file: string): Promise<void> {
    const info = await lstat(file);
    assertSafeFile(info, this.platform);
    const flags = fsConstants.O_RDWR | (this.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    let handle;
    try {
      handle = await open(file, flags);
      const before = await handle.stat();
      assertSafeFile(before, this.platform);
      if (!sameStableFile(info, before)) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志持久化目标已变化");
      }
      await handle.sync();
      const after = await handle.stat();
      assertSafeFile(after, this.platform);
      if (!sameStableFile(before, after)) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志持久化目标不稳定");
      }
      await handle.close();
      handle = undefined;
      const relinked = await lstat(file);
      assertSafeFile(relinked, this.platform);
      if (!sameStableFile(after, relinked)) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志持久化链接已变化");
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw journalError("desktop_credential_journal_unsafe", "凭据操作日志目录不安全");
    }
    if (this.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
      throw journalError("desktop_credential_journal_unsafe", "凭据操作日志目录权限不安全");
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
      throw journalError("desktop_credential_secure_storage_unavailable", "系统安全存储不可用");
    }
  }

  private target(operationId: string): string {
    return path.join(this.root, `${operationId}.sec`);
  }

  private temporary(operationId: string): string {
    return path.join(this.root, `${operationId}.sec.tmp`);
  }

  private commit(operationId: string, generation: number): string {
    return path.join(this.root, `${operationId}.sec.commit-${generation}`);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = rootTails.get(this.root) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    rootTails.set(this.root, settled);
    void settled.then(() => {
      if (rootTails.get(this.root) === settled) rootTails.delete(this.root);
    });
    return result;
  }

  private async boundary<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DesktopCredentialJournalError) throw error;
      throw journalError("desktop_credential_journal_corrupt", "凭据操作日志处理失败");
    }
  }
}

function validateRecord(value: unknown): DesktopCredentialOperationRecord {
  if (!isExactRecord(value, [
    "version", "generation", "recordDigest", "executorId", "operationId", "sourceKind",
    "sourceId", "sourceOwnershipDigest", "targetRevision", "expectedDigest", "phase",
    "createdAt", "updatedAt", "ackReplay", "authorizationSessionId",
    "activationAckRequestReference", "activationAckRequestHash", "acknowledgedAt"
  ])) {
    throw journalError("desktop_credential_journal_corrupt", "凭据操作日志结构无效");
  }
  const record = value as unknown as DesktopCredentialOperationRecord;
  if (
    record.version !== 2 ||
    !Number.isSafeInteger(record.generation) || record.generation < 1 ||
    !SAFE_ID.test(record.executorId) || !SAFE_ID.test(record.operationId) || !SAFE_ID.test(record.sourceId) ||
    (record.sourceKind !== "staging" && record.sourceKind !== "operation") ||
    (record.sourceKind === "staging" ? !DIGEST.test(record.sourceOwnershipDigest ?? "") : record.sourceOwnershipDigest !== null) ||
    !Number.isSafeInteger(record.targetRevision) || record.targetRevision < 1 ||
    !DIGEST.test(record.expectedDigest) || !DIGEST.test(record.recordDigest) ||
    !(["prepared", "source_durable", "reserved", "renamed", "immutable", "verified", "acknowledged", "removed", "quarantined"] as const).includes(record.phase) ||
    !isCanonicalTime(record.createdAt) || !isCanonicalTime(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
    (record.ackReplay !== null && !validAckReplay(record.ackReplay)) ||
    !validAcknowledgedShape(record) ||
    recordDigest(record) !== record.recordDigest
  ) {
    throw journalError("desktop_credential_journal_corrupt", "凭据操作日志字段无效");
  }
  return cloneRecord(record);
}

function validAcknowledgedShape(record: DesktopCredentialOperationRecord): boolean {
  if (record.phase === "acknowledged" || record.phase === "removed") {
    const acknowledgedAt = record.acknowledgedAt;
    return (
      AUTHORIZATION_SESSION_ID.test(record.authorizationSessionId ?? "") &&
      DIGEST.test(record.activationAckRequestReference ?? "") &&
      DIGEST.test(record.activationAckRequestHash ?? "") &&
      isCanonicalTime(acknowledgedAt) &&
      (record.phase === "acknowledged"
        ? acknowledgedAt === record.updatedAt
        : Date.parse(acknowledgedAt) <= Date.parse(record.updatedAt))
    );
  }
  return record.authorizationSessionId === null && record.activationAckRequestReference === null &&
    record.activationAckRequestHash === null && record.acknowledgedAt === null;
}

function validateAcknowledgement(
  value: DesktopCredentialAcknowledgementProvenance | undefined
): DesktopCredentialAcknowledgementProvenance {
  if (!isExactRecord(value, [
    "authorizationSessionId", "activationAckRequestReference", "activationAckRequestHash"
  ])) {
    throw journalError("desktop_credential_journal_unsafe", "凭据 ACK 来源结构无效");
  }
  const candidate = value as unknown as DesktopCredentialAcknowledgementProvenance;
  if (!AUTHORIZATION_SESSION_ID.test(candidate.authorizationSessionId) ||
      !DIGEST.test(candidate.activationAckRequestReference) ||
      !DIGEST.test(candidate.activationAckRequestHash)) {
    throw journalError("desktop_credential_journal_unsafe", "凭据 ACK 来源字段无效");
  }
  return { ...candidate };
}

function validRequestedTransition(
  current: DesktopCredentialOperationPhase,
  next: DesktopCredentialOperationPhase,
  acknowledgement?: DesktopCredentialAcknowledgementProvenance
): boolean {
  if (current === "quarantined" || current === "removed") return false;
  if (next === "removed") return current === "acknowledged" && acknowledgement === undefined;
  if (next === "quarantined") {
    return current !== "acknowledged" && acknowledgement === undefined;
  }
  const phases: DesktopCredentialOperationPhase[] = [
    "prepared", "source_durable", "reserved", "renamed", "immutable", "verified", "acknowledged"
  ];
  if (!phases.includes(current) || !phases.includes(next)) return false;
  const valid = phases.indexOf(next) === phases.indexOf(current) + 1;
  if (!valid) return false;
  if (next === "acknowledged") {
    validateAcknowledgement(acknowledgement);
    return true;
  }
  return acknowledgement === undefined;
}

function validSuccessor(
  current: DesktopCredentialOperationRecord,
  next: DesktopCredentialOperationRecord
): boolean {
  return next.generation === current.generation + 1 &&
    immutableOperationFieldsEqual(current, next) &&
    (next.phase !== "removed" || exactAcknowledgementProvenance(current, next)) &&
    Date.parse(next.updatedAt) >= Date.parse(current.updatedAt) &&
    validRequestedTransition(
      current.phase,
      next.phase,
      next.phase === "acknowledged" ? {
        authorizationSessionId: next.authorizationSessionId!,
        activationAckRequestReference: next.activationAckRequestReference!,
        activationAckRequestHash: next.activationAckRequestHash!
      } : undefined
    );
}

function exactAcknowledgementProvenance(
  current: DesktopCredentialOperationRecord,
  next: DesktopCredentialOperationRecord
): boolean {
  return current.phase === "acknowledged" &&
    current.authorizationSessionId === next.authorizationSessionId &&
    current.activationAckRequestReference === next.activationAckRequestReference &&
    current.activationAckRequestHash === next.activationAckRequestHash &&
    current.acknowledgedAt === next.acknowledgedAt;
}

function immutableOperationFieldsEqual(
  left: DesktopCredentialOperationRecord,
  right: DesktopCredentialOperationRecord
): boolean {
  return left.version === right.version && left.executorId === right.executorId &&
    left.operationId === right.operationId && left.sourceKind === right.sourceKind &&
    left.sourceId === right.sourceId && left.sourceOwnershipDigest === right.sourceOwnershipDigest &&
    left.targetRevision === right.targetRevision && left.expectedDigest === right.expectedDigest &&
    left.createdAt === right.createdAt && JSON.stringify(left.ackReplay) === JSON.stringify(right.ackReplay);
}

function sameRequestedAcknowledgement(
  current: DesktopCredentialOperationRecord,
  phase: DesktopCredentialOperationPhase,
  acknowledgement?: DesktopCredentialAcknowledgementProvenance
): boolean {
  if (phase !== "acknowledged") return acknowledgement === undefined;
  const value = validateAcknowledgement(acknowledgement);
  return current.authorizationSessionId === value.authorizationSessionId &&
    current.activationAckRequestReference === value.activationAckRequestReference &&
    current.activationAckRequestHash === value.activationAckRequestHash;
}

function withRecordDigest(record: DesktopCredentialOperationRecord): DesktopCredentialOperationRecord {
  const next = { ...record, ackReplay: record.ackReplay ? { ...record.ackReplay } : null };
  next.recordDigest = recordDigest(next);
  return validateRecord(next);
}

function recordDigest(record: DesktopCredentialOperationRecord): string {
  return createHash("sha256").update(RECORD_DIGEST_DOMAIN, "utf8").update(JSON.stringify({
    version: record.version,
    generation: record.generation,
    executorId: record.executorId,
    operationId: record.operationId,
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    sourceOwnershipDigest: record.sourceOwnershipDigest,
    targetRevision: record.targetRevision,
    expectedDigest: record.expectedDigest,
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ackReplay: record.ackReplay,
    authorizationSessionId: record.authorizationSessionId,
    activationAckRequestReference: record.activationAckRequestReference,
    activationAckRequestHash: record.activationAckRequestHash,
    acknowledgedAt: record.acknowledgedAt
  }), "utf8").digest("hex");
}

function addRecoveryRecord(
  values: Map<number, DesktopCredentialOperationRecord>,
  candidate: DesktopCredentialOperationRecord
): void {
  const existing = values.get(candidate.generation);
  if (existing && !sameRecord(existing, candidate)) {
    throw journalError("desktop_credential_journal_corrupt", "凭据操作日志同代恢复分支冲突");
  }
  values.set(candidate.generation, candidate);
}

function validAckReplay(value: unknown): value is DesktopCredentialAckReplayReference {
  if (!isExactRecord(value, ["tokenHash", "tokenReference"])) return false;
  const candidate = value as unknown as DesktopCredentialAckReplayReference;
  return (candidate.tokenHash === null || DIGEST.test(candidate.tokenHash)) &&
    (candidate.tokenReference === null || SAFE_ID.test(candidate.tokenReference)) &&
    (candidate.tokenHash !== null || candidate.tokenReference !== null);
}

function cloneRecord(record: DesktopCredentialOperationRecord): DesktopCredentialOperationRecord {
  return { ...record, ackReplay: record.ackReplay ? { ...record.ackReplay } : null };
}

function cloneNullable(record: DesktopCredentialOperationRecord | null): DesktopCredentialOperationRecord | null {
  return record ? cloneRecord(record) : null;
}

function sameRecord(left: DesktopCredentialOperationRecord, right: DesktopCredentialOperationRecord): boolean {
  return left.recordDigest === right.recordDigest && JSON.stringify(left) === JSON.stringify(right);
}

function assertSafeId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw journalError("desktop_credential_journal_unsafe", "凭据操作日志标识无效");
  }
}

function assertSafeFile(info: Stats, platform: NodeJS.Platform): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 ||
      info.size > MAX_JOURNAL_BYTES || (platform !== "win32" && (info.mode & 0o777) !== 0o600)) {
    throw journalError("desktop_credential_journal_unsafe", "凭据操作日志文件不安全");
  }
}

function assertSafeNewFile(info: Stats, platform: NodeJS.Platform): void {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size !== 0 ||
    (platform !== "win32" && (info.mode & 0o777) !== 0o600)
  ) {
    throw journalError("desktop_credential_journal_unsafe", "凭据操作日志新文件不安全");
  }
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function canonicalTime(value: string): string {
  if (!isCanonicalTime(value)) {
    throw journalError("desktop_credential_journal_unsafe", "凭据操作日志时间无效");
  }
  return value;
}

function monotonicNow(now: () => Date, previous: string): string {
  const value = now().toISOString();
  return Date.parse(value) >= Date.parse(previous) ? value : previous;
}

function isCanonicalTime(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UTC.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function syncDirectoryStrict(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function journalError(code: DesktopCredentialJournalErrorCode, message: string): DesktopCredentialJournalError {
  return new DesktopCredentialJournalError(code, message);
}
