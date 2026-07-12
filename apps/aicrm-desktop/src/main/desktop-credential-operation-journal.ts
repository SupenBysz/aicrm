import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { SafeStorageLike } from "./desktop-device-identity.ts";

const ENVELOPE_MAGIC = Buffer.from("AICRM-CREDENTIAL-OP-ENC-V1\n", "ascii");
const MAX_JOURNAL_BYTES = 64 << 10;
const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export type DesktopCredentialPromotionSourceKind = "staging" | "operation";
export type DesktopCredentialOperationPhase =
  | "prepared"
  | "reserved"
  | "source_durable"
  | "renamed"
  | "immutable"
  | "verified"
  | "quarantined";

/** A future ACK replay may retain only a hash or an opaque secret-store reference. */
export interface DesktopCredentialAckReplayReference {
  tokenHash: string | null;
  tokenReference: string | null;
}

export interface DesktopCredentialOperationRecord {
  version: 1;
  executorId: string;
  operationId: string;
  sourceKind: DesktopCredentialPromotionSourceKind;
  sourceId: string;
  targetRevision: number;
  expectedDigest: string;
  phase: DesktopCredentialOperationPhase;
  createdAt: string;
  ackReplay: DesktopCredentialAckReplayReference | null;
}

export interface DesktopCredentialOperationProjection {
  executorId: string;
  operationId: string;
  sourceKind: DesktopCredentialPromotionSourceKind;
  sourceId: string;
  targetRevision: number;
  expectedDigest: string;
  phase: DesktopCredentialOperationPhase;
  createdAt: string;
  ackReplay: DesktopCredentialAckReplayReference | null;
}

export type DesktopCredentialJournalErrorCode =
  | "desktop_credential_secure_storage_unavailable"
  | "desktop_credential_journal_corrupt"
  | "desktop_credential_journal_unsafe";

export class DesktopCredentialJournalError extends Error {
  readonly code: DesktopCredentialJournalErrorCode;

  constructor(code: DesktopCredentialJournalErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DesktopCredentialOperationJournalOptions {
  root: string;
  safeStorage: SafeStorageLike;
}

/** Main-only safeStorage envelope for promotion recovery metadata. */
export class DesktopCredentialOperationJournalStore {
  private readonly root: string;
  private readonly safeStorage: SafeStorageLike;

  constructor(options: DesktopCredentialOperationJournalOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw journalError("desktop_credential_journal_unsafe", "凭据操作日志目录无效");
    }
    this.safeStorage = options.safeStorage;
  }

  async save(value: DesktopCredentialOperationRecord): Promise<void> {
    const record = validateRecord(value);
    this.assertSecureStorage();
    await this.ensureRoot();
    let ciphertext: Buffer;
    try {
      ciphertext = this.safeStorage.encryptString(JSON.stringify(record));
    } catch {
      throw journalError("desktop_credential_secure_storage_unavailable", "凭据操作日志加密失败");
    }
    if (!Buffer.isBuffer(ciphertext) || ciphertext.byteLength < 1) {
      throw journalError("desktop_credential_secure_storage_unavailable", "凭据操作日志密文无效");
    }
    const envelope = Buffer.concat([ENVELOPE_MAGIC, ciphertext]);
    if (envelope.byteLength > MAX_JOURNAL_BYTES) {
      throw journalError("desktop_credential_journal_unsafe", "凭据操作日志超过安全上限");
    }
    await this.writeAtomic(record.operationId, envelope);
  }

  async load(operationId: string): Promise<DesktopCredentialOperationRecord | null> {
    assertSafeId(operationId);
    this.assertSecureStorage();
    await this.ensureRoot();
    await this.repairTemporary(operationId);
    const target = this.target(operationId);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw journalError("desktop_credential_journal_corrupt", "凭据操作日志读取失败");
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > MAX_JOURNAL_BYTES) {
      throw journalError("desktop_credential_journal_unsafe", "凭据操作日志文件不安全");
    }
    if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
      throw journalError("desktop_credential_journal_unsafe", "凭据操作日志权限不安全");
    }
    const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
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
        before.size > MAX_JOURNAL_BYTES ||
        (process.platform !== "win32" && (before.mode & 0o777) !== 0o600) ||
        before.dev !== info.dev ||
        before.ino !== info.ino ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        raw.byteLength !== before.size ||
        !raw.subarray(0, ENVELOPE_MAGIC.byteLength).equals(ENVELOPE_MAGIC)
      ) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志封套无效");
      }
      const plaintext = this.safeStorage.decryptString(raw.subarray(ENVELOPE_MAGIC.byteLength));
      const record = validateRecord(JSON.parse(plaintext) as unknown);
      if (record.operationId !== operationId) {
        throw journalError("desktop_credential_journal_corrupt", "凭据操作日志标识不匹配");
      }
      return record;
    } catch (error) {
      if (error instanceof DesktopCredentialJournalError) throw error;
      throw journalError("desktop_credential_journal_corrupt", "凭据操作日志无法解密");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async listOperationIds(): Promise<string[]> {
    this.assertSecureStorage();
    await this.ensureRoot();
    const children = await readdir(this.root, { withFileTypes: true });
    const ids = new Set<string>();
    for (const child of children) {
      if (!child.isFile() || child.isSymbolicLink()) {
        throw journalError("desktop_credential_journal_unsafe", "凭据操作日志目录包含非法条目");
      }
      let match = /^([A-Za-z0-9_-]{1,120})\.sec$/.exec(child.name);
      if (match) {
        ids.add(match[1]);
        continue;
      }
      match = /^([A-Za-z0-9_-]{1,120})\.sec\.tmp$/.exec(child.name);
      if (!match) {
        throw journalError("desktop_credential_journal_unsafe", "凭据操作日志目录包含非法文件");
      }
      ids.add(match[1]);
    }
    for (const id of ids) await this.repairTemporary(id);
    return [...ids].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  }

  async removeVerified(expected: DesktopCredentialOperationRecord): Promise<void> {
    const record = validateRecord(expected);
    if (record.phase !== "verified") {
      throw journalError("desktop_credential_journal_unsafe", "仅已验证凭据操作可在 ACK 后清理");
    }
    await this.ensureRoot();
    const current = await this.load(record.operationId);
    if (current === null || JSON.stringify(current) !== JSON.stringify(record)) {
      throw journalError("desktop_credential_journal_corrupt", "凭据 ACK 清理栅栏不匹配");
    }
    await rm(this.target(record.operationId));
    await rm(this.temporary(record.operationId), { force: true });
    await syncDirectory(this.root);
  }

  projection(record: DesktopCredentialOperationRecord): DesktopCredentialOperationProjection {
    const value = validateRecord(record);
    return {
      executorId: value.executorId,
      operationId: value.operationId,
      sourceKind: value.sourceKind,
      sourceId: value.sourceId,
      targetRevision: value.targetRevision,
      expectedDigest: value.expectedDigest,
      phase: value.phase,
      createdAt: value.createdAt,
      ackReplay: value.ackReplay === null ? null : { ...value.ackReplay }
    };
  }

  private target(operationId: string): string {
    return path.join(this.root, `${operationId}.sec`);
  }

  private temporary(operationId: string): string {
    return path.join(this.root, `${operationId}.sec.tmp`);
  }

  private async writeAtomic(operationId: string, value: Buffer): Promise<void> {
    const target = this.target(operationId);
    const temporary = this.temporary(operationId);
    await rm(temporary, { force: true });
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(value);
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await syncDirectory(this.root);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  }

  private async repairTemporary(operationId: string): Promise<void> {
    const temporary = this.temporary(operationId);
    let temporaryInfo;
    try {
      temporaryInfo = await lstat(temporary);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw journalError("desktop_credential_journal_corrupt", "凭据操作临时日志读取失败");
    }
    if (
      !temporaryInfo.isFile() ||
      temporaryInfo.isSymbolicLink() ||
      temporaryInfo.nlink !== 1 ||
      temporaryInfo.size < 1 ||
      temporaryInfo.size > MAX_JOURNAL_BYTES ||
      (process.platform !== "win32" && (temporaryInfo.mode & 0o777) !== 0o600)
    ) {
      throw journalError("desktop_credential_journal_unsafe", "凭据操作临时日志不安全");
    }
    try {
      await lstat(this.target(operationId));
      await rm(temporary);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      await rename(temporary, this.target(operationId));
    }
    await syncDirectory(this.root);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw journalError("desktop_credential_journal_unsafe", "凭据操作日志目录不安全");
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
      throw journalError("desktop_credential_secure_storage_unavailable", "系统安全存储不可用");
    }
  }
}

function validateRecord(value: unknown): DesktopCredentialOperationRecord {
  if (!isExactRecord(value, [
    "version",
    "executorId",
    "operationId",
    "sourceKind",
    "sourceId",
    "targetRevision",
    "expectedDigest",
    "phase",
    "createdAt",
    "ackReplay"
  ])) {
    throw journalError("desktop_credential_journal_corrupt", "凭据操作日志结构无效");
  }
  const record = value as unknown as DesktopCredentialOperationRecord;
  assertSafeId(record.executorId);
  assertSafeId(record.operationId);
  assertSafeId(record.sourceId);
  if (
    record.version !== 1 ||
    (record.sourceKind !== "staging" && record.sourceKind !== "operation") ||
    !Number.isSafeInteger(record.targetRevision) ||
    record.targetRevision < 1 ||
    !DIGEST.test(record.expectedDigest) ||
    !["prepared", "reserved", "source_durable", "renamed", "immutable", "verified", "quarantined"].includes(record.phase) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    (record.ackReplay !== null && !validAckReplay(record.ackReplay))
  ) {
    throw journalError("desktop_credential_journal_corrupt", "凭据操作日志字段无效");
  }
  return {
    ...record,
    ackReplay: record.ackReplay === null ? null : { ...record.ackReplay }
  };
}

function validAckReplay(value: unknown): value is DesktopCredentialAckReplayReference {
  if (!isExactRecord(value, ["tokenHash", "tokenReference"])) return false;
  const candidate = value as unknown as DesktopCredentialAckReplayReference;
  return (
    (candidate.tokenHash === null || DIGEST.test(candidate.tokenHash)) &&
    (candidate.tokenReference === null || SAFE_ID.test(candidate.tokenReference)) &&
    (candidate.tokenHash !== null || candidate.tokenReference !== null)
  );
}

function assertSafeId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw journalError("desktop_credential_journal_unsafe", "凭据操作日志标识无效");
  }
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform === "win32" && isUnsupportedDirectorySync(error)) return;
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

function journalError(code: DesktopCredentialJournalErrorCode, message: string): DesktopCredentialJournalError {
  return new DesktopCredentialJournalError(code, message);
}
