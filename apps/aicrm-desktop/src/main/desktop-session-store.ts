import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DesktopSession } from "../shared/types.ts";
import type { SafeStorageLike } from "./desktop-device-identity.ts";

const SESSION_FILE = "session.sec";
const LEGACY_SESSION_FILE = "session.json";
const MIGRATION_MARKER_FILE = "session.migrated-v1";
const ENVELOPE_MAGIC = Buffer.from("AICRM-SESSION-ENC-V1\n", "ascii");
const MIGRATION_MARKER = Buffer.from("AICRM-SESSION-MIGRATED-V1\n", "ascii");
const MAX_SESSION_BYTES = 32 << 10;

export type DesktopSessionStoreErrorCode =
  | "desktop_secure_storage_unavailable"
  | "desktop_session_corrupt"
  | "desktop_session_unsafe";

export class DesktopSessionStoreError extends Error {
  readonly code: DesktopSessionStoreErrorCode;

  constructor(code: DesktopSessionStoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DesktopSessionStoreOptions {
  root: string;
  safeStorage: SafeStorageLike;
}

/** Main-only encrypted host-session store with atomic legacy migration. */
export class DesktopSessionStore {
  private readonly root: string;
  private readonly target: string;
  private readonly legacyTarget: string;
  private readonly migrationMarker: string;
  private readonly safeStorage: SafeStorageLike;
  private cached: DesktopSession | null | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: DesktopSessionStoreOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw sessionError("desktop_session_unsafe", "登录会话目录无效");
    }
    this.target = path.join(this.root, SESSION_FILE);
    this.legacyTarget = path.join(this.root, LEGACY_SESSION_FILE);
    this.migrationMarker = path.join(this.root, MIGRATION_MARKER_FILE);
    this.safeStorage = options.safeStorage;
  }

  load(): Promise<DesktopSession | null> {
    return this.exclusive(async () => {
      if (this.cached !== undefined) return cloneSession(this.cached);
      this.assertSecureStorage();
      await this.ensureRoot();
      const [encryptedExists, markerExists, legacyExists] = await Promise.all([
        regularFileExists(this.target),
        regularFileExists(this.migrationMarker),
        regularFileExists(this.legacyTarget)
      ]);
      if (encryptedExists) {
        const session = await this.readEncryptedSession();
        await this.writeMigrationMarker();
        if (legacyExists) {
          await rm(this.legacyTarget);
          await syncDirectory(this.root);
        }
        this.cached = session;
        return cloneSession(session);
      }
      if (markerExists) {
        await this.writeMigrationMarker();
        if (legacyExists) {
          throw sessionError(
            "desktop_session_unsafe",
            "旧版明文登录会话在迁移完成后被拒绝"
          );
        }
        this.cached = null;
        return null;
      }
      if (!legacyExists) {
        // A fresh installation (or a previously logged-out one) closes the
        // legacy plaintext window on its first read.
        await this.writeMigrationMarker();
        this.cached = null;
        return null;
      }
      const { raw } = await this.readRaw(this.legacyTarget, true);
      let legacyText: string;
      try {
        legacyText = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        throw sessionError("desktop_session_corrupt", "旧版登录会话编码无效");
      }
      if (!legacyText.startsWith("{")) {
        throw sessionError("desktop_session_corrupt", "旧版登录会话格式无效");
      }
      let legacyValue: unknown;
      try {
        legacyValue = JSON.parse(legacyText) as unknown;
      } catch {
        throw sessionError("desktop_session_corrupt", "旧版登录会话格式无效");
      }
      const session = validateSession(legacyValue);
      // New encrypted state and the permanent downgrade fence are durable
      // before the old plaintext file is removed.
      await this.writeLocked(session);
      await rm(this.legacyTarget);
      await syncDirectory(this.root);
      this.cached = session;
      return cloneSession(session);
    });
  }

  save(session: DesktopSession): Promise<void> {
    return this.exclusive(async () => {
      const validated = validateSession(session);
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.writeLocked(validated);
      await rm(this.legacyTarget, { force: true });
      await syncDirectory(this.root);
      this.cached = validated;
    });
  }

  clear(): Promise<void> {
    return this.exclusive(async () => {
      this.cached = null;
      await this.ensureRoot();
      const existed =
        (await regularFileExists(this.target)) || (await regularFileExists(this.legacyTarget));
      await rm(this.target, { force: true });
      await rm(this.legacyTarget, { force: true });
      await this.writeMigrationMarker();
      if (existed) await syncDirectory(this.root);
    });
  }

  private async readEncryptedSession(): Promise<DesktopSession> {
    const { raw } = await this.readRaw(this.target, false);
    if (
      raw.byteLength <= ENVELOPE_MAGIC.byteLength ||
      !raw.subarray(0, ENVELOPE_MAGIC.byteLength).equals(ENVELOPE_MAGIC)
    ) {
      throw sessionError("desktop_session_corrupt", "加密登录会话封套无效");
    }
    try {
      const plaintext = this.safeStorage.decryptString(raw.subarray(ENVELOPE_MAGIC.byteLength));
      return validateSession(JSON.parse(plaintext) as unknown);
    } catch (error) {
      if (error instanceof DesktopSessionStoreError) throw error;
      throw sessionError("desktop_session_corrupt", "加密登录会话无法解密");
    }
  }

  private async readRaw(file: string, allowLegacyPermissions: boolean): Promise<{ raw: Buffer; mode: number }> {
    const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    let handle;
    try {
      handle = await open(file, flags);
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size < 1 ||
        info.size > MAX_SESSION_BYTES ||
        (!allowLegacyPermissions && process.platform !== "win32" && (info.mode & 0o077) !== 0)
      ) {
        throw sessionError("desktop_session_unsafe", "登录会话文件不安全");
      }
      return { raw: await handle.readFile(), mode: info.mode };
    } catch (error) {
      if (error instanceof DesktopSessionStoreError) throw error;
      throw sessionError("desktop_session_corrupt", "登录会话读取失败");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeLocked(session: DesktopSession): Promise<void> {
    let ciphertext: Buffer;
    try {
      ciphertext = this.safeStorage.encryptString(JSON.stringify(session));
    } catch {
      throw sessionError("desktop_secure_storage_unavailable", "登录会话加密失败");
    }
    if (!Buffer.isBuffer(ciphertext) || ciphertext.byteLength < 1) {
      throw sessionError("desktop_secure_storage_unavailable", "安全存储返回无效会话密文");
    }
    const encrypted = Buffer.concat([ENVELOPE_MAGIC, ciphertext]);
    if (encrypted.byteLength > MAX_SESSION_BYTES) {
      throw sessionError("desktop_secure_storage_unavailable", "安全存储返回无效会话密文");
    }
    await this.writeAtomic(this.target, encrypted);
    await this.writeMigrationMarker();
  }

  private async writeMigrationMarker(): Promise<void> {
    if (await regularFileExists(this.migrationMarker)) {
      const { raw } = await this.readRaw(this.migrationMarker, false);
      if (!raw.equals(MIGRATION_MARKER)) {
        throw sessionError("desktop_session_unsafe", "登录会话迁移标记无效");
      }
      return;
    }
    await this.writeAtomic(this.migrationMarker, MIGRATION_MARKER);
  }

  private async writeAtomic(file: string, value: Buffer): Promise<void> {
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(value);
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
      throw sessionError("desktop_secure_storage_unavailable", "系统安全存储不可用");
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw sessionError("desktop_session_unsafe", "登录会话目录不安全");
    }
    if (process.platform !== "win32") await chmod(this.root, 0o700);
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

function validateSession(value: unknown): DesktopSession {
  if (!isExactRecord(value, ["token", "expiresAt"])) {
    throw sessionError("desktop_session_corrupt", "登录会话结构无效");
  }
  const session = value as unknown as DesktopSession;
  if (
    !validToken(session.token) ||
    typeof session.expiresAt !== "string" ||
    session.expiresAt.trim() !== session.expiresAt ||
    !Number.isFinite(Date.parse(session.expiresAt))
  ) {
    throw sessionError("desktop_session_corrupt", "登录会话字段无效");
  }
  return { token: session.token, expiresAt: session.expiresAt };
}

function validToken(value: string): boolean {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function cloneSession(value: DesktopSession | null): DesktopSession | null {
  return value ? { ...value } : null;
}

function isExactRecord(value: unknown, expectedKeys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function regularFileExists(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw sessionError("desktop_session_unsafe", "登录会话路径不安全");
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

function sessionError(code: DesktopSessionStoreErrorCode, message: string): DesktopSessionStoreError {
  return new DesktopSessionStoreError(code, message);
}
