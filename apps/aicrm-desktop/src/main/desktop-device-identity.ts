import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  buildDesktopDeviceProof,
  createDeviceNonce,
  generateDesktopDeviceKeyMaterial,
  validateDesktopDeviceKeyMaterial,
  type DesktopDeviceKeyMaterial,
  type DesktopDeviceProof
} from "./desktop-device-proof.ts";

const IDENTITY_FILE = "identity.sec";
const SEQUENCE_FILE = "sequence.sec";
const REGISTRATION_RESET_FILE = "registration-reset.sec";
const REGISTRATION_PENDING_FILE = "registration-pending.sec";
const DEVICE_REGISTRATION_PATH = "/api/v1/ai-executor-devices";
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;

export type DesktopDeviceIdentityErrorCode =
  | "desktop_secure_storage_unavailable"
  | "desktop_device_identity_corrupt"
  | "desktop_device_identity_unsafe"
  | "desktop_device_identity_reset_forbidden"
  | "desktop_device_registration_recovery_required"
  | "desktop_device_sequence_exhausted";

export class DesktopDeviceIdentityError extends Error {
  readonly code: DesktopDeviceIdentityErrorCode;

  constructor(code: DesktopDeviceIdentityErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export type DesktopDeviceRegistrationStatus = "unregistered" | "registered" | "revoked";

export interface DesktopDeviceIdentityProjection {
  deviceId: string;
  publicKey: string;
  keyGeneration: number;
  registrationStatus: DesktopDeviceRegistrationStatus;
  createdAt: string;
  registeredAt: string | null;
}

export interface SignDesktopDeviceRequestInput {
  method: string;
  path: string;
  body: Uint8Array;
  authorization?: string;
  allowedAuthorizationSchemes?: string[];
  timestamp?: number;
  nonce?: string;
}

export interface SignedDesktopDeviceRequest extends DesktopDeviceProof {
  deviceId: string;
  publicKey: string;
  keyGeneration: number;
  sequence: string;
}

export interface DesktopDeviceRegistrationSequenceFence {
  deviceId: string;
  publicKey: string;
  keyGeneration: number;
  sequence: string;
}

interface StoredIdentity extends DesktopDeviceKeyMaterial {
  version: 1;
  keyGeneration: number;
  lastSequence: string;
  registrationStatus: DesktopDeviceRegistrationStatus;
  createdAt: string;
  registeredAt: string | null;
}

interface StoredSequence {
  version: 1;
  deviceId: string;
  keyGeneration: number;
  lastSequence: string;
}

interface StoredRegistrationReset {
  version: 1;
  previousDeviceId: string;
  startedAt: string;
}

export interface DesktopDeviceIdentityStoreOptions {
  root: string;
  safeStorage: SafeStorageLike;
  keyFactory?: () => DesktopDeviceKeyMaterial;
  now?: () => Date;
}

/**
 * Main-process-only identity store. The Electron single-instance lock is the
 * process-level exclusion boundary; this class serializes every local mutation
 * and durably advances sequence before a signed request leaves Main.
 */
export class DesktopDeviceIdentityStore {
  private readonly root: string;
  private readonly identityPath: string;
  private readonly sequencePath: string;
  private readonly registrationResetPath: string;
  private readonly safeStorage: SafeStorageLike;
  private readonly keyFactory: () => DesktopDeviceKeyMaterial;
  private readonly now: () => Date;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: DesktopDeviceIdentityStoreOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw identityError("desktop_device_identity_unsafe", "设备身份目录无效");
    }
    this.identityPath = path.join(this.root, IDENTITY_FILE);
    this.sequencePath = path.join(this.root, SEQUENCE_FILE);
    this.registrationResetPath = path.join(this.root, REGISTRATION_RESET_FILE);
    this.safeStorage = options.safeStorage;
    this.keyFactory = options.keyFactory ?? generateDesktopDeviceKeyMaterial;
    this.now = options.now ?? (() => new Date());
  }

  getIdentity(): Promise<DesktopDeviceIdentityProjection> {
    return this.exclusive(async () => projection(await this.loadOrCreate()));
  }

  signRequest(input: SignDesktopDeviceRequestInput): Promise<SignedDesktopDeviceRequest> {
    return this.exclusive(async () => {
      const identity = await this.loadOrCreate();
      const previous = parseSequence(identity.lastSequence);
      if (previous >= MAX_UINT64) {
        throw identityError("desktop_device_sequence_exhausted", "设备请求序列已耗尽");
      }
      const sequence = previous + 1n;
      const timestamp = input.timestamp ?? this.now().getTime();
      const nonce = input.nonce ?? createDeviceNonce();
      // Construct first, but do not return it until both durable counters have
      // advanced. A failed persistence may consume a sequence but cannot reuse it.
      const proof = buildDesktopDeviceProof({
        key: identity,
        method: input.method,
        path: input.path,
        body: input.body,
        authorization: input.authorization,
        allowedAuthorizationSchemes: input.allowedAuthorizationSchemes,
        timestamp,
        nonce,
        sequence
      });
      identity.lastSequence = sequence.toString(10);
      await this.writeEncrypted(this.identityPath, identity);
      await this.writeEncrypted(this.sequencePath, sequenceState(identity));
      return {
        ...proof,
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        keyGeneration: identity.keyGeneration,
        sequence: identity.lastSequence
      };
    });
  }

  /**
   * Persists the exact signed registration request before advancing either
   * local high-water record. If Main crashes after `persistPending` returns,
   * the pending request is sufficient to repair sequence 1 and replay the
   * server ledger entry without ever allocating sequence 2.
   */
  prepareRegistrationRequest(
    input: SignDesktopDeviceRequestInput,
    persistPending: (request: SignedDesktopDeviceRequest) => Promise<void>
  ): Promise<SignedDesktopDeviceRequest> {
    return this.exclusive(async () => {
      const identity = await this.loadOrCreate();
      if (
        identity.registrationStatus !== "unregistered" ||
        parseSequence(identity.lastSequence) !== 0n ||
        input.method !== "POST" ||
        input.path !== DEVICE_REGISTRATION_PATH ||
        typeof input.authorization !== "string" ||
        !input.authorization.startsWith("Bearer ") ||
        input.allowedAuthorizationSchemes?.length !== 1 ||
        input.allowedAuthorizationSchemes[0] !== "Bearer"
      ) {
        throw identityError(
          "desktop_device_registration_recovery_required",
          "设备首次登记序列需要恢复"
        );
      }
      const timestamp = input.timestamp ?? this.now().getTime();
      const nonce = input.nonce ?? createDeviceNonce();
      const proof = buildDesktopDeviceProof({
        key: identity,
        method: input.method,
        path: input.path,
        body: input.body,
        authorization: input.authorization,
        allowedAuthorizationSchemes: input.allowedAuthorizationSchemes,
        timestamp,
        nonce,
        sequence: 1n
      });
      const signed: SignedDesktopDeviceRequest = {
        ...proof,
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        keyGeneration: identity.keyGeneration,
        sequence: "1"
      };
      // This must complete and fsync before either high-water file advances.
      await persistPending(signed);
      identity.lastSequence = "1";
      await this.writeEncrypted(this.identityPath, identity);
      await this.writeEncrypted(this.sequencePath, sequenceState(identity));
      return signed;
    });
  }

  /** Repairs a crash between durable pending creation and high-water commit. */
  repairRegistrationSequence(fence: DesktopDeviceRegistrationSequenceFence): Promise<void> {
    return this.exclusive(async () => {
      const identity = await this.loadOrCreate();
      if (
        identity.registrationStatus !== "unregistered" ||
        fence.sequence !== "1" ||
        fence.deviceId !== identity.deviceId ||
        fence.publicKey !== identity.publicKey ||
        fence.keyGeneration !== identity.keyGeneration ||
        identity.keyGeneration !== 1
      ) {
        throw identityError(
          "desktop_device_registration_recovery_required",
          "设备登记恢复栅栏不匹配"
        );
      }
      const current = parseSequence(identity.lastSequence);
      if (current > 1n) {
        throw identityError(
          "desktop_device_registration_recovery_required",
          "设备登记序列已越过首次登记"
        );
      }
      if (current === 1n) return;
      identity.lastSequence = "1";
      await this.writeEncrypted(this.identityPath, identity);
      await this.writeEncrypted(this.sequencePath, sequenceState(identity));
    });
  }

  markRegistration(status: DesktopDeviceRegistrationStatus, expectedDeviceId: string): Promise<DesktopDeviceIdentityProjection> {
    return this.exclusive(async () => {
      const identity = await this.loadOrCreate();
      if (identity.deviceId !== expectedDeviceId || !["unregistered", "registered", "revoked"].includes(status)) {
        throw identityError("desktop_device_identity_corrupt", "设备登记目标不匹配");
      }
	  if (
		(identity.registrationStatus === "revoked" && status !== "revoked") ||
		(status === "unregistered" && identity.registrationStatus !== "unregistered")
	  ) {
		throw identityError("desktop_device_identity_corrupt", "设备登记状态不可逆");
	  }
	  const alreadyRegistered = identity.registrationStatus === "registered" && status === "registered";
      identity.registrationStatus = status;
	  identity.registeredAt = status === "registered" ? (alreadyRegistered ? identity.registeredAt : this.now().toISOString()) : null;
      await this.writeEncrypted(this.identityPath, identity);
      return projection(identity);
    });
  }

  /**
   * Starts an explicitly authorized recovery reset with a durable marker before
   * any pending request or key file is removed. A crash leaves enough evidence
   * for the next Main process to complete the reset without reviving the old
   * identity. Registered and revoked identities are never reset here.
   */
  resetRegistrationRecovery(
    expectedDeviceId: string,
    clearPending: () => Promise<void>
  ): Promise<DesktopDeviceIdentityProjection> {
    return this.exclusive(async () => {
      const identity = await this.loadOrCreate();
      if (identity.deviceId !== expectedDeviceId) {
        throw identityError(
          "desktop_device_registration_recovery_required",
          "设备登记恢复目标不匹配"
        );
      }
      if (identity.registrationStatus !== "unregistered") {
        throw identityError(
          "desktop_device_identity_reset_forbidden",
          "已登记或已撤销设备禁止本地重置"
        );
      }
      await this.writeEncrypted(this.registrationResetPath, {
        version: 1,
        previousDeviceId: identity.deviceId,
        startedAt: this.now().toISOString()
      });
      await clearPending();
      await this.recoverRegistrationReset();
      return projection(await this.loadOrCreate());
    });
  }

  private async loadOrCreate(): Promise<StoredIdentity> {
    this.assertSecureStorage();
    await this.ensureRoot();
    await this.recoverRegistrationReset();
    const [identityExists, sequenceExists] = await Promise.all([
      regularFileExists(this.identityPath),
      regularFileExists(this.sequencePath)
    ]);
    if (!identityExists && sequenceExists) {
      throw identityError("desktop_device_identity_corrupt", "设备身份主记录缺失");
    }
    if (!identityExists) {
      const key = validateDesktopDeviceKeyMaterial(this.keyFactory());
      const identity: StoredIdentity = {
        version: 1,
        ...key,
        keyGeneration: 1,
        lastSequence: "0",
        registrationStatus: "unregistered",
        createdAt: this.now().toISOString(),
        registeredAt: null
      };
      validateIdentity(identity);
      await this.writeEncrypted(this.identityPath, identity);
      await this.writeEncrypted(this.sequencePath, sequenceState(identity));
      return identity;
    }
    const identity = validateIdentity(await this.readEncrypted(this.identityPath));
    if (!sequenceExists) {
      await this.writeEncrypted(this.sequencePath, sequenceState(identity));
      return identity;
    }
    const sequence = validateSequence(await this.readEncrypted(this.sequencePath));
    if (sequence.deviceId !== identity.deviceId || sequence.keyGeneration !== identity.keyGeneration) {
      throw identityError("desktop_device_identity_corrupt", "设备序列与身份不匹配");
    }
    const durable = parseSequence(sequence.lastSequence);
    const embedded = parseSequence(identity.lastSequence);
    const highWater = durable > embedded ? durable : embedded;
    if (durable !== highWater || embedded !== highWater) {
      identity.lastSequence = highWater.toString(10);
      await this.writeEncrypted(this.identityPath, identity);
      await this.writeEncrypted(this.sequencePath, sequenceState(identity));
    }
    return identity;
  }

  private async recoverRegistrationReset(): Promise<void> {
    if (!(await regularFileExists(this.registrationResetPath))) return;
    const marker = validateRegistrationReset(await this.readEncrypted(this.registrationResetPath));
    if (await regularFileExists(this.identityPath)) {
      const identity = validateIdentity(await this.readEncrypted(this.identityPath));
      if (identity.deviceId !== marker.previousDeviceId) {
        await rm(this.registrationResetPath);
        await syncDirectory(this.root);
        return;
      }
      if (identity.registrationStatus !== "unregistered") {
        throw identityError(
          "desktop_device_identity_reset_forbidden",
          "恢复标记不得重置已登记或已撤销设备"
        );
      }
    }
    // The encrypted reset marker is the durable authorization to remove the
    // one fixed pending-registration record as part of the same recoverable
    // local transaction, including after a process crash in clearPending().
    await rm(path.join(this.root, REGISTRATION_PENDING_FILE), { force: true });
    await rm(this.identityPath, { force: true });
    await rm(this.sequencePath, { force: true });
    await syncDirectory(this.root);
    await rm(this.registrationResetPath, { force: true });
    await syncDirectory(this.root);
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
      throw identityError("desktop_secure_storage_unavailable", "系统安全存储不可用");
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw identityError("desktop_device_identity_unsafe", "设备身份目录不安全");
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw identityError("desktop_device_identity_unsafe", "设备身份目录权限不安全");
    }
    if (process.platform !== "win32") await chmod(this.root, 0o700);
  }

  private async readEncrypted(file: string): Promise<unknown> {
	const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
	let handle;
    try {
	  handle = await open(file, flags);
	  const info = await handle.stat();
	  if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 64 << 10) {
		throw identityError("desktop_device_identity_unsafe", "设备身份文件不安全");
	  }
	  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
		throw identityError("desktop_device_identity_unsafe", "设备身份文件权限不安全");
	  }
	  const decrypted = this.safeStorage.decryptString(await handle.readFile());
	  return JSON.parse(decrypted) as unknown;
	} catch (error) {
	  if (error instanceof DesktopDeviceIdentityError) throw error;
      throw identityError("desktop_device_identity_corrupt", "设备身份无法解密");
	} finally {
	  await handle?.close().catch(() => undefined);
    }
  }

  private async writeEncrypted(
    file: string,
    value: StoredIdentity | StoredSequence | StoredRegistrationReset
  ): Promise<void> {
    let encrypted: Buffer;
    try {
      encrypted = this.safeStorage.encryptString(JSON.stringify(value));
    } catch {
      throw identityError("desktop_secure_storage_unavailable", "系统安全存储写入失败");
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.byteLength < 1 || encrypted.byteLength > 64 << 10) {
      throw identityError("desktop_secure_storage_unavailable", "系统安全存储返回无效数据");
    }
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
	  const handle = await open(temporary, "wx", 0o600);
	  try {
		await handle.writeFile(encrypted);
		await handle.sync();
	  } finally {
		await handle.close();
	  }
	  if (process.platform !== "win32") await chmod(temporary, 0o600);
	  await rename(temporary, file);
	  if (process.platform !== "win32") await chmod(file, 0o600);
	  await syncDirectory(this.root);
	} catch (error) {
	  await rm(temporary, { force: true }).catch(() => undefined);
	  throw error;
    }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

function projection(identity: StoredIdentity): DesktopDeviceIdentityProjection {
  return {
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    keyGeneration: identity.keyGeneration,
    registrationStatus: identity.registrationStatus,
    createdAt: identity.createdAt,
    registeredAt: identity.registeredAt
  };
}

function sequenceState(identity: StoredIdentity): StoredSequence {
  return {
    version: 1,
    deviceId: identity.deviceId,
    keyGeneration: identity.keyGeneration,
    lastSequence: identity.lastSequence
  };
}

function validateIdentity(value: unknown): StoredIdentity {
  if (!isExactRecord(value, [
    "version",
    "publicKey",
    "privateKeyPkcs8",
    "deviceId",
    "keyGeneration",
    "lastSequence",
    "registrationStatus",
    "createdAt",
    "registeredAt"
  ])) {
    throw identityError("desktop_device_identity_corrupt", "设备身份结构无效");
  }
  const identity = value as unknown as StoredIdentity;
  try {
    validateDesktopDeviceKeyMaterial(identity);
  } catch {
    throw identityError("desktop_device_identity_corrupt", "设备身份密钥无效");
  }
  if (
    identity.version !== 1 ||
    !Number.isSafeInteger(identity.keyGeneration) ||
    identity.keyGeneration < 1 ||
    !["unregistered", "registered", "revoked"].includes(identity.registrationStatus) ||
    !validISOString(identity.createdAt) ||
    (identity.registeredAt !== null && !validISOString(identity.registeredAt))
  ) {
    throw identityError("desktop_device_identity_corrupt", "设备身份字段无效");
  }
  parseSequence(identity.lastSequence);
  return identity;
}

function validateSequence(value: unknown): StoredSequence {
  if (!isExactRecord(value, ["version", "deviceId", "keyGeneration", "lastSequence"])) {
    throw identityError("desktop_device_identity_corrupt", "设备序列结构无效");
  }
  const sequence = value as unknown as StoredSequence;
  if (
    sequence.version !== 1 ||
    !/^[0-9a-f]{64}$/.test(sequence.deviceId) ||
    !Number.isSafeInteger(sequence.keyGeneration) ||
    sequence.keyGeneration < 1
  ) {
    throw identityError("desktop_device_identity_corrupt", "设备序列字段无效");
  }
  parseSequence(sequence.lastSequence);
  return sequence;
}

function validateRegistrationReset(value: unknown): StoredRegistrationReset {
  if (!isExactRecord(value, ["version", "previousDeviceId", "startedAt"])) {
    throw identityError("desktop_device_identity_corrupt", "设备登记恢复标记无效");
  }
  const marker = value as unknown as StoredRegistrationReset;
  if (
    marker.version !== 1 ||
    !/^[0-9a-f]{64}$/.test(marker.previousDeviceId) ||
    !validISOString(marker.startedAt)
  ) {
    throw identityError("desktop_device_identity_corrupt", "设备登记恢复标记字段无效");
  }
  return marker;
}

function parseSequence(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw identityError("desktop_device_identity_corrupt", "设备序列格式无效");
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > MAX_UINT64) {
    throw identityError("desktop_device_identity_corrupt", "设备序列超出范围");
  }
  return parsed;
}

function isExactRecord(value: unknown, expectedKeys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validISOString(value: string): boolean {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

async function regularFileExists(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw identityError("desktop_device_identity_unsafe", "设备身份路径不安全");
    }
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function identityError(code: DesktopDeviceIdentityErrorCode, message: string): DesktopDeviceIdentityError {
  return new DesktopDeviceIdentityError(code, message);
}
