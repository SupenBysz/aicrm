import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  SafeStorageLike,
  SignedDesktopDeviceRequest
} from "./desktop-device-identity.ts";
import {
  canonicalDevicePath,
  hashAuthorizationToken,
  sha256Hex,
  verifyDesktopDeviceSigningInput
} from "./desktop-device-proof.ts";
import type { DesktopDeviceRequestLane } from "./desktop-device-request-lane.ts";

const ENVELOPE_MAGIC = Buffer.from("AICRM-DEVICE-REQUEST-ENC-V1\n", "ascii");
const MAX_JOURNAL_BYTES = 256 << 10;
const MAX_REQUEST_BODY_BYTES = 64 << 10;
const MAX_RESPONSE_BODY_BYTES = 64 << 10;
const MAX_AUTHORIZATION_BYTES = 8 << 10;
const REFERENCE_PATTERN = /^[0-9a-f]{64}$/;
const FAIL_CLOSED_REFERENCE = "0".repeat(64);
const DEVICE_ID_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_SEQUENCE_PATTERN = /^[1-9][0-9]{0,19}$/;
const DECIMAL_TIMESTAMP_PATTERN = /^[1-9][0-9]{0,15}$/;
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CANONICAL_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PROOF_HEADER_NAMES = [
  "X-AiCRM-Content-SHA256",
  "X-AiCRM-Device-Id",
  "X-AiCRM-Device-Nonce",
  "X-AiCRM-Device-Sequence",
  "X-AiCRM-Device-Signature",
  "X-AiCRM-Device-Timestamp"
] as const;
const rootOperationTails = new Map<string, Promise<void>>();

export type DesktopTrustedRequestKind =
  | "device_binding"
  | "handoff_claim"
  | "authorization_proof"
  | "credential_activation_lease_renewal"
  | "credential_activation_ack"
  | "authorization_command_ack"
  | "credential_revocation_ack";

export interface DesktopDeviceRequestJournalResponse {
  status: 200 | 201;
  bodyBase64: string;
  receivedAt: string;
}

export interface DesktopDeviceRequestJournalRecord {
  version: 1;
  reference: string;
  kind: DesktopTrustedRequestKind;
  method: "POST";
  origin: string;
  path: string;
  authorization: string;
  bodyBase64: string;
  signed: SignedDesktopDeviceRequest;
  createdAt: string;
  response: DesktopDeviceRequestJournalResponse | null;
}

export type DesktopDeviceRequestJournalErrorCode =
  | "desktop_device_request_journal_conflict"
  | "desktop_device_request_journal_corrupt"
  | "desktop_device_request_journal_not_completed"
  | "desktop_device_request_journal_unsafe"
  | "desktop_secure_storage_unavailable";

export class DesktopDeviceRequestJournalError extends Error {
  readonly code: DesktopDeviceRequestJournalErrorCode;

  constructor(code: DesktopDeviceRequestJournalErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DesktopDeviceRequestJournalStoreOptions {
  root: string;
  safeStorage: SafeStorageLike;
}

/** Encrypted exact-replay ledger for Main-only ticket-bearing device requests. */
export class DesktopDeviceRequestJournalStore {
  private readonly root: string;
  private readonly safeStorage: SafeStorageLike;

  constructor(options: DesktopDeviceRequestJournalStoreOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw journalError("desktop_device_request_journal_unsafe", "设备请求日志目录无效");
    }
    this.safeStorage = options.safeStorage;
  }

  createOrLoad(
    candidate: DesktopDeviceRequestJournalRecord
  ): Promise<DesktopDeviceRequestJournalRecord> {
    return this.exclusive(async () => {
      const record = validateRecord(candidate);
      if (record.response !== null) {
        throw journalError(
          "desktop_device_request_journal_unsafe",
          "新建设备请求不得伪造持久响应"
        );
      }
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairTemporary(record.reference);
      const existing = await this.loadLocked(record.reference);
      if (existing) {
        if (!sameRequest(existing, record)) {
          throw journalError(
            "desktop_device_request_journal_conflict",
            "设备请求重放引用已绑定其他请求"
          );
        }
        return cloneRecord(existing);
      }
      await this.writeAtomic(record);
      return cloneRecord(record);
    });
  }

  load(reference: string): Promise<DesktopDeviceRequestJournalRecord | null> {
    return this.exclusive(async () => {
      assertReference(reference);
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairTemporary(reference);
      const record = await this.loadLocked(reference);
      return record ? cloneRecord(record) : null;
    });
  }

  recordResponse(
    reference: string,
    expectedRequestHash: string,
    response: DesktopDeviceRequestJournalResponse
  ): Promise<DesktopDeviceRequestJournalRecord> {
    return this.exclusive(async () => {
      assertReference(reference);
      if (!DIGEST_PATTERN.test(expectedRequestHash)) {
        throw journalError("desktop_device_request_journal_unsafe", "设备请求响应栅栏无效");
      }
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairTemporary(reference);
      const current = await this.loadLocked(reference);
      if (!current || current.signed.requestHash !== expectedRequestHash) {
        throw journalError("desktop_device_request_journal_conflict", "设备请求响应栅栏不匹配");
      }
      const validated = validateResponse(response, current.kind);
      if (current.response) {
        if (!sameResponse(current.response, validated)) {
          throw journalError("desktop_device_request_journal_conflict", "设备请求响应发生冲突");
        }
        return cloneRecord(current);
      }
      current.response = validated;
      await this.writeAtomic(current);
      return cloneRecord(current);
    });
  }

  complete(reference: string, expectedRequestHash: string): Promise<void> {
    return this.exclusive(async () => {
      assertReference(reference);
      if (!DIGEST_PATTERN.test(expectedRequestHash)) {
        throw journalError("desktop_device_request_journal_unsafe", "设备请求完成栅栏无效");
      }
      this.assertSecureStorage();
      await this.ensureRoot();
      await this.repairTemporary(reference);
      const current = await this.loadLocked(reference);
      if (
        !current ||
        !current.response ||
        current.signed.requestHash !== expectedRequestHash
      ) {
        throw journalError(
          "desktop_device_request_journal_not_completed",
          "设备请求尚未形成可确认的持久响应"
        );
      }
      await rm(this.target(reference));
      await rm(this.temporary(reference), { force: true });
      await syncDirectory(this.root);
    });
  }

  list(): Promise<DesktopDeviceRequestJournalRecord[]> {
    return this.exclusive(async () => {
      this.assertSecureStorage();
      await this.ensureRoot();
      const children = await readdir(this.root, { withFileTypes: true });
      const references = new Set<string>();
      for (const child of children) {
        if (!child.isFile() || child.isSymbolicLink()) {
          throw journalError("desktop_device_request_journal_unsafe", "设备请求日志含非法条目");
        }
        const match = /^([0-9a-f]{64})\.sec(?:\.tmp)?$/.exec(child.name);
        if (!match) {
          throw journalError("desktop_device_request_journal_unsafe", "设备请求日志含未知文件");
        }
        references.add(match[1]);
      }
      const records: DesktopDeviceRequestJournalRecord[] = [];
      for (const reference of [...references].sort()) {
        await this.repairTemporary(reference);
        const record = await this.loadLocked(reference);
        if (record) records.push(cloneRecord(record));
      }
      return records;
    });
  }

  private async loadLocked(reference: string): Promise<DesktopDeviceRequestJournalRecord | null> {
    const target = this.target(reference);
    let pathInfo;
    try {
      pathInfo = await lstat(target);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw journalError("desktop_device_request_journal_corrupt", "设备请求日志无法读取");
    }
    assertSafeJournalFile(pathInfo);
    const flags =
      fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    let handle;
    try {
      handle = await open(target, flags);
      const before = await handle.stat();
      assertSafeJournalFile(before);
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
        throw journalError("desktop_device_request_journal_corrupt", "设备请求日志封套不稳定");
      }
      const plaintext = this.safeStorage.decryptString(
        raw.subarray(ENVELOPE_MAGIC.byteLength)
      );
      const record = validateRecord(JSON.parse(plaintext) as unknown);
      if (record.reference !== reference) {
        throw journalError("desktop_device_request_journal_corrupt", "设备请求日志引用不匹配");
      }
      return record;
    } catch (error) {
      if (error instanceof DesktopDeviceRequestJournalError) throw error;
      throw journalError("desktop_device_request_journal_corrupt", "设备请求日志无法解密");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeAtomic(record: DesktopDeviceRequestJournalRecord): Promise<void> {
    let ciphertext: Buffer;
    try {
      ciphertext = this.safeStorage.encryptString(JSON.stringify(validateRecord(record)));
    } catch {
      throw journalError("desktop_secure_storage_unavailable", "设备请求日志加密失败");
    }
    if (!Buffer.isBuffer(ciphertext) || ciphertext.byteLength < 1) {
      throw journalError("desktop_secure_storage_unavailable", "设备请求日志密文无效");
    }
    const envelope = Buffer.concat([ENVELOPE_MAGIC, ciphertext]);
    if (envelope.byteLength > MAX_JOURNAL_BYTES) {
      throw journalError("desktop_device_request_journal_unsafe", "设备请求日志超过安全上限");
    }
    const temporary = this.temporary(record.reference);
    await rm(temporary, { force: true });
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(envelope);
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.target(record.reference));
      await syncDirectory(this.root);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  }

  private async repairTemporary(reference: string): Promise<void> {
    const temporary = this.temporary(reference);
    let info;
    try {
      info = await lstat(temporary);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw journalError("desktop_device_request_journal_corrupt", "设备请求临时日志无法读取");
    }
    assertSafeJournalFile(info);
    try {
      await lstat(this.target(reference));
      await rm(temporary);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      await rename(temporary, this.target(reference));
    }
    await syncDirectory(this.root);
  }

  private target(reference: string): string {
    return path.join(this.root, `${reference}.sec`);
  }

  private temporary(reference: string): string {
    return path.join(this.root, `${reference}.sec.tmp`);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw journalError("desktop_device_request_journal_unsafe", "设备请求日志目录不安全");
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
      throw journalError("desktop_secure_storage_unavailable", "系统安全存储不可用");
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = rootOperationTails.get(this.root) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    rootOperationTails.set(this.root, settled);
    void settled.then(() => {
      if (rootOperationTails.get(this.root) === settled) rootOperationTails.delete(this.root);
    });
    return result;
  }
}

export function desktopTrustedRequestReference(
  kind: DesktopTrustedRequestKind,
  pathValue: string
): string {
  return sha256Hex(Buffer.from(`AICRM-TRUSTED-REQUEST-V1\n${kind}\n${canonicalDevicePath(pathValue)}`, "utf8"));
}

/**
 * Restores the one process-wide signed-sequence fence before any heartbeat can
 * start. Every encrypted record is unresolved until its owning Main workflow
 * validates the durable response and calls `complete`; two records therefore
 * indicate an impossible split head and fail closed.
 */
export async function restoreDesktopDeviceRequestJournalPin(
  journal: Pick<DesktopDeviceRequestJournalStore, "list">,
  lane: Pick<DesktopDeviceRequestLane, "restorePin">
): Promise<string | null> {
  let records: DesktopDeviceRequestJournalRecord[];
  try {
    records = await journal.list();
  } catch (error) {
    await lane.restorePin(FAIL_CLOSED_REFERENCE);
    throw error;
  }
  if (records.length > 1) {
    await lane.restorePin(FAIL_CLOSED_REFERENCE);
    throw journalError(
      "desktop_device_request_journal_conflict",
      "设备请求日志存在多个待恢复栅栏"
    );
  }
  const reference = records[0]?.reference ?? null;
  if (reference) await lane.restorePin(reference);
  return reference;
}

function validateRecord(value: unknown): DesktopDeviceRequestJournalRecord {
  if (
    !exactObject(value, [
      "version",
      "reference",
      "kind",
      "method",
      "origin",
      "path",
      "authorization",
      "bodyBase64",
      "signed",
      "createdAt",
      "response"
    ])
  ) {
    throw journalError("desktop_device_request_journal_corrupt", "设备请求日志结构无效");
  }
  const record = value as unknown as DesktopDeviceRequestJournalRecord;
  const body = decodeCanonicalBase64(record.bodyBase64, MAX_REQUEST_BODY_BYTES);
  const kindValid = trustedRequestKind(record.kind);
  const scheme = kindValid ? authorizationScheme(record.kind) : "";
  if (record.response !== null) validateResponse(record.response, record.kind);
  if (
    record.version !== 1 ||
    !REFERENCE_PATTERN.test(record.reference) ||
    !kindValid ||
    record.method !== "POST" ||
    !validTrustedOrigin(record.origin) ||
    !validCanonicalPath(record.path) ||
    record.reference !== desktopTrustedRequestReference(record.kind, record.path) ||
    !validAuthorization(record.authorization, scheme) ||
    !canonicalTime(record.createdAt) ||
    !validateSignedRequest(record.signed, record.path, body, record.authorization, scheme)
  ) {
    throw journalError("desktop_device_request_journal_corrupt", "设备请求日志字段无效");
  }
  return cloneRecord(record);
}

function validateSignedRequest(
  signed: SignedDesktopDeviceRequest,
  requestPath: string,
  body: Buffer,
  authorization: string,
  scheme: string
): boolean {
  if (!exactObject(signed, [
    "headers",
    "bodySha256",
    "authorizationTokenHash",
    "signingInput",
    "requestHash",
    "deviceId",
    "publicKey",
    "keyGeneration",
    "sequence"
  ])) return false;
  if (!exactObject(signed.headers, [...PROOF_HEADER_NAMES])) return false;
  if (Object.values(signed.headers).some((value) => typeof value !== "string")) return false;
  const expectedBodyHash = sha256Hex(body);
  let expectedAuthorizationHash: string;
  try {
    expectedAuthorizationHash = hashAuthorizationToken(authorization, [scheme]);
  } catch {
    return false;
  }
  const publicKey = decodeCanonicalBase64Url(signed.publicKey, 32);
  const timestamp = signed.headers["X-AiCRM-Device-Timestamp"];
  const nonce = signed.headers["X-AiCRM-Device-Nonce"];
  const expectedSigningInput = [
    "AICRM-DEVICE-V1",
    "POST",
    requestPath,
    signed.headers["X-AiCRM-Device-Timestamp"],
    signed.headers["X-AiCRM-Device-Nonce"],
    signed.sequence,
    expectedBodyHash,
    expectedAuthorizationHash
  ].join("\n");
  return (
    DEVICE_ID_PATTERN.test(signed.deviceId) &&
    publicKey !== null &&
    sha256Hex(publicKey) === signed.deviceId &&
    validTimestamp(timestamp) &&
    decodeCanonicalBase64Url(nonce, 16) !== null &&
    signed.headers["X-AiCRM-Device-Id"] === signed.deviceId &&
    signed.bodySha256 === expectedBodyHash &&
    signed.headers["X-AiCRM-Content-SHA256"] === expectedBodyHash &&
    signed.authorizationTokenHash === expectedAuthorizationHash &&
    validUint64(signed.sequence) &&
    signed.headers["X-AiCRM-Device-Sequence"] === signed.sequence &&
    Number.isSafeInteger(signed.keyGeneration) &&
    signed.keyGeneration > 0 &&
    typeof signed.publicKey === "string" &&
    signed.publicKey !== "" &&
    signed.signingInput === expectedSigningInput &&
    signed.requestHash === sha256Hex(Buffer.from(expectedSigningInput, "utf8")) &&
    verifyDesktopDeviceSigningInput(
      signed.publicKey,
      signed.signingInput,
      signed.headers["X-AiCRM-Device-Signature"]
    )
  );
}

function validateResponse(
  value: DesktopDeviceRequestJournalResponse,
  kind: DesktopTrustedRequestKind
): DesktopDeviceRequestJournalResponse {
  if (!exactObject(value, ["status", "bodyBase64", "receivedAt"])) {
    throw journalError("desktop_device_request_journal_corrupt", "设备请求响应日志结构无效");
  }
  decodeCanonicalBase64(value.bodyBase64, MAX_RESPONSE_BODY_BYTES);
  const expectedStatus = kind === "device_binding" ? 201 : 200;
  if (value.status !== expectedStatus || !canonicalTime(value.receivedAt)) {
    throw journalError("desktop_device_request_journal_corrupt", "设备请求响应日志字段无效");
  }
  return { ...value };
}

function sameRequest(
  left: DesktopDeviceRequestJournalRecord,
  right: DesktopDeviceRequestJournalRecord
): boolean {
  return (
    left.version === right.version &&
    left.reference === right.reference &&
    left.kind === right.kind &&
    left.method === right.method &&
    left.origin === right.origin &&
    left.path === right.path &&
    left.authorization === right.authorization &&
    left.bodyBase64 === right.bodyBase64 &&
    left.createdAt === right.createdAt &&
    sameSignedRequest(left.signed, right.signed)
  );
}

function sameSignedRequest(
  left: SignedDesktopDeviceRequest,
  right: SignedDesktopDeviceRequest
): boolean {
  return (
    left.bodySha256 === right.bodySha256 &&
    left.authorizationTokenHash === right.authorizationTokenHash &&
    left.signingInput === right.signingInput &&
    left.requestHash === right.requestHash &&
    left.deviceId === right.deviceId &&
    left.publicKey === right.publicKey &&
    left.keyGeneration === right.keyGeneration &&
    left.sequence === right.sequence &&
    PROOF_HEADER_NAMES.every((name) => left.headers[name] === right.headers[name])
  );
}

function sameResponse(
  left: DesktopDeviceRequestJournalResponse,
  right: DesktopDeviceRequestJournalResponse
): boolean {
  return (
    left.status === right.status &&
    left.bodyBase64 === right.bodyBase64 &&
    left.receivedAt === right.receivedAt
  );
}

function cloneRecord(record: DesktopDeviceRequestJournalRecord): DesktopDeviceRequestJournalRecord {
  return {
    ...record,
    signed: { ...record.signed, headers: { ...record.signed.headers } },
    response: record.response ? { ...record.response } : null
  };
}

function trustedRequestKind(value: string): value is DesktopTrustedRequestKind {
  return [
    "device_binding",
    "handoff_claim",
    "authorization_proof",
    "credential_activation_lease_renewal",
    "credential_activation_ack",
    "authorization_command_ack",
    "credential_revocation_ack"
  ].includes(value);
}

function authorizationScheme(kind: DesktopTrustedRequestKind): string {
  switch (kind) {
    case "device_binding":
      return "Bearer";
    case "handoff_claim":
      return "AiCRM-Handoff";
    case "authorization_proof":
      return "AiCRM-Claim";
    case "credential_activation_lease_renewal":
    case "credential_activation_ack":
      return "AiCRM-Activation";
    case "authorization_command_ack":
    case "credential_revocation_ack":
      return "AiCRM-Command";
  }
}

function validAuthorization(value: string, scheme: string): boolean {
  if (typeof value !== "string") return false;
  const prefix = `${scheme} `;
  if (!value.startsWith(prefix)) return false;
  const token = value.slice(prefix.length);
  if (scheme === "Bearer") {
    if (
      token.length < 1 ||
      Buffer.byteLength(value, "utf8") > MAX_AUTHORIZATION_BYTES ||
      token.trim() !== token
    ) {
      return false;
    }
    for (let index = 0; index < token.length; index += 1) {
      const code = token.charCodeAt(index);
      if (code < 0x21 || code > 0x7e) return false;
    }
    return true;
  }
  return (
    token.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_AUTHORIZATION_BYTES &&
    COMPACT_JWS_PATTERN.test(token) &&
    token.trim() === token
  );
}

function validTrustedOrigin(value: string): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return (
    url.origin === value &&
    (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
    url.username === "" &&
    url.password === "" &&
    (url.pathname === "" || url.pathname === "/") &&
    url.search === "" &&
    url.hash === ""
  );
}

function decodeCanonicalBase64(value: string, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 + 4) {
    throw journalError("desktop_device_request_journal_corrupt", "设备请求日志编码无效");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maximum || decoded.toString("base64") !== value) {
    throw journalError("desktop_device_request_journal_corrupt", "设备请求日志编码无效");
  }
  return decoded;
}

function canonicalTime(value: string): boolean {
  if (typeof value !== "string" || !CANONICAL_UTC_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validCanonicalPath(value: string): boolean {
  try {
    return canonicalDevicePath(value) === value;
  } catch {
    return false;
  }
}

function decodeCanonicalBase64Url(value: string, expectedBytes: number): Buffer | null {
  if (typeof value !== "string" || value === "" || value.includes("=")) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === expectedBytes && decoded.toString("base64url") === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function validUint64(value: string): boolean {
  if (typeof value !== "string" || !DECIMAL_SEQUENCE_PATTERN.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= 0x7fff_ffff_ffff_ffffn;
  } catch {
    return false;
  }
}

function validTimestamp(value: string): boolean {
  if (typeof value !== "string" || !DECIMAL_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertReference(value: string): void {
  if (!REFERENCE_PATTERN.test(value)) {
    throw journalError("desktop_device_request_journal_unsafe", "设备请求日志引用无效");
  }
}

function assertSafeJournalFile(info: Stats): void {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < ENVELOPE_MAGIC.byteLength + 1 ||
    info.size > MAX_JOURNAL_BYTES ||
    (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)
  ) {
    throw journalError("desktop_device_request_journal_unsafe", "设备请求日志文件不安全");
  }
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

function journalError(
  code: DesktopDeviceRequestJournalErrorCode,
  message: string
): DesktopDeviceRequestJournalError {
  return new DesktopDeviceRequestJournalError(code, message);
}
