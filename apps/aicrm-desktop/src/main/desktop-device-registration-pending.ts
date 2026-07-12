import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { SafeStorageLike, SignedDesktopDeviceRequest } from "./desktop-device-identity.ts";
import {
  DEVICE_SIGNATURE_DOMAIN,
  hashAuthorizationToken,
  sha256Hex,
  validateDeviceNonce,
  verifyDesktopDeviceSigningInput
} from "./desktop-device-proof.ts";

const PENDING_FILE = "registration-pending.sec";
const TEMPORARY_PREFIX = `${PENDING_FILE}.tmp-`;
const REGISTRATION_PATH = "/api/v1/ai-executor-devices";
const MAX_ENCRYPTED_BYTES = 128 << 10;
const MAX_BODY_BYTES = 16 << 10;
const DEVICE_ID_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type DesktopDevicePendingRegistrationErrorCode =
  | "desktop_device_registration_recovery_required"
  | "desktop_secure_storage_unavailable";

export class DesktopDevicePendingRegistrationError extends Error {
  readonly code: DesktopDevicePendingRegistrationErrorCode;

  constructor(code: DesktopDevicePendingRegistrationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Encrypted, Main-only replay record. It intentionally contains no private key;
 * the exact Bearer and signed request remain protected by Electron safeStorage.
 */
export interface DesktopDevicePendingRegistration {
  version: 1;
  method: "POST";
  path: string;
  authorization: string;
  bodyBase64: string;
  headers: Record<string, string>;
  bodySha256: string;
  authorizationTokenHash: string;
  signingInput: string;
  requestHash: string;
  deviceId: string;
  publicKey: string;
  keyGeneration: number;
  sequence: string;
  createdAt: string;
}

export interface CreateDesktopDevicePendingRegistrationInput {
  body: Uint8Array;
  authorization: string;
  signed: SignedDesktopDeviceRequest;
  createdAt: string;
}

export interface DesktopDevicePendingRegistrationStoreOptions {
  root: string;
  safeStorage: SafeStorageLike;
}

export function createDesktopDevicePendingRegistration(
  input: CreateDesktopDevicePendingRegistrationInput
): DesktopDevicePendingRegistration {
  const candidate: DesktopDevicePendingRegistration = {
    version: 1,
    method: "POST",
    path: REGISTRATION_PATH,
    authorization: input.authorization,
    bodyBase64: Buffer.from(input.body).toString("base64"),
    headers: { ...input.signed.headers },
    bodySha256: input.signed.bodySha256,
    authorizationTokenHash: input.signed.authorizationTokenHash,
    signingInput: input.signed.signingInput,
    requestHash: input.signed.requestHash,
    deviceId: input.signed.deviceId,
    publicKey: input.signed.publicKey,
    keyGeneration: input.signed.keyGeneration,
    sequence: input.signed.sequence,
    createdAt: input.createdAt
  };
  return validatePending(candidate);
}

export function pendingRegistrationBody(value: DesktopDevicePendingRegistration): Buffer {
  const pending = validatePending(value);
  return decodeCanonicalBase64(pending.bodyBase64, MAX_BODY_BYTES);
}

export function pendingRegistrationSignedRequest(
  value: DesktopDevicePendingRegistration
): SignedDesktopDeviceRequest {
  const pending = validatePending(value);
  return {
    headers: { ...pending.headers },
    bodySha256: pending.bodySha256,
    authorizationTokenHash: pending.authorizationTokenHash,
    signingInput: pending.signingInput,
    requestHash: pending.requestHash,
    deviceId: pending.deviceId,
    publicKey: pending.publicKey,
    keyGeneration: pending.keyGeneration,
    sequence: pending.sequence
  };
}

export class DesktopDevicePendingRegistrationStore {
  private readonly root: string;
  private readonly pendingPath: string;
  private readonly safeStorage: SafeStorageLike;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: DesktopDevicePendingRegistrationStoreOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw pendingError("desktop_device_registration_recovery_required", "设备登记目录无效");
    }
    this.pendingPath = path.join(this.root, PENDING_FILE);
    this.safeStorage = options.safeStorage;
  }

  load(): Promise<DesktopDevicePendingRegistration | null> {
    return this.exclusive(() => this.loadLocked());
  }

  create(value: DesktopDevicePendingRegistration): Promise<void> {
    return this.exclusive(async () => {
      const pending = validatePending(value);
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.cleanupTemporaryFiles();
      const existing = await this.readIfExists();
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(pending)) return;
        throw pendingError(
          "desktop_device_registration_recovery_required",
          "存在不同的设备登记待定请求"
        );
      }
      const encrypted = this.encrypt(pending);
      const temporary = path.join(
        this.root,
        `${TEMPORARY_PREFIX}${process.pid}-${randomUUID()}`
      );
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(encrypted);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (process.platform !== "win32") await chmod(temporary, 0o600);
        if (await regularFileExists(this.pendingPath)) {
          throw pendingError(
            "desktop_device_registration_recovery_required",
            "设备登记待定请求发生并发冲突"
          );
        }
        await rename(temporary, this.pendingPath);
        if (process.platform !== "win32") await chmod(this.pendingPath, 0o600);
        await syncDirectory(this.root);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  clear(expectedDeviceId: string, expectedRequestHash: string): Promise<void> {
    return this.exclusive(async () => {
      const current = await this.loadLocked();
      if (!current) return;
      if (
        current.deviceId !== expectedDeviceId ||
        current.requestHash !== expectedRequestHash
      ) {
        throw pendingError(
          "desktop_device_registration_recovery_required",
          "设备登记待定请求清理栅栏不匹配"
        );
      }
      await rm(this.pendingPath);
      await syncDirectory(this.root);
    });
  }

  private async loadLocked(): Promise<DesktopDevicePendingRegistration | null> {
    this.assertSecureStorage();
    await this.ensureRoot();
    await this.cleanupTemporaryFiles();
    return this.readIfExists();
  }

  private async readIfExists(): Promise<DesktopDevicePendingRegistration | null> {
    if (!(await regularFileExists(this.pendingPath))) return null;
    const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    let handle;
    try {
      handle = await open(this.pendingPath, flags);
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size < 1 ||
        info.size > MAX_ENCRYPTED_BYTES ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      ) {
        throw pendingError(
          "desktop_device_registration_recovery_required",
          "设备登记待定文件不安全"
        );
      }
      const decrypted = this.safeStorage.decryptString(await handle.readFile());
      return validatePending(JSON.parse(decrypted) as unknown);
    } catch (error) {
      if (error instanceof DesktopDevicePendingRegistrationError) throw error;
      throw pendingError(
        "desktop_device_registration_recovery_required",
        "设备登记待定请求损坏"
      );
    } finally {
      await handle?.close().catch(() => undefined);
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
      throw pendingError("desktop_secure_storage_unavailable", "系统安全存储不可用");
    }
  }

  private encrypt(value: DesktopDevicePendingRegistration): Buffer {
    let encrypted: Buffer;
    try {
      encrypted = this.safeStorage.encryptString(JSON.stringify(value));
    } catch {
      throw pendingError("desktop_secure_storage_unavailable", "设备登记待定请求加密失败");
    }
    if (
      !Buffer.isBuffer(encrypted) ||
      encrypted.byteLength < 1 ||
      encrypted.byteLength > MAX_ENCRYPTED_BYTES
    ) {
      throw pendingError("desktop_secure_storage_unavailable", "安全存储返回无效数据");
    }
    return encrypted;
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    ) {
      throw pendingError(
        "desktop_device_registration_recovery_required",
        "设备登记目录不安全"
      );
    }
    if (process.platform !== "win32") await chmod(this.root, 0o700);
  }

  private async cleanupTemporaryFiles(): Promise<void> {
    let removed = false;
    for (const name of await readdir(this.root)) {
      if (!name.startsWith(TEMPORARY_PREFIX)) continue;
      const candidate = path.join(this.root, name);
      const info = await lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        throw pendingError(
          "desktop_device_registration_recovery_required",
          "设备登记临时文件不安全"
        );
      }
      await rm(candidate);
      removed = true;
    }
    if (removed) await syncDirectory(this.root);
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

function validatePending(value: unknown): DesktopDevicePendingRegistration {
  if (!isExactRecord(value, [
    "version",
    "method",
    "path",
    "authorization",
    "bodyBase64",
    "headers",
    "bodySha256",
    "authorizationTokenHash",
    "signingInput",
    "requestHash",
    "deviceId",
    "publicKey",
    "keyGeneration",
    "sequence",
    "createdAt"
  ])) {
    throw pendingError(
      "desktop_device_registration_recovery_required",
      "设备登记待定结构无效"
    );
  }
  const pending = value as unknown as DesktopDevicePendingRegistration;
  const requiredHeaders = [
    "X-AiCRM-Content-SHA256",
    "X-AiCRM-Device-Id",
    "X-AiCRM-Device-Nonce",
    "X-AiCRM-Device-Sequence",
    "X-AiCRM-Device-Signature",
    "X-AiCRM-Device-Timestamp"
  ];
  if (
    pending.version !== 1 ||
    pending.method !== "POST" ||
    pending.path !== REGISTRATION_PATH ||
    pending.keyGeneration !== 1 ||
    pending.sequence !== "1" ||
    !DEVICE_ID_PATTERN.test(pending.deviceId) ||
    !isExactRecord(pending.headers, requiredHeaders) ||
    !validISOString(pending.createdAt)
  ) {
    throw pendingError(
      "desktop_device_registration_recovery_required",
      "设备登记待定字段无效"
    );
  }
  const publicKey = decodeCanonicalBase64Url(pending.publicKey, 32);
  const body = decodeCanonicalBase64(pending.bodyBase64, MAX_BODY_BYTES);
  const bodyHash = sha256Hex(body);
  const tokenHash = validBearerAuthorization(pending.authorization);
  const timestamp = pending.headers["X-AiCRM-Device-Timestamp"];
  const nonce = pending.headers["X-AiCRM-Device-Nonce"];
  const timestampNumber = Number(timestamp);
  try {
    validateDeviceNonce(nonce);
  } catch {
    throw pendingError(
      "desktop_device_registration_recovery_required",
      "设备登记待定 nonce 无效"
    );
  }
  const expectedSigningInput = [
    DEVICE_SIGNATURE_DOMAIN,
    "POST",
    REGISTRATION_PATH,
    timestamp,
    nonce,
    "1",
    bodyHash,
    tokenHash
  ].join("\n");
  if (
    publicKey.byteLength !== 32 ||
    sha256Hex(publicKey) !== pending.deviceId ||
    !DIGEST_PATTERN.test(pending.bodySha256) ||
    pending.bodySha256 !== bodyHash ||
    !DIGEST_PATTERN.test(pending.authorizationTokenHash) ||
    pending.authorizationTokenHash !== tokenHash ||
    pending.headers["X-AiCRM-Device-Id"] !== pending.deviceId ||
    pending.headers["X-AiCRM-Device-Sequence"] !== "1" ||
    pending.headers["X-AiCRM-Content-SHA256"] !== bodyHash ||
    !/^[1-9][0-9]{0,15}$/.test(timestamp) ||
    !Number.isSafeInteger(timestampNumber) ||
    pending.signingInput !== expectedSigningInput ||
    pending.requestHash !== sha256Hex(Buffer.from(expectedSigningInput, "utf8")) ||
    !verifyDesktopDeviceSigningInput(
      pending.publicKey,
      expectedSigningInput,
      pending.headers["X-AiCRM-Device-Signature"]
    )
  ) {
    throw pendingError(
      "desktop_device_registration_recovery_required",
      "设备登记待定签名无效"
    );
  }
  return {
    ...pending,
    headers: { ...pending.headers }
  };
}

function validBearerAuthorization(value: string): string {
  if (typeof value !== "string" || !value.startsWith("Bearer ")) {
    throw pendingError(
      "desktop_device_registration_recovery_required",
      "设备登记待定 Bearer 无效"
    );
  }
  const token = value.slice("Bearer ".length);
  if (!token || token.length > 8192) {
    throw pendingError(
      "desktop_device_registration_recovery_required",
      "设备登记待定 Bearer 无效"
    );
  }
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) {
      throw pendingError(
        "desktop_device_registration_recovery_required",
        "设备登记待定 Bearer 无效"
      );
    }
  }
  return hashAuthorizationToken(value, ["Bearer"]);
}

function decodeCanonicalBase64(value: string, maximum: number): Buffer {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw pendingError(
      "desktop_device_registration_recovery_required",
      "设备登记待定 body 编码无效"
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength < 1 || decoded.byteLength > maximum || decoded.toString("base64") !== value) {
    throw pendingError(
      "desktop_device_registration_recovery_required",
      "设备登记待定 body 编码无效"
    );
  }
  return decoded;
}

function decodeCanonicalBase64Url(value: string, expected: number): Buffer {
  if (typeof value !== "string" || !value || value.includes("=") || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw pendingError(
      "desktop_device_registration_recovery_required",
      "设备登记待定公钥无效"
    );
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== expected || decoded.toString("base64url") !== value) {
    throw pendingError(
      "desktop_device_registration_recovery_required",
      "设备登记待定公钥无效"
    );
  }
  return decoded;
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
      throw pendingError(
        "desktop_device_registration_recovery_required",
        "设备登记待定路径不安全"
      );
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

function pendingError(
  code: DesktopDevicePendingRegistrationErrorCode,
  message: string
): DesktopDevicePendingRegistrationError {
  return new DesktopDevicePendingRegistrationError(code, message);
}
