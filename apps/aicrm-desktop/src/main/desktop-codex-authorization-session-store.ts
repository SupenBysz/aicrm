import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { CodexAuthorizationSnapshot } from "../shared/types.ts";
import type { SafeStorageLike } from "./desktop-device-identity.ts";
import { DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM } from "./desktop-credential-tree-digest.ts";

const ENVELOPE_MAGIC = Buffer.from("AICRM-CODEX-AUTH-SESSION-ENC-V1\n", "ascii");
const MAX_FILE_BYTES = 96 << 10;
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const DEVICE_ID = /^[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,95}$/;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COMMIT_SUFFIX = /^\.commit-([1-9][0-9]{0,15})$/;
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100] as const;
const INDETERMINATE_FAILURE_CODE = "desktop_effect_outcome_indeterminate";
const rootTails = new Map<string, Promise<void>>();

export const DESKTOP_CODEX_AUTHORIZATION_PROGRESS = [
  "accepted",
  "handoff_claim_starting",
  "handoff_claimed",
  "app_server_starting",
  "app_server_started",
  "login_starting",
  "waiting_user",
  "login_completed",
  "proof_submit_starting",
  "proof_prepared",
  "activation_pending",
  "credential_promotion_starting",
  "credential_durable",
  "activation_ack_starting",
  "activation_ack_response_received",
  "activation_acked"
] as const;

export const DESKTOP_CODEX_AUTHORIZATION_TERMINAL = [
  "failed",
  "cancelled",
  "expired",
  "interrupted",
  "indeterminate"
] as const;

const EFFECT_STARTING = new Set<DesktopCodexAuthorizationProgressStatus>([
  "handoff_claim_starting",
  "app_server_starting",
  "login_starting",
  "proof_submit_starting",
  "credential_promotion_starting",
  "activation_ack_starting"
]);

export type DesktopCodexAuthorizationProgressStatus =
  (typeof DESKTOP_CODEX_AUTHORIZATION_PROGRESS)[number];
export type DesktopCodexAuthorizationTerminalStatus =
  (typeof DESKTOP_CODEX_AUTHORIZATION_TERMINAL)[number];
export type DesktopCodexAuthorizationSessionStatus =
  | DesktopCodexAuthorizationProgressStatus
  | DesktopCodexAuthorizationTerminalStatus;

export interface DesktopCodexCredentialPromotionReceipt {
  executorId: string;
  revision: number;
  operationId: string;
  digestAlgorithm: typeof DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM;
  digest: string;
  fileCount: number;
  totalBytes: number;
}

/**
 * Main-only recovery tuple. Raw tokens are deliberately present only in this
 * encrypted record and are never part of the safe snapshot projection.
 */
export interface DesktopCodexAuthorizationSessionData {
  status: DesktopCodexAuthorizationSessionStatus;
  lastProgressStatus: DesktopCodexAuthorizationProgressStatus;
  sessionId: string;
  executorId: string;
  deviceId: string;
  handoffId: string;
  sessionRevision: number;
  claimRequestReference: string | null;
  claimRequestHash: string | null;
  claimToken: string | null;
  claimExpiresAt: string | null;
  loginIdHash: string | null;
  accountFingerprint: string | null;
  candidateBindingDigest: string | null;
  proofRequestReference: string | null;
  proofRequestHash: string | null;
  proofId: string | null;
  activationOperationId: string | null;
  activationId: string | null;
  activationToken: string | null;
  activationExpiresAt: string | null;
  credentialRevision: number | null;
  leaseEpoch: number | null;
  sourceCredentialRevision: number | null;
  revocationEpoch: number | null;
  bindingDigest: string | null;
  promotionReceipt: DesktopCodexCredentialPromotionReceipt | null;
  ackRequestReference: string | null;
  ackRequestHash: string | null;
  localFailureCode: string | null;
}

export interface DesktopCodexAuthorizationSessionRecord
  extends DesktopCodexAuthorizationSessionData {
  version: 1;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDesktopCodexAuthorizationSessionInput {
  sessionId: string;
  executorId: string;
  deviceId: string;
  handoffId: string;
  sessionRevision: number;
}

export type DesktopCodexAuthorizationSessionStoreErrorCode =
  | "desktop_codex_authorization_conflict"
  | "desktop_codex_authorization_corrupt"
  | "desktop_codex_authorization_unsafe"
  | "desktop_secure_storage_unavailable";

export class DesktopCodexAuthorizationSessionStoreError extends Error {
  readonly code: DesktopCodexAuthorizationSessionStoreErrorCode;

  constructor(code: DesktopCodexAuthorizationSessionStoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type DesktopCodexAuthorizationSessionFaultPoint =
  | "after_commit_shadow_fsync"
  | "after_temporary_fsync"
  | "after_rename"
  | "before_directory_fsync";

export interface DesktopCodexAuthorizationSessionStoreOptions {
  root: string;
  safeStorage: SafeStorageLike;
  now?: () => Date;
  faultInjector?: (
    point: DesktopCodexAuthorizationSessionFaultPoint
  ) => void | Promise<void>;
  renameFile?: (source: string, target: string) => Promise<void>;
  syncDirectory?: (directory: string) => Promise<boolean>;
}

/**
 * Runtime ordering fence supplied only after Main has inspected every exact
 * outbound request journal and persisted any recoverable successor generation.
 */
export interface DesktopCodexRecoveryPrerequisites {
  exactOutboundJournalRecoveryAttempted: true;
  activationLeaseFenceRecoveryAttempted: true;
}

/**
 * Main-only durable orchestration truth for one Codex Desktop authorization.
 * Every external effect has a persisted `*_starting` fence. After process
 * restart, a fence without a recoverable committed successor becomes
 * `indeterminate` instead of replaying the effect.
 */
export class DesktopCodexAuthorizationSessionStore {
  private readonly root: string;
  private readonly safeStorage: SafeStorageLike;
  private readonly now: () => Date;
  private readonly faultInjector?: DesktopCodexAuthorizationSessionStoreOptions["faultInjector"];
  private readonly renameFile: (source: string, target: string) => Promise<void>;
  private readonly syncDirectory: (directory: string) => Promise<boolean>;

  constructor(options: DesktopCodexAuthorizationSessionStoreOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw sessionError("desktop_codex_authorization_unsafe", "Codex 授权恢复目录无效");
    }
    this.safeStorage = options.safeStorage;
    this.now = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
    this.renameFile = options.renameFile ?? rename;
    this.syncDirectory = options.syncDirectory ?? syncDirectory;
  }

  create(
    input: CreateDesktopCodexAuthorizationSessionInput
  ): Promise<DesktopCodexAuthorizationSessionRecord> {
    const initial = validateCreateInput(input);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairPending(initial.sessionId);
      const current = await this.readTarget(initial.sessionId);
      const data = initialData(initial);
      if (current) {
        if (current.generation === 1 && sameData(current, data)) {
          await this.ensureDurableTarget(current);
          return cloneRecord(current);
        }
        throw sessionError(
          "desktop_codex_authorization_conflict",
          "Codex 授权会话已存在"
        );
      }
      const timestamp = canonicalNow(this.now());
      const record = validateRecord({
        version: 1,
        generation: 1,
        ...data,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      await this.writeAtomic(record);
      return cloneRecord(record);
    });
  }

  read(sessionId: string): Promise<DesktopCodexAuthorizationSessionRecord | null> {
    assertSafeId(sessionId);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairPending(sessionId);
      const current = await this.readTarget(sessionId);
      return current ? cloneRecord(current) : null;
    });
  }

  list(): Promise<DesktopCodexAuthorizationSessionRecord[]> {
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      const sessionIds = await this.listSessionIdsLocked();
      const records: DesktopCodexAuthorizationSessionRecord[] = [];
      for (const sessionId of sessionIds) {
        await this.repairPending(sessionId);
        const record = await this.readTarget(sessionId);
        if (record) records.push(cloneRecord(record));
      }
      return records;
    });
  }

  transition(
    expected: DesktopCodexAuthorizationSessionRecord,
    nextData: DesktopCodexAuthorizationSessionData
  ): Promise<DesktopCodexAuthorizationSessionRecord> {
    const expectedRecord = validateRecord(expected);
    const desired = validateData(nextData);
    if (expectedRecord.sessionId !== desired.sessionId) {
      throw sessionError(
        "desktop_codex_authorization_conflict",
        "Codex 授权会话 CAS 目标不匹配"
      );
    }
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairPending(expectedRecord.sessionId);
      return this.transitionLocked(expectedRecord, desired);
    });
  }

  terminalize(
    expected: DesktopCodexAuthorizationSessionRecord,
    status: DesktopCodexAuthorizationTerminalStatus,
    localFailureCode: string | null = null
  ): Promise<DesktopCodexAuthorizationSessionRecord> {
    const current = validateRecord(expected);
    if (!isTerminalStatus(status)) {
      throw sessionError(
        "desktop_codex_authorization_unsafe",
        "Codex 授权终态无效"
      );
    }
    const failureCode = terminalFailureCode(status, localFailureCode);
    return this.transition(current, {
      ...desktopCodexAuthorizationSessionData(current),
      status,
      claimToken: null,
      activationToken: null,
      localFailureCode: failureCode
    });
  }

  /**
   * Final startup step only. The future orchestrator MUST first inspect/replay
   * the exact outbound journal for claim/proof/ACK, reconcile the dedicated
   * DesktopActivationLeaseFenceStore, and persist any recovered successor.
   * This store retains immutable token expiries; evolving latestRenewedAt and
   * latestLeaseExpiresAt deliberately remain in that dedicated lease fence.
   * Calling this before both attempts could destroy a replayable network-effect
   * fence, so a runtime ordering credential is mandatory.
   * Filesystem commit repair runs first; only a still-unresolved effect fence
   * is then terminalized as indeterminate.
   */
  recover(
    sessionId: string,
    attempt: DesktopCodexRecoveryPrerequisites
  ): Promise<DesktopCodexAuthorizationSessionRecord | null> {
    assertSafeId(sessionId);
    assertOutboundJournalRecoveryAttempt(attempt);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairPending(sessionId);
      const current = await this.readTarget(sessionId);
      if (!current || !effectOutcomeUnknown(current)) {
        return current ? cloneRecord(current) : null;
      }
      return this.transitionLocked(current, {
        ...desktopCodexAuthorizationSessionData(current),
        status: "indeterminate",
        claimToken: null,
        activationToken: null,
        localFailureCode: INDETERMINATE_FAILURE_CODE
      });
    });
  }

  /** Same ordering contract as recover; never call before journal reconciliation. */
  recoverAll(
    attempt: DesktopCodexRecoveryPrerequisites
  ): Promise<DesktopCodexAuthorizationSessionRecord[]> {
    assertOutboundJournalRecoveryAttempt(attempt);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      const recovered: DesktopCodexAuthorizationSessionRecord[] = [];
      for (const sessionId of await this.listSessionIdsLocked()) {
        await this.repairPending(sessionId);
        const current = await this.readTarget(sessionId);
        if (!current) continue;
        if (effectOutcomeUnknown(current)) {
          recovered.push(
            await this.transitionLocked(current, {
              ...desktopCodexAuthorizationSessionData(current),
              status: "indeterminate",
              claimToken: null,
              activationToken: null,
              localFailureCode: INDETERMINATE_FAILURE_CODE
            })
          );
        } else {
          recovered.push(cloneRecord(current));
        }
      }
      return recovered;
    });
  }

  async snapshot(sessionId: string): Promise<CodexAuthorizationSnapshot | null> {
    const record = await this.read(sessionId);
    return record ? projectDesktopCodexAuthorizationSnapshot(record) : null;
  }

  private async transitionLocked(
    expected: DesktopCodexAuthorizationSessionRecord,
    desired: DesktopCodexAuthorizationSessionData
  ): Promise<DesktopCodexAuthorizationSessionRecord> {
    const current = await this.readTarget(expected.sessionId);
    if (
      current &&
      current.generation === expected.generation + 1 &&
      sameData(current, desired) &&
      validSuccessor(expected, current)
    ) {
      await this.ensureDurableTarget(current);
      return cloneRecord(current);
    }
    if (!current || !sameRecord(current, expected)) {
      throw sessionError(
        "desktop_codex_authorization_conflict",
        "Codex 授权会话 CAS 已过期"
      );
    }
    const generation = current.generation + 1;
    if (!Number.isSafeInteger(generation)) {
      throw sessionError(
        "desktop_codex_authorization_conflict",
        "Codex 授权会话代次已耗尽"
      );
    }
    const next = validateRecord({
      version: 1,
      generation,
      ...desired,
      createdAt: current.createdAt,
      updatedAt: canonicalNow(this.now())
    });
    if (!validSuccessor(current, next)) {
      throw sessionError(
        "desktop_codex_authorization_conflict",
        "Codex 授权状态迁移无效"
      );
    }
    await this.writeAtomic(next);
    return cloneRecord(next);
  }

  private async writeAtomic(record: DesktopCodexAuthorizationSessionRecord): Promise<void> {
    const validated = validateRecord(record);
    await this.ensureCommitMarker(validated);
    await this.faultInjector?.("after_commit_shadow_fsync");
    await this.ensureTemporary(validated);
    await this.faultInjector?.("after_temporary_fsync");
    await this.replaceWithRetry(
      this.temporary(validated.sessionId),
      this.target(validated.sessionId)
    );
    await this.faultInjector?.("after_rename");
    await this.finishDurability(validated, true);
  }

  private async repairPending(sessionId: string): Promise<void> {
    const target = await this.readTarget(sessionId);
    const commits = await this.readCommitStates(sessionId);
    const temporary = await this.readPath(this.temporary(sessionId), sessionId, true);
    if (commits.length === 0 && temporary === null) return;

    const candidates = new Map<number, DesktopCodexAuthorizationSessionRecord>();
    for (const commit of commits) addRecoveryState(candidates, commit.record);
    if (temporary) addRecoveryState(candidates, temporary);
    const ordered = [...candidates.values()].sort(
      (left, right) => left.generation - right.generation
    );

    let recovered: DesktopCodexAuthorizationSessionRecord | null = null;
    if (target === null) {
      if (ordered.length !== 1 || ordered[0]?.generation !== 1) {
        throw sessionError(
          "desktop_codex_authorization_corrupt",
          "Codex 授权恢复缺少前代状态"
        );
      }
      recovered = ordered[0] ?? null;
    } else {
      const sameGeneration = candidates.get(target.generation);
      if (sameGeneration && !sameRecord(sameGeneration, target)) {
        throw sessionError(
          "desktop_codex_authorization_corrupt",
          "Codex 授权同代恢复状态冲突"
        );
      }
      let cursor = target;
      for (const candidate of ordered) {
        if (candidate.generation <= cursor.generation) continue;
        if (!validSuccessor(cursor, candidate)) {
          throw sessionError(
            "desktop_codex_authorization_corrupt",
            "Codex 授权恢复代次冲突"
          );
        }
        cursor = candidate;
      }
      if (cursor.generation > target.generation) recovered = cursor;
    }

    if (recovered) {
      await this.ensureCommitMarker(recovered);
      await this.ensureTemporary(recovered);
      await this.replaceWithRetry(this.temporary(sessionId), this.target(sessionId));
      await this.finishDurability(recovered, false);
      return;
    }
    if (target) await this.finishDurability(target, false);
  }

  private ensureDurableTarget(record: DesktopCodexAuthorizationSessionRecord): Promise<void> {
    return this.finishDurability(record, false);
  }

  private async finishDurability(
    record: DesktopCodexAuthorizationSessionRecord,
    injectFaults: boolean
  ): Promise<void> {
    await this.syncRegularFile(this.target(record.sessionId));
    const verified = await this.readTarget(record.sessionId);
    if (!verified || !sameRecord(verified, record)) {
      throw sessionError(
        "desktop_codex_authorization_corrupt",
        "Codex 授权替换结果不匹配"
      );
    }
    if (injectFaults) await this.faultInjector?.("before_directory_fsync");
    const directoryDurable = await this.syncDirectory(this.root);
    const commits = await this.readCommitStates(record.sessionId);
    await rm(this.temporary(record.sessionId), { force: true });
    if (directoryDurable) {
      for (const commit of commits) await rm(commit.file, { force: true });
      const cleanupDurable = await this.syncDirectory(this.root);
      if (!cleanupDurable) {
        await this.ensureCommitMarker(record);
        await this.syncRegularFile(this.commit(record.sessionId, record.generation));
      }
      return;
    }

    await this.ensureCommitMarker(record);
    await this.syncRegularFile(this.commit(record.sessionId, record.generation));
    for (const commit of commits) {
      if (commit.record.generation !== record.generation) await rm(commit.file, { force: true });
    }
  }

  private async ensureCommitMarker(record: DesktopCodexAuthorizationSessionRecord): Promise<void> {
    const file = this.commit(record.sessionId, record.generation);
    const existing = await this.readPath(file, record.sessionId, true);
    if (existing) {
      if (!sameRecord(existing, record)) {
        throw sessionError(
          "desktop_codex_authorization_corrupt",
          "Codex 授权提交影子冲突"
        );
      }
      return;
    }
    await this.writeEnvelopeExclusive(file, record);
  }

  private async ensureTemporary(record: DesktopCodexAuthorizationSessionRecord): Promise<void> {
    const temporary = this.temporary(record.sessionId);
    const existing = await this.readPath(temporary, record.sessionId, true);
    if (existing && sameRecord(existing, record)) return;
    if (existing) await rm(temporary);
    await this.writeEnvelopeExclusive(temporary, record);
  }

  private async writeEnvelopeExclusive(
    file: string,
    record: DesktopCodexAuthorizationSessionRecord
  ): Promise<void> {
    const envelope = this.encryptEnvelope(record);
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
      await handle.writeFile(envelope);
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  }

  private encryptEnvelope(record: DesktopCodexAuthorizationSessionRecord): Buffer {
    let encrypted: Buffer;
    try {
      encrypted = this.safeStorage.encryptString(JSON.stringify(validateRecord(record)));
    } catch {
      throw sessionError(
        "desktop_secure_storage_unavailable",
        "Codex 授权恢复状态加密失败"
      );
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.byteLength < 1) {
      throw sessionError(
        "desktop_secure_storage_unavailable",
        "Codex 授权恢复状态密文无效"
      );
    }
    const envelope = Buffer.concat([ENVELOPE_MAGIC, encrypted]);
    if (envelope.byteLength > MAX_FILE_BYTES) {
      throw sessionError(
        "desktop_codex_authorization_unsafe",
        "Codex 授权恢复状态超过安全上限"
      );
    }
    return envelope;
  }

  private async readCommitStates(
    sessionId: string
  ): Promise<Array<{ file: string; record: DesktopCodexAuthorizationSessionRecord }>> {
    const prefix = `${sessionId}.sec`;
    const children = await readdir(this.root, { withFileTypes: true });
    const commits: Array<{ file: string; record: DesktopCodexAuthorizationSessionRecord }> = [];
    for (const child of children) {
      if (!child.name.startsWith(`${prefix}.commit`)) continue;
      if (!child.isFile() || child.isSymbolicLink()) {
        throw sessionError(
          "desktop_codex_authorization_unsafe",
          "Codex 授权提交影子不安全"
        );
      }
      const match = COMMIT_SUFFIX.exec(child.name.slice(prefix.length));
      const generation = match ? Number(match[1]) : Number.NaN;
      if (!Number.isSafeInteger(generation)) {
        throw sessionError(
          "desktop_codex_authorization_unsafe",
          "Codex 授权提交影子无效"
        );
      }
      const file = path.join(this.root, child.name);
      const record = await this.readPath(file, sessionId);
      if (!record || record.generation !== generation) {
        throw sessionError(
          "desktop_codex_authorization_corrupt",
          "Codex 授权提交影子代次不匹配"
        );
      }
      commits.push({ file, record });
    }
    return commits.sort((left, right) => left.record.generation - right.record.generation);
  }

  private async listSessionIdsLocked(): Promise<string[]> {
    const children = await readdir(this.root, { withFileTypes: true });
    const sessionIds = new Set<string>();
    for (const child of children) {
      if (!child.isFile() || child.isSymbolicLink()) {
        throw sessionError(
          "desktop_codex_authorization_unsafe",
          "Codex 授权恢复目录含非法条目"
        );
      }
      const match = /^([A-Za-z0-9_-]{1,160})\.sec(?:\.tmp|\.commit-[1-9][0-9]{0,15})?$/.exec(
        child.name
      );
      if (!match?.[1]) {
        throw sessionError(
          "desktop_codex_authorization_unsafe",
          "Codex 授权恢复目录含未知文件"
        );
      }
      sessionIds.add(match[1]);
    }
    return [...sessionIds].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    );
  }

  private async syncRegularFile(file: string): Promise<void> {
    const pathInfo = await lstat(file);
    assertSafeFile(pathInfo);
    const flags =
      fsConstants.O_RDWR | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    let handle;
    try {
      handle = await open(file, flags);
      const before = await handle.stat();
      assertSafeFile(before);
      if (before.dev !== pathInfo.dev || before.ino !== pathInfo.ino) {
        throw sessionError(
          "desktop_codex_authorization_corrupt",
          "Codex 授权持久化目标已变化"
        );
      }
      await handle.sync();
      const after = await handle.stat();
      assertStableFile(before, after);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private readTarget(
    sessionId: string
  ): Promise<DesktopCodexAuthorizationSessionRecord | null> {
    return this.readPath(this.target(sessionId), sessionId, true);
  }

  private async readPath(
    file: string,
    expectedSessionId: string,
    missingAllowed = false
  ): Promise<DesktopCodexAuthorizationSessionRecord | null> {
    let pathInfo;
    try {
      pathInfo = await lstat(file);
    } catch (error) {
      if (missingAllowed && isErrorCode(error, "ENOENT")) return null;
      throw sessionError(
        "desktop_codex_authorization_corrupt",
        "Codex 授权恢复状态无法读取"
      );
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
      assertStableFile(before, after);
      if (
        before.dev !== pathInfo.dev ||
        before.ino !== pathInfo.ino ||
        raw.byteLength !== before.size ||
        !raw.subarray(0, ENVELOPE_MAGIC.byteLength).equals(ENVELOPE_MAGIC)
      ) {
        throw sessionError(
          "desktop_codex_authorization_corrupt",
          "Codex 授权恢复封套不稳定"
        );
      }
      const plaintext = this.safeStorage.decryptString(
        raw.subarray(ENVELOPE_MAGIC.byteLength)
      );
      const record = validateRecord(JSON.parse(plaintext) as unknown);
      if (record.sessionId !== expectedSessionId) {
        throw sessionError(
          "desktop_codex_authorization_corrupt",
          "Codex 授权恢复状态归属不匹配"
        );
      }
      return record;
    } catch (error) {
      if (error instanceof DesktopCodexAuthorizationSessionStoreError) throw error;
      throw sessionError(
        "desktop_codex_authorization_corrupt",
        "Codex 授权恢复状态无法解密"
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async replaceWithRetry(source: string, target: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.renameFile(source, target);
        return;
      } catch (error) {
        if (
          attempt >= RENAME_RETRY_DELAYS_MS.length ||
          !["EACCES", "EBUSY", "EPERM"].some((code) => isErrorCode(error, code))
        ) {
          throw error;
        }
        await delay(RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" && (info.mode & 0o777) !== 0o700)
    ) {
      throw sessionError(
        "desktop_codex_authorization_unsafe",
        "Codex 授权恢复目录不安全"
      );
    }
    if (process.platform !== "win32") await chmod(this.root, 0o700);
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
      throw sessionError(
        "desktop_secure_storage_unavailable",
        "系统安全存储不可用"
      );
    }
  }

  private target(sessionId: string): string {
    return path.join(this.root, `${sessionId}.sec`);
  }

  private temporary(sessionId: string): string {
    return path.join(this.root, `${sessionId}.sec.tmp`);
  }

  private commit(sessionId: string, generation: number): string {
    return path.join(this.root, `${sessionId}.sec.commit-${generation}`);
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

export function desktopCodexAuthorizationSessionData(
  record: DesktopCodexAuthorizationSessionRecord
): DesktopCodexAuthorizationSessionData {
  const value = validateRecord(record);
  return cloneData(value);
}

export function projectDesktopCodexAuthorizationSnapshot(
  record: DesktopCodexAuthorizationSessionRecord
): CodexAuthorizationSnapshot {
  const value = validateRecord(record);
  const status = snapshotStatus(value.status);
  const projection: CodexAuthorizationSnapshot = {
    sessionId: value.sessionId,
    executorId: value.executorId,
    sequence: value.generation,
    status,
    canReopen: value.status === "waiting_user",
    canCancel: isProgressStatus(value.status) && value.status !== "activation_acked"
  };
  if (value.localFailureCode !== null) {
    projection.localFailureCode = value.localFailureCode;
  }
  return projection;
}

function validateCreateInput(
  value: unknown
): CreateDesktopCodexAuthorizationSessionInput {
  if (!exactObject(value, ["sessionId", "executorId", "deviceId", "handoffId", "sessionRevision"])) {
    throw sessionError(
      "desktop_codex_authorization_unsafe",
      "Codex 授权初始状态结构无效"
    );
  }
  const input = value as unknown as CreateDesktopCodexAuthorizationSessionInput;
  if (
    !SAFE_ID.test(input.sessionId) ||
    !SAFE_ID.test(input.executorId) ||
    !DEVICE_ID.test(input.deviceId) ||
    !SAFE_ID.test(input.handoffId) ||
    !positiveRevision(input.sessionRevision)
  ) {
    throw sessionError(
      "desktop_codex_authorization_unsafe",
      "Codex 授权初始状态字段无效"
    );
  }
  return { ...input };
}

function initialData(
  input: CreateDesktopCodexAuthorizationSessionInput
): DesktopCodexAuthorizationSessionData {
  return {
    status: "accepted",
    lastProgressStatus: "accepted",
    ...input,
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

const DATA_KEYS = [
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
  "localFailureCode"
] as const;

const RECORD_KEYS = ["version", "generation", ...DATA_KEYS, "createdAt", "updatedAt"] as const;

function validateRecord(value: unknown): DesktopCodexAuthorizationSessionRecord {
  if (!exactObject(value, RECORD_KEYS)) {
    throw sessionError(
      "desktop_codex_authorization_corrupt",
      "Codex 授权恢复状态结构无效"
    );
  }
  const record = value as unknown as DesktopCodexAuthorizationSessionRecord;
  if (
    record.version !== 1 ||
    !positiveRevision(record.generation) ||
    !canonicalTime(record.createdAt) ||
    !canonicalTime(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt)
  ) {
    throw sessionError(
      "desktop_codex_authorization_corrupt",
      "Codex 授权恢复元数据无效"
    );
  }
  validateData(record, "desktop_codex_authorization_corrupt");
  return cloneRecord(record);
}

function validateData(
  value: unknown,
  code: DesktopCodexAuthorizationSessionStoreErrorCode = "desktop_codex_authorization_unsafe"
): DesktopCodexAuthorizationSessionData {
  if (!hasDataShape(value)) {
    throw sessionError(code, "Codex 授权恢复元组结构无效");
  }
  const data = value as unknown as DesktopCodexAuthorizationSessionData;
  if (
    !isSessionStatus(data.status) ||
    !isProgressStatus(data.lastProgressStatus) ||
    (!isTerminalStatus(data.status) && data.lastProgressStatus !== data.status) ||
    !SAFE_ID.test(data.sessionId) ||
    !SAFE_ID.test(data.executorId) ||
    !DEVICE_ID.test(data.deviceId) ||
    !SAFE_ID.test(data.handoffId) ||
    !positiveRevision(data.sessionRevision) ||
    !nullableDigest(data.claimRequestReference) ||
    !nullableDigest(data.claimRequestHash) ||
    !nullableTicket(data.claimToken) ||
    !nullableCanonicalTime(data.claimExpiresAt) ||
    !nullableDigest(data.loginIdHash) ||
    !nullableDigest(data.accountFingerprint) ||
    !nullableDigest(data.candidateBindingDigest) ||
    !nullableDigest(data.proofRequestReference) ||
    !nullableDigest(data.proofRequestHash) ||
    !nullableSafeId(data.proofId) ||
    !nullableSafeId(data.activationOperationId) ||
    !nullableSafeId(data.activationId) ||
    !nullableTicket(data.activationToken) ||
    !nullableCanonicalTime(data.activationExpiresAt) ||
    !nullablePositiveRevision(data.credentialRevision) ||
    !nullablePositiveRevision(data.leaseEpoch) ||
    !nullableNonNegativeRevision(data.sourceCredentialRevision) ||
    !nullableNonNegativeRevision(data.revocationEpoch) ||
    !nullableDigest(data.bindingDigest) ||
    !nullableDigest(data.ackRequestReference) ||
    !nullableDigest(data.ackRequestHash) ||
    !nullableFailureCode(data.localFailureCode) ||
    !validPromotionReceipt(data.promotionReceipt, data.executorId)
  ) {
    throw sessionError(code, "Codex 授权恢复元组字段无效");
  }
  if (!validStatusShape(data)) {
    throw sessionError(code, "Codex 授权恢复阶段字段无效");
  }
  return cloneData(data);
}

function hasDataShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).filter(
    (key) => key !== "version" && key !== "generation" && key !== "createdAt" && key !== "updatedAt"
  );
  const expected = [...DATA_KEYS].sort();
  actual.sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validStatusShape(data: DesktopCodexAuthorizationSessionData): boolean {
  const progress = data.lastProgressStatus;
  const index = progressIndex(progress);
  const terminal = isTerminalStatus(data.status);
  if (terminal) {
    if (data.claimToken !== null || data.activationToken !== null) return false;
    if (data.status === "indeterminate" && data.localFailureCode !== INDETERMINATE_FAILURE_CODE) {
      return false;
    }
    if (
      (data.status === "failed" || data.status === "interrupted") &&
      data.localFailureCode === null
    ) {
      return false;
    }
  } else if (data.localFailureCode !== null) {
    return false;
  }

  if (!pairAt(data.claimRequestReference, data.claimRequestHash, index >= 1)) return false;
  if ((data.claimExpiresAt !== null) !== (index >= 2)) return false;
  if (!tripleAt(data.loginIdHash, data.accountFingerprint, data.candidateBindingDigest, index >= 7)) {
    return false;
  }
  if (!pairAt(data.proofRequestReference, data.proofRequestHash, index >= 8)) return false;
  const activationExpected = index >= 9;
  if (
    !allAt(
      [
        data.proofId,
        data.activationOperationId,
        data.activationId,
        data.credentialRevision,
        data.leaseEpoch,
        data.sourceCredentialRevision,
        data.revocationEpoch,
        data.bindingDigest
      ],
      activationExpected
    )
  ) {
    return false;
  }
  if (
    activationExpected &&
    data.credentialRevision !== null &&
    data.sourceCredentialRevision !== null &&
    (data.sourceCredentialRevision >= data.credentialRevision ||
      data.bindingDigest !== data.candidateBindingDigest)
  ) {
    return false;
  }
  if ((data.promotionReceipt !== null) !== (index >= 12)) return false;
  if ((data.activationExpiresAt !== null) !== activationExpected) return false;
  if (
    data.promotionReceipt !== null &&
    (data.promotionReceipt.revision !== data.credentialRevision ||
      data.promotionReceipt.operationId !== data.activationOperationId ||
      data.promotionReceipt.digest !== data.bindingDigest)
  ) {
    return false;
  }
  if (!pairAt(data.ackRequestReference, data.ackRequestHash, index >= 14)) return false;

  if (!terminal) {
    // Claim and activation credentials remain available through the durable
    // ACK-response fence. Only a durable local success/terminal generation may
    // erase them, closing the response-returned/local-commit crash window.
    const claimTokenExpected = index >= 2 && index <= 14;
    const activationTokenExpected = index >= 9 && index <= 14;
    if ((data.claimToken !== null) !== claimTokenExpected) return false;
    if ((data.activationToken !== null) !== activationTokenExpected) return false;
  }
  return true;
}

function validSuccessor(
  current: DesktopCodexAuthorizationSessionRecord,
  next: DesktopCodexAuthorizationSessionRecord
): boolean {
  if (
    current.version !== 1 ||
    next.version !== 1 ||
    next.generation !== current.generation + 1 ||
    next.sessionId !== current.sessionId ||
    next.executorId !== current.executorId ||
    next.deviceId !== current.deviceId ||
    next.handoffId !== current.handoffId ||
    next.createdAt !== current.createdAt ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    next.sessionRevision < current.sessionRevision ||
    isTerminalStatus(current.status) ||
    current.status === "activation_acked" ||
    !monotonicRecoveryTuple(current, next)
  ) {
    return false;
  }

  if (isTerminalStatus(next.status)) {
    return (
      next.lastProgressStatus === current.lastProgressStatus &&
      next.claimToken === null &&
      next.activationToken === null
    );
  }
  const currentIndex = progressIndex(current.lastProgressStatus);
  const nextIndex = progressIndex(next.status);
  return (
    current.status === current.lastProgressStatus &&
    next.lastProgressStatus === next.status &&
    nextIndex === currentIndex + 1
  );
}

function monotonicRecoveryTuple(
  current: DesktopCodexAuthorizationSessionRecord,
  next: DesktopCodexAuthorizationSessionRecord
): boolean {
  return (
    monotonicOptional(current.claimRequestReference, next.claimRequestReference) &&
    monotonicOptional(current.claimRequestHash, next.claimRequestHash) &&
    tokenProgression(current.claimToken, next.claimToken, next) &&
    monotonicOptional(current.claimExpiresAt, next.claimExpiresAt) &&
    monotonicOptional(current.loginIdHash, next.loginIdHash) &&
    monotonicOptional(current.accountFingerprint, next.accountFingerprint) &&
    monotonicOptional(current.candidateBindingDigest, next.candidateBindingDigest) &&
    monotonicOptional(current.proofRequestReference, next.proofRequestReference) &&
    monotonicOptional(current.proofRequestHash, next.proofRequestHash) &&
    monotonicOptional(current.proofId, next.proofId) &&
    monotonicOptional(current.activationOperationId, next.activationOperationId) &&
    monotonicOptional(current.activationId, next.activationId) &&
    activationTokenProgression(current.activationToken, next.activationToken, next) &&
    monotonicOptional(current.activationExpiresAt, next.activationExpiresAt) &&
    monotonicOptional(current.credentialRevision, next.credentialRevision) &&
    monotonicOptional(current.leaseEpoch, next.leaseEpoch) &&
    monotonicOptional(current.sourceCredentialRevision, next.sourceCredentialRevision) &&
    monotonicOptional(current.revocationEpoch, next.revocationEpoch) &&
    monotonicOptional(current.bindingDigest, next.bindingDigest) &&
    monotonicReceipt(current.promotionReceipt, next.promotionReceipt) &&
    monotonicOptional(current.ackRequestReference, next.ackRequestReference) &&
    monotonicOptional(current.ackRequestHash, next.ackRequestHash)
  );
}

function tokenProgression(
  current: string | null,
  next: string | null,
  nextRecord: DesktopCodexAuthorizationSessionRecord
): boolean {
  if (current === next) return true;
  if (current === null && next !== null) {
    return nextRecord.status === "handoff_claimed";
  }
  return (
    current !== null &&
    next === null &&
    (isTerminalStatus(nextRecord.status) || nextRecord.status === "activation_acked")
  );
}

function activationTokenProgression(
  current: string | null,
  next: string | null,
  nextRecord: DesktopCodexAuthorizationSessionRecord
): boolean {
  if (current === next) return true;
  if (current === null && next !== null) return nextRecord.status === "proof_prepared";
  return (
    current !== null &&
    next === null &&
    (isTerminalStatus(nextRecord.status) || nextRecord.status === "activation_acked")
  );
}

function projectTerminalFailureCode(
  status: DesktopCodexAuthorizationTerminalStatus,
  value: string | null
): string | null {
  if (status === "indeterminate") return INDETERMINATE_FAILURE_CODE;
  if ((status === "failed" || status === "interrupted") && value === null) {
    throw sessionError(
      "desktop_codex_authorization_unsafe",
      "Codex 授权失败终态缺少安全错误码"
    );
  }
  if (!nullableFailureCode(value)) {
    throw sessionError(
      "desktop_codex_authorization_unsafe",
      "Codex 授权终态错误码无效"
    );
  }
  return value;
}

function terminalFailureCode(
  status: DesktopCodexAuthorizationTerminalStatus,
  value: string | null
): string | null {
  return projectTerminalFailureCode(status, value);
}

function effectOutcomeUnknown(record: DesktopCodexAuthorizationSessionRecord): boolean {
  return !isTerminalStatus(record.status) && EFFECT_STARTING.has(record.status);
}

function snapshotStatus(
  status: DesktopCodexAuthorizationSessionStatus
): CodexAuthorizationSnapshot["status"] {
  if (status === "activation_acked") return "succeeded";
  if (status === "failed" || status === "cancelled" || status === "expired" || status === "interrupted") {
    return status;
  }
  if (status === "indeterminate") return "interrupted";
  const index = progressIndex(status);
  if (index <= 5) return "starting";
  if (index <= 6) return "waiting_user";
  return "verifying";
}

function progressIndex(status: DesktopCodexAuthorizationProgressStatus): number {
  return DESKTOP_CODEX_AUTHORIZATION_PROGRESS.indexOf(status);
}

function isProgressStatus(value: unknown): value is DesktopCodexAuthorizationProgressStatus {
  return (DESKTOP_CODEX_AUTHORIZATION_PROGRESS as readonly unknown[]).includes(value);
}

function isTerminalStatus(value: unknown): value is DesktopCodexAuthorizationTerminalStatus {
  return (DESKTOP_CODEX_AUTHORIZATION_TERMINAL as readonly unknown[]).includes(value);
}

function isSessionStatus(value: unknown): value is DesktopCodexAuthorizationSessionStatus {
  return isProgressStatus(value) || isTerminalStatus(value);
}

function validPromotionReceipt(
  value: DesktopCodexCredentialPromotionReceipt | null,
  executorId: string
): boolean {
  if (value === null) return true;
  return (
    exactObject(value, [
      "executorId",
      "revision",
      "operationId",
      "digestAlgorithm",
      "digest",
      "fileCount",
      "totalBytes"
    ]) &&
    value.executorId === executorId &&
    positiveRevision(value.revision) &&
    SAFE_ID.test(value.operationId) &&
    value.digestAlgorithm === DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM &&
    DIGEST.test(value.digest) &&
    nonNegativeRevision(value.fileCount) &&
    nonNegativeRevision(value.totalBytes)
  );
}

function monotonicReceipt(
  current: DesktopCodexCredentialPromotionReceipt | null,
  next: DesktopCodexCredentialPromotionReceipt | null
): boolean {
  if (current === null) return next === null || validPromotionReceipt(next, next.executorId);
  return next !== null && sameReceipt(current, next);
}

function sameReceipt(
  left: DesktopCodexCredentialPromotionReceipt,
  right: DesktopCodexCredentialPromotionReceipt
): boolean {
  return (
    left.executorId === right.executorId &&
    left.revision === right.revision &&
    left.operationId === right.operationId &&
    left.digestAlgorithm === right.digestAlgorithm &&
    left.digest === right.digest &&
    left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes
  );
}

function sameRecord(
  left: DesktopCodexAuthorizationSessionRecord,
  right: DesktopCodexAuthorizationSessionRecord
): boolean {
  return (
    left.version === right.version &&
    left.generation === right.generation &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    sameData(left, right)
  );
}

function sameData(
  left: DesktopCodexAuthorizationSessionData,
  right: DesktopCodexAuthorizationSessionData
): boolean {
  for (const key of DATA_KEYS) {
    if (key === "promotionReceipt") continue;
    if (left[key] !== right[key]) return false;
  }
  return (
    (left.promotionReceipt === null && right.promotionReceipt === null) ||
    (left.promotionReceipt !== null &&
      right.promotionReceipt !== null &&
      sameReceipt(left.promotionReceipt, right.promotionReceipt))
  );
}

function cloneData(
  value: DesktopCodexAuthorizationSessionData
): DesktopCodexAuthorizationSessionData {
  const data: DesktopCodexAuthorizationSessionData = {
    status: value.status,
    lastProgressStatus: value.lastProgressStatus,
    sessionId: value.sessionId,
    executorId: value.executorId,
    deviceId: value.deviceId,
    handoffId: value.handoffId,
    sessionRevision: value.sessionRevision,
    claimRequestReference: value.claimRequestReference,
    claimRequestHash: value.claimRequestHash,
    claimToken: value.claimToken,
    claimExpiresAt: value.claimExpiresAt,
    loginIdHash: value.loginIdHash,
    accountFingerprint: value.accountFingerprint,
    candidateBindingDigest: value.candidateBindingDigest,
    proofRequestReference: value.proofRequestReference,
    proofRequestHash: value.proofRequestHash,
    proofId: value.proofId,
    activationOperationId: value.activationOperationId,
    activationId: value.activationId,
    activationToken: value.activationToken,
    activationExpiresAt: value.activationExpiresAt,
    credentialRevision: value.credentialRevision,
    leaseEpoch: value.leaseEpoch,
    sourceCredentialRevision: value.sourceCredentialRevision,
    revocationEpoch: value.revocationEpoch,
    bindingDigest: value.bindingDigest,
    promotionReceipt: value.promotionReceipt ? { ...value.promotionReceipt } : null,
    ackRequestReference: value.ackRequestReference,
    ackRequestHash: value.ackRequestHash,
    localFailureCode: value.localFailureCode
  };
  return data;
}

function cloneRecord(
  value: DesktopCodexAuthorizationSessionRecord
): DesktopCodexAuthorizationSessionRecord {
  return {
    version: 1,
    generation: value.generation,
    ...cloneData(value),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function addRecoveryState(
  states: Map<number, DesktopCodexAuthorizationSessionRecord>,
  candidate: DesktopCodexAuthorizationSessionRecord
): void {
  const existing = states.get(candidate.generation);
  if (existing && !sameRecord(existing, candidate)) {
    throw sessionError(
      "desktop_codex_authorization_corrupt",
      "Codex 授权同代恢复状态冲突"
    );
  }
  states.set(candidate.generation, candidate);
}

function pairAt(left: unknown, right: unknown, expected: boolean): boolean {
  return (left !== null && right !== null) === expected && (left === null) === (right === null);
}

function tripleAt(first: unknown, second: unknown, third: unknown, expected: boolean): boolean {
  const present = first !== null && second !== null && third !== null;
  const absent = first === null && second === null && third === null;
  return expected ? present : absent;
}

function allAt(values: readonly unknown[], expected: boolean): boolean {
  return expected ? values.every((value) => value !== null) : values.every((value) => value === null);
}

function monotonicOptional<T>(current: T | null, next: T | null): boolean {
  return current === null ? true : next === current;
}

function nullableDigest(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DIGEST.test(value));
}

function nullableTicket(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length <= 8192 && COMPACT_JWS.test(value))
  );
}

function nullableSafeId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SAFE_ID.test(value));
}

function nullableFailureCode(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SAFE_CODE.test(value));
}

function nullableCanonicalTime(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && canonicalTime(value));
}

function nullablePositiveRevision(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && positiveRevision(value));
}

function nullableNonNegativeRevision(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && nonNegativeRevision(value));
}

function positiveRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalNow(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw sessionError(
      "desktop_codex_authorization_unsafe",
      "Codex 授权恢复时间无效"
    );
  }
  return value.toISOString();
}

function canonicalTime(value: string): boolean {
  if (typeof value !== "string" || !CANONICAL_UTC.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertSafeId(value: string): void {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw sessionError(
      "desktop_codex_authorization_unsafe",
      "Codex 授权会话标识无效"
    );
  }
}

function assertOutboundJournalRecoveryAttempt(
  value: DesktopCodexRecoveryPrerequisites
): void {
  if (
    !exactObject(value, [
      "exactOutboundJournalRecoveryAttempted",
      "activationLeaseFenceRecoveryAttempted"
    ]) ||
    value.exactOutboundJournalRecoveryAttempted !== true ||
    value.activationLeaseFenceRecoveryAttempted !== true
  ) {
    throw sessionError(
      "desktop_codex_authorization_unsafe",
      "Codex 授权 outbound journal 或 lease fence 尚未完成恢复尝试"
    );
  }
}

function assertSafeFile(info: Stats): void {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < ENVELOPE_MAGIC.byteLength + 1 ||
    info.size > MAX_FILE_BYTES ||
    (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)
  ) {
    throw sessionError(
      "desktop_codex_authorization_unsafe",
      "Codex 授权恢复文件不安全"
    );
  }
}

function assertStableFile(before: Stats, after: Stats): void {
  assertSafeFile(after);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw sessionError(
      "desktop_codex_authorization_corrupt",
      "Codex 授权恢复文件读取不稳定"
    );
  }
}

async function syncDirectory(directory: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
    return true;
  } catch (error) {
    if (process.platform === "win32" && isUnsupportedDirectorySync(error)) return false;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return isErrorCode(error, "EINVAL") || isErrorCode(error, "EPERM") || isErrorCode(error, "ENOTSUP");
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sessionError(
  code: DesktopCodexAuthorizationSessionStoreErrorCode,
  message: string
): DesktopCodexAuthorizationSessionStoreError {
  return new DesktopCodexAuthorizationSessionStoreError(code, message);
}
