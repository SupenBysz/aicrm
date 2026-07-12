import { createHash, randomBytes } from "node:crypto";
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
  type DesktopCredentialAcknowledgementProvenance,
  type DesktopCredentialOperationProjection,
  type DesktopCredentialOperationRecord,
  type DesktopCredentialPromotionSourceKind
} from "./desktop-credential-operation-journal.ts";
import {
  DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM,
  DesktopCredentialTreeError,
  digestDesktopCredentialTree,
  type DesktopCredentialTreeDigest
} from "./desktop-credential-tree-digest.ts";
import {
  createDesktopWindowsCredentialProtection,
  type DesktopWindowsCredentialProtection
} from "./desktop-credential-windows-protection.ts";

const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const AUTHORIZATION_SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_FILES = 4096;
const MAX_TOTAL_BYTES = 128 << 20;
const RESERVATION_HOME = "home";
const RESERVATION_FENCE = "owner.fence";
const OWNER_FENCE_MAGIC = Buffer.from("AICRM-CREDENTIAL-OWNER-FENCE-V1\n", "ascii");
const MAX_RESERVATION_FENCE_BYTES = 4096;
const OWNER_NONCE = /^[0-9a-f]{64}$/;
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
  | "after_staging_mkdir"
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
  | "after_quarantine_journal"
  | "after_quarantine_reservation"
  | "after_quarantine_rename"
  | "before_journal_remove";

export type DesktopCredentialTreeFaultInjector = (
  point: DesktopCredentialTreeFaultPoint
) => void | Promise<void>;

export interface DesktopCredentialStagingRef {
  kind: "staging";
  executorId: string;
  sessionId: string;
}

export interface DesktopCredentialStagingCreationResult {
  ref: DesktopCredentialStagingRef;
  recovered: boolean;
  ownershipDigest: string;
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

export interface DesktopCredentialPromotionFenceInput {
  executorId: string;
  operationId: string;
  revision: number;
  expectedDigest: string;
}

export interface CompleteDesktopCredentialAcknowledgementInput
  extends DesktopCredentialPromotionFenceInput,
    DesktopCredentialAcknowledgementProvenance {}

export interface DesktopCredentialQuarantinedPromotionProjection {
  executorId: string;
  operationId: string;
  revision: number;
  digestAlgorithm: typeof DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM;
  quarantineDigest: string;
  fileCount: number;
  totalBytes: number;
}

export interface DesktopCredentialStagingQuarantineProjection {
  ref: DesktopCredentialQuarantineRef;
  digestAlgorithm: typeof DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM;
  digest: string;
  fileCount: number;
  totalBytes: number;
}

interface DesktopCredentialReservationFence {
  version: 2;
  executorId: string;
  operationId: string;
  revision: number;
  expectedDigest: string;
  sourceOwnershipDigest: string | null;
}

interface DesktopCredentialStagingOwnerFence {
  version: 1;
  kind: "staging";
  executorId: string;
  sessionId: string;
  nonce: string;
}

interface DesktopCredentialStagingQuarantineFence {
  version: 1;
  kind: "staging_quarantine";
  executorId: string;
  sessionId: string;
  sourceNonce: string;
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
      await this.createStagingReservation(executorId, sessionId, parent, false);
      return { kind: "staging", executorId, sessionId };
    });
  }

  /**
   * Creates the exact authorization staging directory, or adopts only the
   * same executor/session directory left behind by a crash after mkdir. A
   * staging quarantine reservation for the same tuple is an ownership
   * ambiguity and is never guessed away.
   */
  async createOrRecoverStaging(
    executorId: string,
    sessionId: string
  ): Promise<DesktopCredentialStagingCreationResult> {
    assertSafeId(executorId);
    assertSafeId(sessionId);
    return this.withExecutorLock(executorId, async () => {
      try {
        const ref: DesktopCredentialStagingRef = {
          kind: "staging",
          executorId,
          sessionId
        };
        const parent = await this.ensurePrivatePath(executorId, "staging");
        const quarantineParent = await this.ensurePrivatePath(
          executorId,
          "quarantine",
          quarantineCategory("staging")
        );
        const quarantineReservation = path.join(quarantineParent, sessionId);
        if (await pathExists(quarantineReservation)) {
          throw managerError(
            "desktop_credential_recovery_required",
            "凭据 staging 已存在隔离恢复状态"
          );
        }
        const reservation = this.stagingReservationPath(executorId, sessionId);
        let recovered = await pathExists(reservation);
        if (!recovered) {
          try {
            await this.createStagingReservation(executorId, sessionId, parent, true);
          } catch (error) {
            if (
              !(error instanceof DesktopCredentialTreeManagerError) ||
              error.code !== "desktop_credential_target_exists"
            ) {
              throw error;
            }
            recovered = true;
          }
        }
        const ownerFence = await this.assertMutableStagingReservation(
          reservation,
          executorId,
          sessionId
        );
        await this.durableBarrier(this.pathFor(ref));
        await this.syncParent(reservation);
        if (await pathExists(quarantineReservation)) {
          throw managerError(
            "desktop_credential_recovery_required",
            "凭据 staging 与隔离恢复状态同时存在"
          );
        }
        await this.syncParent(parent);
        return {
          ref,
          recovered,
          ownershipDigest: stagingOwnershipDigest(ownerFence)
        };
      } catch (error) {
        throw normalizeStagingRecoveryError(error);
      }
    });
  }

  /**
   * Flushes a mutable candidate before measuring it. Revision measurements
   * additionally prove the permanent reservation fence and read-only seal.
   * The returned projection never exposes the host path.
   */
  async measure(ref: DesktopCredentialTreeRef): Promise<DesktopCredentialTreeDigest> {
    validateRef(ref);
    return this.withExecutorLock(ref.executorId, async () => {
      const target = this.pathFor(ref);
      await this.assertSafeDirectory(target);
      if (ref.kind === "revision") {
        const container = this.revisionContainerPath(ref.executorId, ref.revision);
        const fence = await this.readReservationFence(ref.executorId, ref.revision);
        await this.validateReadOnlyTree(container);
        const measured = await digestDesktopCredentialTree(target);
        if (measured.digest !== fence.expectedDigest) {
          throw managerError(
            "desktop_credential_digest_mismatch",
            "凭据版本与预留栅栏摘要不一致"
          );
        }
        return measured;
      }
      await this.durableBarrier(target);
      await this.syncParent(path.dirname(target));
      return digestDesktopCredentialTree(target);
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
      const ids = await journal.listPendingOperationIds();
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
      for (const id of await journal.listPendingOperationIds()) {
        const record = await journal.load(id);
        if (record === null || record.executorId !== executorId) {
          throw managerError("desktop_credential_recovery_required", "凭据操作日志归属不匹配");
        }
        values.push(journal.projection(record));
      }
      return values;
    });
  }

  /** Enumerates only executors that own a non-terminal encrypted promotion journal. */
  async listPendingExecutorIds(): Promise<string[]> {
    await this.ensureRoot();
    const children = await readdir(this.root, { withFileTypes: true });
    const pending: string[] = [];
    for (const child of children) {
      if (
        !child.isDirectory() ||
        child.isSymbolicLink() ||
        !SAFE_ID.test(child.name)
      ) {
        throw managerError(
          "desktop_credential_tree_unsafe",
          "凭据 Vault 根目录包含非法条目"
        );
      }
      const executorId = child.name;
      await this.ensurePrivatePath(executorId);
      const journalRoot = this.containedPath(executorId, "journals");
      if (!(await pathExists(journalRoot))) continue;
      await this.assertSafeDirectory(journalRoot);
      const journal = new DesktopCredentialOperationJournalStore({
        root: journalRoot,
        safeStorage: this.safeStorage,
        platform: this.platform,
        now: this.now,
        directorySync: (directory) => this.syncJournalDirectory(directory)
      });
      if ((await journal.listPendingOperationIds()).length > 0) pending.push(executorId);
    }
    return pending.sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
    );
  }

  async completeAfterAcknowledgement(
    input: CompleteDesktopCredentialAcknowledgementInput
  ): Promise<DesktopCredentialRevisionProjection> {
    validateAcknowledgementInput(input);
    return this.withExecutorLock(input.executorId, async () => {
      const journal = await this.journal(input.executorId);
      let record = await journal.load(input.operationId);
      if (
        record === null ||
        (record.phase !== "verified" &&
          record.phase !== "acknowledged" &&
          record.phase !== "removed") ||
        record.executorId !== input.executorId ||
        record.operationId !== input.operationId ||
        record.targetRevision !== input.revision ||
        record.expectedDigest !== input.expectedDigest
      ) {
        throw managerError("desktop_credential_recovery_required", "凭据 ACK 完成栅栏不匹配");
      }
      if (
        (record.phase === "acknowledged" || record.phase === "removed") &&
        !acknowledgementMatches(record, input)
      ) {
        throw managerError("desktop_credential_recovery_required", "凭据 ACK 来源栅栏不匹配");
      }
      await this.assertPromotionSourceOwnership(record);
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
      if (record.phase === "verified") {
        record = await journal.transition(record, "acknowledged", acknowledgementFromInput(input));
      }
      return revisionProjection(record, verified);
    });
  }

  /** Exact coordinator inspection; a different ACK provenance never aliases. */
  async inspectAcknowledged(
    input: CompleteDesktopCredentialAcknowledgementInput
  ): Promise<DesktopCredentialOperationProjection | null> {
    validateAcknowledgementInput(input);
    return this.withExecutorLock(input.executorId, async () => {
      const journal = await this.journal(input.executorId);
      const record = await journal.load(input.operationId);
      if (record === null || record.phase !== "acknowledged") return null;
      if (!acknowledgementRecordMatches(record, input)) {
        throw managerError("desktop_credential_recovery_required", "凭据 ACK 墓碑来源不匹配");
      }
      return journal.projection(record);
    });
  }

  /** Removes only the exact current ACK tombstone after coordinator retention. */
  async removeAcknowledged(
    input: CompleteDesktopCredentialAcknowledgementInput
  ): Promise<void> {
    validateAcknowledgementInput(input);
    return this.withExecutorLock(input.executorId, async () => {
      const journal = await this.journal(input.executorId);
      const record = await journal.load(input.operationId);
      if (
        record === null ||
        (record.phase !== "acknowledged" && record.phase !== "removed") ||
        !acknowledgementRecordMatches(record, input)
      ) {
        throw managerError("desktop_credential_recovery_required", "凭据 ACK 墓碑清理栅栏不匹配");
      }
      if (record.phase === "removed") return;
      await this.fault("before_journal_remove");
      await journal.removeAcknowledged(record);
    });
  }

  /**
   * Moves a verified activation candidate into durable quarantine while
   * retaining its encrypted terminal promotion journal. The exact tuple makes
   * retries idempotent after any rename or sealing crash window.
   */
  async quarantinePromotion(
    input: DesktopCredentialPromotionFenceInput
  ): Promise<DesktopCredentialQuarantinedPromotionProjection> {
    validatePromotionInput(input);
    return this.withExecutorLock(input.executorId, async () => {
      try {
        const journal = await this.journal(input.executorId);
        let record = await journal.load(input.operationId);
        if (
          record === null ||
          record.executorId !== input.executorId ||
          record.operationId !== input.operationId ||
          record.targetRevision !== input.revision ||
          record.expectedDigest !== input.expectedDigest ||
          (record.phase !== "verified" && record.phase !== "quarantined")
        ) {
          throw managerError(
            "desktop_credential_recovery_required",
            "凭据隔离操作栅栏不匹配"
          );
        }
        if (record.phase === "verified") {
          await this.assertPromotionSourceOwnership(record);
          await this.verifyPromotionRevision(record);
          record = await journal.transition(record, "quarantined");
          await this.fault("after_quarantine_journal");
        }
        const measured = await this.finishQuarantinedPromotion(record);
        return {
          executorId: record.executorId,
          operationId: record.operationId,
          revision: record.targetRevision,
          digestAlgorithm: measured.algorithm,
          quarantineDigest: measured.digest,
          fileCount: measured.fileCount,
          totalBytes: measured.totalBytes
        };
      } catch (error) {
        throw normalizeQuarantinePromotionError(error);
      }
    });
  }

  quarantine(ref: DesktopCredentialTreeRef): Promise<DesktopCredentialQuarantineRef> {
    validateRef(ref);
    if (ref.kind === "staging") {
      return this.withExecutorLock(ref.executorId, async () =>
        (await this.quarantineStagingUnlocked(ref.executorId, ref.sessionId)).ref
      );
    }
    return this.withExecutorLock(ref.executorId, () => this.quarantineUnlocked(ref));
  }

  /**
   * Durably moves one exact authorization staging tree into its deterministic
   * quarantine reservation. The same safe projection is returned after a
   * reservation/rename/seal crash; ambiguous filesystem shapes fail closed.
   */
  async quarantineStaging(
    executorId: string,
    sessionId: string
  ): Promise<DesktopCredentialStagingQuarantineProjection> {
    assertSafeId(executorId);
    assertSafeId(sessionId);
    return this.withExecutorLock(executorId, () =>
      this.quarantineStagingUnlocked(executorId, sessionId)
    );
  }

  /**
   * Startup recovery for the app_server_starting -> staging-create crash
   * window. A wholly absent source and quarantine is a proven no-op; any
   * partial or competing state still fails closed through the strict path.
   */
  async quarantineStagingIfPresent(
    executorId: string,
    sessionId: string
  ): Promise<DesktopCredentialStagingQuarantineProjection | null> {
    assertSafeId(executorId);
    assertSafeId(sessionId);
    return this.withExecutorLock(executorId, async () => {
      const sourceReservation = this.stagingReservationPath(executorId, sessionId);
      const sourceHome = this.pathFor({ kind: "staging", executorId, sessionId });
      const quarantineParent = await this.ensurePrivatePath(
        executorId,
        "quarantine",
        quarantineCategory("staging")
      );
      const reservation = path.join(quarantineParent, sessionId);
      const payload = path.join(reservation, "payload");
      const states = await Promise.all([
        pathExists(sourceReservation),
        pathExists(sourceHome),
        pathExists(reservation),
        pathExists(payload)
      ]);
      if (states.every((exists) => !exists)) return null;
      return this.quarantineStagingUnlocked(executorId, sessionId);
    });
  }

  private async quarantineStagingUnlocked(
    executorId: string,
    sessionId: string
  ): Promise<DesktopCredentialStagingQuarantineProjection> {
    try {
      const sourceRef: DesktopCredentialStagingRef = {
        kind: "staging",
        executorId,
        sessionId
      };
      const targetRef: DesktopCredentialQuarantineRef = {
        kind: "quarantine",
        executorId,
        sourceKind: "staging",
        sourceId: sessionId
      };
      const sourceReservation = this.stagingReservationPath(executorId, sessionId);
      const sourceHome = this.pathFor(sourceRef);
      const sourceParent = await this.ensurePrivatePath(executorId, "staging");
      const targetParent = await this.ensurePrivatePath(
        executorId,
        "quarantine",
        quarantineCategory("staging")
      );
      const reservation = path.join(targetParent, sessionId);
      const payload = path.join(reservation, "payload");
      let [sourceReservationExists, sourceHomeExists, reservationExists, payloadExists] =
        await Promise.all([
          pathExists(sourceReservation),
          pathExists(sourceHome),
          pathExists(reservation),
          pathExists(payload)
        ]);
      if (sourceReservationExists && payloadExists) {
        throw managerError(
          "desktop_credential_recovery_required",
          "凭据 staging 隔离来源与目标同时存在"
        );
      }
      if (sourceReservationExists !== sourceHomeExists) {
        throw managerError(
          "desktop_credential_recovery_required",
          "凭据 staging 隔离来源结构不完整"
        );
      }

      let quarantineFence: DesktopCredentialStagingQuarantineFence;
      if (sourceReservationExists) {
        const stagingFence = await this.assertMutableStagingReservation(
          sourceReservation,
          executorId,
          sessionId
        );
        await this.durableBarrier(sourceHome);
        const measured = await digestDesktopCredentialTree(sourceHome);
        quarantineFence = {
          version: 1,
          kind: "staging_quarantine",
          executorId,
          sessionId,
          sourceNonce: stagingFence.nonce,
          expectedDigest: measured.digest
        };
        if (reservationExists) {
          await this.assertMutableStagingQuarantineReservation(
            reservation,
            quarantineFence
          );
          await this.syncParent(reservation);
          await this.syncParent(targetParent);
        } else {
          try {
            await this.createPrivateDirectoryNoReplace(reservation);
            await this.writeOwnerFence(reservation, quarantineFence);
            await this.syncParent(reservation);
            await this.syncParent(targetParent);
            await this.fault("after_quarantine_reservation");
          } catch (error) {
            if (
              !(error instanceof DesktopCredentialTreeManagerError) ||
              error.code !== "desktop_credential_target_exists"
            ) {
              throw error;
            }
            await this.assertMutableStagingQuarantineReservation(
              reservation,
              quarantineFence
            );
          }
        }
        if (await pathExists(payload)) {
          throw managerError(
            "desktop_credential_recovery_required",
            "凭据 staging 隔离来源与目标同时存在"
          );
        }
        await renameIntoPrivateReservation(sourceReservation, payload, reservation);
        await this.fault("after_quarantine_rename");
        await this.syncParent(sourceParent);
        reservationExists = true;
        payloadExists = true;
        sourceReservationExists = false;
      } else {
        if (!reservationExists || !payloadExists) {
          throw managerError(
            "desktop_credential_recovery_required",
            "凭据 staging 隔离来源与目标均不存在"
          );
        }
        quarantineFence = await this.readStagingQuarantineFence(
          reservation,
          executorId,
          sessionId,
          true
        );
      }
      if (sourceReservationExists || !reservationExists || !payloadExists) {
        throw managerError(
          "desktop_credential_recovery_required",
          "凭据 staging 隔离状态不完整"
        );
      }
      const measured = await this.finishStagingQuarantine(
        sourceParent,
        targetParent,
        reservation,
        payload,
        quarantineFence
      );
      return {
        ref: targetRef,
        digestAlgorithm: measured.algorithm,
        digest: measured.digest,
        fileCount: measured.fileCount,
        totalBytes: measured.totalBytes
      };
    } catch (error) {
      throw normalizeStagingRecoveryError(error);
    }
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
      return ref.sourceKind === "revision" || ref.sourceKind === "staging"
        ? path.join(payload, RESERVATION_HOME)
        : payload;
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
      const sourceOwnershipDigest = await this.readPromotionSourceOwnershipDigest(
        sourceRef,
        sourceKind
      );
      const existing = await journal.load(input.operationId);
      if (existing !== null) {
        if (!sameOperation(existing, input, sourceKind, sourceId, sourceOwnershipDigest)) {
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
      const record = await journal.create({
        executorId: input.executorId,
        operationId: input.operationId,
        sourceKind,
        sourceId,
        sourceOwnershipDigest,
        targetRevision: input.revision,
        expectedDigest: input.expectedDigest,
        createdAt: this.now().toISOString(),
        ackReplay: input.ackReplay ?? null
      });
      await this.fault("after_journal_prepared");
      return this.executePromotion(journal, record);
    });
  }

  private async readPromotionSourceOwnershipDigest(
    sourceRef: DesktopCredentialStagingRef | DesktopCredentialOperationRef,
    sourceKind: DesktopCredentialPromotionSourceKind
  ): Promise<string | null> {
    if (sourceKind === "operation") return null;
    if (sourceRef.kind !== "staging") {
      throw managerError("desktop_credential_recovery_required", "凭据来源所有权类型不匹配");
    }
    const fence = await this.readStagingOwnerFence(
      this.stagingReservationPath(sourceRef.executorId, sourceRef.sessionId),
      sourceRef.executorId,
      sourceRef.sessionId,
      false
    );
    return stagingOwnershipDigest(fence);
  }

  private async assertPromotionSourceOwnership(
    record: DesktopCredentialOperationRecord
  ): Promise<void> {
    if (record.sourceKind === "operation") {
      if (record.sourceOwnershipDigest !== null) {
        throw managerError("desktop_credential_recovery_required", "凭据操作来源所有权栅栏无效");
      }
      return;
    }
    const fence = await this.readStagingOwnerFence(
      this.stagingReservationPath(record.executorId, record.sourceId),
      record.executorId,
      record.sourceId,
      false
    );
    if (stagingOwnershipDigest(fence) !== record.sourceOwnershipDigest) {
      throw managerError("desktop_credential_recovery_required", "凭据 staging 所有权摘要不匹配");
    }
  }

  private async executePromotion(
    journal: DesktopCredentialOperationJournalStore,
    initialRecord: DesktopCredentialOperationRecord
  ): Promise<DesktopCredentialRevisionProjection> {
    let record = initialRecord;
    if (record.phase === "quarantined") {
      throw managerError("desktop_credential_recovery_required", "凭据操作已进入隔离终态");
    }
    if (record.phase === "acknowledged") {
      throw managerError("desktop_credential_recovery_required", "凭据操作已完成 ACK，不属于待恢复事务");
    }
    if (record.phase === "removed") {
      throw managerError("desktop_credential_recovery_required", "凭据操作 ACK 记录已进入删除高水位");
    }
    await this.assertPromotionSourceOwnership(record);
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
      await this.assertPromotionSourceOwnership(record);
      record = await journal.transition(record, "quarantined");
      let quarantineFailed = false;
      try {
        if (sourceRef.kind === "staging") {
          await this.quarantineStagingUnlocked(sourceRef.executorId, sourceRef.sessionId);
        } else {
          await this.quarantineUnlocked(sourceRef);
        }
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
      if (
        record.phase !== "prepared" &&
        record.phase !== "source_durable" &&
        record.phase !== "reserved"
      ) {
        throw managerError("desktop_credential_recovery_required", "凭据恢复阶段与来源目录不匹配");
      }
      await this.assertPromotionSourceOwnership(record);
      await this.assertSafeDirectory(source);
      const measured = await digestDesktopCredentialTree(source);
      if (measured.digest !== record.expectedDigest) {
        throw managerError("desktop_credential_digest_mismatch", "凭据恢复摘要不匹配");
      }
      if (record.phase === "prepared") {
        await this.durableBarrier(source);
        await this.assertPromotionSourceOwnership(record);
        record = await journal.transition(record, "source_durable");
        await this.fault("after_source_durable");
      }
      const sourceParent = path.dirname(source);
      if (record.phase === "source_durable") {
        await this.ensureRevisionReservation(record);
        await this.assertPromotionSourceOwnership(record);
        record = await journal.transition(record, "reserved");
        await this.fault("after_reservation_fence");
      }
      if (record.phase === "reserved") {
        await this.ensureRevisionReservation(record);
        await this.assertPromotionSourceOwnership(record);
        await renameIntoPrivateReservation(source, target, targetContainer);
        await this.fault("after_rename");
        await this.syncParent(sourceParent);
        await this.syncParent(targetContainer);
        await this.fault("after_rename_parent_fsync");
        await this.assertPromotionSourceOwnership(record);
        record = await journal.transition(record, "renamed");
      }
    }
    await this.assertSafeDirectory(target);
    const fence = await this.readReservationFence(record.executorId, record.targetRevision);
    if (!reservationMatches(fence, record)) {
      throw managerError("desktop_credential_recovery_required", "凭据预留所有权栅栏不匹配");
    }
    await this.assertPromotionSourceOwnership(record);
    if (record.phase === "reserved") {
      // Crash after rename and parent durability, before the journal advance.
      await this.syncParent(targetContainer);
      record = await journal.transition(record, "renamed");
    }
    if (record.phase === "renamed") {
      if (this.platform === "win32") {
        await this.sealWindowsReadOnlyTree(targetContainer);
        await this.syncParent(path.dirname(targetContainer));
      } else {
        await makeReadOnly(target, this.platform);
        await makeReservationReadOnly(targetContainer, this.platform);
        await this.durableBarrier(targetContainer);
        await this.syncParent(path.dirname(targetContainer));
      }
      await this.assertPromotionSourceOwnership(record);
      record = await journal.transition(record, "immutable");
      await this.fault("after_readonly");
    }
    if (record.phase !== "immutable" && record.phase !== "verified") {
      throw managerError("desktop_credential_recovery_required", "凭据恢复阶段无法验证");
    }
    await this.fault("after_target_durable");
    await this.validateReadOnlyTree(targetContainer);
    const verified = await digestDesktopCredentialTree(target);
    if (verified.digest !== record.expectedDigest) {
      await this.assertPromotionSourceOwnership(record);
      record = await journal.transition(record, "quarantined");
      await this.quarantineUnlocked({
        kind: "revision",
        executorId: record.executorId,
        revision: record.targetRevision
      });
      throw managerError("desktop_credential_digest_mismatch", "凭据版本复核摘要不匹配");
    }
    if (record.phase === "immutable") {
      await this.assertPromotionSourceOwnership(record);
      record = await journal.transition(record, "verified");
      await this.fault("after_verified");
    }
    return revisionProjection(record, verified);
  }

  private async quarantineUnlocked(
    ref: DesktopCredentialRevisionRef | DesktopCredentialOperationRef
  ): Promise<DesktopCredentialQuarantineRef> {
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
      await this.fault("after_quarantine_reservation");
      await renameIntoPrivateReservation(sourceRoot, targetPayload, targetReservation);
      await this.fault("after_quarantine_rename");
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

  private async createStagingReservation(
    executorId: string,
    sessionId: string,
    parent: string,
    injectFault: boolean
  ): Promise<void> {
    const reservation = this.stagingReservationPath(executorId, sessionId);
    await this.createPrivateDirectoryNoReplace(reservation);
    const home = path.join(reservation, RESERVATION_HOME);
    await this.createPrivateDirectoryNoReplace(home);
    const fence: DesktopCredentialStagingOwnerFence = {
      version: 1,
      kind: "staging",
      executorId,
      sessionId,
      nonce: randomBytes(32).toString("hex")
    };
    await this.writeOwnerFence(reservation, fence);
    await this.syncParent(reservation);
    await this.syncParent(parent);
    if (injectFault) await this.fault("after_staging_mkdir");
  }

  private async writeOwnerFence(
    reservation: string,
    fence: DesktopCredentialStagingOwnerFence | DesktopCredentialStagingQuarantineFence
  ): Promise<void> {
    const target = path.join(reservation, RESERVATION_FENCE);
    let encrypted: Buffer;
    try {
      encrypted = this.safeStorage.encryptString(JSON.stringify(fence));
    } catch {
      throw managerError(
        "desktop_credential_tree_unsafe",
        "凭据 owner fence 安全存储不可用"
      );
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.byteLength < 1) {
      throw managerError("desktop_credential_tree_unsafe", "凭据 owner fence 密文无效");
    }
    const raw = Buffer.concat([OWNER_FENCE_MAGIC, encrypted]);
    if (raw.byteLength < 1 || raw.byteLength > MAX_RESERVATION_FENCE_BYTES) {
      throw managerError("desktop_credential_tree_unsafe", "凭据 owner fence 超过安全上限");
    }
    let handle;
    try {
      handle = await open(target, "wx", 0o600);
      await handle.writeFile(raw);
      if (this.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      const info = await handle.stat();
      const pathInfo = await lstat(target);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size !== raw.byteLength ||
        !pathInfo.isFile() ||
        pathInfo.isSymbolicLink() ||
        pathInfo.nlink !== 1 ||
        pathInfo.dev !== info.dev ||
        pathInfo.ino !== info.ino ||
        pathInfo.mode !== info.mode ||
        pathInfo.size !== info.size
      ) {
        throw managerError("desktop_credential_tree_unsafe", "凭据 owner fence 写入不稳定");
      }
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) {
        throw managerError("desktop_credential_target_exists", "凭据 owner fence 已存在");
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async assertMutableStagingReservation(
    reservation: string,
    executorId: string,
    sessionId: string
  ): Promise<DesktopCredentialStagingOwnerFence> {
    await this.assertStagingReservationShape(reservation);
    const home = path.join(reservation, RESERVATION_HOME);
    if (this.platform !== "win32") {
      const [reservationInfo, homeInfo] = await Promise.all([
        lstat(reservation),
        lstat(home)
      ]);
      if (
        (reservationInfo.mode & 0o777) !== 0o700 ||
        (homeInfo.mode & 0o777) !== 0o700
      ) {
        throw managerError(
          "desktop_credential_tree_unsafe",
          "凭据 staging reservation 不是私有可写目录"
        );
      }
    } else {
      await this.ensureWindowsPrivateDirectory(reservation);
      await this.ensureWindowsPrivateDirectory(home);
    }
    return this.readStagingOwnerFence(reservation, executorId, sessionId, false);
  }

  private async assertStagingReservationShape(reservation: string): Promise<void> {
    await this.assertSafeDirectory(reservation);
    const children = await readdir(reservation, { withFileTypes: true });
    const home = children.find((child) => child.name === RESERVATION_HOME);
    const fence = children.find((child) => child.name === RESERVATION_FENCE);
    if (
      children.length !== 2 ||
      !home?.isDirectory() ||
      home.isSymbolicLink() ||
      !fence?.isFile() ||
      fence.isSymbolicLink()
    ) {
      throw managerError(
        "desktop_credential_recovery_required",
        "凭据 staging reservation 缺少精确所有权结构"
      );
    }
    await this.assertSafeDirectory(path.join(reservation, RESERVATION_HOME));
  }

  private async assertMutableStagingQuarantineReservation(
    reservation: string,
    expected: DesktopCredentialStagingQuarantineFence
  ): Promise<void> {
    await this.assertSafeDirectory(reservation);
    const children = await readdir(reservation, { withFileTypes: true });
    if (
      children.length !== 1 ||
      children[0]?.name !== RESERVATION_FENCE ||
      !children[0].isFile() ||
      children[0].isSymbolicLink()
    ) {
      throw managerError(
        "desktop_credential_recovery_required",
        "凭据 staging 隔离预留缺少精确所有权结构"
      );
    }
    if (
      this.platform !== "win32" &&
      ((await lstat(reservation)).mode & 0o777) !== 0o700
    ) {
      throw managerError(
        "desktop_credential_tree_unsafe",
        "凭据 staging 隔离预留模式无效"
      );
    }
    if (this.platform === "win32") await this.ensureWindowsPrivateDirectory(reservation);
    const actual = await this.readStagingQuarantineFence(
      reservation,
      expected.executorId,
      expected.sessionId,
      false
    );
    if (!sameStagingQuarantineFence(actual, expected)) {
      throw managerError(
        "desktop_credential_recovery_required",
        "凭据 staging 隔离所有权栅栏不匹配"
      );
    }
  }

  private async readStagingOwnerFence(
    reservation: string,
    executorId: string,
    sessionId: string,
    allowReadOnly: boolean
  ): Promise<DesktopCredentialStagingOwnerFence> {
    const value = await this.readOwnerFenceValue(reservation, allowReadOnly);
    return validateStagingOwnerFence(value, executorId, sessionId);
  }

  private async readStagingQuarantineFence(
    reservation: string,
    executorId: string,
    sessionId: string,
    allowReadOnly: boolean
  ): Promise<DesktopCredentialStagingQuarantineFence> {
    const value = await this.readOwnerFenceValue(reservation, allowReadOnly);
    return validateStagingQuarantineFence(value, executorId, sessionId);
  }

  private async readOwnerFenceValue(
    reservation: string,
    allowReadOnly: boolean
  ): Promise<unknown> {
    await this.assertSafeDirectory(reservation);
    const target = path.join(reservation, RESERVATION_FENCE);
    const info = await lstat(target).catch((error: unknown) => {
      if (isErrorCode(error, "ENOENT")) {
        throw managerError(
          "desktop_credential_recovery_required",
          "凭据 owner fence 不存在"
        );
      }
      throw error;
    });
    const allowedModes = allowReadOnly ? [0o600, 0o400] : [0o600];
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > MAX_RESERVATION_FENCE_BYTES ||
      (this.platform !== "win32" && !allowedModes.includes(info.mode & 0o777))
    ) {
      throw managerError("desktop_credential_tree_unsafe", "凭据 owner fence 不安全");
    }
    const flags =
      fsConstants.O_RDONLY | (this.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    let handle;
    try {
      handle = await open(target, flags);
      const before = await handle.stat();
      const raw = await handle.readFile();
      const after = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.dev !== info.dev ||
        before.ino !== info.ino ||
        before.mode !== info.mode ||
        raw.byteLength !== before.size ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mode !== after.mode ||
        before.nlink !== after.nlink ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        throw managerError(
          "desktop_credential_recovery_required",
          "凭据 owner fence 读取期间发生变化"
        );
      }
      if (!raw.subarray(0, OWNER_FENCE_MAGIC.byteLength).equals(OWNER_FENCE_MAGIC)) {
        throw managerError(
          "desktop_credential_recovery_required",
          "凭据 owner fence 封套无效"
        );
      }
      let plaintext: string;
      try {
        plaintext = this.safeStorage.decryptString(raw.subarray(OWNER_FENCE_MAGIC.byteLength));
      } catch {
        throw managerError(
          "desktop_credential_recovery_required",
          "凭据 owner fence 无法解密"
        );
      }
      return JSON.parse(plaintext);
    } catch (error) {
      if (error instanceof DesktopCredentialTreeManagerError) throw error;
      throw managerError(
        "desktop_credential_recovery_required",
        "凭据 owner fence 无法读取"
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async finishStagingQuarantine(
    sourceParent: string,
    targetParent: string,
    reservation: string,
    payload: string,
    expectedFence: DesktopCredentialStagingQuarantineFence
  ): Promise<Awaited<ReturnType<typeof digestDesktopCredentialTree>>> {
    await this.assertSafeDirectory(reservation);
    await this.assertStagingReservationShape(payload);
    const children = await readdir(reservation, { withFileTypes: true });
    const payloadEntry = children.find((child) => child.name === "payload");
    const fenceEntry = children.find((child) => child.name === RESERVATION_FENCE);
    if (
      children.length !== 2 ||
      !payloadEntry?.isDirectory() ||
      payloadEntry.isSymbolicLink() ||
      !fenceEntry?.isFile() ||
      fenceEntry.isSymbolicLink()
    ) {
      throw managerError(
        "desktop_credential_tree_unsafe",
        "凭据 staging 隔离目录结构不安全"
      );
    }
    const actualFence = await this.readStagingQuarantineFence(
      reservation,
      expectedFence.executorId,
      expectedFence.sessionId,
      true
    );
    if (!sameStagingQuarantineFence(actualFence, expectedFence)) {
      throw managerError(
        "desktop_credential_recovery_required",
        "凭据 staging 隔离栅栏与恢复目标不匹配"
      );
    }
    const stagingFence = await this.readStagingOwnerFence(
      payload,
      expectedFence.executorId,
      expectedFence.sessionId,
      true
    );
    if (stagingFence.nonce !== expectedFence.sourceNonce) {
      throw managerError(
        "desktop_credential_recovery_required",
        "凭据 staging 隔离来源 nonce 不匹配"
      );
    }
    const home = path.join(payload, RESERVATION_HOME);
    const beforeSeal = await digestDesktopCredentialTree(home);
    if (beforeSeal.digest !== expectedFence.expectedDigest) {
      throw managerError(
        "desktop_credential_digest_mismatch",
        "凭据 staging 隔离来源摘要不匹配"
      );
    }
    if (this.platform === "win32") {
      try {
        await this.validateReadOnlyTree(reservation);
      } catch {
        await this.sealWindowsReadOnlyTree(reservation);
      }
      await this.validateReadOnlyTree(reservation);
    } else {
      const reservationMode = (await lstat(reservation)).mode & 0o777;
      if (reservationMode !== 0o700 && reservationMode !== 0o500) {
        throw managerError(
          "desktop_credential_tree_unsafe",
          "凭据 staging 隔离目录模式无效"
        );
      }
      if (reservationMode === 0o500) {
        await this.validateReadOnlyTree(reservation);
        const fenceMode = (await lstat(path.join(reservation, RESERVATION_FENCE))).mode & 0o777;
        if (fenceMode !== 0o400) {
          throw managerError(
            "desktop_credential_tree_unsafe",
            "凭据 staging 隔离完成栅栏模式无效"
          );
        }
      } else {
        await makeReadOnly(payload, this.platform);
        await chmod(path.join(reservation, RESERVATION_FENCE), 0o400);
        await this.durableBarrier(reservation);
        await this.syncParent(reservation);
        await chmod(reservation, 0o500);
        await this.syncParent(reservation);
        await this.validateReadOnlyTree(reservation);
      }
    }
    await this.syncParent(sourceParent);
    await this.syncParent(targetParent);
    const verifiedFence = await this.readStagingQuarantineFence(
      reservation,
      expectedFence.executorId,
      expectedFence.sessionId,
      true
    );
    if (!sameStagingQuarantineFence(verifiedFence, expectedFence)) {
      throw managerError(
        "desktop_credential_recovery_required",
        "凭据 staging 隔离完成栅栏发生变化"
      );
    }
    const verified = await digestDesktopCredentialTree(home);
    if (verified.digest !== expectedFence.expectedDigest) {
      throw managerError(
        "desktop_credential_digest_mismatch",
        "凭据 staging 隔离完成摘要不匹配"
      );
    }
    return verified;
  }

  private async verifyPromotionRevision(
    record: DesktopCredentialOperationRecord
  ): Promise<Awaited<ReturnType<typeof digestDesktopCredentialTree>>> {
    const revision = this.pathFor({
      kind: "revision",
      executorId: record.executorId,
      revision: record.targetRevision
    });
    const container = this.revisionContainerPath(record.executorId, record.targetRevision);
    await this.assertSafeDirectory(revision);
    await this.ensurePromotionRevisionSeal(
      container,
      revision,
      record,
      record.phase === "quarantined"
    );
    const measured = await digestDesktopCredentialTree(revision);
    if (measured.digest !== record.expectedDigest) {
      throw managerError(
        "desktop_credential_digest_mismatch",
        "凭据隔离候选摘要不匹配"
      );
    }
    return measured;
  }

  private async finishQuarantinedPromotion(
    record: DesktopCredentialOperationRecord
  ): Promise<Awaited<ReturnType<typeof digestDesktopCredentialTree>>> {
    const sourceRef: DesktopCredentialRevisionRef = {
      kind: "revision",
      executorId: record.executorId,
      revision: record.targetRevision
    };
    const sourceTree = this.pathFor(sourceRef);
    const sourceContainer = this.revisionContainerPath(record.executorId, record.targetRevision);
    const quarantineParent = await this.ensurePrivatePath(
      record.executorId,
      "quarantine",
      quarantineCategory("revision")
    );
    const quarantineReservation = this.containedPath(
      record.executorId,
      "quarantine",
      quarantineCategory("revision"),
      String(record.targetRevision)
    );
    const quarantinePayload = path.join(quarantineReservation, "payload");
    const quarantineTree = path.join(quarantinePayload, RESERVATION_HOME);
    const [sourceContainerExists, sourceTreeExists, reservationExists, quarantinePayloadExists] = await Promise.all([
      pathExists(sourceContainer),
      pathExists(sourceTree),
      pathExists(quarantineReservation),
      pathExists(quarantinePayload)
    ]);
    if (sourceContainerExists && quarantinePayloadExists) {
      throw managerError(
        "desktop_credential_recovery_required",
        "凭据隔离来源与目标同时存在"
      );
    }
    if (sourceContainerExists !== sourceTreeExists) {
      throw managerError(
        "desktop_credential_recovery_required",
        "凭据隔离来源目录结构不一致"
      );
    }
    if (sourceContainerExists) {
      await this.verifyPromotionRevision(record);
      if (!reservationExists) {
        await this.quarantineUnlocked(sourceRef);
      } else {
        await this.assertSafeDirectory(quarantineReservation);
        const children = await readdir(quarantineReservation, { withFileTypes: true });
        if (children.length !== 0) {
          throw managerError(
            "desktop_credential_recovery_required",
            "凭据隔离预留包含未知条目"
          );
        }
        const reopenForRename =
          this.platform !== "win32" &&
          ((await lstat(sourceContainer)).mode & 0o777) === 0o500;
        if (reopenForRename) await chmod(sourceContainer, 0o700);
        try {
          await renameIntoPrivateReservation(
            sourceContainer,
            quarantinePayload,
            quarantineReservation
          );
        } catch (error) {
          if (reopenForRename) await chmod(sourceContainer, 0o500).catch(() => undefined);
          throw error;
        }
        await this.fault("after_quarantine_rename");
        await this.syncParent(path.dirname(sourceContainer));
      }
    } else if (!quarantinePayloadExists) {
      throw managerError(
        "desktop_credential_recovery_required",
        "凭据隔离来源与目标均不存在"
      );
    }
    await this.finishQuarantineReservation(
      quarantineParent,
      quarantineReservation,
      quarantinePayload,
      record
    );
    await this.assertSafeDirectory(quarantineTree);
    const measured = await digestDesktopCredentialTree(quarantineTree);
    if (measured.digest !== record.expectedDigest) {
      throw managerError(
        "desktop_credential_digest_mismatch",
        "凭据隔离结果摘要不匹配"
      );
    }
    return measured;
  }

  private async finishQuarantineReservation(
    quarantineParent: string,
    reservation: string,
    payload: string,
    record: DesktopCredentialOperationRecord
  ): Promise<void> {
    await this.assertSafeDirectory(reservation);
    await this.assertSafeDirectory(payload);
    const children = await readdir(reservation, { withFileTypes: true });
    if (
      children.length !== 1 ||
      children[0]?.name !== "payload" ||
      !children[0].isDirectory() ||
      children[0].isSymbolicLink()
    ) {
      throw managerError(
        "desktop_credential_tree_unsafe",
        "凭据隔离目录结构不安全"
      );
    }
    await this.ensurePromotionRevisionSeal(
      payload,
      path.join(payload, RESERVATION_HOME),
      record,
      true
    );
    if (this.platform === "win32") {
      try {
        await this.validateReadOnlyTree(reservation);
      } catch {
        await this.sealWindowsQuarantineReservation(reservation, payload);
      }
    } else {
      await this.durableBarrier(payload);
      await chmod(reservation, 0o500);
      await this.syncParent(reservation);
    }
    await this.validateReadOnlyTree(reservation);
    await this.syncParent(quarantineParent);
  }

  private async ensurePromotionRevisionSeal(
    container: string,
    credentialTree: string,
    record: DesktopCredentialOperationRecord,
    allowInterruptedQuarantineRepair: boolean
  ): Promise<void> {
    await this.assertSafeDirectory(container);
    await this.assertSafeDirectory(credentialTree);
    await this.assertRevisionContainerShape(container);
    const fence = await this.readReservationFenceAt(container);
    if (!reservationMatches(fence, record)) {
      throw managerError(
        "desktop_credential_recovery_required",
        "凭据隔离预留所有权栅栏不匹配"
      );
    }
    if (this.platform !== "win32") {
      const info = await lstat(container);
      const mode = info.mode & 0o777;
      if (mode !== 0o500) {
        if (!allowInterruptedQuarantineRepair || mode !== 0o700) {
          throw managerError(
            "desktop_credential_tree_unsafe",
            "凭据隔离候选只读模式无效"
          );
        }
        const fenceInfo = await lstat(path.join(container, RESERVATION_FENCE));
        if (
          !fenceInfo.isFile() ||
          fenceInfo.isSymbolicLink() ||
          fenceInfo.nlink !== 1 ||
          (fenceInfo.mode & 0o777) !== 0o400
        ) {
          throw managerError(
            "desktop_credential_tree_unsafe",
            "凭据隔离恢复栅栏模式无效"
          );
        }
        await this.validateReadOnlyTree(credentialTree);
        await chmod(container, 0o500);
        await this.syncParent(container);
        await this.syncParent(path.dirname(container));
      }
    }
    await this.validateReadOnlyTree(container);
  }

  private async assertRevisionContainerShape(container: string): Promise<void> {
    const children = await readdir(container, { withFileTypes: true });
    const home = children.find((child) => child.name === RESERVATION_HOME);
    const fence = children.find((child) => child.name === RESERVATION_FENCE);
    if (
      children.length !== 2 ||
      !home?.isDirectory() ||
      home.isSymbolicLink() ||
      !fence?.isFile() ||
      fence.isSymbolicLink()
    ) {
      throw managerError(
        "desktop_credential_tree_unsafe",
        "凭据版本预留目录结构不安全"
      );
    }
  }

  private pathFor(ref: DesktopCredentialTreeRef): string {
    switch (ref.kind) {
      case "staging":
        return path.join(
          this.stagingReservationPath(ref.executorId, ref.sessionId),
          RESERVATION_HOME
        );
      case "revision":
        return path.join(this.revisionContainerPath(ref.executorId, ref.revision), RESERVATION_HOME);
      case "operation":
        return this.containedPath(ref.executorId, "operations", ref.operationId);
    }
  }

  private stagingReservationPath(executorId: string, sessionId: string): string {
    return this.containedPath(executorId, "staging", sessionId);
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
      version: 2,
      executorId: record.executorId,
      operationId: record.operationId,
      revision: record.targetRevision,
      expectedDigest: record.expectedDigest,
      sourceOwnershipDigest: record.sourceOwnershipDigest
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
    return this.readReservationFenceAt(container);
  }

  private async readReservationFenceAt(
    container: string
  ): Promise<DesktopCredentialReservationFence> {
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
      now: this.now,
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

function validateAcknowledgementInput(
  input: CompleteDesktopCredentialAcknowledgementInput
): void {
  validatePromotionInput(input);
  if (
    !AUTHORIZATION_SESSION_ID.test(input.authorizationSessionId) ||
    !DIGEST.test(input.activationAckRequestReference) ||
    !DIGEST.test(input.activationAckRequestHash)
  ) {
    throw managerError("desktop_credential_path_invalid", "凭据 ACK 来源参数无效");
  }
}

function acknowledgementFromInput(
  input: CompleteDesktopCredentialAcknowledgementInput
): DesktopCredentialAcknowledgementProvenance {
  return {
    authorizationSessionId: input.authorizationSessionId,
    activationAckRequestReference: input.activationAckRequestReference,
    activationAckRequestHash: input.activationAckRequestHash
  };
}

function acknowledgementMatches(
  record: DesktopCredentialOperationRecord,
  input: CompleteDesktopCredentialAcknowledgementInput
): boolean {
  return record.authorizationSessionId === input.authorizationSessionId &&
    record.activationAckRequestReference === input.activationAckRequestReference &&
    record.activationAckRequestHash === input.activationAckRequestHash;
}

function acknowledgementRecordMatches(
  record: DesktopCredentialOperationRecord,
  input: CompleteDesktopCredentialAcknowledgementInput
): boolean {
  return record.executorId === input.executorId &&
    record.operationId === input.operationId &&
    record.targetRevision === input.revision &&
    record.expectedDigest === input.expectedDigest &&
    acknowledgementMatches(record, input);
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
  if (!isExactRecord(value, [
    "version",
    "executorId",
    "operationId",
    "revision",
    "expectedDigest",
    "sourceOwnershipDigest"
  ])) {
    throw managerError("desktop_credential_recovery_required", "凭据版本所有权栅栏结构无效");
  }
  const fence = value as unknown as DesktopCredentialReservationFence;
  assertSafeId(fence.executorId);
  assertSafeId(fence.operationId);
  assertRevision(fence.revision);
  if (
    fence.version !== 2 ||
    !DIGEST.test(fence.expectedDigest) ||
    (fence.sourceOwnershipDigest !== null && !DIGEST.test(fence.sourceOwnershipDigest))
  ) {
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
    fence.expectedDigest === record.expectedDigest &&
    fence.sourceOwnershipDigest === record.sourceOwnershipDigest
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
  sourceId: string,
  sourceOwnershipDigest: string | null
): boolean {
  return (
    record.executorId === input.executorId &&
    record.operationId === input.operationId &&
    record.sourceKind === sourceKind &&
    record.sourceId === sourceId &&
    record.sourceOwnershipDigest === sourceOwnershipDigest &&
    record.targetRevision === input.revision &&
    record.expectedDigest === input.expectedDigest &&
    JSON.stringify(record.ackReplay) === JSON.stringify(input.ackReplay ?? null)
  );
}

function stagingOwnershipDigest(fence: DesktopCredentialStagingOwnerFence): string {
  return createHash("sha256")
    .update("AICRM-CREDENTIAL-STAGING-OWNERSHIP-V1\n", "utf8")
    .update(fence.executorId, "utf8")
    .update("\n", "utf8")
    .update(fence.sessionId, "utf8")
    .update("\n", "utf8")
    .update(fence.nonce, "utf8")
    .digest("hex");
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

function validateStagingOwnerFence(
  value: unknown,
  executorId: string,
  sessionId: string
): DesktopCredentialStagingOwnerFence {
  if (
    !isExactRecord(value, ["version", "kind", "executorId", "sessionId", "nonce"])
  ) {
    throw managerError(
      "desktop_credential_recovery_required",
      "凭据 staging owner fence 结构无效"
    );
  }
  const fence = value as unknown as DesktopCredentialStagingOwnerFence;
  if (
    fence.version !== 1 ||
    fence.kind !== "staging" ||
    fence.executorId !== executorId ||
    fence.sessionId !== sessionId ||
    !SAFE_ID.test(fence.executorId) ||
    !SAFE_ID.test(fence.sessionId) ||
    !OWNER_NONCE.test(fence.nonce)
  ) {
    throw managerError(
      "desktop_credential_recovery_required",
      "凭据 staging owner fence 与目标不匹配"
    );
  }
  return { ...fence };
}

function validateStagingQuarantineFence(
  value: unknown,
  executorId: string,
  sessionId: string
): DesktopCredentialStagingQuarantineFence {
  if (
    !isExactRecord(value, [
      "version",
      "kind",
      "executorId",
      "sessionId",
      "sourceNonce",
      "expectedDigest"
    ])
  ) {
    throw managerError(
      "desktop_credential_recovery_required",
      "凭据 staging quarantine fence 结构无效"
    );
  }
  const fence = value as unknown as DesktopCredentialStagingQuarantineFence;
  if (
    fence.version !== 1 ||
    fence.kind !== "staging_quarantine" ||
    fence.executorId !== executorId ||
    fence.sessionId !== sessionId ||
    !SAFE_ID.test(fence.executorId) ||
    !SAFE_ID.test(fence.sessionId) ||
    !OWNER_NONCE.test(fence.sourceNonce) ||
    !DIGEST.test(fence.expectedDigest)
  ) {
    throw managerError(
      "desktop_credential_recovery_required",
      "凭据 staging quarantine fence 与目标不匹配"
    );
  }
  return { ...fence };
}

function sameStagingQuarantineFence(
  left: DesktopCredentialStagingQuarantineFence,
  right: DesktopCredentialStagingQuarantineFence
): boolean {
  return (
    left.version === right.version &&
    left.kind === right.kind &&
    left.executorId === right.executorId &&
    left.sessionId === right.sessionId &&
    left.sourceNonce === right.sourceNonce &&
    left.expectedDigest === right.expectedDigest
  );
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

function normalizeQuarantinePromotionError(error: unknown): DesktopCredentialTreeManagerError {
  if (error instanceof DesktopCredentialTreeManagerError) return error;
  const normalized = normalizeTreeError(error);
  if (normalized instanceof DesktopCredentialTreeManagerError) return normalized;
  return managerError(
    "desktop_credential_recovery_required",
    "凭据隔离恢复失败"
  );
}

function normalizeStagingRecoveryError(error: unknown): DesktopCredentialTreeManagerError {
  if (error instanceof DesktopCredentialTreeManagerError) return error;
  const normalized = normalizeTreeError(error);
  if (normalized instanceof DesktopCredentialTreeManagerError) return normalized;
  return managerError(
    "desktop_credential_recovery_required",
    "凭据 staging 恢复失败"
  );
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
