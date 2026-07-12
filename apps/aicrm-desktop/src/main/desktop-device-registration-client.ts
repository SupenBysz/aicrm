import { randomUUID } from "node:crypto";
import type { DesktopSession } from "../shared/types.ts";
import type {
  DesktopDeviceIdentityProjection,
  DesktopDeviceIdentityStore,
  SignedDesktopDeviceRequest
} from "./desktop-device-identity.ts";
import {
  createDesktopDevicePendingRegistration,
  pendingRegistrationBody,
  pendingRegistrationSignedRequest,
  type DesktopDevicePendingRegistration,
  type DesktopDevicePendingRegistrationStore
} from "./desktop-device-registration-pending.ts";
import {
  hashAuthorizationToken,
  sha256Hex,
  verifyDesktopDeviceSigningInput
} from "./desktop-device-proof.ts";

export const DESKTOP_DEVICE_REGISTRATION_CHALLENGE_PATH =
  "/api/v1/ai-executor-devices/registration-challenges";
export const DESKTOP_DEVICE_REGISTRATION_PATH = "/api/v1/ai-executor-devices";

const PLATFORM_WORKSPACE_TYPE = "platform";
const PLATFORM_WORKSPACE_ID = "platform_root";
const MAX_RESPONSE_BYTES = 64 << 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_ID_PATTERN = /^[0-9a-f]{64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/;

export type DesktopDeviceRegistrationErrorCode =
  | "desktop_device_already_revoked"
  | "desktop_device_registration_cancelled"
  | "desktop_device_registration_contract_invalid"
  | "desktop_device_registration_recovery_required"
  | "desktop_device_registration_rejected"
  | "desktop_device_registration_response_invalid"
  | "desktop_device_registration_transport_failed"
  | "desktop_host_api_untrusted"
  | "desktop_host_session_expired"
  | "desktop_host_session_unavailable";

export class DesktopDeviceRegistrationError extends Error {
  readonly code: DesktopDeviceRegistrationErrorCode;
  readonly status: number | null;
  readonly serverCode: string | null;

  constructor(
    code: DesktopDeviceRegistrationErrorCode,
    message: string,
    options: { status?: number; serverCode?: string } = {}
  ) {
    super(message);
    this.code = code;
    this.status = Number.isInteger(options.status) ? (options.status ?? null) : null;
    this.serverCode = validServerCode(options.serverCode) ? options.serverCode! : null;
  }
}

/** Locked docs section 20.3 challenge request DTO. */
export interface DesktopDeviceRegistrationChallengeRequest {
  publicKey: string;
  deviceLabel: string;
  appVersion: string;
}

/** Locked docs section 20.3 challenge response DTO. */
export interface DesktopDeviceRegistrationChallenge {
  challengeId: string;
  challenge: string;
  expiresAt: string;
  algorithm: "Ed25519";
}

/** Locked docs section 20.3 create request DTO. */
export interface DesktopDeviceRegistrationCreateRequest {
  challengeId: string;
  challenge: string;
  publicKey: string;
  deviceLabel: string;
  appVersion: string;
}

/**
 * The registration endpoint returns only the server-derived identifier. Main
 * projects local registration state after checking that identifier against the
 * key it owns; no server-controlled status is trusted or forwarded.
 */
export interface DesktopDeviceRegistrationCreateResponse {
  deviceId: string;
}

interface RegistrationIdentityStore
  extends Pick<
    DesktopDeviceIdentityStore,
    | "getIdentity"
    | "prepareRegistrationRequest"
    | "repairRegistrationSequence"
    | "markRegistration"
  > {}

interface RegistrationPendingStore
  extends Pick<DesktopDevicePendingRegistrationStore, "load" | "create" | "clear"> {}

interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type HostFetch = (url: string, init: RequestInit) => Promise<HttpResponseLike>;

export interface DesktopDeviceRegistrationClientOptions {
  identityStore: RegistrationIdentityStore;
  pendingRegistrationStore: RegistrationPendingStore;
  deviceLabel: string;
  appVersion: string;
  /** Main-owned host session. Never source this value from Renderer input. */
  loadHostSession?: () => Promise<DesktopSession | null>;
  /** Main-owned trusted configuration. The registration method accepts no URL. */
  loadTrustedApiBaseUrl?: () => string | Promise<string>;
  fetch?: HostFetch;
  now?: () => Date;
  requestIdFactory?: () => string;
  requestTimeoutMs?: number;
}

/**
 * Main-only device registration client. It is intentionally not registered as
 * IPC and does not advertise any Codex capability. `register()` accepts no
 * token, URL, challenge or device state from Renderer.
 */
export class DesktopDeviceRegistrationClient {
  private readonly identityStore: RegistrationIdentityStore;
  private readonly pendingRegistrationStore: RegistrationPendingStore;
  private readonly deviceLabel: string;
  private readonly appVersion: string;
  private readonly loadHostSession: () => Promise<DesktopSession | null>;
  private readonly loadTrustedApiBaseUrl: () => string | Promise<string>;
  private readonly hostFetch: HostFetch;
  private readonly now: () => Date;
  private readonly requestIdFactory: () => string;
  private readonly requestTimeoutMs: number;
  private inFlight: Promise<DesktopDeviceIdentityProjection> | null = null;
  private cancellationEpoch = 0;
  private readonly activeControllers = new Set<AbortController>();

  constructor(options: DesktopDeviceRegistrationClientOptions) {
    this.identityStore = options.identityStore;
    this.pendingRegistrationStore = options.pendingRegistrationStore;
    this.deviceLabel = validateDeviceLabel(options.deviceLabel);
    this.appVersion = validateAppVersion(options.appVersion);
    this.loadHostSession =
      options.loadHostSession ?? (async () => (await import("./session-store.ts")).loadSession());
    this.loadTrustedApiBaseUrl =
      options.loadTrustedApiBaseUrl ??
      (async () => (await import("./config.ts")).loadDesktopConfig().apiBaseUrl);
    this.hostFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => new Date());
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.requestTimeoutMs = validateTimeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  register(): Promise<DesktopDeviceIdentityProjection> {
    if (this.inFlight) return this.inFlight;
    const epoch = this.cancellationEpoch;
    const operation = this.registerOnce(epoch);
    this.inFlight = operation;
    void operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    }).catch(() => undefined);
    return operation;
  }

  cancel(): void {
    this.cancellationEpoch += 1;
    for (const controller of this.activeControllers) controller.abort();
  }

  private async registerOnce(epoch: number): Promise<DesktopDeviceIdentityProjection> {
    this.assertActive(epoch);
    const identity = await this.identityStore.getIdentity();
    this.assertActive(epoch);
    const pending = await this.pendingRegistrationStore.load();
    this.assertActive(epoch);
    if (identity.registrationStatus === "registered") {
      if (pending) {
        validatePendingForIdentity(pending, identity);
        await this.pendingRegistrationStore.clear(identity.deviceId, pending.requestHash);
        this.assertActive(epoch);
      }
      return identity;
    }
    if (identity.registrationStatus === "revoked") {
      throw registrationError("desktop_device_already_revoked", "设备身份已撤销，禁止重新登记");
    }

    const authorization = await this.loadBearerAuthorization();
    this.assertActive(epoch);
    const origin = trustedApiOrigin(await this.loadTrustedApiBaseUrl());
    this.assertActive(epoch);
    if (pending) {
      if (pending.authorization !== authorization) {
        throw registrationError(
          "desktop_device_registration_recovery_required",
          "Host Bearer 已变化，禁止重签首次登记"
        );
      }
      return this.replayPending(identity, pending, origin, authorization, epoch);
    }
    const challengeRequest: DesktopDeviceRegistrationChallengeRequest = {
      publicKey: identity.publicKey,
      deviceLabel: this.deviceLabel,
      appVersion: this.appVersion
    };
    const challengeBody = encodeJson(challengeRequest);
    const challenge = await this.postJson<DesktopDeviceRegistrationChallenge>(
      origin,
      DESKTOP_DEVICE_REGISTRATION_CHALLENGE_PATH,
      authorization,
      challengeBody,
      validateChallenge,
      epoch,
      { "Idempotency-Key": challengeIdempotencyKey(challengeBody) }
    );
    this.assertActive(epoch);
    if (Date.parse(challenge.expiresAt) <= this.now().getTime()) {
      throw registrationError(
        "desktop_device_registration_response_invalid",
        "设备登记 challenge 已过期"
      );
    }

    const createRequest: DesktopDeviceRegistrationCreateRequest = {
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      publicKey: identity.publicKey,
      deviceLabel: this.deviceLabel,
      appVersion: this.appVersion
    };
    const createBody = encodeJson(createRequest);
    let prepared: DesktopDevicePendingRegistration | null = null;
    await this.identityStore.prepareRegistrationRequest(
      {
        method: "POST",
        path: DESKTOP_DEVICE_REGISTRATION_PATH,
        body: createBody,
        authorization,
        allowedAuthorizationSchemes: ["Bearer"]
      },
      async (signed) => {
        this.assertActive(epoch);
        validateSignedRegistration(
          signed,
          identity,
          createBody,
          authorization,
          this.now().getTime(),
          true
        );
        prepared = createDesktopDevicePendingRegistration({
          body: createBody,
          authorization,
          signed,
          createdAt: this.now().toISOString()
        });
        await this.pendingRegistrationStore.create(prepared);
        this.assertActive(epoch);
      }
    );
    this.assertActive(epoch);
    if (!prepared) {
      throw registrationError(
        "desktop_device_registration_recovery_required",
        "设备登记待定请求未持久化"
      );
    }
    return this.submitPending(identity, prepared, origin, authorization, epoch);
  }

  private async replayPending(
    identity: DesktopDeviceIdentityProjection,
    pending: DesktopDevicePendingRegistration,
    origin: string,
    authorization: string,
    epoch: number
  ): Promise<DesktopDeviceIdentityProjection> {
    this.assertActive(epoch);
    validatePendingForIdentity(pending, identity);
    await this.identityStore.repairRegistrationSequence({
      deviceId: pending.deviceId,
      publicKey: pending.publicKey,
      keyGeneration: pending.keyGeneration,
      sequence: pending.sequence
    });
    this.assertActive(epoch);
    return this.submitPending(identity, pending, origin, authorization, epoch);
  }

  private async submitPending(
    identity: DesktopDeviceIdentityProjection,
    pending: DesktopDevicePendingRegistration,
    origin: string,
    authorization: string,
    epoch: number
  ): Promise<DesktopDeviceIdentityProjection> {
    this.assertActive(epoch);
    const body = pendingRegistrationBody(pending);
    const signed = pendingRegistrationSignedRequest(pending);
    validatePendingCreateBody(body, identity);
    validateSignedRegistration(signed, identity, body, authorization, this.now().getTime(), false);
    const created = await this.postJson<DesktopDeviceRegistrationCreateResponse>(
      origin,
      DESKTOP_DEVICE_REGISTRATION_PATH,
      authorization,
      body,
      validateCreateResponse,
      epoch,
      signed.headers
    );
    this.assertActive(epoch);
    if (created.deviceId !== identity.deviceId) {
      throw registrationError(
        "desktop_device_registration_response_invalid",
        "服务端设备标识与本机密钥不匹配"
      );
    }
    const registered = await this.identityStore.markRegistration("registered", identity.deviceId);
    this.assertActive(epoch);
    await this.pendingRegistrationStore.clear(identity.deviceId, pending.requestHash);
    this.assertActive(epoch);
    return registered;
  }

  private async loadBearerAuthorization(): Promise<string> {
    const session = await this.loadHostSession();
    if (!session || !validBearerToken(session.token)) {
      throw registrationError("desktop_host_session_unavailable", "Host 登录会话不可用");
    }
    const expiresAt = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) {
      throw registrationError("desktop_host_session_expired", "Host 登录会话已过期");
    }
    return `Bearer ${session.token}`;
  }

  private async postJson<T>(
    origin: string,
    path: string,
    authorization: string,
    body: Uint8Array,
    validate: (value: unknown) => T,
    epoch: number,
    signedHeaders: Record<string, string> = {}
  ): Promise<T> {
    this.assertActive(epoch);
    const requestId = this.requestIdFactory();
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw registrationError(
        "desktop_device_registration_contract_invalid",
        "Host requestId 无效"
      );
    }
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: HttpResponseLike;
    try {
      response = await this.hostFetch(`${origin}${path}`, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
        headers: {
          ...signedHeaders,
          Accept: "application/json",
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
          Authorization: authorization,
          "X-KY-Request-Id": requestId,
          "X-KY-Workspace-Type": PLATFORM_WORKSPACE_TYPE,
          "X-KY-Workspace-Id": PLATFORM_WORKSPACE_ID
        },
        body: Buffer.from(body).toString("utf8")
      });
    } catch {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
      if (epoch !== this.cancellationEpoch) {
        throw registrationError("desktop_device_registration_cancelled", "设备自动登记已取消");
      }
      throw registrationError(
        "desktop_device_registration_transport_failed",
        "设备登记请求失败"
      );
    }

    let text: string;
    try {
      text = await readBoundedText(response);
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
    this.assertActive(epoch);
    const envelope = parseEnvelope(text);
    if (!response.ok) {
      throw new DesktopDeviceRegistrationError(
        "desktop_device_registration_rejected",
        "服务端拒绝设备登记",
        {
          status: response.status,
          serverCode: readServerCode(envelope)
        }
      );
    }
    return validate(readEnvelopeData(envelope));
  }

  private assertActive(epoch: number): void {
    if (epoch !== this.cancellationEpoch) {
      throw registrationError("desktop_device_registration_cancelled", "设备自动登记已取消");
    }
  }
}

function trustedApiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw registrationError("desktop_host_api_untrusted", "Host API 地址无效");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw registrationError("desktop_host_api_untrusted", "Host API 地址不受信");
  }
  return url.origin;
}

function validateChallenge(value: unknown): DesktopDeviceRegistrationChallenge {
  if (!exactObject(value, ["challengeId", "challenge", "expiresAt", "algorithm"])) {
    throw registrationError(
      "desktop_device_registration_response_invalid",
      "设备登记 challenge 响应无效"
    );
  }
  const challenge = value as unknown as DesktopDeviceRegistrationChallenge;
  if (
    !validOpaque(challenge.challengeId, 160) ||
    typeof challenge.challenge !== "string" ||
    challenge.challenge.length < 16 ||
    challenge.challenge.length > 2048 ||
    !Number.isFinite(Date.parse(challenge.expiresAt)) ||
    challenge.algorithm !== "Ed25519"
  ) {
    throw registrationError(
      "desktop_device_registration_response_invalid",
      "设备登记 challenge 响应无效"
    );
  }
  return challenge;
}

function validateCreateResponse(value: unknown): DesktopDeviceRegistrationCreateResponse {
  if (!exactObject(value, ["deviceId"])) {
    throw registrationError(
      "desktop_device_registration_response_invalid",
      "设备登记响应不是安全投影"
    );
  }
  const response = value as unknown as DesktopDeviceRegistrationCreateResponse;
  if (!DEVICE_ID_PATTERN.test(response.deviceId)) {
    throw registrationError(
      "desktop_device_registration_response_invalid",
      "设备登记响应标识无效"
    );
  }
  return response;
}

function validateSignedRegistration(
  signed: SignedDesktopDeviceRequest,
  identity: DesktopDeviceIdentityProjection,
  body: Uint8Array,
  authorization: string,
  nowMilliseconds: number,
  enforceClockWindow: boolean
): void {
  const requiredHeaderNames = [
    "X-AiCRM-Content-SHA256",
    "X-AiCRM-Device-Id",
    "X-AiCRM-Device-Nonce",
    "X-AiCRM-Device-Sequence",
    "X-AiCRM-Device-Signature",
    "X-AiCRM-Device-Timestamp"
  ];
  if (!exactObject(signed.headers, requiredHeaderNames)) {
    throw registrationError(
      "desktop_device_registration_contract_invalid",
      "设备登记签名头无效"
    );
  }
  const expectedBodyHash = sha256Hex(body);
  const expectedTokenHash = hashAuthorizationToken(authorization, ["Bearer"]);
  const timestamp = Number(signed.headers["X-AiCRM-Device-Timestamp"]);
  const signature = signed.headers["X-AiCRM-Device-Signature"];
  if (
    signed.sequence !== "1" ||
    signed.deviceId !== identity.deviceId ||
    signed.publicKey !== identity.publicKey ||
    signed.keyGeneration !== 1 ||
    signed.headers["X-AiCRM-Device-Id"] !== identity.deviceId ||
    signed.headers["X-AiCRM-Device-Sequence"] !== "1" ||
    signed.headers["X-AiCRM-Content-SHA256"] !== expectedBodyHash ||
    signed.bodySha256 !== expectedBodyHash ||
    signed.authorizationTokenHash !== expectedTokenHash ||
    signed.requestHash !== sha256Hex(Buffer.from(signed.signingInput, "utf8")) ||
    !Number.isSafeInteger(timestamp) ||
    (enforceClockWindow && Math.abs(timestamp - nowMilliseconds) > 5 * 60 * 1000) ||
    !verifyDesktopDeviceSigningInput(identity.publicKey, signed.signingInput, signature)
  ) {
    throw registrationError(
      "desktop_device_registration_recovery_required",
      "设备首次登记签名、序列或密钥代次无效"
    );
  }
}

function validatePendingForIdentity(
  pending: DesktopDevicePendingRegistration,
  identity: DesktopDeviceIdentityProjection
): void {
  const body = pendingRegistrationBody(pending);
  const signed = pendingRegistrationSignedRequest(pending);
  if (
    pending.deviceId !== identity.deviceId ||
    pending.publicKey !== identity.publicKey ||
    pending.keyGeneration !== identity.keyGeneration ||
    pending.sequence !== "1"
  ) {
    throw registrationError(
      "desktop_device_registration_recovery_required",
      "设备登记待定请求与身份不匹配"
    );
  }
  validatePendingCreateBody(body, identity);
  validateSignedRegistration(
    signed,
    identity,
    body,
    pending.authorization,
    Date.parse(pending.createdAt),
    false
  );
}

function validatePendingCreateBody(
  body: Uint8Array,
  identity: DesktopDeviceIdentityProjection
): DesktopDeviceRegistrationCreateRequest {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    throw registrationError(
      "desktop_device_registration_recovery_required",
      "设备登记待定 body 无效"
    );
  }
  if (!exactObject(value, ["challengeId", "challenge", "publicKey", "deviceLabel", "appVersion"])) {
    throw registrationError(
      "desktop_device_registration_recovery_required",
      "设备登记待定 body 结构无效"
    );
  }
  const create = value as unknown as DesktopDeviceRegistrationCreateRequest;
  if (
    !validOpaque(create.challengeId, 160) ||
    typeof create.challenge !== "string" ||
    create.challenge.length < 16 ||
    create.challenge.length > 2048 ||
    create.publicKey !== identity.publicKey
  ) {
    throw registrationError(
      "desktop_device_registration_recovery_required",
      "设备登记待定 body 字段无效"
    );
  }
  validateDeviceLabel(create.deviceLabel);
  validateAppVersion(create.appVersion);
  const canonical = encodeJson({
    challengeId: create.challengeId,
    challenge: create.challenge,
    publicKey: create.publicKey,
    deviceLabel: create.deviceLabel,
    appVersion: create.appVersion
  });
  if (!Buffer.from(canonical).equals(Buffer.from(body))) {
    throw registrationError(
      "desktop_device_registration_recovery_required",
      "设备登记待定 body 不是规范编码"
    );
  }
  return create;
}

function challengeIdempotencyKey(body: Uint8Array): string {
  return `desktop-device-challenge:${sha256Hex(body)}`;
}

function validateDeviceLabel(value: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 120 ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw registrationError(
      "desktop_device_registration_contract_invalid",
      "设备名称无效"
    );
  }
  return value;
}

function validateAppVersion(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    value.trim() !== value ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x21 || code > 0x7e;
    })
  ) {
    throw registrationError(
      "desktop_device_registration_contract_invalid",
      "客户端版本无效"
    );
  }
  return value;
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60_000) {
    throw registrationError(
      "desktop_device_registration_contract_invalid",
      "设备登记超时配置无效"
    );
  }
  return value;
}

function validBearerToken(token: string): boolean {
  if (typeof token !== "string" || token.length < 1 || token.length > 8192) return false;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function validOpaque(value: string, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function encodeJson(value: object): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

async function readBoundedText(response: HttpResponseLike): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw registrationError(
      "desktop_device_registration_response_invalid",
      "设备登记响应无法读取"
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw registrationError(
      "desktop_device_registration_response_invalid",
      "设备登记响应过大"
    );
  }
  return text;
}

function parseEnvelope(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw registrationError(
      "desktop_device_registration_response_invalid",
      "设备登记响应格式无效"
    );
  }
}

function readEnvelopeData(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !("data" in envelope)) {
    throw registrationError(
      "desktop_device_registration_response_invalid",
      "设备登记响应 envelope 无效"
    );
  }
  return (envelope as { data?: unknown }).data;
}

function readServerCode(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return undefined;
  const error = (envelope as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function validServerCode(value: string | undefined): boolean {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value);
}

function registrationError(
  code: DesktopDeviceRegistrationErrorCode,
  message: string
): DesktopDeviceRegistrationError {
  return new DesktopDeviceRegistrationError(code, message);
}
