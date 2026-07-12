import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { SafeStorageLike } from "./desktop-device-identity.ts";

const ENVELOPE_MAGIC = Buffer.from("AICRM-EXECUTOR-BINDING-ENC-V1\n", "ascii");
const MAX_FILE_BYTES = 64 << 10;
const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const AUTHORIZATION_SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/;
const DEVICE_ID = /^[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COMMIT_SUFFIX = /^\.commit-([1-9][0-9]{0,15})$/;
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100] as const;
const rootTails = new Map<string, Promise<void>>();

export type DesktopExecutorBindingStatus = "active" | "revoking" | "revoked";
export type DesktopExecutorRevocationResult = "succeeded" | "failed" | "stale_target";

export interface DesktopExecutorBindingState {
  version: 1;
  generation: number;
  status: DesktopExecutorBindingStatus;
  executorId: string;
  deviceId: string;
  credentialRevision: number;
  sourceCredentialRevision: number;
  revocationEpoch: number;
  bindingDigest: string;
  accountFingerprint: string;
  activationOperationId: string;
  activationId: string;
  authorizationSessionId: string;
  activationAckRequestReference: string;
  activationAckRequestHash: string;
  activatedAt: string;
  revocationOperationId: string | null;
  revocationId: string | null;
  revocationStartedAt: string | null;
  revocationResult: DesktopExecutorRevocationResult | null;
  quarantineDigest: string | null;
  revokedAt: string | null;
}

export interface ActivateDesktopExecutorBindingInput {
  executorId: string;
  deviceId: string;
  operationId: string;
  activationId: string;
  authorizationSessionId: string;
  activationAckRequestReference: string;
  activationAckRequestHash: string;
  credentialRevision: number;
  sourceCredentialRevision: number;
  revocationEpoch: number;
  bindingDigest: string;
  accountFingerprint: string;
}

export interface BeginDesktopExecutorBindingRevocationInput {
  executorId: string;
  deviceId: string;
  operationId: string;
  revocationId: string;
  credentialRevision: number;
  revocationEpoch: number;
}

export interface RevokeDesktopExecutorBindingInput
  extends BeginDesktopExecutorBindingRevocationInput {
  result: DesktopExecutorRevocationResult;
  quarantineDigest: string | null;
}

export type DesktopExecutorBindingStateErrorCode =
  | "desktop_executor_binding_conflict"
  | "desktop_executor_binding_corrupt"
  | "desktop_executor_binding_unsafe"
  | "desktop_secure_storage_unavailable";

export class DesktopExecutorBindingStateError extends Error {
  readonly code: DesktopExecutorBindingStateErrorCode;

  constructor(code: DesktopExecutorBindingStateErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type DesktopExecutorBindingStateFaultPoint =
  | "after_temporary_fsync"
  | "after_rename"
  | "before_directory_fsync";

export interface DesktopExecutorBindingStateStoreOptions {
  root: string;
  safeStorage: SafeStorageLike;
  now?: () => Date;
  faultInjector?: (point: DesktopExecutorBindingStateFaultPoint) => void | Promise<void>;
  renameFile?: (source: string, target: string) => Promise<void>;
  syncDirectory?: (directory: string) => Promise<boolean>;
}

/**
 * Main-only local current-binding truth. Activation is recorded after its ACK;
 * logout first records a durable revoking fence and only then touches a
 * credential tree. No state or recovery artifact is exposed through IPC.
 */
export class DesktopExecutorBindingStateStore {
  private readonly root: string;
  private readonly safeStorage: SafeStorageLike;
  private readonly now: () => Date;
  private readonly faultInjector?: DesktopExecutorBindingStateStoreOptions["faultInjector"];
  private readonly renameFile: (source: string, target: string) => Promise<void>;
  private readonly syncDirectory: (directory: string) => Promise<boolean>;

  constructor(options: DesktopExecutorBindingStateStoreOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw bindingError("desktop_executor_binding_unsafe", "执行器绑定目录无效");
    }
    this.safeStorage = options.safeStorage;
    this.now = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
    this.renameFile = options.renameFile ?? rename;
    this.syncDirectory = options.syncDirectory ?? syncDirectory;
  }

  read(executorId: string): Promise<DesktopExecutorBindingState | null> {
    assertSafeId(executorId);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairPending(executorId);
      const state = await this.readTarget(executorId);
      return state ? cloneState(state) : null;
    });
  }

  list(): Promise<DesktopExecutorBindingState[]> {
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      const children = await readdir(this.root, { withFileTypes: true });
      const executorIds = new Set<string>();
      for (const child of children) {
        if (!child.isFile() || child.isSymbolicLink()) {
          throw bindingError("desktop_executor_binding_unsafe", "执行器绑定目录含非法条目");
        }
        const match = /^([A-Za-z0-9_-]{1,120})\.sec(?:\.tmp|\.commit-[1-9][0-9]{0,15})?$/.exec(
          child.name
        );
        if (!match) {
          throw bindingError("desktop_executor_binding_unsafe", "执行器绑定目录含未知文件");
        }
        executorIds.add(match[1]);
      }
      const states: DesktopExecutorBindingState[] = [];
      for (const executorId of [...executorIds].sort()) {
        await this.repairPending(executorId);
        const state = await this.readTarget(executorId);
        if (state) states.push(cloneState(state));
      }
      return states;
    });
  }

  activate(input: ActivateDesktopExecutorBindingInput): Promise<DesktopExecutorBindingState> {
    const candidate = validateActivationInput(input);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairPending(candidate.executorId);
      const current = await this.readTarget(candidate.executorId);
      if (current?.status === "active" && sameActivation(current, candidate)) {
        await this.ensureDurableTarget(current);
        return cloneState(current);
      }
      if (
        current &&
        (current.activationOperationId === candidate.operationId ||
          current.activationId === candidate.activationId)
      ) {
        throw bindingError("desktop_executor_binding_conflict", "执行器激活标识已绑定其他状态");
      }
      assertActivationTransition(current, candidate);
      const next: DesktopExecutorBindingState = {
        version: 1,
        generation: nextGeneration(current),
        status: "active",
        executorId: candidate.executorId,
        deviceId: candidate.deviceId,
        credentialRevision: candidate.credentialRevision,
        sourceCredentialRevision: candidate.sourceCredentialRevision,
        revocationEpoch: candidate.revocationEpoch,
        bindingDigest: candidate.bindingDigest,
        accountFingerprint: candidate.accountFingerprint,
        activationOperationId: candidate.operationId,
        activationId: candidate.activationId,
        authorizationSessionId: candidate.authorizationSessionId,
        activationAckRequestReference: candidate.activationAckRequestReference,
        activationAckRequestHash: candidate.activationAckRequestHash,
        activatedAt: canonicalNow(this.now()),
        revocationOperationId: null,
        revocationId: null,
        revocationStartedAt: null,
        revocationResult: null,
        quarantineDigest: null,
        revokedAt: null
      };
      await this.writeAtomic(next);
      return cloneState(next);
    });
  }

  beginRevocation(
    input: BeginDesktopExecutorBindingRevocationInput
  ): Promise<DesktopExecutorBindingState> {
    const candidate = validateRevocationIntentInput(input);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairPending(candidate.executorId);
      const current = await this.readTarget(candidate.executorId);
      if (current && current.status !== "active" && sameRevocationIntent(current, candidate)) {
        await this.ensureDurableTarget(current);
        return cloneState(current);
      }
      if (
        current &&
        (current.revocationOperationId === candidate.operationId ||
          current.revocationId === candidate.revocationId)
      ) {
        throw bindingError("desktop_executor_binding_conflict", "执行器注销标识已绑定其他状态");
      }
      if (
        current === null ||
        current.status !== "active" ||
        current.executorId !== candidate.executorId ||
        current.deviceId !== candidate.deviceId ||
        current.credentialRevision !== candidate.credentialRevision ||
        !isExactNextRevision(current.revocationEpoch, candidate.revocationEpoch)
      ) {
        throw bindingError("desktop_executor_binding_conflict", "执行器注销目标已变化");
      }
      const next: DesktopExecutorBindingState = {
        ...current,
        generation: nextGeneration(current),
        status: "revoking",
        revocationEpoch: candidate.revocationEpoch,
        revocationOperationId: candidate.operationId,
        revocationId: candidate.revocationId,
        revocationStartedAt: canonicalNow(this.now()),
        revocationResult: null,
        quarantineDigest: null,
        revokedAt: null
      };
      await this.writeAtomic(next);
      return cloneState(next);
    });
  }

  markRevoked(input: RevokeDesktopExecutorBindingInput): Promise<DesktopExecutorBindingState> {
    const candidate = validateRevocationInput(input);
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairPending(candidate.executorId);
      const current = await this.readTarget(candidate.executorId);
      if (current?.status === "revoked" && sameRevocation(current, candidate)) {
        await this.ensureDurableTarget(current);
        return cloneState(current);
      }
      if (
        current === null ||
        current.status !== "revoking" ||
        current.executorId !== candidate.executorId ||
        current.deviceId !== candidate.deviceId ||
        current.credentialRevision !== candidate.credentialRevision ||
        !sameRevocationIntent(current, candidate)
      ) {
        throw bindingError("desktop_executor_binding_conflict", "执行器注销目标已变化");
      }
      const next: DesktopExecutorBindingState = {
        ...current,
        generation: nextGeneration(current),
        status: "revoked",
        revocationResult: candidate.result,
        quarantineDigest: candidate.quarantineDigest,
        revokedAt: canonicalNow(this.now())
      };
      await this.writeAtomic(next);
      return cloneState(next);
    });
  }

  private async writeAtomic(state: DesktopExecutorBindingState): Promise<void> {
    const validated = validateState(state);
    await this.ensureCommitMarker(validated);
    await this.ensureTemporary(validated);
    await this.faultInjector?.("after_temporary_fsync");
    await this.replaceWithRetry(this.temporary(validated.executorId), this.target(validated.executorId));
    await this.faultInjector?.("after_rename");
    await this.finishDurability(validated, true);
  }

  private async repairPending(executorId: string): Promise<void> {
    const targetState = await this.readTarget(executorId);
    const commits = await this.readCommitStates(executorId);
    const temporaryState = await this.readPath(this.temporary(executorId), executorId, true);
    if (commits.length === 0 && temporaryState === null) return;

    const recoveryStates = new Map<number, DesktopExecutorBindingState>();
    for (const commit of commits) {
      addRecoveryState(recoveryStates, commit.state);
    }
    if (temporaryState) addRecoveryState(recoveryStates, temporaryState);

    const ordered = [...recoveryStates.values()].sort((left, right) => left.generation - right.generation);
    let recovered: DesktopExecutorBindingState | null = null;
    if (targetState === null) {
      // A later generation without its predecessor is not a recoverable first
      // write. Promoting it would silently bypass the CAS/tombstone history.
      if (ordered.length !== 1 || ordered[0].generation !== 1) {
        throw bindingError("desktop_executor_binding_corrupt", "执行器绑定恢复缺少前代状态");
      }
      recovered = ordered[0];
    } else {
      const sameGeneration = recoveryStates.get(targetState.generation);
      if (sameGeneration && !sameState(sameGeneration, targetState)) {
        throw bindingError("desktop_executor_binding_corrupt", "执行器绑定同代状态冲突");
      }
      let cursor = targetState;
      for (const candidate of ordered) {
        if (candidate.generation <= cursor.generation) continue;
        if (!validSuccessor(cursor, candidate)) {
          throw bindingError("desktop_executor_binding_corrupt", "执行器绑定恢复代次冲突");
        }
        cursor = candidate;
      }
      if (cursor.generation > targetState.generation) recovered = cursor;
    }

    if (recovered) {
      await this.ensureCommitMarker(recovered);
      await this.ensureTemporary(recovered);
      await this.replaceWithRetry(this.temporary(executorId), this.target(executorId));
      await this.finishDurability(recovered, false);
      return;
    }
    if (targetState) await this.finishDurability(targetState, false);
  }

  private async ensureDurableTarget(state: DesktopExecutorBindingState): Promise<void> {
    await this.finishDurability(state, false);
  }

  private async finishDurability(
    state: DesktopExecutorBindingState,
    injectFaults: boolean
  ): Promise<void> {
    await this.syncRegularFile(this.target(state.executorId));
    const verified = await this.readTarget(state.executorId);
    if (!verified || !sameState(verified, state)) {
      throw bindingError("desktop_executor_binding_corrupt", "执行器绑定替换结果不匹配");
    }
    if (injectFaults) await this.faultInjector?.("before_directory_fsync");
    const directoryDurable = await this.syncDirectory(this.root);
    const commits = await this.readCommitStates(state.executorId);
    await rm(this.temporary(state.executorId), { force: true });
    if (directoryDurable) {
      for (const commit of commits) await rm(commit.file, { force: true });
      const cleanupDurable = await this.syncDirectory(this.root);
      if (!cleanupDurable) {
        await this.ensureCommitMarker(state);
        await this.syncRegularFile(this.commit(state.executorId, state.generation));
      }
      return;
    }

    // Windows commonly cannot fsync a directory handle. Keep one immutable,
    // flushed generation marker as the recovery copy instead of pretending the
    // unsupported directory barrier succeeded.
    await this.ensureCommitMarker(state);
    await this.syncRegularFile(this.commit(state.executorId, state.generation));
    for (const commit of commits) {
      if (commit.state.generation !== state.generation) await rm(commit.file, { force: true });
    }
  }

  private async ensureCommitMarker(state: DesktopExecutorBindingState): Promise<void> {
    const file = this.commit(state.executorId, state.generation);
    const existing = await this.readPath(file, state.executorId, true);
    if (existing) {
      if (!sameState(existing, state)) {
        throw bindingError("desktop_executor_binding_corrupt", "执行器绑定提交标记冲突");
      }
      return;
    }
    await this.writeEnvelopeExclusive(file, state);
  }

  private async ensureTemporary(state: DesktopExecutorBindingState): Promise<void> {
    const temporary = this.temporary(state.executorId);
    const existing = await this.readPath(temporary, state.executorId, true);
    if (existing && sameState(existing, state)) return;
    if (existing) await rm(temporary);
    await this.writeEnvelopeExclusive(temporary, state);
  }

  private async writeEnvelopeExclusive(
    file: string,
    state: DesktopExecutorBindingState
  ): Promise<void> {
    const envelope = this.encryptEnvelope(state);
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

  private encryptEnvelope(state: DesktopExecutorBindingState): Buffer {
    let encrypted: Buffer;
    try {
      encrypted = this.safeStorage.encryptString(JSON.stringify(validateState(state)));
    } catch {
      throw bindingError("desktop_secure_storage_unavailable", "执行器绑定状态加密失败");
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.byteLength < 1) {
      throw bindingError("desktop_secure_storage_unavailable", "执行器绑定状态密文无效");
    }
    const envelope = Buffer.concat([ENVELOPE_MAGIC, encrypted]);
    if (envelope.byteLength > MAX_FILE_BYTES) {
      throw bindingError("desktop_executor_binding_unsafe", "执行器绑定状态超过安全上限");
    }
    return envelope;
  }

  private async readCommitStates(
    executorId: string
  ): Promise<Array<{ file: string; state: DesktopExecutorBindingState }>> {
    const prefix = `${executorId}.sec`;
    const children = await readdir(this.root, { withFileTypes: true });
    const commits: Array<{ file: string; state: DesktopExecutorBindingState }> = [];
    for (const child of children) {
      if (!child.name.startsWith(`${prefix}.commit`)) continue;
      if (!child.isFile() || child.isSymbolicLink()) {
        throw bindingError("desktop_executor_binding_unsafe", "执行器绑定提交标记不安全");
      }
      const match = COMMIT_SUFFIX.exec(child.name.slice(prefix.length));
      const generation = match ? Number(match[1]) : Number.NaN;
      if (!Number.isSafeInteger(generation)) {
        throw bindingError("desktop_executor_binding_unsafe", "执行器绑定提交标记无效");
      }
      const file = path.join(this.root, child.name);
      const state = await this.readPath(file, executorId);
      if (!state || state.generation !== generation) {
        throw bindingError("desktop_executor_binding_corrupt", "执行器绑定提交代次不匹配");
      }
      commits.push({ file, state });
    }
    return commits.sort((left, right) => left.state.generation - right.state.generation);
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
        throw bindingError("desktop_executor_binding_corrupt", "执行器绑定持久化目标已变化");
      }
      await handle.sync();
      const after = await handle.stat();
      assertSafeFile(after);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mode !== after.mode ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        throw bindingError("desktop_executor_binding_corrupt", "执行器绑定持久化目标不稳定");
      }
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

  private readTarget(executorId: string): Promise<DesktopExecutorBindingState | null> {
    return this.readPath(this.target(executorId), executorId, true);
  }

  private async readPath(
    file: string,
    expectedExecutorId: string,
    missingAllowed = false
  ): Promise<DesktopExecutorBindingState | null> {
    let pathInfo;
    try {
      pathInfo = await lstat(file);
    } catch (error) {
      if (missingAllowed && isErrorCode(error, "ENOENT")) return null;
      throw bindingError("desktop_executor_binding_corrupt", "执行器绑定状态无法读取");
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
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        raw.byteLength !== before.size ||
        !raw.subarray(0, ENVELOPE_MAGIC.byteLength).equals(ENVELOPE_MAGIC)
      ) {
        throw bindingError("desktop_executor_binding_corrupt", "执行器绑定状态封套不稳定");
      }
      const plaintext = this.safeStorage.decryptString(raw.subarray(ENVELOPE_MAGIC.byteLength));
      const state = validateState(JSON.parse(plaintext) as unknown);
      if (state.executorId !== expectedExecutorId) {
        throw bindingError("desktop_executor_binding_corrupt", "执行器绑定状态归属不匹配");
      }
      return state;
    } catch (error) {
      if (error instanceof DesktopExecutorBindingStateError) throw error;
      throw bindingError("desktop_executor_binding_corrupt", "执行器绑定状态无法解密");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw bindingError("desktop_executor_binding_unsafe", "执行器绑定目录不安全");
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
      throw bindingError("desktop_secure_storage_unavailable", "系统安全存储不可用");
    }
  }

  private target(executorId: string): string {
    return path.join(this.root, `${executorId}.sec`);
  }

  private temporary(executorId: string): string {
    return path.join(this.root, `${executorId}.sec.tmp`);
  }

  private commit(executorId: string, generation: number): string {
    return path.join(this.root, `${executorId}.sec.commit-${generation}`);
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

function validateState(value: unknown): DesktopExecutorBindingState {
  if (!exactObject(value, [
    "version",
    "generation",
    "status",
    "executorId",
    "deviceId",
    "credentialRevision",
    "sourceCredentialRevision",
    "revocationEpoch",
    "bindingDigest",
    "accountFingerprint",
    "activationOperationId",
    "activationId",
    "authorizationSessionId",
    "activationAckRequestReference",
    "activationAckRequestHash",
    "activatedAt",
    "revocationOperationId",
    "revocationId",
    "revocationStartedAt",
    "revocationResult",
    "quarantineDigest",
    "revokedAt"
  ])) {
    throw bindingError("desktop_executor_binding_corrupt", "执行器绑定状态结构无效");
  }
  const state = value as unknown as DesktopExecutorBindingState;
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 1 ||
    !(["active", "revoking", "revoked"] as const).includes(state.status) ||
    !SAFE_ID.test(state.executorId) ||
    !DEVICE_ID.test(state.deviceId) ||
    !positiveRevision(state.credentialRevision) ||
    !nonNegativeRevision(state.sourceCredentialRevision) ||
    state.sourceCredentialRevision >= state.credentialRevision ||
    !nonNegativeRevision(state.revocationEpoch) ||
    !DIGEST.test(state.bindingDigest) ||
    !DIGEST.test(state.accountFingerprint) ||
    !SAFE_ID.test(state.activationOperationId) ||
    !SAFE_ID.test(state.activationId) ||
    typeof state.authorizationSessionId !== "string" ||
    !AUTHORIZATION_SESSION_ID.test(state.authorizationSessionId) ||
    !DIGEST.test(state.activationAckRequestReference) ||
    !DIGEST.test(state.activationAckRequestHash) ||
    !canonicalTime(state.activatedAt)
  ) {
    throw bindingError("desktop_executor_binding_corrupt", "执行器绑定状态字段无效");
  }
  const activeShape =
    state.revocationOperationId === null &&
    state.revocationId === null &&
    state.revocationStartedAt === null &&
    state.revocationResult === null &&
    state.quarantineDigest === null &&
    state.revokedAt === null;
  const revocationIntentShape =
    typeof state.revocationOperationId === "string" &&
    SAFE_ID.test(state.revocationOperationId) &&
    typeof state.revocationId === "string" &&
    SAFE_ID.test(state.revocationId) &&
    typeof state.revocationStartedAt === "string" &&
    canonicalTime(state.revocationStartedAt);
  const revokingShape =
    revocationIntentShape &&
    state.revocationResult === null &&
    state.quarantineDigest === null &&
    state.revokedAt === null;
  const revokedShape =
    revocationIntentShape &&
    validRevocationResultShape(state.revocationResult, state.quarantineDigest) &&
    typeof state.revokedAt === "string" &&
    canonicalTime(state.revokedAt);
  if (
    (state.status === "active" && !activeShape) ||
    (state.status === "revoking" && !revokingShape) ||
    (state.status === "revoked" && !revokedShape)
  ) {
    throw bindingError("desktop_executor_binding_corrupt", "执行器绑定状态终态字段无效");
  }
  return cloneState(state);
}

function validateActivationInput(
  input: ActivateDesktopExecutorBindingInput
): ActivateDesktopExecutorBindingInput {
  if (
    !exactObject(input, [
      "executorId",
      "deviceId",
      "operationId",
      "activationId",
      "authorizationSessionId",
      "activationAckRequestReference",
      "activationAckRequestHash",
      "credentialRevision",
      "sourceCredentialRevision",
      "revocationEpoch",
      "bindingDigest",
      "accountFingerprint"
    ]) ||
    !SAFE_ID.test(input.executorId) ||
    !DEVICE_ID.test(input.deviceId) ||
    !SAFE_ID.test(input.operationId) ||
    !SAFE_ID.test(input.activationId) ||
    typeof input.authorizationSessionId !== "string" ||
    !AUTHORIZATION_SESSION_ID.test(input.authorizationSessionId) ||
    !DIGEST.test(input.activationAckRequestReference) ||
    !DIGEST.test(input.activationAckRequestHash) ||
    !positiveRevision(input.credentialRevision) ||
    !nonNegativeRevision(input.sourceCredentialRevision) ||
    input.credentialRevision <= input.sourceCredentialRevision ||
    !nonNegativeRevision(input.revocationEpoch) ||
    !DIGEST.test(input.bindingDigest) ||
    !DIGEST.test(input.accountFingerprint)
  ) {
    throw bindingError("desktop_executor_binding_unsafe", "执行器激活绑定参数无效");
  }
  return { ...input };
}

function validateRevocationIntentInput(
  input: BeginDesktopExecutorBindingRevocationInput
): BeginDesktopExecutorBindingRevocationInput {
  if (
    !exactObject(input, [
      "executorId",
      "deviceId",
      "operationId",
      "revocationId",
      "credentialRevision",
      "revocationEpoch"
    ]) ||
    !validRevocationIntentFields(input)
  ) {
    throw bindingError("desktop_executor_binding_unsafe", "执行器注销绑定参数无效");
  }
  return { ...input };
}

function validateRevocationInput(
  input: RevokeDesktopExecutorBindingInput
): RevokeDesktopExecutorBindingInput {
  if (
    !exactObject(input, [
      "executorId",
      "deviceId",
      "operationId",
      "revocationId",
      "credentialRevision",
      "revocationEpoch",
      "result",
      "quarantineDigest"
    ]) ||
    !validRevocationIntentFields(input) ||
    !validRevocationResultShape(input.result, input.quarantineDigest)
  ) {
    throw bindingError("desktop_executor_binding_unsafe", "执行器注销绑定参数无效");
  }
  return { ...input };
}

function assertActivationTransition(
  current: DesktopExecutorBindingState | null,
  next: ActivateDesktopExecutorBindingInput
): void {
  if (current === null) {
    if (next.sourceCredentialRevision === 0) return;
  } else if (current.status === "active") {
    if (
      current.deviceId === next.deviceId &&
      current.credentialRevision === next.sourceCredentialRevision &&
      current.revocationEpoch === next.revocationEpoch &&
      next.credentialRevision > current.credentialRevision &&
      distinctActivationProvenance(current, next)
    ) {
      return;
    }
  } else if (
    current.status === "revoked" &&
    next.sourceCredentialRevision === 0 &&
    next.revocationEpoch === current.revocationEpoch &&
    next.credentialRevision > current.credentialRevision &&
    distinctActivationProvenance(current, next)
  ) {
    return;
  }
  throw bindingError("desktop_executor_binding_conflict", "执行器激活绑定来源已变化");
}

function sameActivation(
  current: DesktopExecutorBindingState,
  input: ActivateDesktopExecutorBindingInput
): boolean {
  return (
    current.executorId === input.executorId &&
    current.deviceId === input.deviceId &&
    current.credentialRevision === input.credentialRevision &&
    current.sourceCredentialRevision === input.sourceCredentialRevision &&
    current.revocationEpoch === input.revocationEpoch &&
    current.bindingDigest === input.bindingDigest &&
    current.accountFingerprint === input.accountFingerprint &&
    current.activationOperationId === input.operationId &&
    current.activationId === input.activationId &&
    current.authorizationSessionId === input.authorizationSessionId &&
    current.activationAckRequestReference === input.activationAckRequestReference &&
    current.activationAckRequestHash === input.activationAckRequestHash
  );
}

function sameRevocation(
  current: DesktopExecutorBindingState,
  input: RevokeDesktopExecutorBindingInput
): boolean {
  return (
    sameRevocationIntent(current, input) &&
    current.revocationResult === input.result &&
    current.quarantineDigest === input.quarantineDigest
  );
}

function sameRevocationIntent(
  current: DesktopExecutorBindingState,
  input: BeginDesktopExecutorBindingRevocationInput
): boolean {
  return (
    current.executorId === input.executorId &&
    current.deviceId === input.deviceId &&
    current.credentialRevision === input.credentialRevision &&
    current.revocationEpoch === input.revocationEpoch &&
    current.revocationOperationId === input.operationId &&
    current.revocationId === input.revocationId
  );
}

function validSuccessor(
  current: DesktopExecutorBindingState,
  next: DesktopExecutorBindingState
): boolean {
  if (
    next.generation !== current.generation + 1 ||
    next.executorId !== current.executorId
  ) {
    return false;
  }
  if (current.status === "active" && next.status === "active") {
    return (
      next.deviceId === current.deviceId &&
      next.sourceCredentialRevision === current.credentialRevision &&
      next.revocationEpoch === current.revocationEpoch &&
      next.credentialRevision > current.credentialRevision &&
      next.activationOperationId !== current.activationOperationId &&
      next.activationId !== current.activationId &&
      distinctActivationProvenance(current, next)
    );
  }
  if (current.status === "active" && next.status === "revoking") {
    return (
      sameActivationStateFields(current, next) &&
      isExactNextRevision(current.revocationEpoch, next.revocationEpoch)
    );
  }
  if (current.status === "revoking" && next.status === "revoked") {
    return (
      sameActivationStateFields(current, next) &&
      sameRevocationStateFields(current, next) &&
      next.revocationResult !== null
    );
  }
  return (
    current.status === "revoked" &&
    next.status === "active" &&
    next.sourceCredentialRevision === 0 &&
    next.revocationEpoch === current.revocationEpoch &&
    next.credentialRevision > current.credentialRevision &&
    next.activationOperationId !== current.activationOperationId &&
    next.activationId !== current.activationId &&
    distinctActivationProvenance(current, next)
  );
}

function distinctActivationProvenance(
  current: DesktopExecutorBindingState,
  next: Pick<
    ActivateDesktopExecutorBindingInput,
    "authorizationSessionId" | "activationAckRequestReference" | "activationAckRequestHash"
  >
): boolean {
  return (
    next.authorizationSessionId !== current.authorizationSessionId &&
    next.activationAckRequestReference !== current.activationAckRequestReference &&
    next.activationAckRequestHash !== current.activationAckRequestHash
  );
}

function sameActivationStateFields(
  left: DesktopExecutorBindingState,
  right: DesktopExecutorBindingState
): boolean {
  return (
    left.executorId === right.executorId &&
    left.deviceId === right.deviceId &&
    left.credentialRevision === right.credentialRevision &&
    left.sourceCredentialRevision === right.sourceCredentialRevision &&
    left.bindingDigest === right.bindingDigest &&
    left.accountFingerprint === right.accountFingerprint &&
    left.activationOperationId === right.activationOperationId &&
    left.activationId === right.activationId &&
    left.authorizationSessionId === right.authorizationSessionId &&
    left.activationAckRequestReference === right.activationAckRequestReference &&
    left.activationAckRequestHash === right.activationAckRequestHash &&
    left.activatedAt === right.activatedAt
  );
}

function sameRevocationStateFields(
  left: DesktopExecutorBindingState,
  right: DesktopExecutorBindingState
): boolean {
  return (
    left.revocationEpoch === right.revocationEpoch &&
    left.revocationOperationId === right.revocationOperationId &&
    left.revocationId === right.revocationId &&
    left.revocationStartedAt === right.revocationStartedAt
  );
}

function nextGeneration(current: DesktopExecutorBindingState | null): number {
  const generation = (current?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) {
    throw bindingError("desktop_executor_binding_conflict", "执行器绑定代次已耗尽");
  }
  return generation;
}

function sameState(left: DesktopExecutorBindingState, right: DesktopExecutorBindingState): boolean {
  return (Object.keys(left) as Array<keyof DesktopExecutorBindingState>).every(
    (key) => left[key] === right[key]
  );
}

function cloneState(state: DesktopExecutorBindingState): DesktopExecutorBindingState {
  return { ...state };
}

function positiveRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isExactNextRevision(current: number, next: number): boolean {
  return Number.isSafeInteger(current) && Number.isSafeInteger(next) && next === current + 1;
}

function validRevocationIntentFields(
  input: BeginDesktopExecutorBindingRevocationInput
): boolean {
  return (
    SAFE_ID.test(input.executorId) &&
    DEVICE_ID.test(input.deviceId) &&
    SAFE_ID.test(input.operationId) &&
    SAFE_ID.test(input.revocationId) &&
    positiveRevision(input.credentialRevision) &&
    positiveRevision(input.revocationEpoch)
  );
}

function validRevocationResultShape(
  result: DesktopExecutorRevocationResult | null,
  quarantineDigest: string | null
): boolean {
  switch (result) {
    case "succeeded":
      return typeof quarantineDigest === "string" && DIGEST.test(quarantineDigest);
    case "failed":
      return quarantineDigest === null || DIGEST.test(quarantineDigest);
    case "stale_target":
      return quarantineDigest === null;
    default:
      return false;
  }
}

function addRecoveryState(
  states: Map<number, DesktopExecutorBindingState>,
  candidate: DesktopExecutorBindingState
): void {
  const existing = states.get(candidate.generation);
  if (existing && !sameState(existing, candidate)) {
    throw bindingError("desktop_executor_binding_corrupt", "执行器绑定同代恢复状态冲突");
  }
  states.set(candidate.generation, candidate);
}

function canonicalNow(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw bindingError("desktop_executor_binding_unsafe", "执行器绑定时间无效");
  }
  return value.toISOString();
}

function canonicalTime(value: string): boolean {
  if (typeof value !== "string" || !CANONICAL_UTC.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertSafeId(value: string): void {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw bindingError("desktop_executor_binding_unsafe", "执行器标识无效");
  }
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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
    throw bindingError("desktop_executor_binding_unsafe", "执行器绑定状态文件不安全");
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return isErrorCode(error, "EINVAL") || isErrorCode(error, "EPERM") || isErrorCode(error, "ENOTSUP");
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function bindingError(
  code: DesktopExecutorBindingStateErrorCode,
  message: string
): DesktopExecutorBindingStateError {
  return new DesktopExecutorBindingStateError(code, message);
}
