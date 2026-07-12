import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  DesktopTrustedTransportResult,
  RenewDesktopCredentialActivationLeaseInput,
  RenewDesktopCredentialActivationLeaseResponse
} from "./desktop-authorization-transport-client.ts";
import type {
  DesktopActivationLeaseFenceStore as DesktopActivationLeaseFenceStoreContract
} from "./desktop-activation-lease-controller.ts";
import type { SafeStorageLike } from "./desktop-device-identity.ts";

const ENVELOPE_MAGIC = Buffer.from("AICRM-ACTIVATION-LEASE-FENCE-ENC-V1\n", "ascii");
const MAX_FILE_BYTES = 64 << 10;
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const COMMIT_SUFFIX = /^\.commit-([1-9][0-9]{0,15})$/;
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100] as const;
const MAX_ROOT_ENTRIES = 4096;
const rootTails = new Map<string, Promise<void>>();

type RenewalResult = DesktopTrustedTransportResult<RenewDesktopCredentialActivationLeaseResponse>;

export type DesktopActivationLeaseFenceStatus = "fresh" | "recovery_required" | "removed";

export interface DesktopActivationLeaseFenceRecord {
  version: 1;
  generation: number;
  status: DesktopActivationLeaseFenceStatus;
  semanticKey: string;
  sessionId: string;
  executorId: string;
  operationId: string;
  activationId: string;
  credentialRevision: number;
  leaseEpoch: number;
  sourceCredentialRevision: number;
  revocationEpoch: number;
  bindingDigest: string;
  tokenHash: string;
  requestReference: string;
  requestHash: string;
  renewedAt: string;
  leaseExpiresAt: string;
  replayed: boolean;
  recovered: boolean;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
}

interface DesktopActivationLeaseFenceData {
  semanticKey: string;
  sessionId: string;
  executorId: string;
  operationId: string;
  activationId: string;
  credentialRevision: number;
  leaseEpoch: number;
  sourceCredentialRevision: number;
  revocationEpoch: number;
  bindingDigest: string;
  tokenHash: string;
  requestReference: string;
  requestHash: string;
  renewedAt: string;
  leaseExpiresAt: string;
  replayed: boolean;
  recovered: boolean;
}

export type DesktopActivationLeaseFenceStoreErrorCode =
  | "desktop_activation_lease_fence_conflict"
  | "desktop_activation_lease_fence_corrupt"
  | "desktop_activation_lease_fence_unsafe"
  | "desktop_secure_storage_unavailable";

export class DesktopActivationLeaseFenceStoreError extends Error {
  readonly code: DesktopActivationLeaseFenceStoreErrorCode;

  constructor(code: DesktopActivationLeaseFenceStoreErrorCode, message: string) {
    super(message);
    this.name = "DesktopActivationLeaseFenceStoreError";
    this.code = code;
  }
}

export type DesktopActivationLeaseFenceStoreFaultPoint =
  | "after_commit_shadow_fsync"
  | "after_temporary_fsync"
  | "after_rename"
  | "before_directory_fsync";

export interface DesktopActivationLeaseFenceStoreOptions {
  root: string;
  safeStorage: SafeStorageLike;
  now?: () => Date;
  faultInjector?: (
    point: DesktopActivationLeaseFenceStoreFaultPoint
  ) => void | Promise<void>;
  renameFile?: (source: string, target: string) => Promise<void>;
  syncDirectory?: (directory: string) => Promise<boolean>;
}

/**
 * Main-only durable fence written before the activation renewal request journal
 * is completed. Raw activation tokens are reduced to SHA-256 before any value
 * is handed to safeStorage. Removed fences remain encrypted tombstones so a
 * crashed or stale writer cannot resurrect an older lease generation.
 */
export class DesktopActivationLeaseFenceStore
  implements DesktopActivationLeaseFenceStoreContract
{
  private readonly root: string;
  private readonly safeStorage: SafeStorageLike;
  private readonly now: () => Date;
  private readonly faultInjector?: DesktopActivationLeaseFenceStoreOptions["faultInjector"];
  private readonly renameFile: (source: string, target: string) => Promise<void>;
  private readonly syncDirectory: (directory: string) => Promise<boolean>;

  constructor(options: DesktopActivationLeaseFenceStoreOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw fenceError("desktop_activation_lease_fence_unsafe", "激活租约 fence 目录无效");
    }
    this.safeStorage = options.safeStorage;
    this.now = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
    this.renameFile = options.renameFile ?? rename;
    this.syncDirectory = options.syncDirectory ?? syncDirectory;
  }

  async persistRenewal(
    target: RenewDesktopCredentialActivationLeaseInput,
    result: RenewalResult
  ): Promise<void> {
    const candidate = renewalData(target, result);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.assertRootEntries();
      await this.repairPending(candidate.activationId);
      const current = await this.readTarget(candidate.activationId);
      if (current?.status === "removed") {
        throw fenceError(
          "desktop_activation_lease_fence_conflict",
          "已移除的激活租约 fence 禁止复活"
        );
      }
      await this.assertNoCompetingFence(candidate);
      if (current) {
        assertFrozenTuple(current, candidate);
        if (sameRequestIdentity(current, candidate)) {
          if (!sameServerRenewal(current, candidate)) {
            throw fenceError(
              "desktop_activation_lease_fence_conflict",
              "相同续租请求返回了不同结果"
            );
          }
          if (current.recovered === candidate.recovered) {
            await this.ensureDurableTarget(current);
            return;
          }
          if (current.recovered || !candidate.recovered) {
            throw fenceError(
              "desktop_activation_lease_fence_conflict",
              "相同续租请求禁止从恢复态升级"
            );
          }
        } else {
          assertMonotonicRenewal(current, candidate);
        }
      }
      const timestamp = canonicalNow(this.now());
      if (current && Date.parse(timestamp) < Date.parse(current.updatedAt)) {
        throw fenceError(
          "desktop_activation_lease_fence_conflict",
          "激活租约 fence 本地更新时间倒退"
        );
      }
      const next = validateRecord({
        version: 1,
        generation: nextGeneration(current),
        status: renewalStatus(candidate),
        ...candidate,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
        removedAt: null
      });
      if (current && !validSuccessor(current, next)) {
        throw fenceError(
          "desktop_activation_lease_fence_conflict",
          "激活租约 fence 代次迁移无效"
        );
      }
      await this.writeAtomic(next);
    });
  }

  read(activationId: string): Promise<DesktopActivationLeaseFenceRecord | null> {
    assertSafeId(activationId);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.assertRootEntries();
      await this.repairPending(activationId);
      const current = await this.readTarget(activationId);
      return current && current.status !== "removed" ? cloneRecord(current) : null;
    });
  }

  /** Startup-only exact inspection that also returns a removed tombstone. */
  inspect(activationId: string): Promise<DesktopActivationLeaseFenceRecord | null> {
    assertSafeId(activationId);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.assertRootEntries();
      await this.repairPending(activationId);
      const current = await this.readTarget(activationId);
      return current ? cloneRecord(current) : null;
    });
  }

  list(): Promise<DesktopActivationLeaseFenceRecord[]> {
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      const activationIds = await this.listActivationIdsLocked();
      const records: DesktopActivationLeaseFenceRecord[] = [];
      for (const activationId of activationIds) {
        await this.repairPending(activationId);
        const current = await this.readTarget(activationId);
        if (current && current.status !== "removed") records.push(cloneRecord(current));
      }
      assertUniqueActiveRecords(records);
      return records;
    });
  }

  requireFresh(
    expected: DesktopActivationLeaseFenceRecord
  ): Promise<DesktopActivationLeaseFenceRecord> {
    const exact = validateExpectedActiveRecord(expected);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.assertRootEntries();
      await this.repairPending(exact.activationId);
      const current = await this.readTarget(exact.activationId);
      const now = this.now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw fenceError(
          "desktop_activation_lease_fence_unsafe",
          "激活租约 fence 新鲜度时间无效"
        );
      }
      if (
        !current ||
        current.status !== "fresh" ||
        !sameRecord(current, exact) ||
        now.getTime() >= Date.parse(current.leaseExpiresAt)
      ) {
        throw fenceError(
          "desktop_activation_lease_fence_conflict",
          "激活租约 fence 不是可用的新鲜代次"
        );
      }
      return cloneRecord(current);
    });
  }

  async remove(expected: DesktopActivationLeaseFenceRecord): Promise<void> {
    const exact = validateExpectedActiveRecord(expected);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.assertRootEntries();
      await this.repairPending(exact.activationId);
      const current = await this.readTarget(exact.activationId);
      if (current?.status === "removed" && validRemovalSuccessor(exact, current)) {
        await this.ensureDurableTarget(current);
        return;
      }
      if (!current || current.status === "removed" || !sameRecord(current, exact)) {
        throw fenceError(
          "desktop_activation_lease_fence_conflict",
          "仅允许移除当前精确激活租约 fence"
        );
      }
      const removedAt = canonicalNow(this.now());
      if (Date.parse(removedAt) < Date.parse(current.updatedAt)) {
        throw fenceError(
          "desktop_activation_lease_fence_conflict",
          "激活租约 fence 删除时间倒退"
        );
      }
      const tombstone = validateRecord({
        ...current,
        generation: nextGeneration(current),
        status: "removed",
        updatedAt: removedAt,
        removedAt
      });
      await this.writeAtomic(tombstone);
    });
  }

  private async assertNoCompetingFence(
    candidate: DesktopActivationLeaseFenceData
  ): Promise<void> {
    for (const activationId of await this.listActivationIdsLocked()) {
      if (activationId === candidate.activationId) continue;
      await this.repairPending(activationId);
      const other = await this.readTarget(activationId);
      if (
        other &&
        other.status !== "removed" &&
        (other.executorId === candidate.executorId || other.operationId === candidate.operationId)
      ) {
        throw fenceError(
          "desktop_activation_lease_fence_conflict",
          "执行器或激活操作存在另一个未终结租约 fence"
        );
      }
    }
  }

  private async writeAtomic(record: DesktopActivationLeaseFenceRecord): Promise<void> {
    const validated = validateRecord(record);
    await this.ensureCommitMarker(validated);
    await this.faultInjector?.("after_commit_shadow_fsync");
    await this.ensureTemporary(validated);
    await this.faultInjector?.("after_temporary_fsync");
    await this.replaceWithRetry(
      this.temporary(validated.activationId),
      this.target(validated.activationId),
      validated
    );
    await this.faultInjector?.("after_rename");
    await this.finishDurability(validated, true);
  }

  private async repairPending(activationId: string): Promise<void> {
    const target = await this.readTarget(activationId);
    const commits = await this.readCommitStates(activationId);
    const temporary = await this.readPath(this.temporary(activationId), activationId, true);
    if (commits.length === 0 && temporary === null) return;

    const candidates = new Map<number, DesktopActivationLeaseFenceRecord>();
    for (const commit of commits) addRecoveryState(candidates, commit.record);
    if (temporary) addRecoveryState(candidates, temporary);
    const ordered = [...candidates.values()].sort(
      (left, right) => left.generation - right.generation
    );

    let recovered: DesktopActivationLeaseFenceRecord | null = null;
    if (target === null) {
      if (
        ordered.length !== 1 ||
        ordered[0]?.generation !== 1 ||
        ordered[0]?.status === "removed"
      ) {
        throw fenceError(
          "desktop_activation_lease_fence_corrupt",
          "激活租约 fence 恢复缺少前代"
        );
      }
      recovered = ordered[0] ?? null;
    } else {
      const sameGeneration = candidates.get(target.generation);
      if (sameGeneration && !sameRecord(sameGeneration, target)) {
        throw fenceError(
          "desktop_activation_lease_fence_corrupt",
          "激活租约 fence 同代恢复冲突"
        );
      }
      const historical = ordered.filter(
        (candidate) => candidate.generation < target.generation
      );
      if (historical.length > 0) {
        let ancestor = historical[0]!;
        for (const candidate of historical.slice(1)) {
          if (!validSuccessor(ancestor, candidate)) {
            throw fenceError(
              "desktop_activation_lease_fence_corrupt",
              "激活租约 fence 旧代恢复链冲突"
            );
          }
          ancestor = candidate;
        }
        if (!validSuccessor(ancestor, target)) {
          throw fenceError(
            "desktop_activation_lease_fence_corrupt",
            "激活租约 fence 旧代与当前目标不连续"
          );
        }
      }
      let cursor = target;
      for (const candidate of ordered) {
        if (candidate.generation <= cursor.generation) continue;
        if (!validSuccessor(cursor, candidate)) {
          throw fenceError(
            "desktop_activation_lease_fence_corrupt",
            "激活租约 fence 恢复代次冲突"
          );
        }
        cursor = candidate;
      }
      if (cursor.generation > target.generation) recovered = cursor;
    }

    if (recovered) {
      await this.ensureCommitMarker(recovered);
      await this.ensureTemporary(recovered);
      await this.replaceWithRetry(
        this.temporary(activationId),
        this.target(activationId),
        recovered
      );
      await this.finishDurability(recovered, false);
      return;
    }
    if (target) await this.finishDurability(target, false);
  }

  private ensureDurableTarget(record: DesktopActivationLeaseFenceRecord): Promise<void> {
    return this.finishDurability(record, false);
  }

  private async finishDurability(
    record: DesktopActivationLeaseFenceRecord,
    injectFaults: boolean
  ): Promise<void> {
    await this.syncRegularFile(this.target(record.activationId));
    const verified = await this.readTarget(record.activationId);
    if (!verified || !sameRecord(verified, record)) {
      throw fenceError(
        "desktop_activation_lease_fence_corrupt",
        "激活租约 fence 替换结果不匹配"
      );
    }
    if (injectFaults) await this.faultInjector?.("before_directory_fsync");
    const directoryDurable = await this.syncDirectory(this.root);
    const commits = await this.readCommitStates(record.activationId);
    await rm(this.temporary(record.activationId), { force: true });
    if (directoryDurable) {
      for (const commit of commits) await rm(commit.file, { force: true });
      const cleanupDurable = await this.syncDirectory(this.root);
      if (!cleanupDurable) {
        await this.ensureCommitMarker(record);
        await this.syncRegularFile(this.commit(record.activationId, record.generation));
      }
      return;
    }

    await this.ensureCommitMarker(record);
    await this.syncRegularFile(this.commit(record.activationId, record.generation));
    for (const commit of commits) {
      if (commit.record.generation !== record.generation) {
        await rm(commit.file, { force: true });
      }
    }
  }

  private async ensureCommitMarker(record: DesktopActivationLeaseFenceRecord): Promise<void> {
    const file = this.commit(record.activationId, record.generation);
    const existing = await this.readPath(file, record.activationId, true);
    if (existing) {
      if (!sameRecord(existing, record)) {
        throw fenceError(
          "desktop_activation_lease_fence_corrupt",
          "激活租约 fence 提交影子冲突"
        );
      }
      return;
    }
    await this.writeEnvelopeExclusive(file, record);
  }

  private async ensureTemporary(record: DesktopActivationLeaseFenceRecord): Promise<void> {
    const temporary = this.temporary(record.activationId);
    const existing = await this.readPath(temporary, record.activationId, true);
    if (existing && sameRecord(existing, record)) return;
    if (existing) {
      throw fenceError(
        "desktop_activation_lease_fence_corrupt",
        "激活租约 fence 临时代次存在分支"
      );
    }
    await this.writeEnvelopeExclusive(temporary, record);
  }

  private async writeEnvelopeExclusive(
    file: string,
    record: DesktopActivationLeaseFenceRecord
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
      if (
        handleInfo.dev !== pathInfo.dev ||
        handleInfo.ino !== pathInfo.ino ||
        handleInfo.mode !== pathInfo.mode ||
        handleInfo.nlink !== pathInfo.nlink ||
        handleInfo.size !== pathInfo.size ||
        handleInfo.size !== envelope.byteLength
      ) {
        throw fenceError(
          "desktop_activation_lease_fence_corrupt",
          "激活租约 fence 写入目标已变化"
        );
      }
      await handle.close();
      handle = undefined;
      const closedPathInfo = await lstat(file);
      assertSafeFile(closedPathInfo);
      if (
        handleInfo.dev !== closedPathInfo.dev ||
        handleInfo.ino !== closedPathInfo.ino ||
        handleInfo.mode !== closedPathInfo.mode ||
        handleInfo.nlink !== closedPathInfo.nlink ||
        handleInfo.size !== closedPathInfo.size
      ) {
        throw fenceError(
          "desktop_activation_lease_fence_corrupt",
          "激活租约 fence 关闭后目标已变化"
        );
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  }

  private encryptEnvelope(record: DesktopActivationLeaseFenceRecord): Buffer {
    let encrypted: Buffer;
    try {
      encrypted = this.safeStorage.encryptString(JSON.stringify(validateRecord(record)));
    } catch {
      throw fenceError(
        "desktop_secure_storage_unavailable",
        "激活租约 fence 加密失败"
      );
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.byteLength < 1) {
      throw fenceError(
        "desktop_secure_storage_unavailable",
        "激活租约 fence 密文无效"
      );
    }
    const envelope = Buffer.concat([ENVELOPE_MAGIC, encrypted]);
    if (envelope.byteLength > MAX_FILE_BYTES) {
      throw fenceError(
        "desktop_activation_lease_fence_unsafe",
        "激活租约 fence 超过安全上限"
      );
    }
    return envelope;
  }

  private async readCommitStates(
    activationId: string
  ): Promise<Array<{ file: string; record: DesktopActivationLeaseFenceRecord }>> {
    const prefix = `${activationId}.sec`;
    const children = await readdir(this.root, { withFileTypes: true });
    const commits: Array<{ file: string; record: DesktopActivationLeaseFenceRecord }> = [];
    for (const child of children) {
      if (!child.name.startsWith(`${prefix}.commit`)) continue;
      if (!child.isFile() || child.isSymbolicLink()) {
        throw fenceError(
          "desktop_activation_lease_fence_unsafe",
          "激活租约 fence 提交影子不安全"
        );
      }
      const match = COMMIT_SUFFIX.exec(child.name.slice(prefix.length));
      const generation = match ? Number(match[1]) : Number.NaN;
      if (!Number.isSafeInteger(generation)) {
        throw fenceError(
          "desktop_activation_lease_fence_unsafe",
          "激活租约 fence 提交影子无效"
        );
      }
      const file = path.join(this.root, child.name);
      const record = await this.readPath(file, activationId);
      if (!record || record.generation !== generation) {
        throw fenceError(
          "desktop_activation_lease_fence_corrupt",
          "激活租约 fence 提交代次不匹配"
        );
      }
      commits.push({ file, record });
    }
    return commits.sort((left, right) => left.record.generation - right.record.generation);
  }

  private async assertRootEntries(): Promise<void> {
    await this.listActivationIdsLocked();
  }

  private async listActivationIdsLocked(): Promise<string[]> {
    const children = await readdir(this.root, { withFileTypes: true });
    if (children.length > MAX_ROOT_ENTRIES) {
      throw fenceError(
        "desktop_activation_lease_fence_unsafe",
        "激活租约 fence 目录条目超过安全上限"
      );
    }
    const activationIds = new Set<string>();
    for (const child of children) {
      if (!child.isFile() || child.isSymbolicLink()) {
        throw fenceError(
          "desktop_activation_lease_fence_unsafe",
          "激活租约 fence 目录含非法条目"
        );
      }
      const match = /^([A-Za-z0-9_-]{1,160})\.sec(?:\.tmp|\.commit-[1-9][0-9]{0,15})?$/.exec(
        child.name
      );
      if (!match?.[1]) {
        throw fenceError(
          "desktop_activation_lease_fence_unsafe",
          "激活租约 fence 目录含未知文件"
        );
      }
      assertSafeFile(await lstat(path.join(this.root, child.name)));
      activationIds.add(match[1]);
    }
    return [...activationIds].sort((left, right) =>
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
        throw fenceError(
          "desktop_activation_lease_fence_corrupt",
          "激活租约 fence 持久化目标已变化"
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
    activationId: string
  ): Promise<DesktopActivationLeaseFenceRecord | null> {
    return this.readPath(this.target(activationId), activationId, true);
  }

  private async readPath(
    file: string,
    expectedActivationId: string,
    missingAllowed = false
  ): Promise<DesktopActivationLeaseFenceRecord | null> {
    let pathInfo;
    try {
      pathInfo = await lstat(file);
    } catch (error) {
      if (missingAllowed && isErrorCode(error, "ENOENT")) return null;
      throw fenceError(
        "desktop_activation_lease_fence_corrupt",
        "激活租约 fence 无法读取"
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
        throw fenceError(
          "desktop_activation_lease_fence_corrupt",
          "激活租约 fence 封套不稳定"
        );
      }
      const plaintext = this.safeStorage.decryptString(
        raw.subarray(ENVELOPE_MAGIC.byteLength)
      );
      const record = validateRecord(JSON.parse(plaintext) as unknown);
      if (record.activationId !== expectedActivationId) {
        throw fenceError(
          "desktop_activation_lease_fence_corrupt",
          "激活租约 fence 归属不匹配"
        );
      }
      return record;
    } catch (error) {
      if (error instanceof DesktopActivationLeaseFenceStoreError) throw error;
      throw fenceError(
        "desktop_activation_lease_fence_corrupt",
        "激活租约 fence 无法解密"
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async replaceWithRetry(
    source: string,
    target: string,
    expected: DesktopActivationLeaseFenceRecord
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const sourceRecord = await this.readPath(source, expected.activationId);
        if (!sourceRecord || !sameRecord(sourceRecord, expected)) {
          throw fenceError(
            "desktop_activation_lease_fence_corrupt",
            "激活租约 fence 待替换代次已变化"
          );
        }
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
      throw fenceError(
        "desktop_activation_lease_fence_unsafe",
        "激活租约 fence 目录不安全"
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
      throw fenceError("desktop_secure_storage_unavailable", "系统安全存储不可用");
    }
  }

  private target(activationId: string): string {
    return path.join(this.root, `${activationId}.sec`);
  }

  private temporary(activationId: string): string {
    return path.join(this.root, `${activationId}.sec.tmp`);
  }

  private commit(activationId: string, generation: number): string {
    return path.join(this.root, `${activationId}.sec.commit-${generation}`);
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

const DATA_KEYS = [
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
  "recovered"
] as const;

const RECORD_KEYS = [
  "version",
  "generation",
  "status",
  ...DATA_KEYS,
  "createdAt",
  "updatedAt",
  "removedAt"
] as const;

function renewalData(
  targetValue: RenewDesktopCredentialActivationLeaseInput,
  resultValue: RenewalResult
): DesktopActivationLeaseFenceData {
  const target = validateTarget(targetValue);
  const result = validateResult(resultValue, target);
  return validateData({
    semanticKey: activationLeaseSemanticKey(target.sessionId, target.activationId),
    sessionId: target.sessionId,
    executorId: result.data.executorId,
    operationId: target.operationId,
    activationId: target.activationId,
    credentialRevision: target.credentialRevision,
    leaseEpoch: target.leaseEpoch,
    sourceCredentialRevision: target.sourceCredentialRevision,
    revocationEpoch: target.revocationEpoch,
    bindingDigest: target.bindingDigest,
    tokenHash: createHash("sha256").update(target.activationToken, "utf8").digest("hex"),
    requestReference: result.requestReference,
    requestHash: result.requestHash,
    renewedAt: result.data.renewedAt,
    leaseExpiresAt: result.data.leaseExpiresAt,
    replayed: result.data.replayed,
    recovered: result.recovered
  });
}

function validateTarget(
  value: unknown
): RenewDesktopCredentialActivationLeaseInput {
  const keys = [
    "sessionId",
    "activationToken",
    "operationId",
    "activationId",
    "credentialRevision",
    "leaseEpoch",
    "sourceCredentialRevision",
    "revocationEpoch",
    "bindingDigest"
  ];
  if (!exactObject(value, keys)) {
    throw fenceError(
      "desktop_activation_lease_fence_unsafe",
      "激活租约 fence 目标结构无效"
    );
  }
  const target = value as unknown as RenewDesktopCredentialActivationLeaseInput;
  if (
    !SAFE_ID.test(target.sessionId) ||
    !validTicket(target.activationToken) ||
    !SAFE_ID.test(target.operationId) ||
    !SAFE_ID.test(target.activationId) ||
    !positiveRevision(target.credentialRevision) ||
    !positiveRevision(target.leaseEpoch) ||
    !nonNegativeRevision(target.sourceCredentialRevision) ||
    target.sourceCredentialRevision >= target.credentialRevision ||
    !nonNegativeRevision(target.revocationEpoch) ||
    !DIGEST.test(target.bindingDigest)
  ) {
    throw fenceError(
      "desktop_activation_lease_fence_unsafe",
      "激活租约 fence 目标字段无效"
    );
  }
  return { ...target };
}

function validateResult(
  value: unknown,
  target: RenewDesktopCredentialActivationLeaseInput
): RenewalResult {
  if (!exactObject(value, ["requestReference", "requestHash", "recovered", "data"])) {
    throw fenceError(
      "desktop_activation_lease_fence_unsafe",
      "激活租约 fence 结果结构无效"
    );
  }
  const result = value as unknown as RenewalResult;
  if (
    !DIGEST.test(result.requestReference) ||
    result.requestReference !== activationLeaseRequestReference(target.sessionId, target.activationId) ||
    !DIGEST.test(result.requestHash) ||
    typeof result.recovered !== "boolean" ||
    !exactObject(result.data, [
      "activationId",
      "executorId",
      "operationId",
      "credentialRevision",
      "leaseEpoch",
      "sourceCredentialRevision",
      "revocationEpoch",
      "renewedAt",
      "leaseExpiresAt",
      "replayed"
    ])
  ) {
    throw fenceError(
      "desktop_activation_lease_fence_unsafe",
      "激活租约 fence 结果字段无效"
    );
  }
  const data = result.data;
  const renewedAt = Date.parse(data.renewedAt);
  const leaseExpiresAt = Date.parse(data.leaseExpiresAt);
  if (
    data.activationId !== target.activationId ||
    !SAFE_ID.test(data.executorId) ||
    data.operationId !== target.operationId ||
    data.credentialRevision !== target.credentialRevision ||
    data.leaseEpoch !== target.leaseEpoch ||
    data.sourceCredentialRevision !== target.sourceCredentialRevision ||
    data.revocationEpoch !== target.revocationEpoch ||
    !canonicalServerTime(data.renewedAt) ||
    !canonicalServerTime(data.leaseExpiresAt) ||
    !Number.isFinite(renewedAt) ||
    !Number.isFinite(leaseExpiresAt) ||
    leaseExpiresAt <= renewedAt ||
    leaseExpiresAt - renewedAt > 30_000 ||
    typeof data.replayed !== "boolean"
  ) {
    throw fenceError(
      "desktop_activation_lease_fence_unsafe",
      "激活租约 fence 响应与目标不匹配"
    );
  }
  return {
    requestReference: result.requestReference,
    requestHash: result.requestHash,
    recovered: result.recovered,
    data: { ...data }
  };
}

function validateRecord(value: unknown): DesktopActivationLeaseFenceRecord {
  if (!exactObject(value, RECORD_KEYS)) {
    throw fenceError(
      "desktop_activation_lease_fence_corrupt",
      "激活租约 fence 记录结构无效"
    );
  }
  const record = value as unknown as DesktopActivationLeaseFenceRecord;
  if (
    record.version !== 1 ||
    !positiveRevision(record.generation) ||
    !["fresh", "recovery_required", "removed"].includes(record.status) ||
    !canonicalMillisecondTime(record.createdAt) ||
    !canonicalMillisecondTime(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt)
  ) {
    throw fenceError(
      "desktop_activation_lease_fence_corrupt",
      "激活租约 fence 记录元数据无效"
    );
  }
  validateData(record, "desktop_activation_lease_fence_corrupt");
  if (
    (record.status === "fresh" &&
      (record.recovered || record.replayed || record.removedAt !== null)) ||
    (record.status === "recovery_required" &&
      ((!record.recovered && !record.replayed) || record.removedAt !== null)) ||
    (record.status === "removed" &&
      (record.generation < 2 ||
        typeof record.removedAt !== "string" ||
        !canonicalMillisecondTime(record.removedAt) ||
        record.removedAt !== record.updatedAt))
  ) {
    throw fenceError(
      "desktop_activation_lease_fence_corrupt",
      "激活租约 fence 删除终态无效"
    );
  }
  return cloneRecord(record);
}

function validateData(
  value: unknown,
  code: DesktopActivationLeaseFenceStoreErrorCode = "desktop_activation_lease_fence_unsafe"
): DesktopActivationLeaseFenceData {
  if (!hasDataShape(value)) {
    throw fenceError(code, "激活租约 fence 数据结构无效");
  }
  const data = value as unknown as DesktopActivationLeaseFenceData;
  const renewedAt = Date.parse(data.renewedAt);
  const leaseExpiresAt = Date.parse(data.leaseExpiresAt);
  if (
    !DIGEST.test(data.semanticKey) ||
    data.semanticKey !== activationLeaseSemanticKey(data.sessionId, data.activationId) ||
    !SAFE_ID.test(data.sessionId) ||
    !SAFE_ID.test(data.executorId) ||
    !SAFE_ID.test(data.operationId) ||
    !SAFE_ID.test(data.activationId) ||
    !positiveRevision(data.credentialRevision) ||
    !positiveRevision(data.leaseEpoch) ||
    !nonNegativeRevision(data.sourceCredentialRevision) ||
    data.sourceCredentialRevision >= data.credentialRevision ||
    !nonNegativeRevision(data.revocationEpoch) ||
    !DIGEST.test(data.bindingDigest) ||
    !DIGEST.test(data.tokenHash) ||
    !DIGEST.test(data.requestReference) ||
    data.requestReference !== activationLeaseRequestReference(data.sessionId, data.activationId) ||
    !DIGEST.test(data.requestHash) ||
    !canonicalServerTime(data.renewedAt) ||
    !canonicalServerTime(data.leaseExpiresAt) ||
    !Number.isFinite(renewedAt) ||
    !Number.isFinite(leaseExpiresAt) ||
    leaseExpiresAt <= renewedAt ||
    leaseExpiresAt - renewedAt > 30_000 ||
    typeof data.replayed !== "boolean" ||
    typeof data.recovered !== "boolean"
  ) {
    throw fenceError(code, "激活租约 fence 数据字段无效");
  }
  return cloneData(data);
}

function hasDataShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).filter(
    (key) =>
      !["version", "generation", "status", "createdAt", "updatedAt", "removedAt"].includes(
        key
      )
  );
  const expected = [...DATA_KEYS].sort();
  actual.sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateExpectedActiveRecord(
  value: unknown
): DesktopActivationLeaseFenceRecord {
  let record: DesktopActivationLeaseFenceRecord;
  try {
    record = validateRecord(value);
  } catch {
    throw fenceError(
      "desktop_activation_lease_fence_unsafe",
      "待移除的激活租约 fence 结构无效"
    );
  }
  if (record.status === "removed" || record.removedAt !== null) {
    throw fenceError(
      "desktop_activation_lease_fence_unsafe",
      "仅允许提交 active 精确 fence"
    );
  }
  return record;
}

function assertFrozenTuple(
  current: DesktopActivationLeaseFenceRecord,
  candidate: DesktopActivationLeaseFenceData
): void {
  if (!sameFrozenTuple(current, candidate)) {
    throw fenceError(
      "desktop_activation_lease_fence_conflict",
      "激活租约冻结元组已变化"
    );
  }
}

function assertMonotonicRenewal(
  current: DesktopActivationLeaseFenceRecord,
  candidate: DesktopActivationLeaseFenceData
): void {
  const currentRenewed = Date.parse(current.renewedAt);
  const nextRenewed = Date.parse(candidate.renewedAt);
  const currentExpires = Date.parse(current.leaseExpiresAt);
  const nextExpires = Date.parse(candidate.leaseExpiresAt);
  if (nextRenewed <= currentRenewed || nextExpires < currentExpires) {
    throw fenceError(
      "desktop_activation_lease_fence_conflict",
      "激活租约续租时间发生倒退"
    );
  }
}

function validSuccessor(
  current: DesktopActivationLeaseFenceRecord,
  next: DesktopActivationLeaseFenceRecord
): boolean {
  if (
    current.status === "removed" ||
    next.generation !== current.generation + 1 ||
    !sameFrozenTuple(current, next) ||
    next.createdAt !== current.createdAt ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt)
  ) {
    return false;
  }
  if (next.status === "removed") return validRemovalSuccessor(current, next);
  if (next.status !== renewalStatus(next) || next.removedAt !== null) return false;
  if (current.requestHash === next.requestHash) {
    return (
      sameServerRenewal(current, next) &&
      !current.recovered &&
      next.recovered &&
      next.status === "recovery_required"
    );
  }
  try {
    assertMonotonicRenewal(current, next);
    return true;
  } catch {
    return false;
  }
}

function validRemovalSuccessor(
  active: DesktopActivationLeaseFenceRecord,
  removed: DesktopActivationLeaseFenceRecord
): boolean {
  return (
    active.status !== "removed" &&
    removed.status === "removed" &&
    removed.generation === active.generation + 1 &&
    removed.createdAt === active.createdAt &&
    Date.parse(removed.updatedAt) >= Date.parse(active.updatedAt) &&
    removed.updatedAt === removed.removedAt &&
    removed.removedAt !== null &&
    sameRenewalRecordData(active, removed)
  );
}

function sameFrozenTuple(
  left: DesktopActivationLeaseFenceData,
  right: DesktopActivationLeaseFenceData
): boolean {
  return (
    left.semanticKey === right.semanticKey &&
    left.sessionId === right.sessionId &&
    left.executorId === right.executorId &&
    left.operationId === right.operationId &&
    left.activationId === right.activationId &&
    left.credentialRevision === right.credentialRevision &&
    left.leaseEpoch === right.leaseEpoch &&
    left.sourceCredentialRevision === right.sourceCredentialRevision &&
    left.revocationEpoch === right.revocationEpoch &&
    left.bindingDigest === right.bindingDigest &&
    left.tokenHash === right.tokenHash &&
    left.requestReference === right.requestReference
  );
}

function sameRequestIdentity(
  left: DesktopActivationLeaseFenceData,
  right: DesktopActivationLeaseFenceData
): boolean {
  return (
    left.requestHash === right.requestHash
  );
}

function sameServerRenewal(
  left: DesktopActivationLeaseFenceData,
  right: DesktopActivationLeaseFenceData
): boolean {
  return (
    sameFrozenTuple(left, right) &&
    left.renewedAt === right.renewedAt &&
    left.leaseExpiresAt === right.leaseExpiresAt &&
    left.replayed === right.replayed
  );
}

function sameRenewalRecordData(
  left: DesktopActivationLeaseFenceRecord,
  right: DesktopActivationLeaseFenceRecord
): boolean {
  return DATA_KEYS.every((key) => left[key] === right[key]);
}

function sameRecord(
  left: DesktopActivationLeaseFenceRecord,
  right: DesktopActivationLeaseFenceRecord
): boolean {
  return (
    left.version === right.version &&
    left.generation === right.generation &&
    left.status === right.status &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.removedAt === right.removedAt &&
    sameRenewalRecordData(left, right)
  );
}

function nextGeneration(current: DesktopActivationLeaseFenceRecord | null): number {
  const generation = (current?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) {
    throw fenceError(
      "desktop_activation_lease_fence_conflict",
      "激活租约 fence 代次已耗尽"
    );
  }
  return generation;
}

function cloneData(value: DesktopActivationLeaseFenceData): DesktopActivationLeaseFenceData {
  return {
    semanticKey: value.semanticKey,
    sessionId: value.sessionId,
    executorId: value.executorId,
    operationId: value.operationId,
    activationId: value.activationId,
    credentialRevision: value.credentialRevision,
    leaseEpoch: value.leaseEpoch,
    sourceCredentialRevision: value.sourceCredentialRevision,
    revocationEpoch: value.revocationEpoch,
    bindingDigest: value.bindingDigest,
    tokenHash: value.tokenHash,
    requestReference: value.requestReference,
    requestHash: value.requestHash,
    renewedAt: value.renewedAt,
    leaseExpiresAt: value.leaseExpiresAt,
    replayed: value.replayed,
    recovered: value.recovered
  };
}

function cloneRecord(
  value: DesktopActivationLeaseFenceRecord
): DesktopActivationLeaseFenceRecord {
  return {
    version: 1,
    generation: value.generation,
    status: value.status,
    ...cloneData(value),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    removedAt: value.removedAt
  };
}

function addRecoveryState(
  states: Map<number, DesktopActivationLeaseFenceRecord>,
  candidate: DesktopActivationLeaseFenceRecord
): void {
  const existing = states.get(candidate.generation);
  if (existing && !sameRecord(existing, candidate)) {
    throw fenceError(
      "desktop_activation_lease_fence_corrupt",
      "激活租约 fence 同代恢复状态冲突"
    );
  }
  states.set(candidate.generation, candidate);
}

function assertUniqueActiveRecords(records: readonly DesktopActivationLeaseFenceRecord[]): void {
  const executors = new Set<string>();
  const operations = new Set<string>();
  for (const record of records) {
    if (executors.has(record.executorId) || operations.has(record.operationId)) {
      throw fenceError(
        "desktop_activation_lease_fence_corrupt",
        "激活租约 fence 存在并行未终结头"
      );
    }
    executors.add(record.executorId);
    operations.add(record.operationId);
  }
}

function renewalStatus(
  value: Pick<DesktopActivationLeaseFenceData, "replayed" | "recovered">
): Exclude<DesktopActivationLeaseFenceStatus, "removed"> {
  return value.replayed || value.recovered ? "recovery_required" : "fresh";
}

function activationLeaseSemanticKey(sessionId: string, activationId: string): string {
  return sha256Text(`AICRM-ACTIVATION-LEASE-FENCE-V1\n${sessionId}\n${activationId}`);
}

function activationLeaseRequestReference(sessionId: string, activationId: string): string {
  const requestPath =
    `/api/v1/ai-executor-authorization-sessions/${sessionId}` +
    `/desktop-activations/${activationId}/lease-renewals`;
  return sha256Text(
    `AICRM-TRUSTED-REQUEST-V1\ncredential_activation_lease_renewal\n${requestPath}`
  );
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validTicket(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= (16 << 10) - 32 &&
    value.trim() === value &&
    COMPACT_JWS.test(value) &&
    value.split(".").every(validCanonicalBase64UrlSegment)
  );
}

function validCanonicalBase64UrlSegment(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return false;
  const remainder = value.length % 4;
  if (remainder === 2) return /[AQgw]$/.test(value);
  if (remainder === 3) return /[AEIMQUYcgkosw048]$/.test(value);
  return true;
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalNow(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw fenceError(
      "desktop_activation_lease_fence_unsafe",
      "激活租约 fence 本地时间无效"
    );
  }
  return value.toISOString();
}

function canonicalMillisecondTime(value: string): boolean {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalServerTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(
    value
  );
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractional] =
    match;
  if (fractional?.endsWith("0")) return false;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const milliseconds = Number((fractional ?? "").padEnd(3, "0").slice(0, 3) || "0");
  if (year < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, second, milliseconds);
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day &&
    probe.getUTCHours() === hour &&
    probe.getUTCMinutes() === minute &&
    probe.getUTCSeconds() === second &&
    Number.isFinite(probe.getTime())
  );
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertSafeId(value: string): void {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw fenceError(
      "desktop_activation_lease_fence_unsafe",
      "激活租约 fence 标识无效"
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
    throw fenceError(
      "desktop_activation_lease_fence_unsafe",
      "激活租约 fence 文件不安全"
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
    throw fenceError(
      "desktop_activation_lease_fence_corrupt",
      "激活租约 fence 文件读取不稳定"
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
  return (
    isErrorCode(error, "EINVAL") ||
    isErrorCode(error, "EPERM") ||
    isErrorCode(error, "ENOTSUP")
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fenceError(
  code: DesktopActivationLeaseFenceStoreErrorCode,
  message: string
): DesktopActivationLeaseFenceStoreError {
  return new DesktopActivationLeaseFenceStoreError(code, message);
}
