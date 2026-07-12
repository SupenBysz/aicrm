import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import * as tar from "tar";

const SNAPSHOT_SCHEMA_VERSION = 1 as const;
const ARCHIVE_FORMAT = "tar+gzip" as const;
const ENCRYPTION_ALGORITHM = "aes-256-gcm" as const;
const MASTER_KEY_BYTES = 32;
const DATA_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;

const REGENERABLE_PATH_SEGMENTS = new Set([
  "cache",
  "code cache",
  "gpucache",
  "dawncache",
  "grshadercache",
  "shadercache",
  "crashpad",
  "logs",
  "log",
  "scriptcache",
  "cachestorage"
]);

const REGENERABLE_FILE_NAMES = new Set([
  "lock",
  "singletoncookie",
  "singletonlock",
  "singletonsocket",
  "browsermetrics-spare.pma"
]);

export interface MatrixAccountSessionVaultScope {
  attemptId: string;
  webSpaceId: string;
  workspaceId: string;
  workspaceType: "platform" | "agency" | "enterprise";
  platform: "douyin" | "kuaishou" | "xiaohongshu";
  deviceId: string;
}

export interface MatrixAccountSessionFingerprint {
  appVersion: string;
  electronVersion: string;
  chromiumVersion: string;
  operatingSystem: string;
  architecture: string;
  userAgent: string;
  locale: string;
  timezone: string;
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
  deviceId: string;
}

interface EncryptedValue {
  algorithm: typeof ENCRYPTION_ALGORITHM;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface MatrixAccountSessionSnapshotManifest {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  createdAt: string;
  scope: MatrixAccountSessionVaultScope;
  scopeHash: string;
  fingerprint: MatrixAccountSessionFingerprint;
  fingerprintHash: string;
  archive: {
    format: typeof ARCHIVE_FORMAT;
    contentHash: string;
    plaintextBytes: number;
    ciphertextBytes: number;
    sourceBytes: number;
    fileCount: number;
    excludedRegenerablePaths: true;
  };
  encryption: {
    algorithm: typeof ENCRYPTION_ALGORITHM;
    iv: string;
    authTag: string;
    wrappedDataKey: EncryptedValue;
    associatedDataHash: string;
  };
  manifestMac: string;
}

export interface MatrixAccountSessionSnapshotVerification {
  manifest: MatrixAccountSessionSnapshotManifest;
  verifiedAt: string;
}

export interface MatrixAccountSessionSnapshotRestoreResult extends MatrixAccountSessionSnapshotVerification {
  restoredAt: string;
}

export interface MatrixAccountSessionVaultOptions {
  vaultRoot: string;
  masterKeyPath?: string;
}

interface SealInput {
  snapshotId?: string;
  sourceStoragePath: string;
  scope: MatrixAccountSessionVaultScope;
  fingerprint: MatrixAccountSessionFingerprint;
}

interface VerifyInput {
  snapshotId: string;
  expectedScope?: MatrixAccountSessionVaultScope;
}

interface RestoreInput extends VerifyInput {
  targetStoragePath: string;
}

interface DirectoryMeasurement {
  bytes: number;
  files: number;
}

export class MatrixAccountSessionVault {
  private readonly vaultRoot: string;
  private readonly snapshotsDirectory: string;
  private readonly temporaryDirectory: string;
  private readonly masterKeyPath: string;
  private readonly sealInFlight = new Map<string, Promise<MatrixAccountSessionSnapshotVerification>>();

  constructor(options: MatrixAccountSessionVaultOptions) {
    this.vaultRoot = path.resolve(options.vaultRoot);
    this.snapshotsDirectory = path.join(this.vaultRoot, "snapshots");
    this.temporaryDirectory = path.join(this.vaultRoot, "tmp");
    this.masterKeyPath = path.resolve(options.masterKeyPath || path.join(this.vaultRoot, "master.key"));
  }

  async seal(input: SealInput): Promise<MatrixAccountSessionSnapshotVerification> {
    const snapshotId = normalizeSnapshotId(input.snapshotId || randomUUID());
    const active = this.sealInFlight.get(snapshotId);
    if (active) {
      const result = await active;
      assertScopeMatches(result.manifest.scope, input.scope);
      return result;
    }
    const pending = this.sealInternal(input, snapshotId).finally(() => {
      if (this.sealInFlight.get(snapshotId) === pending) this.sealInFlight.delete(snapshotId);
    });
    this.sealInFlight.set(snapshotId, pending);
    return pending;
  }

  private async sealInternal(input: SealInput, snapshotId: string): Promise<MatrixAccountSessionSnapshotVerification> {
    const sourceStoragePath = path.resolve(input.sourceStoragePath);
    await assertDirectory(sourceStoragePath, "WebSpace 持久化目录不存在");
    await this.ensureDirectories();

    const existingManifest = await this.readManifestIfPresent(snapshotId);
    if (existingManifest) {
      assertScopeMatches(existingManifest.scope, input.scope);
      return this.verify({ snapshotId, expectedScope: input.scope });
    }

    const archivePath = this.archivePath(snapshotId);
    if (await pathExists(archivePath)) {
      throw new SessionVaultError("snapshot_id_conflict", "快照标识已存在未完成的归档文件");
    }

    const masterKey = await this.loadOrCreateMasterKey();
    const dataKey = randomBytes(DATA_KEY_BYTES);
    const createdAt = new Date().toISOString();
    const scope = normalizeScope(input.scope);
    const fingerprint = normalizeFingerprint(input.fingerprint);
    const scopeHash = sha256(stableStringify(scope));
    const fingerprintHash = sha256(stableStringify(fingerprint));
    const associatedData = Buffer.from(
      stableStringify({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, snapshotId, createdAt, scopeHash, fingerprintHash }),
      "utf8"
    );
    const associatedDataHash = sha256(associatedData);
    const archiveIv = randomBytes(GCM_IV_BYTES);
    const archiveCipher = createCipheriv(ENCRYPTION_ALGORITHM, dataKey, archiveIv);
    archiveCipher.setAAD(associatedData);
    const archiveTemporaryPath = path.join(this.temporaryDirectory, `${snapshotId}.${randomUUID()}.vault.tmp`);
    const manifestTemporaryPath = path.join(this.temporaryDirectory, `${snapshotId}.${randomUUID()}.json.tmp`);
    const measurement = await measureDirectory(sourceStoragePath, true);
    const contentHash = createHash("sha256");
    let plaintextBytes = 0;
    let archiveCommitted = false;
    let manifestCommitted = false;

    const plaintextMeter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        contentHash.update(chunk);
        plaintextBytes += chunk.length;
        callback(null, chunk);
      }
    });

    try {
      const archiveStream = tar.c(
        {
          cwd: sourceStoragePath,
          gzip: true,
          portable: true,
          noMtime: true,
          filter: (entryPath, entry) =>
            !isRegenerableArchivePath(entryPath) &&
            !("isSymbolicLink" in entry && typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink())
        },
        ["."]
      );
      await pipeline(archiveStream, plaintextMeter, archiveCipher, createWriteStream(archiveTemporaryPath, { mode: 0o600 }));

      const archiveStat = await stat(archiveTemporaryPath);
      const wrappedDataKey = encryptValue(masterKey, dataKey);
      const manifestWithoutMac: Omit<MatrixAccountSessionSnapshotManifest, "manifestMac"> = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        snapshotId,
        createdAt,
        scope,
        scopeHash,
        fingerprint,
        fingerprintHash,
        archive: {
          format: ARCHIVE_FORMAT,
          contentHash: contentHash.digest("hex"),
          plaintextBytes,
          ciphertextBytes: archiveStat.size,
          sourceBytes: measurement.bytes,
          fileCount: measurement.files,
          excludedRegenerablePaths: true
        },
        encryption: {
          algorithm: ENCRYPTION_ALGORITHM,
          iv: archiveIv.toString("base64"),
          authTag: archiveCipher.getAuthTag().toString("base64"),
          wrappedDataKey,
          associatedDataHash
        }
      };
      const manifest: MatrixAccountSessionSnapshotManifest = {
        ...manifestWithoutMac,
        manifestMac: macManifest(masterKey, manifestWithoutMac)
      };

      await writeFile(manifestTemporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(archiveTemporaryPath, archivePath);
      archiveCommitted = true;
      await rename(manifestTemporaryPath, this.manifestPath(snapshotId));
      manifestCommitted = true;

      try {
        return await this.verify({ snapshotId, expectedScope: scope });
      } catch (error) {
        await this.removeSnapshotArtifacts(snapshotId);
        throw error;
      }
    } catch (error) {
      await Promise.allSettled([rm(archiveTemporaryPath, { force: true }), rm(manifestTemporaryPath, { force: true })]);
      if (archiveCommitted || manifestCommitted) await this.removeSnapshotArtifacts(snapshotId);
      throw normalizeVaultError(error, "session_snapshot_seal_failed", "登录态快照封存失败");
    } finally {
      dataKey.fill(0);
      masterKey.fill(0);
    }
  }

  async verify(input: VerifyInput): Promise<MatrixAccountSessionSnapshotVerification> {
    const snapshotId = normalizeSnapshotId(input.snapshotId);
    await this.ensureDirectories();
    const masterKey = await this.loadOrCreateMasterKey();
    let dataKey: Buffer | undefined;
    try {
      const manifest = await this.readAndAuthenticateManifest(snapshotId, masterKey);
      if (input.expectedScope) assertScopeMatches(manifest.scope, input.expectedScope);
      dataKey = decryptValue(masterKey, manifest.encryption.wrappedDataKey);
      const associatedData = snapshotAssociatedData(manifest);
      if (!safeEqualHex(sha256(associatedData), manifest.encryption.associatedDataHash)) {
        throw new SessionVaultError("snapshot_manifest_invalid", "快照关联数据校验失败");
      }

      const decipher = createDecipheriv(
        ENCRYPTION_ALGORITHM,
        dataKey,
        Buffer.from(manifest.encryption.iv, "base64")
      );
      decipher.setAAD(associatedData);
      decipher.setAuthTag(Buffer.from(manifest.encryption.authTag, "base64"));
      const meter = createArchiveMeter();
      const archiveInspector = tar.t({
        strict: true,
        onentry: (entry) => assertSafeArchiveEntry(entry.path, entry.type)
      });
      await pipeline(createReadStream(this.archivePath(snapshotId)), decipher, meter.transform, archiveInspector);
      assertArchiveMeasurement(manifest, meter);

      const verifiedAt = new Date().toISOString();
      return {
        manifest,
        verifiedAt
      };
    } catch (error) {
      throw normalizeVaultError(error, "session_snapshot_verify_failed", "登录态快照校验失败");
    } finally {
      dataKey?.fill(0);
      masterKey.fill(0);
    }
  }

  async restore(input: RestoreInput): Promise<MatrixAccountSessionSnapshotRestoreResult> {
    const snapshotId = normalizeSnapshotId(input.snapshotId);
    const targetStoragePath = path.resolve(input.targetStoragePath);
    await this.ensureDirectories();
    await assertEmptyOrMissingDirectory(targetStoragePath);
    const masterKey = await this.loadOrCreateMasterKey();
    let dataKey: Buffer | undefined;
    const stagingPath = `${targetStoragePath}.restore-${randomUUID()}`;
    try {
      const manifest = await this.readAndAuthenticateManifest(snapshotId, masterKey);
      if (input.expectedScope) assertScopeMatches(manifest.scope, input.expectedScope);
      dataKey = decryptValue(masterKey, manifest.encryption.wrappedDataKey);
      const associatedData = snapshotAssociatedData(manifest);
      if (!safeEqualHex(sha256(associatedData), manifest.encryption.associatedDataHash)) {
        throw new SessionVaultError("snapshot_manifest_invalid", "快照关联数据校验失败");
      }

      await mkdir(stagingPath, { recursive: false, mode: 0o700 });
      const decipher = createDecipheriv(
        ENCRYPTION_ALGORITHM,
        dataKey,
        Buffer.from(manifest.encryption.iv, "base64")
      );
      decipher.setAAD(associatedData);
      decipher.setAuthTag(Buffer.from(manifest.encryption.authTag, "base64"));
      const meter = createArchiveMeter();
      const extractor = tar.x({
        cwd: stagingPath,
        strict: true,
        preservePaths: false,
        filter: (entryPath, entry) => {
          assertSafeArchiveEntry(entryPath, "type" in entry ? entry.type : undefined);
          return !isRegenerableArchivePath(entryPath);
        }
      });
      await pipeline(createReadStream(this.archivePath(snapshotId)), decipher, meter.transform, extractor);
      assertArchiveMeasurement(manifest, meter);

      if (await pathExists(targetStoragePath)) await rm(targetStoragePath, { recursive: true, force: true });
      await mkdir(path.dirname(targetStoragePath), { recursive: true, mode: 0o700 });
      await rename(stagingPath, targetStoragePath);
      const verifiedAt = new Date().toISOString();
      return {
        manifest,
        verifiedAt,
        restoredAt: new Date().toISOString()
      };
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      throw normalizeVaultError(error, "session_snapshot_restore_failed", "登录态快照恢复失败");
    } finally {
      dataKey?.fill(0);
      masterKey.fill(0);
    }
  }

  async measureStoragePath(storagePath: string): Promise<number> {
    return (await measureDirectory(path.resolve(storagePath), false)).bytes;
  }

  async cleanupStoragePath(storagePath: string): Promise<number> {
    const resolvedPath = path.resolve(storagePath);
    const releasedBytes = await this.measureStoragePath(resolvedPath);
    if (!(await pathExists(resolvedPath))) return 0;
    const quarantinePath = `${resolvedPath}.delete-${randomUUID()}`;
    await rename(resolvedPath, quarantinePath);
    try {
      await rm(quarantinePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return releasedBytes;
    } catch (error) {
      if (!(await pathExists(resolvedPath)) && (await pathExists(quarantinePath))) {
        await rename(quarantinePath, resolvedPath).catch(() => undefined);
      }
      throw normalizeVaultError(error, "web_space_cleanup_failed", "WebSpace 持久化目录物理清理失败");
    }
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.vaultRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.snapshotsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
    await Promise.allSettled([
      chmod(this.vaultRoot, 0o700),
      chmod(this.snapshotsDirectory, 0o700),
      chmod(this.temporaryDirectory, 0o700)
    ]);
  }

  private async loadOrCreateMasterKey(): Promise<Buffer> {
    await mkdir(path.dirname(this.masterKeyPath), { recursive: true, mode: 0o700 });
    try {
      const key = await readFile(this.masterKeyPath);
      if (key.length !== MASTER_KEY_BYTES) {
        throw new SessionVaultError("vault_master_key_invalid", "本机 Session Vault 主密钥格式无效");
      }
      return Buffer.from(key);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }

    const candidate = randomBytes(MASTER_KEY_BYTES);
    try {
      const handle = await open(this.masterKeyPath, "wx", 0o600);
      try {
        await handle.writeFile(candidate);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return Buffer.from(candidate);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const key = await readFile(this.masterKeyPath);
      if (key.length !== MASTER_KEY_BYTES) {
        throw new SessionVaultError("vault_master_key_invalid", "本机 Session Vault 主密钥格式无效");
      }
      return Buffer.from(key);
    } finally {
      candidate.fill(0);
    }
  }

  private async readAndAuthenticateManifest(
    snapshotId: string,
    masterKey: Buffer
  ): Promise<MatrixAccountSessionSnapshotManifest> {
    const raw = await readFile(this.manifestPath(snapshotId), "utf8");
    const parsed = JSON.parse(raw) as MatrixAccountSessionSnapshotManifest;
    assertManifestShape(parsed, snapshotId);
    const { manifestMac, ...withoutMac } = parsed;
    const expectedMac = macManifest(masterKey, withoutMac);
    if (!safeEqualBase64(manifestMac, expectedMac)) {
      throw new SessionVaultError("snapshot_manifest_tampered", "快照清单完整性校验失败");
    }
    if (!safeEqualHex(sha256(stableStringify(parsed.scope)), parsed.scopeHash)) {
      throw new SessionVaultError("snapshot_manifest_tampered", "快照业务范围校验失败");
    }
    if (!safeEqualHex(sha256(stableStringify(parsed.fingerprint)), parsed.fingerprintHash)) {
      throw new SessionVaultError("snapshot_manifest_tampered", "快照指纹校验失败");
    }
    return parsed;
  }

  private async readManifestIfPresent(snapshotId: string): Promise<MatrixAccountSessionSnapshotManifest | null> {
    try {
      const masterKey = await this.loadOrCreateMasterKey();
      try {
        return await this.readAndAuthenticateManifest(snapshotId, masterKey);
      } finally {
        masterKey.fill(0);
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  private async removeSnapshotArtifacts(snapshotId: string): Promise<void> {
    await Promise.allSettled([
      rm(this.archivePath(snapshotId), { force: true }),
      rm(this.manifestPath(snapshotId), { force: true })
    ]);
  }

  private archivePath(snapshotId: string): string {
    return path.join(this.snapshotsDirectory, `${normalizeSnapshotId(snapshotId)}.vault`);
  }

  private manifestPath(snapshotId: string): string {
    return path.join(this.snapshotsDirectory, `${normalizeSnapshotId(snapshotId)}.json`);
  }
}

export class SessionVaultError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionVaultError";
    this.code = code;
  }
}

function createArchiveMeter(): { transform: Transform; digest: () => string; bytes: () => number } {
  const hash = createHash("sha256");
  let byteCount = 0;
  return {
    transform: new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        byteCount += chunk.length;
        callback(null, chunk);
      }
    }),
    digest: () => hash.digest("hex"),
    bytes: () => byteCount
  };
}

function assertArchiveMeasurement(
  manifest: MatrixAccountSessionSnapshotManifest,
  meter: { digest: () => string; bytes: () => number }
): void {
  const contentHash = meter.digest();
  if (!safeEqualHex(contentHash, manifest.archive.contentHash) || meter.bytes() !== manifest.archive.plaintextBytes) {
    throw new SessionVaultError("snapshot_content_mismatch", "快照内容哈希或大小不匹配");
  }
}

function snapshotAssociatedData(manifest: MatrixAccountSessionSnapshotManifest): Buffer {
  return Buffer.from(
    stableStringify({
      schemaVersion: manifest.schemaVersion,
      snapshotId: manifest.snapshotId,
      createdAt: manifest.createdAt,
      scopeHash: manifest.scopeHash,
      fingerprintHash: manifest.fingerprintHash
    }),
    "utf8"
  );
}

function encryptValue(masterKey: Buffer, value: Buffer): EncryptedValue {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return {
    algorithm: ENCRYPTION_ALGORITHM,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decryptValue(masterKey: Buffer, encrypted: EncryptedValue): Buffer {
  if (encrypted.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new SessionVaultError("snapshot_encryption_unsupported", "快照密钥加密算法不受支持");
  }
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, masterKey, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]);
}

function macManifest(masterKey: Buffer, manifest: Omit<MatrixAccountSessionSnapshotManifest, "manifestMac">): string {
  return createHmac("sha256", masterKey).update(stableStringify(manifest)).digest("base64");
}

function normalizeScope(scope: MatrixAccountSessionVaultScope): MatrixAccountSessionVaultScope {
  return {
    attemptId: normalizeExternalId(scope.attemptId, "登录流程标识无效"),
    webSpaceId: normalizeExternalId(scope.webSpaceId, "WebSpace 标识无效"),
    workspaceId: normalizeExternalId(scope.workspaceId, "工作区标识无效"),
    workspaceType: scope.workspaceType,
    platform: scope.platform,
    deviceId: normalizeExternalId(scope.deviceId || "default", "设备标识无效")
  };
}

function normalizeFingerprint(fingerprint: MatrixAccountSessionFingerprint): MatrixAccountSessionFingerprint {
  return JSON.parse(stableStringify(fingerprint)) as MatrixAccountSessionFingerprint;
}

function normalizeSnapshotId(value: string): string {
  return normalizeExternalId(value, "快照标识无效");
}

function normalizeExternalId(value: string, message: string): string {
  const normalized = String(value || "").trim();
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(normalized)) {
    throw new SessionVaultError("validation_error", message);
  }
  return normalized;
}

function assertScopeMatches(actual: MatrixAccountSessionVaultScope, expected: MatrixAccountSessionVaultScope): void {
  const expectedNormalized = normalizeScope(expected);
  if (!safeEqualHex(sha256(stableStringify(actual)), sha256(stableStringify(expectedNormalized)))) {
    throw new SessionVaultError("snapshot_scope_mismatch", "快照与当前登录流程的业务范围不一致");
  }
}

function assertManifestShape(manifest: MatrixAccountSessionSnapshotManifest, snapshotId: string): void {
  if (
    !manifest ||
    manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    manifest.snapshotId !== snapshotId ||
    manifest.archive?.format !== ARCHIVE_FORMAT ||
    manifest.encryption?.algorithm !== ENCRYPTION_ALGORITHM ||
    !manifest.manifestMac
  ) {
    throw new SessionVaultError("snapshot_manifest_invalid", "快照清单格式无效或版本不受支持");
  }
}

function assertSafeArchiveEntry(entryPath: string, entryType?: string): void {
  const normalized = entryPath.replace(/\\/g, "/");
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").includes("..") ||
    entryType === "SymbolicLink" ||
    entryType === "Link"
  ) {
    throw new SessionVaultError("snapshot_archive_unsafe", "快照归档包含不安全路径");
  }
}

function isRegenerableArchivePath(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return false;
  const segments = normalized.toLowerCase().split("/").filter(Boolean);
  if (segments.some((segment) => REGENERABLE_PATH_SEGMENTS.has(segment))) return true;
  const fileName = segments.at(-1) || "";
  return (
    REGENERABLE_FILE_NAMES.has(fileName) ||
    fileName.endsWith(".log") ||
    fileName.endsWith(".tmp") ||
    fileName.startsWith("browsermetrics-")
  );
}

async function measureDirectory(directoryPath: string, excludeRegenerable: boolean): Promise<DirectoryMeasurement> {
  if (!(await pathExists(directoryPath))) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const walk = async (currentPath: string, relativePath: string): Promise<void> => {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (excludeRegenerable && isRegenerableArchivePath(childRelativePath)) continue;
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(childPath, childRelativePath);
      } else if (entry.isFile()) {
        const fileStat = await stat(childPath);
        bytes += fileStat.size;
        files += 1;
      }
    }
  };
  await walk(directoryPath, "");
  return { bytes, files };
}

async function assertDirectory(directoryPath: string, message: string): Promise<void> {
  try {
    const info = await stat(directoryPath);
    if (!info.isDirectory()) throw new Error("not_directory");
  } catch (error) {
    if (error instanceof SessionVaultError) throw error;
    throw new SessionVaultError("web_space_storage_missing", message);
  }
}

async function assertEmptyOrMissingDirectory(directoryPath: string): Promise<void> {
  try {
    const entries = await readdir(directoryPath);
    if (entries.length > 0) {
      throw new SessionVaultError("restore_target_not_empty", "恢复目标 WebSpace 不是空目录");
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

function safeEqualHex(left: string, right: string): boolean {
  return safeEqualBytes(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function safeEqualBase64(left: string, right: string): boolean {
  return safeEqualBytes(Buffer.from(left, "base64"), Buffer.from(right, "base64"));
}

function safeEqualBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeVaultError(error: unknown, fallbackCode: string, fallbackMessage: string): SessionVaultError {
  if (error instanceof SessionVaultError) return error;
  return new SessionVaultError(fallbackCode, fallbackMessage);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
