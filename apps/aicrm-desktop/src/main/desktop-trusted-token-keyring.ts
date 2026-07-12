import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { SafeStorageLike } from "./desktop-device-identity.ts";

export const DESKTOP_TRUSTED_TOKEN_KEYRING_PATH =
  "/api/v1/public/ai-executor-trusted-token-keyring";

const EXPECTED_ISSUER = "aicrm-agent-executor" as const;
const EXPECTED_AUDIENCES = [
  "aicrm-desktop",
  "aicrm-desktop-claim",
  "aicrm-desktop-activation",
  "aicrm-desktop-command"
] as const;
const MAX_TOKEN_LIFETIME_SECONDS = 600 as const;
const REFRESH_AFTER_SECONDS = 30 as const;
const MAX_RESPONSE_BYTES = 64 << 10;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_SAFE_REVISION = 2 ** 53 - 1;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,160}$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const RAW_ED25519_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const CANONICAL_UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ENVELOPE_MAGIC = Buffer.from("AICRM-TRUSTED-KEYRING-ENC-V1\n", "ascii");
const PRIMARY_FILE = "keyring.sec";
const HIGH_WATER_FILE = "keyring-high-water.sec";
const KNOWN_FILES = new Set([
  PRIMARY_FILE,
  HIGH_WATER_FILE,
  `${PRIMARY_FILE}.tmp`,
  `${HIGH_WATER_FILE}.tmp`
]);
const rootTails = new Map<string, Promise<void>>();

export type DesktopTrustedTokenAudience = (typeof EXPECTED_AUDIENCES)[number];

export interface DesktopTrustedTokenVerificationKey {
  kid: string;
  kty: "OKP";
  crv: "Ed25519";
  alg: "EdDSA";
  use: "sig";
  x: string;
  signingNotBefore: string;
  signingNotAfter: string | null;
  verifyUntil: string | null;
}

export interface DesktopTrustedTokenKeyring {
  schemaVersion: 1;
  issuer: typeof EXPECTED_ISSUER;
  revision: number;
  activeKid: string;
  generatedAt: string;
  refreshAfterSeconds: typeof REFRESH_AFTER_SECONDS;
  maxTokenLifetimeSeconds: typeof MAX_TOKEN_LIFETIME_SECONDS;
  keyringDigest: string;
  desktopAudiences: DesktopTrustedTokenAudience[];
  keys: DesktopTrustedTokenVerificationKey[];
}

interface StoredKeyringHighWater {
  version: 1;
  generation: number;
  originEpoch: number;
  origin: string;
  revision: number;
  keyringDigest: string | null;
  keyring: DesktopTrustedTokenKeyring | null;
}

interface HttpResponseLike {
  ok: boolean;
  status: number;
  redirected?: boolean;
  body?: ReadableStream<Uint8Array> | null;
  text?: () => Promise<string>;
}

type HostFetch = (url: string, init: RequestInit) => Promise<HttpResponseLike>;

export type DesktopTrustedTokenKeyringErrorCode =
  | "desktop_secure_storage_unavailable"
  | "desktop_trusted_token_keyring_contract_invalid"
  | "desktop_trusted_token_keyring_corrupt"
  | "desktop_trusted_token_keyring_origin_mismatch"
  | "desktop_trusted_token_keyring_response_invalid"
  | "desktop_trusted_token_keyring_rollback"
  | "desktop_trusted_token_keyring_transport_failed"
  | "desktop_trusted_token_keyring_unsafe";

export class DesktopTrustedTokenKeyringError extends Error {
  readonly code: DesktopTrustedTokenKeyringErrorCode;
  readonly status: number | null;

  constructor(
    code: DesktopTrustedTokenKeyringErrorCode,
    message: string,
    options: { status?: number } = {}
  ) {
    super(message);
    this.code = code;
    this.status = Number.isInteger(options.status) ? (options.status ?? null) : null;
  }
}

export type DesktopTrustedTokenKeyringFaultPoint =
  | "after_primary_fsync"
  | "after_primary_rename"
  | "after_high_water_fsync"
  | "after_high_water_rename";

export interface DesktopTrustedTokenKeyringClientOptions {
  /** Main-owned safeStorage directory; never accept it through Renderer IPC. */
  root: string;
  safeStorage: SafeStorageLike;
  /** Main-owned backend webUrl. Only its validated origin is used. */
  loadTrustedWebUrl: () => string | Promise<string>;
  fetch?: HostFetch;
  now?: () => Date;
  /** Test-only escape hatch. Production callers must leave this false. */
  allowInsecureLoopbackForTests?: boolean;
  faultInjector?: (point: DesktopTrustedTokenKeyringFaultPoint) => void | Promise<void>;
  renameFile?: (source: string, target: string) => Promise<void>;
  syncDirectory?: (directory: string) => Promise<boolean>;
}

/**
 * Main-only public trust-material client. Network validation and the encrypted
 * anti-rollback fence complete before a keyring becomes visible to a verifier.
 */
export class DesktopTrustedTokenKeyringClient {
  private readonly loadTrustedWebUrl: () => string | Promise<string>;
  private readonly hostFetch: HostFetch;
  private readonly allowInsecureLoopbackForTests: boolean;
  private readonly now: () => Date;
  private readonly store: DesktopTrustedTokenKeyringStateStore;
  private inFlight: Promise<DesktopTrustedTokenKeyring> | null = null;

  constructor(options: DesktopTrustedTokenKeyringClientOptions) {
    this.loadTrustedWebUrl = options.loadTrustedWebUrl;
    this.hostFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.allowInsecureLoopbackForTests = options.allowInsecureLoopbackForTests === true;
    this.now = options.now ?? (() => new Date());
    this.store = new DesktopTrustedTokenKeyringStateStore(options);
  }

  refresh(): Promise<DesktopTrustedTokenKeyring> {
    if (this.inFlight) return this.inFlight;
    const operation = this.refreshOnce();
    this.inFlight = operation;
    void operation
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
      })
      .catch(() => undefined);
    return operation;
  }

  async readCached(): Promise<DesktopTrustedTokenKeyring | null> {
    const origin = trustedWebOrigin(
      await this.loadTrustedWebUrl(),
      this.allowInsecureLoopbackForTests
    );
    const cached = await this.store.read(origin);
    // A cached projection is never a substitute for the service clock. Once
    // generatedAt leaves the locked freshness window callers must refresh.
    return cached && generatedAtIsFresh(cached.generatedAt, this.now()) ? cached : null;
  }

  /**
   * The only way to change the pinned origin. Both URLs are explicit so a
   * configuration edit can never silently erase the old anti-rollback fence.
   */
  async resetOrigin(expectedCurrentWebUrl: string, nextWebUrl: string): Promise<void> {
    const expected = trustedWebOrigin(
      expectedCurrentWebUrl,
      this.allowInsecureLoopbackForTests
    );
    const next = trustedWebOrigin(nextWebUrl, this.allowInsecureLoopbackForTests);
    if (expected === next) {
      throw keyringError(
        "desktop_trusted_token_keyring_contract_invalid",
        "可信令牌来源未发生变化"
      );
    }
    await this.store.resetOrigin(expected, next);
  }

  private async refreshOnce(): Promise<DesktopTrustedTokenKeyring> {
    const origin = trustedWebOrigin(
      await this.loadTrustedWebUrl(),
      this.allowInsecureLoopbackForTests
    );
    // Check the origin fence before making any request to a newly configured
    // host. This prevents a silent webUrl edit from becoming a trust reset.
    await this.store.assertOrigin(origin);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: HttpResponseLike;
    let raw: string;
    try {
      response = await this.hostFetch(`${origin}${DESKTOP_TRUSTED_TOKEN_KEYRING_PATH}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      });
      if (response === null || typeof response !== "object") throw new Error("response invalid");
      if (response.redirected === true) {
        throw keyringError(
          "desktop_trusted_token_keyring_transport_failed",
          "可信令牌密钥环禁止重定向"
        );
      }
      if (response.ok !== true || response.status !== 200) {
        throw new DesktopTrustedTokenKeyringError(
          "desktop_trusted_token_keyring_transport_failed",
          "可信令牌密钥环服务拒绝请求",
          { status: response.status }
        );
      }
      raw = await readBoundedResponse(response);
    } catch (error) {
      if (error instanceof DesktopTrustedTokenKeyringError) throw error;
      throw keyringError(
        "desktop_trusted_token_keyring_transport_failed",
        "可信令牌密钥环请求失败"
      );
    } finally {
      clearTimeout(timeout);
    }
    const envelope = parseStrictJson(raw);
    if (!exactObject(envelope, ["data", "requestId"])) {
      throw keyringError(
        "desktop_trusted_token_keyring_response_invalid",
        "可信令牌密钥环响应封套无效"
      );
    }
    const requestId = (envelope as { requestId: unknown }).requestId;
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
      throw keyringError(
        "desktop_trusted_token_keyring_response_invalid",
        "可信令牌密钥环 requestId 无效"
      );
    }
    const keyring = validateKeyring((envelope as { data: unknown }).data);
    if (!generatedAtIsFresh(keyring.generatedAt, this.now())) {
      throw keyringError(
        "desktop_trusted_token_keyring_response_invalid",
        "可信令牌密钥环 generatedAt 与本机时钟偏差过大"
      );
    }
    await this.store.accept(origin, keyring);
    return cloneKeyring(keyring);
  }
}

class DesktopTrustedTokenKeyringStateStore {
  private readonly root: string;
  private readonly safeStorage: SafeStorageLike;
  private readonly faultInjector?: DesktopTrustedTokenKeyringClientOptions["faultInjector"];
  private readonly renameFile: (source: string, target: string) => Promise<void>;
  private readonly syncDirectory: (directory: string) => Promise<boolean>;

  constructor(options: DesktopTrustedTokenKeyringClientOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw keyringError("desktop_trusted_token_keyring_unsafe", "可信令牌密钥环目录无效");
    }
    this.safeStorage = options.safeStorage;
    this.faultInjector = options.faultInjector;
    this.renameFile = options.renameFile ?? rename;
    this.syncDirectory = options.syncDirectory ?? syncDirectory;
  }

  assertOrigin(origin: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.loadAndRepair();
      if (state && state.origin !== origin) {
        throw keyringError(
          "desktop_trusted_token_keyring_origin_mismatch",
          "可信令牌来源已变化，需要显式重置"
        );
      }
    });
  }

  read(origin: string): Promise<DesktopTrustedTokenKeyring | null> {
    return this.exclusive(async () => {
      const state = await this.loadAndRepair();
      if (!state) return null;
      if (state.origin !== origin) {
        throw keyringError(
          "desktop_trusted_token_keyring_origin_mismatch",
          "可信令牌来源已变化，需要显式重置"
        );
      }
      return state.keyring ? cloneKeyring(state.keyring) : null;
    });
  }

  accept(origin: string, keyring: DesktopTrustedTokenKeyring): Promise<void> {
    return this.exclusive(async () => {
      const current = await this.loadAndRepair();
      if (current && current.origin !== origin) {
        throw keyringError(
          "desktop_trusted_token_keyring_origin_mismatch",
          "可信令牌来源已变化，需要显式重置"
        );
      }
      if (current && keyring.revision < current.revision) {
        throw keyringError(
          "desktop_trusted_token_keyring_rollback",
          "可信令牌密钥环 revision 回退"
        );
      }
      if (
        current &&
        keyring.revision === current.revision &&
        current.keyringDigest !== null &&
        keyring.keyringDigest !== current.keyringDigest
      ) {
        throw keyringError(
          "desktop_trusted_token_keyring_rollback",
          "可信令牌密钥环同 revision 内容变化"
        );
      }
      if (
        current?.keyring &&
        keyring.revision === current.revision &&
        keyring.keyringDigest === current.keyringDigest
      ) {
        // generatedAt is intentionally outside the Go digest and may advance
        // while the revision stays fixed. Keep the first accepted cache to
        // avoid turning harmless refresh metadata into disk churn.
        await this.persistBoth(current);
        return;
      }
      const next: StoredKeyringHighWater = {
        version: 1,
        generation: (current?.generation ?? 0) + 1,
        originEpoch: current?.originEpoch ?? 1,
        origin,
        revision: keyring.revision,
        keyringDigest: keyring.keyringDigest,
        keyring: cloneKeyring(keyring)
      };
      await this.persistBoth(next);
    });
  }

  resetOrigin(expected: string, next: string): Promise<void> {
    return this.exclusive(async () => {
      const current = await this.loadAndRepair();
      if (!current || current.origin !== expected) {
        throw keyringError(
          "desktop_trusted_token_keyring_origin_mismatch",
          "可信令牌来源重置栅栏不匹配"
        );
      }
      const reset: StoredKeyringHighWater = {
        version: 1,
        generation: current.generation + 1,
        originEpoch: current.originEpoch + 1,
        origin: next,
        revision: 0,
        keyringDigest: null,
        keyring: null
      };
      await this.persistBoth(reset);
    });
  }

  private async loadAndRepair(): Promise<StoredKeyringHighWater | null> {
    this.assertSecureStorage();
    await this.ensureRoot();
    const records = await this.readKnownRecords();
    if (records.length === 0) return null;
    let high = records[0].state;
    for (const record of records.slice(1)) high = chooseHighWater(high, record.state);
    await this.persistBoth(high, true);
    return cloneState(high);
  }

  private async readKnownRecords(): Promise<
    Array<{ file: string; state: StoredKeyringHighWater }>
  > {
    const children = await readdir(this.root, { withFileTypes: true });
    for (const child of children) {
      if (!KNOWN_FILES.has(child.name) || !child.isFile() || child.isSymbolicLink()) {
        throw keyringError(
          "desktop_trusted_token_keyring_unsafe",
          "可信令牌密钥环目录含未知或不安全条目"
        );
      }
    }
    const records: Array<{ file: string; state: StoredKeyringHighWater }> = [];
    for (const name of KNOWN_FILES) {
      const state = await this.readPath(path.join(this.root, name), true);
      if (state) records.push({ file: name, state });
    }
    return records;
  }

  private async persistBoth(state: StoredKeyringHighWater, repair = false): Promise<void> {
    const primary = path.join(this.root, PRIMARY_FILE);
    const highWater = path.join(this.root, HIGH_WATER_FILE);
    if (!(await this.fileEquals(primary, state))) {
      await this.writeAtomic(primary, state, "after_primary_fsync", "after_primary_rename");
    }
    if (!(await this.fileEquals(highWater, state))) {
      await this.writeAtomic(
        highWater,
        state,
        "after_high_water_fsync",
        "after_high_water_rename"
      );
    }
    await rm(`${primary}.tmp`, { force: true });
    await rm(`${highWater}.tmp`, { force: true });
    const durable = await this.syncDirectory(this.root);
    if (!durable && process.platform !== "win32" && !repair) {
      throw keyringError(
        "desktop_trusted_token_keyring_unsafe",
        "可信令牌密钥环目录无法持久化"
      );
    }
  }

  private async fileEquals(file: string, state: StoredKeyringHighWater): Promise<boolean> {
    const existing = await this.readPath(file, true);
    return existing !== null && sameState(existing, state);
  }

  private async writeAtomic(
    target: string,
    state: StoredKeyringHighWater,
    afterFsync: DesktopTrustedTokenKeyringFaultPoint,
    afterRename: DesktopTrustedTokenKeyringFaultPoint
  ): Promise<void> {
    const temporary = `${target}.tmp`;
    await rm(temporary, { force: true });
    const envelope = encryptEnvelope(this.safeStorage, state);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(envelope);
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.faultInjector?.(afterFsync);
      await this.renameFile(temporary, target);
      if (process.platform !== "win32") await chmod(target, 0o600);
      await this.faultInjector?.(afterRename);
      const durable = await this.syncDirectory(this.root);
      if (!durable && process.platform !== "win32") {
        throw keyringError(
          "desktop_trusted_token_keyring_unsafe",
          "可信令牌密钥环目录无法持久化"
        );
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  }

  private async readPath(
    file: string,
    missingAllowed = false
  ): Promise<StoredKeyringHighWater | null> {
    let pathInfo: Stats;
    try {
      pathInfo = await lstat(file);
    } catch (error) {
      if (missingAllowed && isErrorCode(error, "ENOENT")) return null;
      throw keyringError(
        "desktop_trusted_token_keyring_corrupt",
        "可信令牌密钥环状态无法读取"
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
        throw keyringError(
          "desktop_trusted_token_keyring_corrupt",
          "可信令牌密钥环状态不稳定"
        );
      }
      const plaintext = this.safeStorage.decryptString(raw.subarray(ENVELOPE_MAGIC.byteLength));
      return validateStoredState(parseStrictJson(plaintext));
    } catch (error) {
      if (
        error instanceof DesktopTrustedTokenKeyringError &&
        error.code === "desktop_trusted_token_keyring_unsafe"
      ) {
        throw error;
      }
      throw keyringError(
        "desktop_trusted_token_keyring_corrupt",
        "可信令牌密钥环状态无法解密"
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.nlink < 1) {
      throw keyringError("desktop_trusted_token_keyring_unsafe", "可信令牌密钥环目录不安全");
    }
    if (process.platform !== "win32") {
      if ((info.mode & 0o077) !== 0) {
        throw keyringError(
          "desktop_trusted_token_keyring_unsafe",
          "可信令牌密钥环目录权限不安全"
        );
      }
      await chmod(this.root, 0o700);
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
      throw keyringError("desktop_secure_storage_unavailable", "系统安全存储不可用");
    }
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

function validateKeyring(value: unknown): DesktopTrustedTokenKeyring {
  if (
    !exactObject(value, [
      "schemaVersion",
      "issuer",
      "revision",
      "activeKid",
      "generatedAt",
      "refreshAfterSeconds",
      "maxTokenLifetimeSeconds",
      "keyringDigest",
      "desktopAudiences",
      "keys"
    ])
  ) {
    throw keyringError(
      "desktop_trusted_token_keyring_response_invalid",
      "可信令牌密钥环结构无效"
    );
  }
  const ring = value as unknown as DesktopTrustedTokenKeyring;
  if (
    ring.schemaVersion !== 1 ||
    ring.issuer !== EXPECTED_ISSUER ||
    !positiveSafeRevision(ring.revision) ||
    typeof ring.activeKid !== "string" ||
    !KEY_ID.test(ring.activeKid) ||
    !canonicalUtcSecond(ring.generatedAt) ||
    ring.refreshAfterSeconds !== REFRESH_AFTER_SECONDS ||
    ring.maxTokenLifetimeSeconds !== MAX_TOKEN_LIFETIME_SECONDS ||
    !HEX_DIGEST.test(ring.keyringDigest) ||
    !exactStringArray(ring.desktopAudiences, EXPECTED_AUDIENCES) ||
    !Array.isArray(ring.keys) ||
    ring.keys.length < 1 ||
    ring.keys.length > 8
  ) {
    throw keyringError(
      "desktop_trusted_token_keyring_response_invalid",
      "可信令牌密钥环字段无效"
    );
  }
  const keys = ring.keys.map(validateVerificationKey);
  const keyIDs = keys.map((key) => key.kid);
  if (
    new Set(keyIDs).size !== keyIDs.length ||
    keyIDs.some((keyID, index) => index > 0 && keyIDs[index - 1] >= keyID)
  ) {
    throw keyringError(
      "desktop_trusted_token_keyring_response_invalid",
      "可信令牌密钥环 kid 必须唯一排序"
    );
  }
  const active = keys.find((key) => key.kid === ring.activeKid);
  if (!active) {
    throw keyringError(
      "desktop_trusted_token_keyring_response_invalid",
      "可信令牌密钥环 activeKid 无效"
    );
  }
  const generatedAt = unixSecond(ring.generatedAt);
  const activeNotBefore = unixSecond(active.signingNotBefore);
  const activeNotAfter =
    active.signingNotAfter === null ? null : unixSecond(active.signingNotAfter);
  if (
    generatedAt < activeNotBefore ||
    (activeNotAfter !== null && generatedAt >= activeNotAfter)
  ) {
    throw keyringError(
      "desktop_trusted_token_keyring_response_invalid",
      "可信令牌密钥环 activeKid 未覆盖 generatedAt"
    );
  }
  assertNonOverlappingWindows(keys);
  const result: DesktopTrustedTokenKeyring = {
    schemaVersion: 1,
    issuer: EXPECTED_ISSUER,
    revision: ring.revision,
    activeKid: ring.activeKid,
    generatedAt: ring.generatedAt,
    refreshAfterSeconds: REFRESH_AFTER_SECONDS,
    maxTokenLifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    keyringDigest: ring.keyringDigest,
    desktopAudiences: [...EXPECTED_AUDIENCES],
    keys
  };
  if (digestKeyring(result) !== result.keyringDigest) {
    throw keyringError(
      "desktop_trusted_token_keyring_response_invalid",
      "可信令牌密钥环 digest 不匹配"
    );
  }
  return result;
}

function validateVerificationKey(value: unknown): DesktopTrustedTokenVerificationKey {
  if (
    !exactObject(value, [
      "kid",
      "kty",
      "crv",
      "alg",
      "use",
      "x",
      "signingNotBefore",
      "signingNotAfter",
      "verifyUntil"
    ])
  ) {
    throw keyringError(
      "desktop_trusted_token_keyring_response_invalid",
      "可信令牌验证密钥结构无效"
    );
  }
  const key = value as unknown as DesktopTrustedTokenVerificationKey;
  if (
    typeof key.kid !== "string" ||
    !KEY_ID.test(key.kid) ||
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    key.alg !== "EdDSA" ||
    key.use !== "sig" ||
    !canonicalRawEd25519Key(key.x) ||
    !canonicalUtcSecond(key.signingNotBefore) ||
    !optionalCanonicalUtcSecond(key.signingNotAfter) ||
    !optionalCanonicalUtcSecond(key.verifyUntil) ||
    (key.signingNotAfter === null) !== (key.verifyUntil === null)
  ) {
    throw keyringError(
      "desktop_trusted_token_keyring_response_invalid",
      "可信令牌验证密钥字段无效"
    );
  }
  if (key.signingNotAfter !== null && key.verifyUntil !== null) {
    const before = unixSecond(key.signingNotBefore);
    const after = unixSecond(key.signingNotAfter);
    const verifyUntil = unixSecond(key.verifyUntil);
    if (after <= before || verifyUntil !== after + MAX_TOKEN_LIFETIME_SECONDS) {
      throw keyringError(
        "desktop_trusted_token_keyring_response_invalid",
        "可信令牌验证密钥退休窗口无效"
      );
    }
  }
  return { ...key };
}

function assertNonOverlappingWindows(keys: DesktopTrustedTokenVerificationKey[]): void {
  const windows = keys
    .map((key) => ({
      before: unixSecond(key.signingNotBefore),
      after: key.signingNotAfter === null ? null : unixSecond(key.signingNotAfter)
    }))
    .sort((left, right) => left.before - right.before);
  for (let index = 1; index < windows.length; index += 1) {
    const previous = windows[index - 1];
    if (previous.after === null || previous.after > windows[index].before) {
      throw keyringError(
        "desktop_trusted_token_keyring_response_invalid",
        "可信令牌验证密钥签名窗口重叠"
      );
    }
  }
}

function digestKeyring(ring: DesktopTrustedTokenKeyring): string {
  // Property insertion order intentionally mirrors Go publicKeyRingDigestPayload.
  const payload = {
    schemaVersion: ring.schemaVersion,
    issuer: ring.issuer,
    revision: ring.revision,
    activeKid: ring.activeKid,
    maxTokenLifetimeSeconds: ring.maxTokenLifetimeSeconds,
    desktopAudiences: ring.desktopAudiences,
    keys: ring.keys.map((key) => ({
      kid: key.kid,
      kty: key.kty,
      crv: key.crv,
      alg: key.alg,
      use: key.use,
      x: key.x,
      signingNotBefore: key.signingNotBefore,
      signingNotAfter: key.signingNotAfter,
      verifyUntil: key.verifyUntil
    }))
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function validateStoredState(value: unknown): StoredKeyringHighWater {
  if (
    !exactObject(value, [
      "version",
      "generation",
      "originEpoch",
      "origin",
      "revision",
      "keyringDigest",
      "keyring"
    ])
  ) {
    throw keyringError(
      "desktop_trusted_token_keyring_corrupt",
      "可信令牌密钥环高水位结构无效"
    );
  }
  const state = value as unknown as StoredKeyringHighWater;
  if (
    state.version !== 1 ||
    !positiveSafeRevision(state.generation) ||
    !positiveSafeRevision(state.originEpoch) ||
    trustedWebOrigin(state.origin, true) !== state.origin ||
    !nonNegativeSafeRevision(state.revision)
  ) {
    throw keyringError(
      "desktop_trusted_token_keyring_corrupt",
      "可信令牌密钥环高水位字段无效"
    );
  }
  if (state.revision === 0) {
    if (state.keyringDigest !== null || state.keyring !== null) {
      throw keyringError(
        "desktop_trusted_token_keyring_corrupt",
        "可信令牌密钥环来源重置状态无效"
      );
    }
  } else {
    if (typeof state.keyringDigest !== "string" || !HEX_DIGEST.test(state.keyringDigest)) {
      throw keyringError(
        "desktop_trusted_token_keyring_corrupt",
        "可信令牌密钥环高水位 digest 无效"
      );
    }
    let keyring: DesktopTrustedTokenKeyring;
    try {
      keyring = validateKeyring(state.keyring);
    } catch {
      throw keyringError(
        "desktop_trusted_token_keyring_corrupt",
        "可信令牌密钥环缓存无效"
      );
    }
    if (
      keyring.revision !== state.revision ||
      keyring.keyringDigest !== state.keyringDigest
    ) {
      throw keyringError(
        "desktop_trusted_token_keyring_corrupt",
        "可信令牌密钥环缓存与高水位不匹配"
      );
    }
    state.keyring = keyring;
  }
  return cloneState(state);
}

function chooseHighWater(
  left: StoredKeyringHighWater,
  right: StoredKeyringHighWater
): StoredKeyringHighWater {
  if (sameState(left, right)) return cloneState(left);
  if (left.generation === right.generation) {
    throw keyringError(
      "desktop_trusted_token_keyring_rollback",
      "可信令牌密钥环同代次高水位冲突"
    );
  }
  const high = left.generation > right.generation ? left : right;
  const low = high === left ? right : left;
  if (high.originEpoch < low.originEpoch) {
    throw keyringError(
      "desktop_trusted_token_keyring_rollback",
      "可信令牌密钥环来源代次回退"
    );
  }
  if (high.originEpoch === low.originEpoch) {
    if (high.origin !== low.origin || high.revision < low.revision) {
      throw keyringError(
        "desktop_trusted_token_keyring_rollback",
        "可信令牌密钥环高水位回退"
      );
    }
    if (
      high.revision === low.revision &&
      high.keyringDigest !== low.keyringDigest
    ) {
      throw keyringError(
        "desktop_trusted_token_keyring_rollback",
        "可信令牌密钥环同 revision 高水位冲突"
      );
    }
  } else if (high.originEpoch <= low.originEpoch || high.origin === low.origin) {
    throw keyringError(
      "desktop_trusted_token_keyring_rollback",
      "可信令牌密钥环来源重置链无效"
    );
  }
  return cloneState(high);
}

async function readBoundedResponse(response: HttpResponseLike): Promise<string> {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error("response chunk invalid");
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error("response too large");
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      throw keyringError(
        "desktop_trusted_token_keyring_response_invalid",
        "可信令牌密钥环响应超过安全上限"
      );
    } finally {
      reader.releaseLock();
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
    } catch {
      throw keyringError(
        "desktop_trusted_token_keyring_response_invalid",
        "可信令牌密钥环响应不是 UTF-8"
      );
    }
  }
  if (!response.text) {
    throw keyringError(
      "desktop_trusted_token_keyring_response_invalid",
      "可信令牌密钥环响应正文不可读"
    );
  }
  const text = await response.text();
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw keyringError(
      "desktop_trusted_token_keyring_response_invalid",
      "可信令牌密钥环响应超过安全上限"
    );
  }
  return text;
}

function parseStrictJson(raw: string): unknown {
  try {
    assertNoDuplicateJsonKeys(raw);
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof DesktopTrustedTokenKeyringError) throw error;
    throw keyringError(
      "desktop_trusted_token_keyring_response_invalid",
      "可信令牌密钥环 JSON 无效"
    );
  }
}

function assertNoDuplicateJsonKeys(raw: string): void {
  let index = 0;
  const whitespace = () => {
    while (index < raw.length && /[\t\n\r ]/.test(raw[index])) index += 1;
  };
  const string = (): string => {
    if (raw[index] !== '"') throw new Error("expected string");
    const start = index;
    index += 1;
    while (index < raw.length) {
      const character = raw[index++];
      if (character === '"') return JSON.parse(raw.slice(start, index)) as string;
      if (character === "\\") {
        if (index >= raw.length) throw new Error("bad escape");
        const escape = raw[index++];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(index, index + 4))) {
            throw new Error("bad unicode escape");
          }
          index += 4;
        } else if (!'"\\/bfnrt'.includes(escape)) {
          throw new Error("bad escape");
        }
      } else if (character.charCodeAt(0) < 0x20) {
        throw new Error("bad string character");
      }
    }
    throw new Error("unterminated string");
  };
  const value = (): void => {
    whitespace();
    if (raw[index] === "{") {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (raw[index] === "}") {
        index += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("duplicate key");
        keys.add(key);
        whitespace();
        if (raw[index++] !== ":") throw new Error("expected colon");
        value();
        whitespace();
        const separator = raw[index++];
        if (separator === "}") return;
        if (separator !== ",") throw new Error("expected comma");
      }
    }
    if (raw[index] === "[") {
      index += 1;
      whitespace();
      if (raw[index] === "]") {
        index += 1;
        return;
      }
      for (;;) {
        value();
        whitespace();
        const separator = raw[index++];
        if (separator === "]") return;
        if (separator !== ",") throw new Error("expected comma");
      }
    }
    if (raw[index] === '"') {
      string();
      return;
    }
    const remaining = raw.slice(index);
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      remaining
    )?.[0];
    if (!token) throw new Error("invalid value");
    index += token.length;
  };
  value();
  whitespace();
  if (index !== raw.length) throw new Error("trailing JSON");
}

function trustedWebOrigin(value: string, allowInsecureLoopbackForTests: boolean): string {
  if (typeof value !== "string" || value.trim() !== value || value.length > 2_048) {
    throw keyringError(
      "desktop_trusted_token_keyring_contract_invalid",
      "可信 Web URL 无效"
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw keyringError(
      "desktop_trusted_token_keyring_contract_invalid",
      "可信 Web URL 无效"
    );
  }
  if (parsed.username || parsed.password || !parsed.hostname) {
    throw keyringError(
      "desktop_trusted_token_keyring_contract_invalid",
      "可信 Web URL 不得包含凭据"
    );
  }
  const secure = parsed.protocol === "https:";
  const testLoopback =
    allowInsecureLoopbackForTests &&
    parsed.protocol === "http:" &&
    isLoopbackHostname(parsed.hostname);
  if (!secure && !testLoopback) {
    throw keyringError(
      "desktop_trusted_token_keyring_contract_invalid",
      "可信 Web URL 必须使用 HTTPS"
    );
  }
  return parsed.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return match !== null && match.slice(1).every((part) => Number(part) <= 255);
}

function canonicalRawEd25519Key(value: unknown): value is string {
  if (typeof value !== "string" || !RAW_ED25519_PUBLIC_KEY.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === 32 && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function canonicalUtcSecond(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_SECOND.test(value)) return false;
  const time = Date.parse(value);
  return (
    Number.isSafeInteger(time) &&
    time > 0 &&
    new Date(time).toISOString().replace(".000Z", "Z") === value
  );
}

function optionalCanonicalUtcSecond(value: unknown): value is string | null {
  return value === null || canonicalUtcSecond(value);
}

function unixSecond(value: string): number {
  return Date.parse(value) / 1_000;
}

function generatedAtIsFresh(generatedAt: string, now: Date): boolean {
  const current = now.getTime();
  const generated = Date.parse(generatedAt);
  return (
    Number.isSafeInteger(current) &&
    Number.isSafeInteger(generated) &&
    Math.abs(current - generated) <= REFRESH_AFTER_SECONDS * 1_000
  );
}

function exactStringArray(
  value: unknown,
  expected: readonly string[]
): value is DesktopTrustedTokenAudience[] {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as object).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveSafeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_SAFE_REVISION;
}

function nonNegativeSafeRevision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_SAFE_REVISION
  );
}

function encryptEnvelope(
  safeStorage: SafeStorageLike,
  state: StoredKeyringHighWater
): Buffer {
  let encrypted: Buffer;
  try {
    encrypted = safeStorage.encryptString(JSON.stringify(validateStoredState(state)));
  } catch {
    throw keyringError("desktop_secure_storage_unavailable", "可信令牌密钥环状态加密失败");
  }
  if (!Buffer.isBuffer(encrypted) || encrypted.byteLength < 1) {
    throw keyringError("desktop_secure_storage_unavailable", "可信令牌密钥环状态密文无效");
  }
  const envelope = Buffer.concat([ENVELOPE_MAGIC, encrypted]);
  if (envelope.byteLength > MAX_RESPONSE_BYTES) {
    throw keyringError("desktop_trusted_token_keyring_unsafe", "可信令牌密钥环状态过大");
  }
  return envelope;
}

function assertSafeFile(info: Stats): void {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < ENVELOPE_MAGIC.byteLength + 1 ||
    info.size > MAX_RESPONSE_BYTES ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  ) {
    throw keyringError("desktop_trusted_token_keyring_unsafe", "可信令牌密钥环文件不安全");
  }
}

function cloneKeyring(value: DesktopTrustedTokenKeyring): DesktopTrustedTokenKeyring {
  return {
    ...value,
    desktopAudiences: [...value.desktopAudiences],
    keys: value.keys.map((key) => ({ ...key }))
  };
}

function cloneState(value: StoredKeyringHighWater): StoredKeyringHighWater {
  return { ...value, keyring: value.keyring ? cloneKeyring(value.keyring) : null };
}

function sameState(left: StoredKeyringHighWater, right: StoredKeyringHighWater): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function syncDirectory(directory: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EACCES", "EINVAL", "EPERM"].some((code) => isErrorCode(error, code))
    ) {
      return false;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isErrorCode(value: unknown, code: string): boolean {
  return (
    value instanceof Error &&
    "code" in value &&
    (value as NodeJS.ErrnoException).code === code
  );
}

function keyringError(
  code: DesktopTrustedTokenKeyringErrorCode,
  message: string
): DesktopTrustedTokenKeyringError {
  return new DesktopTrustedTokenKeyringError(code, message);
}
