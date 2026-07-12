import { randomUUID } from "node:crypto";
import type { DesktopSession } from "../shared/types.ts";
import type {
  DesktopDeviceIdentityProjection,
  DesktopDeviceIdentityStore,
  SignedDesktopDeviceRequest
} from "./desktop-device-identity.ts";
import type {
  DesktopDeviceRequestJournalRecord,
  DesktopDeviceRequestJournalStore
} from "./desktop-device-request-journal.ts";
import { desktopTrustedRequestReference } from "./desktop-device-request-journal.ts";
import {
  hashAuthorizationToken,
  sha256Hex,
  verifyDesktopDeviceSigningInput
} from "./desktop-device-proof.ts";
import type { DesktopDeviceRequestLane } from "./desktop-device-request-lane.ts";

const PLATFORM_WORKSPACE_TYPE = "platform";
const PLATFORM_WORKSPACE_ID = "platform_root";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 << 10;
const MAX_BEARER_BYTES = 8 << 10;
const DEVICE_ID_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const DECIMAL_SEQUENCE_PATTERN = /^[1-9][0-9]{0,19}$/;
const DECIMAL_TIMESTAMP_PATTERN = /^[1-9][0-9]{0,15}$/;
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PROOF_HEADER_NAMES = [
  "X-AiCRM-Content-SHA256",
  "X-AiCRM-Device-Id",
  "X-AiCRM-Device-Nonce",
  "X-AiCRM-Device-Sequence",
  "X-AiCRM-Device-Signature",
  "X-AiCRM-Device-Timestamp"
] as const;

export type DesktopExecutorDeviceBindingErrorCode =
  | "desktop_executor_device_binding_cancelled"
  | "desktop_executor_device_binding_contract_invalid"
  | "desktop_executor_device_binding_recovery_conflict"
  | "desktop_executor_device_binding_rejected"
  | "desktop_executor_device_binding_response_invalid"
  | "desktop_executor_device_binding_transport_failed"
  | "desktop_device_not_registered"
  | "desktop_host_api_untrusted"
  | "desktop_host_session_expired"
  | "desktop_host_session_unavailable";

export class DesktopExecutorDeviceBindingError extends Error {
  readonly code: DesktopExecutorDeviceBindingErrorCode;
  readonly status: number | null;
  readonly serverCode: string | null;

  constructor(
    code: DesktopExecutorDeviceBindingErrorCode,
    message: string,
    options: { status?: number; serverCode?: string } = {}
  ) {
    super(message);
    this.code = code;
    this.status = Number.isInteger(options.status) ? (options.status ?? null) : null;
    this.serverCode = validServerCode(options.serverCode) ? options.serverCode! : null;
  }
}

export interface BindDesktopExecutorDeviceInput {
  executorId: string;
  expectedRevision: number;
}

export interface DesktopExecutorDeviceBindingProjection {
  executorId: string;
  deviceId: string;
  status: "active";
  revision: number;
  force: false;
  updatedAt: string;
}

export interface BindDesktopExecutorDeviceResponse {
  binding: DesktopExecutorDeviceBindingProjection;
  replayed: boolean;
}

export interface BindDesktopExecutorDeviceResult {
  requestReference: string;
  requestHash: string;
  recovered: boolean;
  data: BindDesktopExecutorDeviceResponse;
}

interface BindingIdentityStore
  extends Pick<DesktopDeviceIdentityStore, "getIdentity" | "signRequest"> {}

interface BindingRequestLane extends Pick<DesktopDeviceRequestLane, "runPinned"> {}

interface BindingRequestJournal
  extends Pick<
    DesktopDeviceRequestJournalStore,
    "load" | "createOrLoad" | "recordResponse" | "complete"
  > {}

interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type HostFetch = (url: string, init: RequestInit) => Promise<HttpResponseLike>;

export interface DesktopExecutorDeviceBindingClientOptions {
  identityStore: BindingIdentityStore;
  requestLane: BindingRequestLane;
  requestJournal: BindingRequestJournal;
  loadHostSession: () => Promise<DesktopSession | null>;
  loadTrustedApiBaseUrl: () => string | Promise<string>;
  /** Main startup must restore the shared request head before this resolves. */
  waitForRequestFence?: () => void | Promise<void>;
  fetch?: HostFetch;
  now?: () => Date;
  requestIdFactory?: () => string;
  requestTimeoutMs?: number;
}

/** Main-only initial executor-to-device binding transport. */
export class DesktopExecutorDeviceBindingClient {
  private readonly identityStore: BindingIdentityStore;
  private readonly requestLane: BindingRequestLane;
  private readonly requestJournal: BindingRequestJournal;
  private readonly loadHostSession: () => Promise<DesktopSession | null>;
  private readonly loadTrustedApiBaseUrl: () => string | Promise<string>;
  private readonly waitForRequestFence: () => void | Promise<void>;
  private readonly hostFetch: HostFetch;
  private readonly now: () => Date;
  private readonly requestIdFactory: () => string;
  private readonly requestTimeoutMs: number;
  private readonly activeControllers = new Set<AbortController>();
  private cancellationEpoch = 0;

  constructor(options: DesktopExecutorDeviceBindingClientOptions) {
    this.identityStore = options.identityStore;
    this.requestLane = options.requestLane;
    this.requestJournal = options.requestJournal;
    this.loadHostSession = options.loadHostSession;
    this.loadTrustedApiBaseUrl = options.loadTrustedApiBaseUrl;
    this.waitForRequestFence = options.waitForRequestFence ?? (() => undefined);
    this.hostFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => new Date());
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.requestTimeoutMs = validateTimeout(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    );
  }

  async bindExecutorDevice(
    input: BindDesktopExecutorDeviceInput
  ): Promise<BindDesktopExecutorDeviceResult> {
    const executorId = validOpaque(input.executorId, "executorId");
    const expectedRevision = nonNegativeRevision(
      input.expectedRevision,
      "expectedRevision"
    );
    const path = `/api/v1/ai-executors/${executorId}/device-bindings`;
    const reference = desktopTrustedRequestReference("device_binding", path);
    const epoch = this.cancellationEpoch;
    try {
      await this.waitForRequestFence();
    } catch {
      throw bindingError(
        "desktop_executor_device_binding_recovery_conflict",
        "设备请求启动恢复栅栏失败"
      );
    }
    this.assertActive(epoch);
    return this.requestLane.runPinned(
      reference,
      () => this.submit(executorId, expectedRevision, path, reference, epoch),
      async () => {
        try {
          // A response-bearing record still awaits this method's strict
          // confirmation and complete barrier, so it remains a startup head.
          return (await this.requestJournal.load(reference)) !== null;
        } catch {
          return true;
        }
      }
    );
  }

  cancel(): void {
    this.cancellationEpoch += 1;
    for (const controller of this.activeControllers) controller.abort();
  }

  private async submit(
    executorId: string,
    expectedRevision: number,
    requestPath: string,
    reference: string,
    epoch: number
  ): Promise<BindDesktopExecutorDeviceResult> {
    this.assertActive(epoch);
    let configuredOrigin: string;
    try {
      configuredOrigin = await this.loadTrustedApiBaseUrl();
    } catch {
      throw bindingError("desktop_host_api_untrusted", "Host API 地址不可用");
    }
    const origin = trustedApiOrigin(configuredOrigin);
    this.assertActive(epoch);
    let record = await this.requestJournal.load(reference);
    this.assertActive(epoch);
    const identity = await this.identityStore.getIdentity();
    this.assertActive(epoch);
    validateRegisteredIdentity(identity);
    const body = encodeJson({ deviceId: identity.deviceId, expectedRevision });

    if (record) {
      validateRecoveredRecord(record, identity, origin, requestPath, body);
    } else {
      const authorization = await this.loadBearerAuthorization();
      this.assertActive(epoch);
      const signed = await this.identityStore.signRequest({
        method: "POST",
        path: requestPath,
        body,
        authorization,
        allowedAuthorizationSchemes: ["Bearer"]
      });
      this.assertActive(epoch);
      validateSignedRequest(signed, identity, requestPath, body, authorization);
      record = await this.requestJournal.createOrLoad({
        version: 1,
        reference,
        kind: "device_binding",
        method: "POST",
        origin,
        path: requestPath,
        authorization,
        bodyBase64: Buffer.from(body).toString("base64"),
        signed,
        createdAt: canonicalJournalNow(this.now()),
        response: null
      });
      this.assertActive(epoch);
      validateRecoveredRecord(record, identity, origin, requestPath, body);
    }

    if (record.response) {
      const data = parseSuccessfulResponse(
        Buffer.from(record.response.bodyBase64, "base64").toString("utf8"),
        executorId,
        identity.deviceId,
        expectedRevision
      );
      await this.requestJournal.complete(reference, record.signed.requestHash);
      return bindingResult(record, data, true);
    }

    const response = await this.postExact(record, epoch);
    const data = parseSuccessfulResponse(
      response.text,
      executorId,
      identity.deviceId,
      expectedRevision
    );
    this.assertActive(epoch);
    const persisted = await this.requestJournal.recordResponse(
      reference,
      record.signed.requestHash,
      {
        status: 201,
        bodyBase64: Buffer.from(response.text, "utf8").toString("base64"),
        receivedAt: canonicalJournalNow(this.now())
      }
    );
    this.assertActive(epoch);
    if (!persisted.response) {
      throw invalidResponse("设备绑定响应未持久化");
    }
    await this.requestJournal.complete(reference, persisted.signed.requestHash);
    return bindingResult(persisted, data, false);
  }

  private async loadBearerAuthorization(): Promise<string> {
    let session: DesktopSession | null;
    try {
      session = await this.loadHostSession();
    } catch {
      throw bindingError("desktop_host_session_unavailable", "Host 登录会话不可用");
    }
    if (!session || !validBearerToken(session.token)) {
      throw bindingError("desktop_host_session_unavailable", "Host 登录会话不可用");
    }
    const expiresAt = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) {
      throw bindingError("desktop_host_session_expired", "Host 登录会话已过期");
    }
    return `Bearer ${session.token}`;
  }

  private async postExact(
    record: DesktopDeviceRequestJournalRecord,
    epoch: number
  ): Promise<{ text: string }> {
    const requestId = this.requestIdFactory();
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw bindingError(
        "desktop_executor_device_binding_contract_invalid",
        "设备绑定 requestId 无效"
      );
    }
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const response = await this.hostFetch(`${record.origin}${record.path}`, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
        headers: {
          ...record.signed.headers,
          Accept: "application/json",
          Authorization: record.authorization,
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
          "X-KY-Request-Id": requestId,
          "X-KY-Workspace-Type": PLATFORM_WORKSPACE_TYPE,
          "X-KY-Workspace-Id": PLATFORM_WORKSPACE_ID
        },
        body: Buffer.from(record.bodyBase64, "base64").toString("utf8")
      });
      const text = await readBoundedText(response);
      this.assertActive(epoch);
      if (!response.ok || response.status !== 201) {
        throw new DesktopExecutorDeviceBindingError(
          "desktop_executor_device_binding_rejected",
          "服务端拒绝设备绑定请求",
          { status: response.status, serverCode: readServerCode(text) }
        );
      }
      return { text };
    } catch (error) {
      if (epoch !== this.cancellationEpoch) {
        throw bindingError(
          "desktop_executor_device_binding_cancelled",
          "设备绑定请求已取消"
        );
      }
      if (timedOut) {
        throw bindingError(
          "desktop_executor_device_binding_transport_failed",
          "设备绑定请求超时"
        );
      }
      if (error instanceof DesktopExecutorDeviceBindingError) throw error;
      throw bindingError(
        "desktop_executor_device_binding_transport_failed",
        "设备绑定请求失败"
      );
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }

  private assertActive(epoch: number): void {
    if (epoch !== this.cancellationEpoch) {
      throw bindingError(
        "desktop_executor_device_binding_cancelled",
        "设备绑定请求已取消"
      );
    }
  }
}

function validateRecoveredRecord(
  record: DesktopDeviceRequestJournalRecord,
  identity: DesktopDeviceIdentityProjection,
  origin: string,
  requestPath: string,
  expectedBody: Uint8Array
): void {
  if (
    record.kind !== "device_binding" ||
    record.method !== "POST" ||
    record.origin !== origin ||
    record.path !== requestPath
  ) {
    throw recoveryConflict("设备绑定恢复记录与当前操作不匹配");
  }
  const actualBody = Buffer.from(record.bodyBase64, "base64");
  if (!actualBody.equals(Buffer.from(expectedBody))) {
    throw recoveryConflict("设备绑定恢复 body 与当前操作不匹配");
  }
  validateSignedRequest(
    record.signed,
    identity,
    requestPath,
    actualBody,
    record.authorization
  );
}

function validateSignedRequest(
  signed: SignedDesktopDeviceRequest,
  identity: DesktopDeviceIdentityProjection,
  requestPath: string,
  body: Uint8Array,
  authorization: string
): void {
  if (
    !exactObject(signed, [
      "headers",
      "bodySha256",
      "authorizationTokenHash",
      "signingInput",
      "requestHash",
      "deviceId",
      "publicKey",
      "keyGeneration",
      "sequence"
    ]) ||
    !exactObject(signed.headers, PROOF_HEADER_NAMES) ||
    Object.values(signed.headers).some((value) => typeof value !== "string")
  ) {
    throw recoveryConflict("设备绑定签名结构无效");
  }
  let expectedAuthorizationHash: string;
  try {
    expectedAuthorizationHash = hashAuthorizationToken(authorization, ["Bearer"]);
  } catch {
    throw recoveryConflict("设备绑定 Bearer 栅栏无效");
  }
  const expectedBodyHash = sha256Hex(body);
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
  const publicKey = decodeCanonicalBase64Url(signed.publicKey, 32);
  if (
    signed.deviceId !== identity.deviceId ||
    signed.publicKey !== identity.publicKey ||
    publicKey === null ||
    sha256Hex(publicKey) !== identity.deviceId ||
    signed.keyGeneration !== identity.keyGeneration ||
    signed.headers["X-AiCRM-Device-Id"] !== identity.deviceId ||
    signed.headers["X-AiCRM-Device-Sequence"] !== signed.sequence ||
    !validTimestamp(signed.headers["X-AiCRM-Device-Timestamp"]) ||
    decodeCanonicalBase64Url(signed.headers["X-AiCRM-Device-Nonce"], 16) === null ||
    !validUint64(signed.sequence) ||
    signed.bodySha256 !== expectedBodyHash ||
    signed.headers["X-AiCRM-Content-SHA256"] !== expectedBodyHash ||
    signed.authorizationTokenHash !== expectedAuthorizationHash ||
    signed.signingInput !== expectedSigningInput ||
    signed.requestHash !== sha256Hex(Buffer.from(expectedSigningInput, "utf8")) ||
    !verifyDesktopDeviceSigningInput(
      identity.publicKey,
      signed.signingInput,
      signed.headers["X-AiCRM-Device-Signature"] ?? ""
    )
  ) {
    throw recoveryConflict("设备绑定签名恢复栅栏不匹配");
  }
}

function parseSuccessfulResponse(
  text: string,
  executorId: string,
  deviceId: string,
  expectedRevision: number
): BindDesktopExecutorDeviceResponse {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse("设备绑定响应格式无效");
  }
  if (!exactObject(envelope, ["data", "requestId"])) {
    throw invalidResponse("设备绑定响应 envelope 无效");
  }
  const typed = envelope as { data: unknown; requestId: unknown };
  if (
    typeof typed.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(typed.requestId)
  ) {
    throw invalidResponse("设备绑定响应 requestId 无效");
  }
  if (!exactObject(typed.data, ["binding", "replayed"])) {
    throw invalidResponse("设备绑定响应不是安全投影");
  }
  const data = typed.data as { binding: unknown; replayed: unknown };
  if (
    typeof data.replayed !== "boolean" ||
    !exactObject(data.binding, [
      "executorId",
      "deviceId",
      "status",
      "revision",
      "force",
      "updatedAt"
    ])
  ) {
    throw invalidResponse("设备绑定结果结构无效");
  }
  const binding = data.binding as unknown as DesktopExecutorDeviceBindingProjection;
  if (
    binding.executorId !== executorId ||
    binding.deviceId !== deviceId ||
    binding.status !== "active" ||
    binding.revision !== expectedRevision + 1 ||
    binding.force !== false ||
    !canonicalServerTime(binding.updatedAt)
  ) {
    throw invalidResponse("设备绑定结果无效");
  }
  return { binding: { ...binding }, replayed: data.replayed };
}

function bindingResult(
  record: DesktopDeviceRequestJournalRecord,
  data: BindDesktopExecutorDeviceResponse,
  recovered: boolean
): BindDesktopExecutorDeviceResult {
  return {
    requestReference: record.reference,
    requestHash: record.signed.requestHash,
    recovered,
    data: { binding: { ...data.binding }, replayed: data.replayed }
  };
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
    throw bindingError("desktop_device_not_registered", "设备尚未安全登记");
  }
}

function encodeJson(value: object): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function trustedApiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw bindingError("desktop_host_api_untrusted", "Host API 地址无效");
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
    throw bindingError("desktop_host_api_untrusted", "Host API 地址不受信");
  }
  return url.origin;
}

async function readBoundedText(response: HttpResponseLike): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw invalidResponse("设备绑定响应无法读取");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw invalidResponse("设备绑定响应过大");
  }
  return text;
}

function readServerCode(text: string): string | undefined {
  try {
    const envelope = JSON.parse(text) as unknown;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return undefined;
    const error = (envelope as { error?: unknown }).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function validServerCode(value: string | undefined): boolean {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value);
}

function validBearerToken(value: string): boolean {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > MAX_BEARER_BYTES
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function validOpaque(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 160 ||
    !OPAQUE_ID_PATTERN.test(value)
  ) {
    throw contractInvalid(`${name} 无效`);
  }
  return value;
}

function nonNegativeRevision(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw contractInvalid(`${name} 无效`);
  }
  return value;
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60_000) {
    throw contractInvalid("设备绑定超时配置无效");
  }
  return value;
}

function canonicalJournalNow(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw contractInvalid("设备绑定时间无效");
  }
  return value.toISOString();
}

function canonicalServerTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(
    value
  );
  if (!match || !RFC3339_UTC_PATTERN.test(value)) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractional] =
    match;
  if (fractional?.endsWith("0")) return false;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const milliseconds = Number((fractional ?? "").padEnd(3, "0").slice(0, 3) || "0");
  if (year < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, second, milliseconds);
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day &&
    probe.getUTCHours() === hour &&
    probe.getUTCMinutes() === minute &&
    probe.getUTCSeconds() === second &&
    Number.isFinite(probe.getTime())
  );
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

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function contractInvalid(message: string): DesktopExecutorDeviceBindingError {
  return bindingError("desktop_executor_device_binding_contract_invalid", message);
}

function recoveryConflict(message: string): DesktopExecutorDeviceBindingError {
  return bindingError("desktop_executor_device_binding_recovery_conflict", message);
}

function invalidResponse(message: string): DesktopExecutorDeviceBindingError {
  return bindingError("desktop_executor_device_binding_response_invalid", message);
}

function bindingError(
  code: DesktopExecutorDeviceBindingErrorCode,
  message: string
): DesktopExecutorDeviceBindingError {
  return new DesktopExecutorDeviceBindingError(code, message);
}
