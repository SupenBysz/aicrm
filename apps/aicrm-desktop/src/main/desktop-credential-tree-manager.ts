import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";
import type { SafeStorageLike } from "./desktop-device-identity.ts";
import {
  DesktopCredentialOperationJournalStore,
  type DesktopCredentialAckReplayReference,
  type DesktopCredentialOperationProjection,
  type DesktopCredentialOperationRecord,
  type DesktopCredentialPromotionSourceKind
} from "./desktop-credential-operation-journal.ts";
import {
  DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM,
  DesktopCredentialTreeError,
  digestDesktopCredentialTree
} from "./desktop-credential-tree-digest.ts";
import {
  createDesktopWindowsCredentialProtection,
  type DesktopWindowsCredentialProtection
} from "./desktop-credential-windows-protection.ts";

const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_FILES = 4096;
const MAX_TOTAL_BYTES = 128 << 20;
const RESERVATION_HOME = "home";
const RESERVATION_FENCE = "owner.fence";
const MAX_RESERVATION_FENCE_BYTES = 4096;
const executorMutexes = new Map<string, Promise<void>>();

export type DesktopCredentialTreeManagerErrorCode =
  | "desktop_credential_path_invalid"
  | "desktop_credential_tree_unsafe"
  | "desktop_credential_digest_mismatch"
  | "desktop_credential_target_exists"
  | "desktop_credential_recovery_required"
  | "desktop_credential_durability_failed";

export class DesktopCredentialTreeManagerError extends Error {
  readonly code: DesktopCredentialTreeManagerErrorCode;

  constructor(code: DesktopCredentialTreeManagerErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type DesktopCredentialTreeFaultPoint =
  | "after_journal_prepared"
  | "before_file_fsync"
  | "before_directory_fsync"
  | "after_source_durable"
  | "after_reservation_mkdir"
  | "after_reservation_fence"
  | "after_rename"
  | "before_parent_fsync"
  | "after_rename_parent_fsync"
  | "after_readonly"
  | "after_target_durable"
  | "after_verified"
  | "before_journal_remove";

export type DesktopCredentialTreeFaultInjector = (
  point: DesktopCredentialTreeFaultPoint
) => void | Promise<void>;

export interface DesktopCredentialStagingRef {
  kind: "staging";
  executorId: string;
  sessionId: string;
}

export interface DesktopCredentialRevisionRef {
  kind: "revision";
  executorId: string;
  revision: number;
}

export interface DesktopCredentialOperationRef {
  kind: "operation";
  executorId: string;
  operationId: string;
}

export type DesktopCredentialTreeRef =
  | DesktopCredentialStagingRef
  | DesktopCredentialRevisionRef
  | DesktopCredentialOperationRef;

export interface DesktopCredentialQuarantineRef {
  kind: "quarantine";
  executorId: string;
  sourceKind: DesktopCredentialTreeRef["kind"];
  sourceId: string;
}

export interface DesktopCredentialPromotionInput {
  executorId: string;
  operationId: string;
  revision: number;
  expectedDigest: string;
  ackReplay?: DesktopCredentialAckReplayReference | null;
}

export interface PromoteDesktopCredentialStagingInput extends DesktopCredentialPromotionInput {
  sessionId: string;
}

export interface PromoteDesktopCredentialOperationInput extends DesktopCredentialPromotionInput {
  sourceOperationId: string;
}

export interface DesktopCredentialRevisionProjection {
  executorId: string;
  revision: number;
  operationId: string;
  digestAlgorithm: typeof DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM;
  digest: string;
  fileCount: number;
  totalBytes: number;
}

export interface CompleteDesktopCredentialAcknowledgementInput {
  executorId: string;
  operationId: string;
  revision: number;
  expectedDigest: string;
}

interface DesktopCredentialReservationFence {
  version: 1;
  executorId: string;
  operationId: string;
  revision: number;
  expectedDigest: string;
}

export interface DesktopCredentialTreeManagerOptions {
  root: string;
  safeStorage: SafeStorageLike;
  now?: () => Date;
  faultInjector?: DesktopCredentialTreeFaultInjector;
  platform?: NodeJS.Platform;
  windowsProtection?: DesktopWindowsCredentialProtection;
}

/**
 * Main-process credential filesystem. Public projections are opaque and never
 * contain a host path. `mainOnlyResolvePath` is intentionally the sole path
 * escape hatch for a trusted local executor mount.
 */
export class DesktopCredentialTreeManager {
  private readonly root: string;
  private readonly safeStorage: SafeStorageLike;
  private readonly now: () => Date;
  private readonly faultInjector?: DesktopCredentialTreeFaultInjector;
  private readonly platform: NodeJS.Platform;
  private readonly windowsProtection?: DesktopWindowsCredentialProtection;

  constructor(options: DesktopCredentialTreeManagerOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw managerError("desktop_credential_path_invalid", "凭据 Vault 根目录无效");
    }
    this.safeStorage = options.safeStorage;
    this.now = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
    this.platform = options.platform ?? process.platform;
    this.windowsProtection =
      options.windowsProtection ??
      (this.platform === "win32" && process.platform === "win32"
        ? createDesktopWindowsCredentialProtection()
        : undefined);
  }

  async initialize(): Promise<void> {
    await this.ensureRoot();
  }

  async createStaging(executorId: string, sessionId: string): Promise<DesktopCredentialStagingRef> {
    assertSafeId(executorId);
    assertSafeId(sessionId);
    return this.withExecutorLock(executorId, async () => {
      const parent = await this.ensurePrivatePath(executorId, "staging");
      const target = this.pathFor({ kind: "staging", executorId, sessionId });
      await this.createPrivateDirectoryNoReplace(target);
      await this.syncParent(parent);
      return { kind: "staging", executorId, sessionId };
    });
  }

  async cloneRevision(
    executorId: string,
    revision: number,
    operationId: string
  ): Promise<DesktopCredentialOperationRef> {
    assertSafeId(executorId);
    assertRevision(revision);
    assertSafeId(operationId);
    return this.withExecutorLock(executorId, async () => {
      const source = this.pathFor({ kind: "revision", executorId, revision });
      const sourceContainer = this.revisionContainerPath(executorId, revision);
      const targetParent = await this.ensurePrivatePath(executorId, "operations");
      const target = this.pathFor({ kind: "operation", executorId, operationId });
      await this.assertSafeDirectory(source);
      const fence = await this.readReservationFence(executorId, revision);
      await this.validateReadOnlyTree(sourceContainer);
      const before = await digestDesktopCredentialTree(source);
      if (before.digest !== fence.expectedDigest) {
        throw managerError("desktop_credential_digest_mismatch", "凭据版本与预留栅栏不一致");
      }
      await this.createPrivateDirectoryNoReplace(target);
      try {
        await copyCredentialTree(
          source,
          target,
          this.platform,
          (directory) => this.createPrivateDirectoryNoReplace(directory)
        );
        await this.durableBarrier(target);
        await this.syncParent(targetParent);
        const [sourceAfter, targetDigest] = await Promise.all([
          digestDesktopCredentialTree(source),
          digestDesktopCredentialTree(target)
        ]);
        await this.validateReadOnlyTree(sourceContainer);
        if (sourceAfter.digest !== before.digest || targetDigest.digest !== before.digest) {
          throw managerError("desktop_credential_digest_mismatch", "凭据 COW 副本摘要不一致");
        }
        return { kind: "operation", executorId, operationId };
      } catch (error) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        await this.syncParent(targetParent).catch(() => undefined);
        throw normalizeTreeError(error);
      }
    });
  }

  promoteStaging(input: PromoteDesktopCredentialStagingInput): Promise<DesktopCredentialRevisionProjection> {
    assertSafeId(input.sessionId);
    return this.promoteSource(
      input,
      { kind: "staging", executorId: input.executorId, sessionId: input.sessionId },
      "staging",
      input.sessionId
    );
  }

  promoteOperation(input: PromoteDesktopCredentialOperationInput): Promise<DesktopCredentialRevisionProjection> {
    assertSafeId(input.sourceOperationId);
    return this.promoteSource(
      input,
      { kind: "operation", executorId: input.executorId, operationId: input.sourceOperationId },
      "operation",
      input.sourceOperationId
    );
  }

  async recoverOperation(
    executorId: string,
    operationId: string
  ): Promise<DesktopCredentialRevisionProjection> {
    assertSafeId(executorId);
    assertSafeId(operationId);
    return this.withExecutorLock(executorId, async () => {
      const journal = await this.journal(executorId);
      const record = await journal.load(operationId);
      if (record === null || record.executorId !== executorId) {
        throw managerError("desktop_credential_recovery_required", "凭据操作不存在可恢复日志");
      }
      return this.executePromotion(journal, record);
    });
  }

  async recoverExecutor(executorId: string): Promise<DesktopCredentialRevisionProjection[]> {
    assertSafeId(executorId);
    return this.withExecutorLock(executorId, async () => {
      const journal = await this.journal(executorId);
      const ids = await journal.listOperationIds();
      const recovered: DesktopCredentialRevisionProjection[] = [];
      for (const operationId of ids) {
        const record = await journal.load(operationId);
        if (record === null || record.executorId !== executorId) {
          throw managerError("desktop_credential_recovery_required", "凭据操作日志归属不匹配");
        }
        recovered.push(await this.executePromotion(journal, record));
      }
      return recovered;
    });
  }

  async listPendingOperations(executorId: string): Promise<DesktopCredentialOperationProjection[]> {
    assertSafeId(executorId);
    return this.withExecutorLock(executorId, async () => {
      const journal = await this.journal(executorId);
      const values: DesktopCredentialOperationProjection[] = [];
      for (const id of await journal.listOperationIds()) {
        const record = await journal.load(id);
        if (record === null || record.executorId !== executorId) {
          throw managerError("desktop_credential_recovery_required", "凭据操作日志归属不匹配");
        }
        values.push(journal.projection(record));
      }
      return values;
    });
  }

  async completeAfterAcknowledgement(
    input: CompleteDesktopCredentialAcknowledgementInput
  ): Promise<DesktopCredentialRevisionProjection> {
    validatePromotionInput(input);
    return this.withExecutorLock(input.executorId, async () => {
      const journal = await this.journal(input.executorId);
      const record = await journal.load(input.operationId);
      if (
        record === null ||
        record.phase !== "verified" ||
        record.executorId !== input.executorId ||
        record.operationId !== input.operationId ||
        record.targetRevision !== input.revision ||
        record.expectedDigest !== input.expectedDigest
      ) {
        throw managerError("desktop_credential_recovery_required", "凭据 ACK 完成栅栏不匹配");
      }
      const target = this.pathFor({
        kind: "revision",
        executorId: input.executorId,
        revision: input.revision
      });
      await this.assertSafeDirectory(target);
      const fence = await this.readReservationFence(input.executorId, input.revision);
      if (!reservationMatches(fence, record)) {
        throw managerError("desktop_credential_recovery_required", "凭据预留所有权栅栏不匹配");
      }
      await this.validateReadOnlyTree(target);
      await this.validateReadOnlyTree(this.revisionContainerPath(input.executorId, input.revision));
      const verified = await digestDesktopCredentialTree(target);
      if (verified.digest !== input.expectedDigest) {
        throw managerError("desktop_credential_digest_mismatch", "凭据 ACK 完成摘要不匹配");
      }
      await this.fault("before_journal_remove");
      await journal.removeVerified(record);
      return revisionProjection(record, verified);
    });
  }

  quarantine(ref: DesktopCredentialTreeRef): Promise<DesktopCredentialQuarantineRef> {
    validateRef(ref);
    return this.withExecutorLock(ref.executorId, () => this.quarantineUnlocked(ref));
  }

  /** Main-only path; never expose this value through IPC, Bridge, logs or API projections. */
  mainOnlyResolvePath(ref: DesktopCredentialTreeRef | DesktopCredentialQuarantineRef): string {
    if (ref.kind === "quarantine") {
      assertSafeId(ref.executorId);
      assertSafeId(ref.sourceId);
      if (!(["staging", "revision", "operation"] as const).includes(ref.sourceKind)) {
        throw managerError("desktop_credential_path_invalid", "凭据隔离引用无效");
      }
      const quarantined = this.containedPath(
        ref.executorId,
        "quarantine",
        quarantineCategory(ref.sourceKind),
        ref.sourceId
      );
      const payload = path.join(quarantined, "payload");
      return ref.sourceKind === "revision" ? path.join(payload, RESERVATION_HOME) : payload;
    }
    validateRef(ref);
    return this.pathFor(ref);
  }

  private async promoteSource(
    input: DesktopCredentialPromotionInput,
    sourceRef: DesktopCredentialStagingRef | DesktopCredentialOperationRef,
    sourceKind: DesktopCredentialPromotionSourceKind,
    sourceId: string
  ): Promise<DesktopCredentialRevisionProjection> {
    validatePromotionInput(input);
    return this.withExecutorLock(input.executorId, async () => {
      const source = this.pathFor(sourceRef);
      const targetContainer = this.revisionContainerPath(input.executorId, input.revision);
      await this.ensurePrivatePath(input.executorId, "revisions");
      const journal = await this.journal(input.executorId);
      const existing = await journal.load(input.operationId);
      if (existing !== null) {
        if (!sameOperation(existing, input, sourceKind, sourceId)) {
          throw managerError("desktop_credential_recovery_required", "凭据操作标识已被其他事务占用");
        }
        return this.executePromotion(journal, existing);
      }
      if (await pathExists(targetContainer)) {
        throw managerError("desktop_credential_target_exists", "凭据版本目标已存在");
      }
      await this.assertSafeDirectory(source);
      const measured = await digestDesktopCredentialTree(source);
      if (measured.digest !== input.expectedDigest) {
        throw managerError("desktop_credential_digest_mismatch", "凭据绑定摘要不匹配");
      }
      const record: DesktopCredentialOperationRecord = {
        version: 1,
        executorId: input.executorId,
        operationId: input.operationId,
        sourceKind,
        sourceId,
        targetRevision: input.revision,
        expectedDigest: input.expectedDigest,
        phase: "prepared",
        createdAt: this.now().toISOString(),
        ackReplay: input.ackReplay ?? null
      };
      await journal.save(record);
      await this.fault("after_journal_prepared");
      return this.executePromotion(journal, record);
    });
  }

  private async executePromotion(
    journal: DesktopCredentialOperationJournalStore,
    record: DesktopCredentialOperationRecord
  ): Promise<DesktopCredentialRevisionProjection> {
    if (record.phase === "quarantined") {
      throw managerError("desktop_credential_recovery_required", "凭据操作已进入隔离终态");
    }
    const sourceRef = sourceRefFromRecord(record);
    const source = this.pathFor(sourceRef);
    const targetContainer = this.revisionContainerPath(record.executorId, record.targetRevision);
    const target = this.pathFor({
      kind: "revision",
      executorId: record.executorId,
      revision: record.targetRevision
    });
    const sourceExists = await pathExists(source);
    const targetExists = await pathExists(target);
    if (sourceExists && targetExists) {
      const targetFence = await this.readReservationFence(
        record.executorId,
        record.targetRevision
      );
      if (!reservationMatches(targetFence, record)) {
        throw managerError(
          "desktop_credential_target_exists",
          "凭据版本由其他操作持有，禁止触碰其目标目录"
        );
      }
      record.phase = "quarantined";
      await journal.save(record);
      let quarantineFailed = false;
      try {
        await this.quarantineUnlocked(sourceRef);
      } catch {
        quarantineFailed = true;
      }
      try {
        await this.quarantineUnlocked({
          kind: "revision",
          executorId: record.executorId,
          revision: record.targetRevision
        });
      } catch {
        quarantineFailed = true;
      }
      throw managerError(
        "desktop_credential_recovery_required",
        quarantineFailed
          ? "凭据操作出现双重目录且未能完整隔离"
          : "凭据操作出现双重目录，来源与目标均已隔离"
      );
    }
    if (!sourceExists && !targetExists) {
      if (await pathExists(targetContainer)) {
        // An empty permanent reservation without its wx ownership fence is an
        // intentionally non-recoverable ambiguity. Never delete or adopt it.
        await this.readReservationFence(record.executorId, record.targetRevision);
      }
      throw managerError("desktop_credential_recovery_required", "凭据操作来源和目标均不存在");
    }
    if (sourceExists) {
      await this.assertSafeDirectory(source);
      const measured = await digestDesktopCredentialTree(source);
      if (measured.digest !== record.expectedDigest) {
        throw managerError("desktop_credential_digest_mismatch", "凭据恢复摘要不匹配");
      }
      await this.durableBarrier(source);
      record.phase = "source_durable";
      await journal.save(record);
      await this.fault("after_source_durable");
      const sourceParent = path.dirname(source);
      await this.ensureRevisionReservation(record);
      record.phase = "reserved";
      await journal.save(record);
      await this.fault("after_reservation_fence");
      await renameIntoPrivateReservation(source, target, targetContainer);
      await this.fault("after_rename");
      await this.syncParent(sourceParent);
      await this.syncParent(targetContainer);
      await this.fault("after_rename_parent_fsync");
      record.phase = "renamed";
      await journal.save(record);
    }
    await this.assertSafeDirectory(target);
    const fence = await this.readReservationFence(record.executorId, record.targetRevision);
    if (!reservationMatches(fence, record)) {
      throw managerError("desktop_credential_recovery_required", "凭据预留所有权栅栏不匹配");
    }
    if (this.platform === "win32") {
      if (record.phase === "immutable" || record.phase === "verified") {
        // A durable journal phase is the recovery receipt for the native seal.
        // Never weaken an already sealed tree merely to obtain a new write handle.
        await this.validateReadOnlyTree(targetContainer);
      } else {
        await this.sealWindowsReadOnlyTree(targetContainer);
        await this.syncParent(path.dirname(targetContainer));
        record.phase = "immutable";
        await journal.save(record);
        await this.fault("after_readonly");
      }
    } else {
      await makeReadOnly(target, this.platform);
      await this.fault("after_readonly");
      record.phase = "immutable";
      await journal.save(record);
      await makeReservationReadOnly(targetContainer, this.platform);
      await this.durableBarrier(targetContainer);
      await this.syncParent(path.dirname(targetContainer));
    }
    await this.fault("after_target_durable");
    await this.validateReadOnlyTree(targetContainer);
    const verified = await digestDesktopCredentialTree(target);
    if (verified.digest !== record.expectedDigest) {
      record.phase = "quarantined";
      await journal.save(record);
      await this.quarantineUnlocked({
        kind: "revision",
        executorId: record.executorId,
        revision: record.targetRevision
      });
      throw managerError("desktop_credential_digest_mismatch", "凭据版本复核摘要不匹配");
    }
    record.phase = "verified";
    await journal.save(record);
    await this.fault("after_verified");
    return revisionProjection(record, verified);
  }

  private async quarantineUnlocked(ref: DesktopCredentialTreeRef): Promise<DesktopCredentialQuarantineRef> {
    const sourceTree = this.pathFor(ref);
    const sourceRoot =
      ref.kind === "revision" ? this.revisionContainerPath(ref.executorId, ref.revision) : sourceTree;
    await this.assertSafeDirectory(sourceTree);
    await digestDesktopCredentialTree(sourceTree);
    if (ref.kind === "revision") {
      await this.readReservationFence(ref.executorId, ref.revision);
    }
    const sourceId = refId(ref);
    const targetParent = await this.ensurePrivatePath(
      ref.executorId,
      "quarantine",
      quarantineCategory(ref.kind)
    );
    const targetRef: DesktopCredentialQuarantineRef = {
      kind: "quarantine",
      executorId: ref.executorId,
      sourceKind: ref.kind,
      sourceId
    };
    const targetReservation = this.containedPath(
      ref.executorId,
      "quarantine",
      quarantineCategory(ref.kind),
      sourceId
    );
    const targetPayload = path.join(targetReservation, "payload");
    if (await pathExists(targetReservation)) {
      throw managerError("desktop_credential_target_exists", "凭据隔离目标已存在");
    }
    const info = await lstat(sourceRoot);
    const originalMode = info.mode & 0o777;
    const adjusted = this.platform !== "win32" && (originalMode & 0o200) === 0;
    if (adjusted) {
      await this.validateReadOnlyTree(sourceRoot);
      await chmod(sourceRoot, originalMode | 0o200);
    }
    const windowsRevision = this.platform === "win32" && ref.kind === "revision";
    if (windowsRevision) {
      await this.validateReadOnlyTree(sourceRoot);
      try {
        await this.requireWindowsProtection().prepareReadOnlyTreeForMove(sourceRoot);
      } catch {
        throw managerError("desktop_credential_tree_unsafe", "Windows 凭据只读树无法安全隔离");
      }
    }
    try {
      // A sealed Windows revision already crossed its durable seal barrier.
      // Reopening it writable only to fsync would weaken the immutable boundary.
      if (!windowsRevision) await this.durableBarrier(sourceRoot);
      await this.createPrivateDirectoryNoReplace(targetReservation);
      await this.syncParent(targetParent);
      await renameIntoPrivateReservation(sourceRoot, targetPayload, targetReservation);
      await this.syncParent(path.dirname(sourceRoot));
      if (this.platform === "win32") {
        if (windowsRevision) {
          await this.sealWindowsQuarantineReservation(targetReservation, targetPayload);
        } else {
          await this.sealWindowsReadOnlyTree(targetReservation);
        }
        await this.validateReadOnlyTree(targetReservation);
      } else {
        await this.syncParent(targetReservation);
        if (adjusted) await chmod(targetPayload, originalMode);
        await this.durableBarrier(targetPayload);
        await chmod(targetReservation, 0o500);
        await this.syncParent(targetReservation);
      }
      await this.syncParent(targetParent);
      return targetRef;
    } catch (error) {
      if (adjusted) {
        const restore = (await pathExists(targetPayload)) ? targetPayload : sourceRoot;
        await chmod(restore, originalMode).catch(() => undefined);
      }
      throw normalizeTreeError(error);
    }
  }

  private pathFor(ref: DesktopCredentialTreeRef): string {
    switch (ref.kind) {
      case "staging":
        return this.containedPath(ref.executorId, "staging", ref.sessionId);
      case "revision":
        return path.join(this.revisionContainerPath(ref.executorId, ref.revision), RESERVATION_HOME);
      case "operation":
        return this.containedPath(ref.executorId, "operations", ref.operationId);
    }
  }

  private revisionContainerPath(executorId: string, revision: number): string {
    return this.containedPath(executorId, "revisions", String(revision));
  }

  private containedPath(...segments: string[]): string {
    const candidate = path.resolve(this.root, ...segments);
    const relative = path.relative(this.root, candidate);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw managerError("desktop_credential_path_invalid", "凭据路径越界");
    }
    return candidate;
  }

  private async ensureRevisionReservation(record: DesktopCredentialOperationRecord): Promise<void> {
    const revisions = await this.ensurePrivatePath(record.executorId, "revisions");
    const container = this.revisionContainerPath(record.executorId, record.targetRevision);
    if (await pathExists(container)) {
      const existing = await this.readContendedReservationFence(record.executorId, record.targetRevision);
      if (!reservationMatches(existing, record)) {
        throw managerError("desktop_credential_target_exists", "凭据版本已被其他操作预留");
      }
      return;
    }
    try {
      await this.createPrivateDirectoryNoReplace(container);
    } catch (error) {
      if (
        error instanceof DesktopCredentialTreeManagerError &&
        error.code === "desktop_credential_target_exists"
      ) {
        const existing = await this.readContendedReservationFence(record.executorId, record.targetRevision);
        if (!reservationMatches(existing, record)) {
          throw managerError("desktop_credential_target_exists", "凭据版本已被其他操作预留");
        }
        return;
      }
      throw error;
    }
    await this.fault("after_reservation_mkdir");
    const fence: DesktopCredentialReservationFence = {
      version: 1,
      executorId: record.executorId,
      operationId: record.operationId,
      revision: record.targetRevision,
      expectedDigest: record.expectedDigest
    };
    const target = path.join(container, RESERVATION_FENCE);
    let handle;
    try {
      handle = await open(target, "wx", 0o600);
      await handle.writeFile(Buffer.from(JSON.stringify(fence), "utf8"));
      if (this.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.syncParent(container);
      await this.syncParent(revisions);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      // The permanent reservation is intentionally retained. A crash or error
      // before a durable owner fence must never be guessed away on recovery.
      throw error;
    }
  }

  private async readReservationFence(
    executorId: string,
    revision: number
  ): Promise<DesktopCredentialReservationFence> {
    const container = this.revisionContainerPath(executorId, revision);
    await this.assertSafeDirectory(container);
    const target = path.join(container, RESERVATION_FENCE);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw managerError(
          "desktop_credential_recovery_required",
          "凭据版本预留缺少所有权栅栏"
        );
      }
      throw error;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > MAX_RESERVATION_FENCE_BYTES ||
      (this.platform !== "win32" && ![0o600, 0o400].includes(info.mode & 0o777))
    ) {
      throw managerError("desktop_credential_tree_unsafe", "凭据版本所有权栅栏不安全");
    }
    const flags = fsConstants.O_RDONLY | (this.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    let handle;
    try {
      handle = await open(target, flags);
      const before = await handle.stat();
      const raw = await handle.readFile();
      const after = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size < 1 ||
        before.size > MAX_RESERVATION_FENCE_BYTES ||
        (this.platform !== "win32" && ![0o600, 0o400].includes(before.mode & 0o777)) ||
        before.dev !== info.dev ||
        before.ino !== info.ino ||
        raw.byteLength !== before.size ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw managerError("desktop_credential_recovery_required", "凭据版本所有权栅栏发生变化");
      }
      return validateReservationFence(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
    } catch (error) {
      if (error instanceof DesktopCredentialTreeManagerError) throw error;
      throw managerError("desktop_credential_recovery_required", "凭据版本所有权栅栏无法读取");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readContendedReservationFence(
    executorId: string,
    revision: number
  ): Promise<DesktopCredentialReservationFence> {
    const target = path.join(
      this.revisionContainerPath(executorId, revision),
      RESERVATION_FENCE
    );
    for (let attempt = 0; attempt < 25; attempt += 1) {
      if (await pathExists(target)) return this.readReservationFence(executorId, revision);
      await new Promise<void>((resolve) => setTimeout(resolve, 4));
    }
    return this.readReservationFence(executorId, revision);
  }

  private async journal(executorId: string): Promise<DesktopCredentialOperationJournalStore> {
    const root = await this.ensurePrivatePath(executorId, "journals");
    return new DesktopCredentialOperationJournalStore({
      root,
      safeStorage: this.safeStorage,
      platform: this.platform,
      directorySync: (directory) => this.syncJournalDirectory(directory)
    });
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw managerError("desktop_credential_tree_unsafe", "凭据 Vault 根目录不安全");
    }
    if (this.platform !== "win32") {
      await chmod(this.root, 0o700);
    } else {
      await this.ensureWindowsPrivateDirectory(this.root);
    }
  }

  private async ensurePrivatePath(...segments: string[]): Promise<string> {
    await this.ensureRoot();
    let current = this.root;
    const canonicalRoot = await realpath(this.root);
    for (const segment of segments) {
      if (!SAFE_ID.test(segment) && !["staging", "revisions", "operations", "quarantine", "journals"].includes(segment)) {
        throw managerError("desktop_credential_path_invalid", "凭据目录标识无效");
      }
      current = path.join(current, segment);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
      }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw managerError("desktop_credential_tree_unsafe", "凭据子目录不安全");
      }
      const canonical = await realpath(current);
      const relative = path.relative(canonicalRoot, canonical);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw managerError("desktop_credential_tree_unsafe", "凭据子目录发生路径逃逸");
      }
      if (this.platform !== "win32") {
        await chmod(current, 0o700);
      } else {
        await this.ensureWindowsPrivateDirectory(current);
      }
    }
    return current;
  }

  private async assertSafeDirectory(directory: string): Promise<void> {
    const lexical = path.relative(this.root, directory);
    if (lexical === "" || lexical.startsWith("..") || path.isAbsolute(lexical)) {
      throw managerError("desktop_credential_path_invalid", "凭据路径越界");
    }
    const [rootInfo, info] = await Promise.all([lstat(this.root), lstat(directory)]);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      !info.isDirectory() ||
      info.isSymbolicLink()
    ) {
      throw managerError("desktop_credential_tree_unsafe", "凭据目录不安全");
    }
    const [canonicalRoot, canonical] = await Promise.all([realpath(this.root), realpath(directory)]);
    const relative = path.relative(canonicalRoot, canonical);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw managerError("desktop_credential_tree_unsafe", "凭据目录发生路径逃逸");
    }
    let parent = path.dirname(directory);
    while (parent !== this.root) {
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
        throw managerError("desktop_credential_tree_unsafe", "凭据父目录不安全");
      }
      parent = path.dirname(parent);
    }
  }

  private async durableBarrier(root: string): Promise<void> {
    const directories: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw managerError("desktop_credential_tree_unsafe", "凭据落盘目录不安全");
      }
      directories.push(directory);
      for (const child of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, child.name);
        const metadata = await lstat(target);
        if (metadata.isSymbolicLink()) {
          throw managerError("desktop_credential_tree_unsafe", "凭据落盘禁止符号链接");
        }
        if (metadata.isDirectory()) {
          await visit(target);
          continue;
        }
        if (!metadata.isFile() || metadata.nlink !== 1) {
          throw managerError("desktop_credential_tree_unsafe", "凭据落盘只允许单链接普通文件");
        }
        const flags = fsConstants.O_RDONLY | (this.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
        const handle = await open(target, flags);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
            throw managerError("desktop_credential_tree_unsafe", "凭据文件在落盘前发生变化");
          }
          await this.fault("before_file_fsync");
          if (this.platform !== "win32") await handle.sync();
        } finally {
          await handle.close().catch(() => undefined);
        }
      }
    };
    try {
      await visit(root);
      directories.sort((left, right) => right.length - left.length);
      if (this.platform === "win32") {
        for (const _directory of directories) await this.fault("before_directory_fsync");
        await this.requireWindowsProtection().syncMutableTree(root);
      } else {
        for (const directory of directories) {
          await this.fault("before_directory_fsync");
          await this.syncDirectory(directory);
        }
      }
    } catch (error) {
      if (error instanceof DesktopCredentialTreeManagerError) throw error;
      throw managerError("desktop_credential_durability_failed", "凭据树持久化屏障失败");
    }
  }

  private async syncParent(directory: string): Promise<void> {
    try {
      await this.fault("before_parent_fsync");
      await this.syncDirectory(directory);
    } catch (error) {
      if (error instanceof DesktopCredentialTreeManagerError) throw error;
      throw managerError("desktop_credential_durability_failed", "凭据父目录持久化失败");
    }
  }

  private async syncJournalDirectory(directory: string): Promise<void> {
    try {
      await this.syncDirectory(directory);
    } catch (error) {
      if (error instanceof DesktopCredentialTreeManagerError) throw error;
      throw managerError("desktop_credential_durability_failed", "凭据事务日志持久化失败");
    }
  }

  private requireWindowsProtection(): DesktopWindowsCredentialProtection {
    if (this.platform !== "win32" || this.windowsProtection === undefined) {
      throw managerError(
        "desktop_credential_tree_unsafe",
        "Windows 凭据保护组件不可用"
      );
    }
    return this.windowsProtection;
  }

  private async ensureWindowsPrivateDirectory(directory: string): Promise<void> {
    try {
      await this.requireWindowsProtection().ensurePrivateDirectory(directory);
    } catch (error) {
      if (error instanceof DesktopCredentialTreeManagerError) throw error;
      throw managerError("desktop_credential_tree_unsafe", "Windows 凭据私有目录保护失败");
    }
  }

  private async createPrivateDirectoryNoReplace(directory: string): Promise<void> {
    await createDirectoryNoReplace(directory);
    if (this.platform !== "win32") return;
    try {
      await this.ensureWindowsPrivateDirectory(directory);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    if (this.platform === "win32") {
      await this.requireWindowsProtection().syncDirectory(directory);
      return;
    }
    await syncPosixDirectory(directory);
  }

  private async validateReadOnlyTree(root: string): Promise<void> {
    await validateReadOnlyTree(root, this.platform);
    if (this.platform !== "win32") return;
    try {
      await this.requireWindowsProtection().validateReadOnlyTree(root);
    } catch (error) {
      if (error instanceof DesktopCredentialTreeManagerError) throw error;
      throw managerError("desktop_credential_tree_unsafe", "Windows 凭据只读 ACL 校验失败");
    }
  }

  private async sealWindowsReadOnlyTree(root: string): Promise<void> {
    await validateReadOnlyTree(root, this.platform);
    try {
      const protection = this.requireWindowsProtection();
      await protection.sealReadOnlyTree(root);
      await protection.validateReadOnlyTree(root);
    } catch (error) {
      if (error instanceof DesktopCredentialTreeManagerError) throw error;
      throw managerError("desktop_credential_durability_failed", "Windows 凭据只读落盘屏障失败");
    }
  }

  private async sealWindowsQuarantineReservation(
    reservation: string,
    payload: string
  ): Promise<void> {
    await validateReadOnlyTree(payload, this.platform);
    try {
      const protection = this.requireWindowsProtection();
      await protection.sealQuarantineReservation(reservation, payload);
      await protection.validateReadOnlyTree(reservation);
    } catch (error) {
      if (error instanceof DesktopCredentialTreeManagerError) throw error;
      throw managerError("desktop_credential_durability_failed", "Windows 凭据隔离落盘屏障失败");
    }
  }

  private fault(point: DesktopCredentialTreeFaultPoint): Promise<void> {
    return Promise.resolve(this.faultInjector?.(point));
  }

  private withExecutorLock<T>(executorId: string, action: () => Promise<T>): Promise<T> {
    return withProcessMutex(`${this.root}\0${executorId}`, action);
  }
}

async function copyCredentialTree(
  source: string,
  target: string,
  platform: NodeJS.Platform,
  createDirectory: (directory: string) => Promise<void>
): Promise<void> {
  let fileCount = 0;
  let totalBytes = 0;
  const copyDirectory = async (sourceDirectory: string, targetDirectory: string): Promise<void> => {
    for (const child of await readdir(sourceDirectory, { withFileTypes: true })) {
      const sourcePath = path.join(sourceDirectory, child.name);
      const targetPath = path.join(targetDirectory, child.name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) {
        throw managerError("desktop_credential_tree_unsafe", "凭据 COW 禁止符号链接");
      }
      if (info.isDirectory()) {
        await createDirectory(targetPath);
        await copyDirectory(sourcePath, targetPath);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) {
        throw managerError("desktop_credential_tree_unsafe", "凭据 COW 只允许单链接普通文件");
      }
      if (
        !Number.isSafeInteger(info.size) ||
        info.size < 0 ||
        info.size > MAX_TOTAL_BYTES ||
        fileCount >= MAX_FILES ||
        totalBytes + info.size > MAX_TOTAL_BYTES
      ) {
        throw managerError("desktop_credential_tree_unsafe", "凭据 COW 超过安全上限");
      }
      fileCount += 1;
      totalBytes += info.size;
      const flags = fsConstants.O_RDONLY | (platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
      const input = await open(sourcePath, flags);
      let output;
      try {
        const opened = await input.stat();
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.dev !== info.dev ||
          opened.ino !== info.ino ||
          opened.mode !== info.mode ||
          opened.size !== info.size ||
          !Number.isSafeInteger(opened.size) ||
          opened.size < 0 ||
          opened.size > MAX_TOTAL_BYTES
        ) {
          throw managerError("desktop_credential_tree_unsafe", "凭据 COW 来源发生变化");
        }
        const content = await input.readFile();
        const after = await input.stat();
        if (
          content.byteLength !== opened.size ||
          opened.dev !== after.dev ||
          opened.ino !== after.ino ||
          opened.mode !== after.mode ||
          opened.nlink !== after.nlink ||
          opened.size !== after.size ||
          opened.mtimeMs !== after.mtimeMs ||
          opened.ctimeMs !== after.ctimeMs
        ) {
          throw managerError("desktop_credential_tree_unsafe", "凭据 COW 来源大小发生变化");
        }
        output = await open(targetPath, "wx", 0o600);
        await output.writeFile(content);
        await output.sync();
        const written = await output.stat();
        if (!written.isFile() || written.nlink !== 1 || written.size !== content.byteLength) {
          throw managerError("desktop_credential_tree_unsafe", "凭据 COW 目标写入不完整");
        }
      } finally {
        await input.close().catch(() => undefined);
        await output?.close().catch(() => undefined);
      }
    }
  };
  await copyDirectory(source, target);
}

async function makeReadOnly(root: string, platform: NodeJS.Platform): Promise<void> {
  const values: Array<{ target: string; directory: boolean }> = [];
  const visit = async (target: string): Promise<void> => {
    const info = await lstat(target);
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) {
      throw managerError("desktop_credential_tree_unsafe", "凭据只读转换遇到非法条目");
    }
    values.push({ target, directory: info.isDirectory() });
    if (info.isDirectory()) {
      for (const child of await readdir(target)) await visit(path.join(target, child));
    }
  };
  await visit(root);
  values.sort((left, right) => right.target.length - left.target.length);
  if (platform !== "win32") {
    for (const value of values) await chmod(value.target, value.directory ? 0o500 : 0o400);
  }
}

async function makeReservationReadOnly(
  container: string,
  platform: NodeJS.Platform
): Promise<void> {
  if (platform === "win32") return;
  const fence = path.join(container, RESERVATION_FENCE);
  const fenceInfo = await lstat(fence);
  const containerInfo = await lstat(container);
  if (
    !fenceInfo.isFile() ||
    fenceInfo.isSymbolicLink() ||
    fenceInfo.nlink !== 1 ||
    !containerInfo.isDirectory() ||
    containerInfo.isSymbolicLink()
  ) {
    throw managerError("desktop_credential_tree_unsafe", "凭据版本预留目录不安全");
  }
  await chmod(fence, 0o400);
  await chmod(container, 0o500);
}

async function validateReadOnlyTree(root: string, platform: NodeJS.Platform): Promise<void> {
  const visit = async (target: string): Promise<void> => {
    const info = await lstat(target);
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) ||
      (platform !== "win32" && (info.mode & 0o222) !== 0)
    ) {
      throw managerError("desktop_credential_tree_unsafe", "凭据版本不是安全只读树");
    }
    if (info.isDirectory()) {
      for (const child of await readdir(target)) await visit(path.join(target, child));
    }
  };
  await visit(root);
}

async function createDirectoryNoReplace(target: string): Promise<void> {
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) {
      throw managerError("desktop_credential_target_exists", "凭据目录目标已存在");
    }
    throw error;
  }
}

async function renameIntoPrivateReservation(
  source: string,
  target: string,
  reservation: string
): Promise<void> {
  if (await pathExists(target)) {
    throw managerError("desktop_credential_target_exists", "凭据目录目标已存在");
  }
  const [sourceInfo, parentInfo] = await Promise.all([lstat(source), lstat(reservation)]);
  if (
    !sourceInfo.isDirectory() ||
    sourceInfo.isSymbolicLink() ||
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink()
  ) {
    throw managerError("desktop_credential_tree_unsafe", "凭据重命名目录不安全");
  }
  if (sourceInfo.dev !== parentInfo.dev) {
    throw managerError("desktop_credential_path_invalid", "凭据目录不在同一文件系统");
  }
  // The reservation itself was won with atomic mkdir. Cooperating processes
  // cannot own this private destination, so `home`/`payload` has one writer.
  await rename(source, target);
}

async function syncPosixDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function withProcessMutex<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = executorMutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  executorMutexes.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (executorMutexes.get(key) === tail) executorMutexes.delete(key);
  }
}

function validatePromotionInput(input: DesktopCredentialPromotionInput): void {
  assertSafeId(input.executorId);
  assertSafeId(input.operationId);
  assertRevision(input.revision);
  if (!DIGEST.test(input.expectedDigest)) {
    throw managerError("desktop_credential_digest_mismatch", "凭据绑定摘要格式无效");
  }
  if (input.ackReplay !== undefined && input.ackReplay !== null) {
    const { tokenHash, tokenReference } = input.ackReplay;
    if (
      (tokenHash !== null && !DIGEST.test(tokenHash)) ||
      (tokenReference !== null && !SAFE_ID.test(tokenReference)) ||
      (tokenHash === null && tokenReference === null)
    ) {
      throw managerError("desktop_credential_path_invalid", "凭据 ACK 重放引用无效");
    }
  }
}

function validateRef(ref: DesktopCredentialTreeRef): void {
  assertSafeId(ref.executorId);
  switch (ref.kind) {
    case "staging":
      assertSafeId(ref.sessionId);
      return;
    case "revision":
      assertRevision(ref.revision);
      return;
    case "operation":
      assertSafeId(ref.operationId);
      return;
  }
}

function sourceRefFromRecord(
  record: DesktopCredentialOperationRecord
): DesktopCredentialStagingRef | DesktopCredentialOperationRef {
  return record.sourceKind === "staging"
    ? { kind: "staging", executorId: record.executorId, sessionId: record.sourceId }
    : { kind: "operation", executorId: record.executorId, operationId: record.sourceId };
}

function validateReservationFence(value: unknown): DesktopCredentialReservationFence {
  if (!isExactRecord(value, ["version", "executorId", "operationId", "revision", "expectedDigest"])) {
    throw managerError("desktop_credential_recovery_required", "凭据版本所有权栅栏结构无效");
  }
  const fence = value as unknown as DesktopCredentialReservationFence;
  assertSafeId(fence.executorId);
  assertSafeId(fence.operationId);
  assertRevision(fence.revision);
  if (fence.version !== 1 || !DIGEST.test(fence.expectedDigest)) {
    throw managerError("desktop_credential_recovery_required", "凭据版本所有权栅栏字段无效");
  }
  return { ...fence };
}

function reservationMatches(
  fence: DesktopCredentialReservationFence,
  record: DesktopCredentialOperationRecord
): boolean {
  return (
    fence.executorId === record.executorId &&
    fence.operationId === record.operationId &&
    fence.revision === record.targetRevision &&
    fence.expectedDigest === record.expectedDigest
  );
}

function revisionProjection(
  record: DesktopCredentialOperationRecord,
  measured: Awaited<ReturnType<typeof digestDesktopCredentialTree>>
): DesktopCredentialRevisionProjection {
  return {
    executorId: record.executorId,
    revision: record.targetRevision,
    operationId: record.operationId,
    digestAlgorithm: measured.algorithm,
    digest: measured.digest,
    fileCount: measured.fileCount,
    totalBytes: measured.totalBytes
  };
}

function sameOperation(
  record: DesktopCredentialOperationRecord,
  input: DesktopCredentialPromotionInput,
  sourceKind: DesktopCredentialPromotionSourceKind,
  sourceId: string
): boolean {
  return (
    record.executorId === input.executorId &&
    record.operationId === input.operationId &&
    record.sourceKind === sourceKind &&
    record.sourceId === sourceId &&
    record.targetRevision === input.revision &&
    record.expectedDigest === input.expectedDigest &&
    JSON.stringify(record.ackReplay) === JSON.stringify(input.ackReplay ?? null)
  );
}

function refId(ref: DesktopCredentialTreeRef): string {
  switch (ref.kind) {
    case "staging":
      return ref.sessionId;
    case "revision":
      return String(ref.revision);
    case "operation":
      return ref.operationId;
  }
}

function quarantineCategory(kind: DesktopCredentialTreeRef["kind"]): string {
  switch (kind) {
    case "staging":
      return "staging";
    case "revision":
      return "revisions";
    case "operation":
      return "operations";
  }
}

function assertSafeId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw managerError("desktop_credential_path_invalid", "凭据标识无效");
  }
}

function assertRevision(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw managerError("desktop_credential_path_invalid", "凭据版本号无效");
  }
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeTreeError(error: unknown): unknown {
  if (error instanceof DesktopCredentialTreeError) {
    return managerError(
      error.code === "desktop_credential_tree_changed"
        ? "desktop_credential_recovery_required"
        : "desktop_credential_tree_unsafe",
      "凭据树安全校验失败"
    );
  }
  return error;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function managerError(
  code: DesktopCredentialTreeManagerErrorCode,
  message: string
): DesktopCredentialTreeManagerError {
  return new DesktopCredentialTreeManagerError(code, message);
}
