import { randomUUID } from "node:crypto";
import type {
  DesktopDeviceIdentityProjection,
  DesktopDeviceIdentityStore,
  SignedDesktopDeviceRequest
} from "./desktop-device-identity.ts";
import { sha256Hex, verifyDesktopDeviceSigningInput } from "./desktop-device-proof.ts";

export const DESKTOP_DEVICE_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 << 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_ID_PATTERN = /^[0-9a-f]{64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/;
const DECIMAL_SEQUENCE_PATTERN = /^[1-9][0-9]{0,19}$/;
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PROOF_HEADER_NAMES = [
  "X-AiCRM-Content-SHA256",
  "X-AiCRM-Device-Id",
  "X-AiCRM-Device-Nonce",
  "X-AiCRM-Device-Sequence",
  "X-AiCRM-Device-Signature",
  "X-AiCRM-Device-Timestamp"
] as const;

export type DesktopDeviceHeartbeatErrorCode =
  | "desktop_device_heartbeat_cancelled"
  | "desktop_device_heartbeat_contract_invalid"
  | "desktop_device_heartbeat_rejected"
  | "desktop_device_heartbeat_response_invalid"
  | "desktop_device_heartbeat_transport_failed"
  | "desktop_device_not_registered"
  | "desktop_host_api_untrusted";

export class DesktopDeviceHeartbeatError extends Error {
  readonly code: DesktopDeviceHeartbeatErrorCode;
  readonly status: number | null;
  readonly serverCode: string | null;

  constructor(
    code: DesktopDeviceHeartbeatErrorCode,
    message: string,
    options: { status?: number; serverCode?: string } = {}
  ) {
    super(message);
    this.code = code;
    this.status = Number.isInteger(options.status) ? (options.status ?? null) : null;
    this.serverCode = validServerCode(options.serverCode) ? options.serverCode! : null;
  }
}

export interface DesktopDeviceHeartbeatResult {
  deviceId: string;
  sequence: number;
  acceptedAt: string;
}

interface HeartbeatIdentityStore
  extends Pick<DesktopDeviceIdentityStore, "getIdentity" | "signRequest"> {}

interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type HostFetch = (url: string, init: RequestInit) => Promise<HttpResponseLike>;
type SetTimer = (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
type ClearTimer = (timer: ReturnType<typeof setTimeout>) => void;

export interface DesktopDeviceHeartbeatClientOptions {
  identityStore: HeartbeatIdentityStore;
  appVersion: string;
  loadTrustedApiBaseUrl: () => string | Promise<string>;
  fetch?: HostFetch;
  now?: () => Date;
  requestIdFactory?: () => string;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
}

/** Main-only signed heartbeat loop. It never receives Bearer or workspace input. */
export class DesktopDeviceHeartbeatClient {
  private readonly identityStore: HeartbeatIdentityStore;
  private readonly appVersion: string;
  private readonly loadTrustedApiBaseUrl: () => string | Promise<string>;
  private readonly hostFetch: HostFetch;
  private readonly now: () => Date;
  private readonly requestIdFactory: () => string;
  private readonly requestTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly activeControllers = new Set<AbortController>();
  private inFlight: Promise<DesktopDeviceHeartbeatResult> | null = null;
  private inFlightEpoch: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cancellationEpoch = 0;

  constructor(options: DesktopDeviceHeartbeatClientOptions) {
    this.identityStore = options.identityStore;
    this.appVersion = validateAppVersion(options.appVersion);
    this.loadTrustedApiBaseUrl = options.loadTrustedApiBaseUrl;
    this.hostFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => new Date());
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.requestTimeoutMs = validatePositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "心跳超时无效"
    );
    this.heartbeatIntervalMs = validatePositiveInteger(
      options.heartbeatIntervalMs ?? DESKTOP_DEVICE_HEARTBEAT_INTERVAL_MS,
      "心跳周期无效"
    );
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const epoch = this.cancellationEpoch;
    void this.runLoopIteration(epoch);
  }

  stop(): void {
    this.running = false;
    this.cancellationEpoch += 1;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    for (const controller of this.activeControllers) controller.abort();
  }

  heartbeat(): Promise<DesktopDeviceHeartbeatResult> {
    if (this.inFlight) return this.inFlight;
    const epoch = this.cancellationEpoch;
    const operation = this.sendHeartbeat(epoch);
    this.inFlight = operation;
    this.inFlightEpoch = epoch;
    void operation
      .finally(() => {
        if (this.inFlight === operation) {
          this.inFlight = null;
          this.inFlightEpoch = null;
        }
      })
      .catch(() => undefined);
    return operation;
  }

  private async runLoopIteration(epoch: number): Promise<void> {
    const operation = this.heartbeat();
    const operationEpoch = this.inFlightEpoch;
    try {
      await operation;
    } catch {
      // A later fresh, monotonically signed heartbeat is the recovery path.
    } finally {
      if (this.running && epoch === this.cancellationEpoch) {
        if (operationEpoch !== epoch) {
          void this.runLoopIteration(epoch);
          return;
        }
        this.timer = this.setTimer(() => {
          this.timer = null;
          void this.runLoopIteration(epoch);
        }, this.heartbeatIntervalMs);
      }
    }
  }

  private async sendHeartbeat(epoch: number): Promise<DesktopDeviceHeartbeatResult> {
    this.assertActive(epoch);
    const identity = await this.identityStore.getIdentity();
    this.assertActive(epoch);
    validateRegisteredIdentity(identity);
    const occurredAt = canonicalNow(this.now());
    const body = Buffer.from(
      JSON.stringify({
        bridgeVersion: 2,
        appVersion: this.appVersion,
        capabilities: { supportsDeviceProof: true },
        occurredAt
      }),
      "utf8"
    );
    const path = `/api/v1/ai-executor-devices/${identity.deviceId}/heartbeat`;
    const signed = await this.identityStore.signRequest({ method: "POST", path, body });
    this.assertActive(epoch);
    validateSignedHeartbeat(signed, identity, body, path);
    const origin = trustedApiOrigin(await this.loadTrustedApiBaseUrl());
    this.assertActive(epoch);
    const requestId = this.requestIdFactory();
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw heartbeatError("desktop_device_heartbeat_contract_invalid", "设备心跳 requestId 无效");
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
          ...signed.headers,
          Accept: "application/json",
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
          "X-KY-Request-Id": requestId
        },
        body: body.toString("utf8")
      });
    } catch {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
      if (epoch !== this.cancellationEpoch) {
        throw heartbeatError("desktop_device_heartbeat_cancelled", "设备心跳已取消");
      }
      throw heartbeatError("desktop_device_heartbeat_transport_failed", "设备心跳请求失败");
    }
    try {
      this.assertActive(epoch);
      const envelope = await readEnvelope(response);
      this.assertActive(epoch);
      if (!response.ok) {
        throw new DesktopDeviceHeartbeatError(
          "desktop_device_heartbeat_rejected",
          "服务端拒绝设备心跳",
          { status: response.status, serverCode: readServerCode(envelope) }
        );
      }
      return validateHeartbeatResponse(
        readEnvelopeData(envelope),
        identity.deviceId,
        signed.sequence
      );
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }

  private assertActive(epoch: number): void {
    if (epoch !== this.cancellationEpoch) {
      throw heartbeatError("desktop_device_heartbeat_cancelled", "设备心跳已取消");
    }
  }
}

function validateRegisteredIdentity(identity: DesktopDeviceIdentityProjection): void {
  if (
    identity.registrationStatus !== "registered" ||
    !DEVICE_ID_PATTERN.test(identity.deviceId) ||
    typeof identity.publicKey !== "string" ||
    identity.publicKey === "" ||
    !Number.isSafeInteger(identity.keyGeneration) ||
    identity.keyGeneration <= 0
  ) {
    throw heartbeatError("desktop_device_not_registered", "设备尚未安全登记");
  }
}

function validateSignedHeartbeat(
  signed: SignedDesktopDeviceRequest,
  identity: DesktopDeviceIdentityProjection,
  body: Uint8Array,
  path: string
): void {
  const names = Object.keys(signed.headers).sort();
  const expectedNames = [...PROOF_HEADER_NAMES].sort();
  const expectedSigningInput = [
    "AICRM-DEVICE-V1",
    "POST",
    path,
    signed.headers["X-AiCRM-Device-Timestamp"],
    signed.headers["X-AiCRM-Device-Nonce"],
    signed.sequence,
    signed.bodySha256,
    ""
  ].join("\n");
  if (
    names.length !== expectedNames.length ||
    !names.every((name, index) => name === expectedNames[index]) ||
    signed.deviceId !== identity.deviceId ||
    signed.publicKey !== identity.publicKey ||
    signed.keyGeneration !== identity.keyGeneration ||
    !DECIMAL_SEQUENCE_PATTERN.test(signed.sequence) ||
    signed.headers["X-AiCRM-Device-Id"] !== identity.deviceId ||
    signed.headers["X-AiCRM-Device-Sequence"] !== signed.sequence ||
    !validUint64(signed.sequence) ||
    signed.bodySha256 !== sha256Hex(body) ||
    signed.headers["X-AiCRM-Content-SHA256"] !== signed.bodySha256 ||
    signed.authorizationTokenHash !== "" ||
    signed.signingInput !== expectedSigningInput ||
    signed.requestHash !== sha256Hex(Buffer.from(expectedSigningInput, "utf8")) ||
    !verifyDesktopDeviceSigningInput(
      identity.publicKey,
      signed.signingInput,
      signed.headers["X-AiCRM-Device-Signature"] ?? ""
    )
  ) {
    throw heartbeatError("desktop_device_heartbeat_contract_invalid", "设备心跳签名合同无效");
  }
}

function validUint64(value: string): boolean {
  if (!DECIMAL_SEQUENCE_PATTERN.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= 0xffff_ffff_ffff_ffffn;
  } catch {
    return false;
  }
}

function validateHeartbeatResponse(
  value: unknown,
  expectedDeviceId: string,
  expectedSequence: string
): DesktopDeviceHeartbeatResult {
  if (!exactObject(value, ["deviceId", "sequence", "acceptedAt"])) {
    throw heartbeatError("desktop_device_heartbeat_response_invalid", "设备心跳响应不是安全投影");
  }
  const result = value as unknown as DesktopDeviceHeartbeatResult;
  if (
    result.deviceId !== expectedDeviceId ||
    !Number.isSafeInteger(result.sequence) ||
    result.sequence <= 0 ||
    String(result.sequence) !== expectedSequence ||
    !canonicalServerTime(result.acceptedAt)
  ) {
    throw heartbeatError("desktop_device_heartbeat_response_invalid", "设备心跳响应无效");
  }
  return { ...result };
}

function canonicalNow(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw heartbeatError("desktop_device_heartbeat_contract_invalid", "设备心跳时间无效");
  }
  return value.toISOString();
}

function canonicalServerTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RFC3339_UTC_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function trustedApiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw heartbeatError("desktop_host_api_untrusted", "Host API 地址无效");
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
    throw heartbeatError("desktop_host_api_untrusted", "Host API 地址不受信");
  }
  return url.origin;
}

async function readEnvelope(response: HttpResponseLike): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw heartbeatError("desktop_device_heartbeat_response_invalid", "设备心跳响应无法读取");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw heartbeatError("desktop_device_heartbeat_response_invalid", "设备心跳响应过大");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw heartbeatError("desktop_device_heartbeat_response_invalid", "设备心跳响应格式无效");
  }
}

function readEnvelopeData(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !("data" in envelope)) {
    throw heartbeatError("desktop_device_heartbeat_response_invalid", "设备心跳响应 envelope 无效");
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

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateAppVersion(value: string): string {
  if (typeof value !== "string" || value === "" || value.length > 64 || value.trim() !== value) {
    throw heartbeatError("desktop_device_heartbeat_contract_invalid", "设备心跳应用版本无效");
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) {
      throw heartbeatError("desktop_device_heartbeat_contract_invalid", "设备心跳应用版本无效");
    }
  }
  return value;
}

function validatePositiveInteger(value: number, message: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw heartbeatError("desktop_device_heartbeat_contract_invalid", message);
  }
  return value;
}

function heartbeatError(
  code: DesktopDeviceHeartbeatErrorCode,
  message: string
): DesktopDeviceHeartbeatError {
  return new DesktopDeviceHeartbeatError(code, message);
}
