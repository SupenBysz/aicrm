import { randomUUID } from "node:crypto";
import type {
  DesktopDeviceIdentityProjection,
  DesktopDeviceIdentityStore,
  SignedDesktopDeviceRequest
} from "./desktop-device-identity.ts";
import {
  type DesktopDeviceRequestJournalRecord,
  type DesktopDeviceRequestJournalStore,
  type DesktopTrustedRequestKind,
  desktopTrustedRequestReference
} from "./desktop-device-request-journal.ts";
import {
  hashAuthorizationToken,
  sha256Hex,
  verifyDesktopDeviceSigningInput
} from "./desktop-device-proof.ts";
import type { DesktopDeviceRequestLane } from "./desktop-device-request-lane.ts";

const MAX_RESPONSE_BYTES = 64 << 10;
const MAX_AUTHORIZATION_BYTES = 8 << 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_CLOCK_WINDOW_MS = 5 * 60_000;
const DEVICE_ID_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const DECIMAL_SEQUENCE_PATTERN = /^[1-9][0-9]{0,19}$/;
const DECIMAL_TIMESTAMP_PATTERN = /^[1-9][0-9]{0,15}$/;
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PROOF_HEADER_NAMES = [
  "X-AiCRM-Content-SHA256",
  "X-AiCRM-Device-Id",
  "X-AiCRM-Device-Nonce",
  "X-AiCRM-Device-Sequence",
  "X-AiCRM-Device-Signature",
  "X-AiCRM-Device-Timestamp"
] as const;

export type DesktopAuthorizationTransportErrorCode =
  | "desktop_authorization_transport_cancelled"
  | "desktop_authorization_transport_contract_invalid"
  | "desktop_authorization_transport_recovery_conflict"
  | "desktop_authorization_transport_rejected"
  | "desktop_authorization_transport_response_invalid"
  | "desktop_authorization_transport_failed"
  | "desktop_device_not_registered"
  | "desktop_host_api_untrusted";

export class DesktopAuthorizationTransportError extends Error {
  readonly code: DesktopAuthorizationTransportErrorCode;
  readonly status: number | null;
  readonly serverCode: string | null;

  constructor(
    code: DesktopAuthorizationTransportErrorCode,
    message: string,
    options: { status?: number; serverCode?: string } = {}
  ) {
    super(message);
    this.code = code;
    this.status = Number.isInteger(options.status) ? (options.status ?? null) : null;
    this.serverCode = validServerCode(options.serverCode) ? options.serverCode! : null;
  }
}

export interface DesktopTrustedTransportResult<T> {
  requestReference: string;
  requestHash: string;
  data: T;
}

export interface ClaimDesktopHandoffInput {
  sessionId: string;
  handoffId: string;
  handoffTicket: string;
}

export interface ClaimDesktopHandoffResponse {
  handoffId: string;
  executorId: string;
  claimToken: string;
  expiresAt: string;
  sessionRevision: number;
  replayed: boolean;
}

export type DesktopAuthorizationProofResult = "succeeded" | "failed" | "cancelled";

export interface SubmitDesktopAuthorizationProofInput {
  sessionId: string;
  claimToken: string;
  handoffId: string;
  sessionRevision: number;
  loginIdHash: string;
  result: DesktopAuthorizationProofResult;
  checkedAt: string;
  accountFingerprint: string;
  candidateBindingDigest: string;
}

export interface SubmitDesktopAuthorizationProofBaseResponse {
  proofId: string;
  result: DesktopAuthorizationProofResult;
  sessionRevision: number;
  replayed: boolean;
}

export interface SubmitDesktopAuthorizationProofSucceededResponse
  extends SubmitDesktopAuthorizationProofBaseResponse {
  result: "succeeded";
  operationId: string;
  activationId: string;
  credentialRevision: number;
  leaseEpoch: number;
  sourceCredentialRevision: number;
  revocationEpoch: number;
  bindingDigest: string;
  activationToken: string;
  expiresAt: string;
}

export type SubmitDesktopAuthorizationProofResponse =
  | SubmitDesktopAuthorizationProofSucceededResponse
  | (SubmitDesktopAuthorizationProofBaseResponse & { result: "failed" | "cancelled" });

export interface AcknowledgeDesktopCredentialActivationInput {
  sessionId: string;
  activationToken: string;
  operationId: string;
  activationId: string;
  credentialRevision: number;
  leaseEpoch: number;
  sourceCredentialRevision: number;
  revocationEpoch: number;
  durableBarrierCompletedAt: string;
  bindingDigest: string;
}

export interface AcknowledgeDesktopCredentialActivationResponse {
  activationId: string;
  executorId: string;
  credentialRevision: number;
  sessionRevision: number;
  replayed: boolean;
}

interface AuthorizationIdentityStore
  extends Pick<DesktopDeviceIdentityStore, "getIdentity" | "signRequest"> {}

interface AuthorizationRequestLane extends Pick<DesktopDeviceRequestLane, "run"> {}

interface AuthorizationRequestJournal
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

export interface DesktopAuthorizationTransportClientOptions {
  identityStore: AuthorizationIdentityStore;
  requestLane: AuthorizationRequestLane;
  requestJournal: AuthorizationRequestJournal;
  loadTrustedApiBaseUrl: () => string | Promise<string>;
  fetch?: HostFetch;
  now?: () => Date;
  requestIdFactory?: () => string;
  requestTimeoutMs?: number;
}

interface TrustedRequestDefinition<T> {
  kind: DesktopTrustedRequestKind;
  path: string;
  authorization: string;
  authorizationScheme: "AiCRM-Handoff" | "AiCRM-Claim" | "AiCRM-Activation";
  createBody: () => Uint8Array;
  validateRecoveredBody: (body: Uint8Array) => void;
  validateResponse: (value: unknown) => T;
}

/**
 * Main-only transport for ticket-bearing Desktop authorization requests.
 *
 * The shared lane is held before journal recovery or signing and until a
 * successful response is durably encrypted. Renderer input can never supply a
 * URL or request headers. A caller must persist its downstream state before
 * calling `completeRequest` with the returned two-part fence.
 */
export class DesktopAuthorizationTransportClient {
  private readonly identityStore: AuthorizationIdentityStore;
  private readonly requestLane: AuthorizationRequestLane;
  private readonly requestJournal: AuthorizationRequestJournal;
  private readonly loadTrustedApiBaseUrl: () => string | Promise<string>;
  private readonly hostFetch: HostFetch;
  private readonly now: () => Date;
  private readonly requestIdFactory: () => string;
  private readonly requestTimeoutMs: number;
  private readonly activeControllers = new Set<AbortController>();
  private cancellationEpoch = 0;

  constructor(options: DesktopAuthorizationTransportClientOptions) {
    this.identityStore = options.identityStore;
    this.requestLane = options.requestLane;
    this.requestJournal = options.requestJournal;
    this.loadTrustedApiBaseUrl = options.loadTrustedApiBaseUrl;
    this.hostFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => new Date());
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.requestTimeoutMs = validateTimeout(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    );
  }

  claimDesktopHandoff(
    input: ClaimDesktopHandoffInput
  ): Promise<DesktopTrustedTransportResult<ClaimDesktopHandoffResponse>> {
    const sessionId = validOpaque(input.sessionId, "sessionId");
    const handoffId = validOpaque(input.handoffId, "handoffId");
    const handoffTicket = validTicket(input.handoffTicket, "handoffTicket");
    const path = `/api/v1/ai-executor-authorization-sessions/${sessionId}/desktop-handoffs/${handoffId}/claim`;
    const authorization = buildAuthorization("AiCRM-Handoff", handoffTicket);
    const epoch = this.cancellationEpoch;
    return this.requestLane.run(() =>
      this.submit(
        {
          kind: "handoff_claim",
          path,
          authorization,
          authorizationScheme: "AiCRM-Handoff",
          createBody: () =>
            encodeJson({ handoffId, claimedAt: canonicalDeviceNow(this.now(), "认领时间无效") }),
          validateRecoveredBody: (body) => {
            const value = parseJson(body, "认领恢复 body 无效");
            if (!exactObject(value, ["handoffId", "claimedAt"])) {
              throw recoveryConflict("认领恢复 body 结构不匹配");
            }
            const recovered = value as { handoffId: unknown; claimedAt: unknown };
            if (recovered.handoffId !== handoffId || !canonicalDeviceTime(recovered.claimedAt)) {
              throw recoveryConflict("认领恢复 body 与当前操作不匹配");
            }
            requireCanonicalEncoding(body, {
              handoffId,
              claimedAt: recovered.claimedAt
            });
          },
          validateResponse: (value) => validateClaimResponse(value, handoffId)
        },
        epoch
      )
    );
  }

  submitAuthorizationProof(
    input: SubmitDesktopAuthorizationProofInput
  ): Promise<DesktopTrustedTransportResult<SubmitDesktopAuthorizationProofResponse>> {
    const sessionId = validOpaque(input.sessionId, "sessionId");
    const claimToken = validTicket(input.claimToken, "claimToken");
    const handoffId = validOpaque(input.handoffId, "handoffId");
    const sessionRevision = positiveRevision(input.sessionRevision, "sessionRevision");
    const loginIdHash = validDigest(input.loginIdHash, "loginIdHash");
    const result = validProofResult(input.result);
    const checkedAt = validClientTime(
      input.checkedAt,
      "checkedAt",
      this.now(),
      "symmetric"
    );
    const accountFingerprint = result === "succeeded"
      ? validDigest(input.accountFingerprint, "accountFingerprint")
      : emptyString(input.accountFingerprint, "accountFingerprint");
    const candidateBindingDigest = result === "succeeded"
      ? validDigest(input.candidateBindingDigest, "candidateBindingDigest")
      : emptyString(input.candidateBindingDigest, "candidateBindingDigest");
    const bodyObject = {
      handoffId,
      sessionRevision,
      loginIdHash,
      result,
      checkedAt,
      accountFingerprint,
      candidateBindingDigest
    };
    const expectedBody = encodeJson(bodyObject);
    const path = `/api/v1/ai-executor-authorization-sessions/${sessionId}/desktop-proofs`;
    const epoch = this.cancellationEpoch;
    return this.requestLane.run(() =>
      this.submit(
        {
          kind: "authorization_proof",
          path,
          authorization: buildAuthorization("AiCRM-Claim", claimToken),
          authorizationScheme: "AiCRM-Claim",
          createBody: () => expectedBody,
          validateRecoveredBody: (body) => requireExactBody(body, expectedBody, "登录证明恢复冲突"),
          validateResponse: (value) => validateProofResponse(value, result)
        },
        epoch
      )
    );
  }

  acknowledgeCredentialActivation(
    input: AcknowledgeDesktopCredentialActivationInput
  ): Promise<DesktopTrustedTransportResult<AcknowledgeDesktopCredentialActivationResponse>> {
    const sessionId = validOpaque(input.sessionId, "sessionId");
    const activationToken = validTicket(input.activationToken, "activationToken");
    const operationId = validOpaque(input.operationId, "operationId");
    const activationId = validOpaque(input.activationId, "activationId");
    const credentialRevision = positiveRevision(
      input.credentialRevision,
      "credentialRevision"
    );
    const leaseEpoch = positiveRevision(input.leaseEpoch, "leaseEpoch");
    const sourceCredentialRevision = nonNegativeRevision(
      input.sourceCredentialRevision,
      "sourceCredentialRevision"
    );
    const revocationEpoch = nonNegativeRevision(input.revocationEpoch, "revocationEpoch");
    const durableBarrierCompletedAt = validClientTime(
      input.durableBarrierCompletedAt,
      "durableBarrierCompletedAt",
      this.now(),
      "past_only"
    );
    const bindingDigest = validDigest(input.bindingDigest, "bindingDigest");
    const bodyObject = {
      operationId,
      activationId,
      credentialRevision,
      leaseEpoch,
      sourceCredentialRevision,
      revocationEpoch,
      durableBarrierCompletedAt,
      bindingDigest
    };
    const expectedBody = encodeJson(bodyObject);
    const path = `/api/v1/ai-executor-authorization-sessions/${sessionId}/desktop-activations/${activationId}/ack`;
    const epoch = this.cancellationEpoch;
    return this.requestLane.run(() =>
      this.submit(
        {
          kind: "credential_activation_ack",
          path,
          authorization: buildAuthorization("AiCRM-Activation", activationToken),
          authorizationScheme: "AiCRM-Activation",
          createBody: () => expectedBody,
          validateRecoveredBody: (body) => requireExactBody(body, expectedBody, "激活确认恢复冲突"),
          validateResponse: (value) =>
            validateActivationResponse(value, activationId, credentialRevision)
        },
        epoch
      )
    );
  }

  completeRequest(requestReference: string, requestHash: string): Promise<void> {
    return this.requestJournal.complete(requestReference, requestHash);
  }

  cancel(): void {
    this.cancellationEpoch += 1;
    for (const controller of this.activeControllers) controller.abort();
  }

  private async submit<T>(
    definition: TrustedRequestDefinition<T>,
    epoch: number
  ): Promise<DesktopTrustedTransportResult<T>> {
    this.assertActive(epoch);
    const reference = desktopTrustedRequestReference(definition.kind, definition.path);
    const origin = trustedApiOrigin(await this.loadTrustedApiBaseUrl());
    this.assertActive(epoch);
    let record = await this.requestJournal.load(reference);
    this.assertActive(epoch);
    const identity = await this.identityStore.getIdentity();
    this.assertActive(epoch);
    validateRegisteredIdentity(identity);

    if (record) {
      validateRecoveredRecord(record, definition, identity, origin);
    } else {
      const body = definition.createBody();
      definition.validateRecoveredBody(body);
      const signed = await this.identityStore.signRequest({
        method: "POST",
        path: definition.path,
        body,
        authorization: definition.authorization,
        allowedAuthorizationSchemes: [definition.authorizationScheme]
      });
      this.assertActive(epoch);
      validateSignedRequest(signed, identity, definition, body);
      record = await this.requestJournal.createOrLoad({
        version: 1,
        reference,
        kind: definition.kind,
        method: "POST",
        origin,
        path: definition.path,
        authorization: definition.authorization,
        bodyBase64: Buffer.from(body).toString("base64"),
        signed,
        createdAt: canonicalJournalNow(this.now(), "设备请求时间无效"),
        response: null
      });
      this.assertActive(epoch);
      validateRecoveredRecord(record, definition, identity, origin);
    }

    if (record.response) {
      const data = parseSuccessfulResponse(
        Buffer.from(record.response.bodyBase64, "base64").toString("utf8"),
        definition.validateResponse
      );
      return trustedResult(record, data);
    }

    const body = Buffer.from(record.bodyBase64, "base64");
    const response = await this.postExact(record.origin, record, body, epoch);
    const data = parseSuccessfulResponse(response.text, definition.validateResponse);
    this.assertActive(epoch);
    const persisted = await this.requestJournal.recordResponse(
      reference,
      record.signed.requestHash,
      {
        status: 200,
        bodyBase64: Buffer.from(response.text, "utf8").toString("base64"),
        receivedAt: canonicalJournalNow(this.now(), "设备响应时间无效")
      }
    );
    this.assertActive(epoch);
    if (!persisted.response) {
      throw transportError(
        "desktop_authorization_transport_response_invalid",
        "设备授权响应未持久化"
      );
    }
    return trustedResult(persisted, data);
  }

  private async postExact(
    origin: string,
    record: DesktopDeviceRequestJournalRecord,
    body: Buffer,
    epoch: number
  ): Promise<{ text: string }> {
    const requestId = this.requestIdFactory();
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw transportError(
        "desktop_authorization_transport_contract_invalid",
        "设备授权 requestId 无效"
      );
    }
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    let response: HttpResponseLike;
    try {
      response = await this.hostFetch(`${origin}${record.path}`, {
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
          "X-KY-Request-Id": requestId
        },
        body: body.toString("utf8")
      });
      const text = await readBoundedText(response);
      this.assertActive(epoch);
      if (!response.ok || response.status !== 200) {
        throw new DesktopAuthorizationTransportError(
          "desktop_authorization_transport_rejected",
          "服务端拒绝设备授权请求",
          { status: response.status, serverCode: readServerCode(text) }
        );
      }
      return { text };
    } catch (error) {
      if (epoch !== this.cancellationEpoch) {
        throw transportError(
          "desktop_authorization_transport_cancelled",
          "设备授权请求已取消"
        );
      }
      if (timedOut) {
        throw transportError("desktop_authorization_transport_failed", "设备授权请求超时");
      }
      if (error instanceof DesktopAuthorizationTransportError) throw error;
      throw transportError(
        "desktop_authorization_transport_failed",
        "设备授权请求失败"
      );
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }

  private assertActive(epoch: number): void {
    if (epoch !== this.cancellationEpoch) {
      throw transportError(
        "desktop_authorization_transport_cancelled",
        "设备授权请求已取消"
      );
    }
  }
}

function validateRecoveredRecord<T>(
  record: DesktopDeviceRequestJournalRecord,
  definition: TrustedRequestDefinition<T>,
  identity: DesktopDeviceIdentityProjection,
  origin: string
): void {
  if (
    record.kind !== definition.kind ||
    record.method !== "POST" ||
    record.origin !== origin ||
    record.path !== definition.path ||
    record.authorization !== definition.authorization
  ) {
    throw recoveryConflict("设备授权恢复记录与当前操作不匹配");
  }
  const body = Buffer.from(record.bodyBase64, "base64");
  definition.validateRecoveredBody(body);
  validateSignedRequest(record.signed, identity, definition, body);
}

function validateSignedRequest<T>(
  signed: SignedDesktopDeviceRequest,
  identity: DesktopDeviceIdentityProjection,
  definition: TrustedRequestDefinition<T>,
  body: Uint8Array
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
    throw recoveryConflict("设备授权签名结构无效");
  }
  const expectedBodyHash = sha256Hex(body);
  const expectedAuthorizationHash = hashAuthorizationToken(definition.authorization, [
    definition.authorizationScheme
  ]);
  const expectedSigningInput = [
    "AICRM-DEVICE-V1",
    "POST",
    definition.path,
    signed.headers["X-AiCRM-Device-Timestamp"],
    signed.headers["X-AiCRM-Device-Nonce"],
    signed.sequence,
    expectedBodyHash,
    expectedAuthorizationHash
  ].join("\n");
  const expectedHeaderNames = [...PROOF_HEADER_NAMES].sort();
  const actualHeaderNames = Object.keys(signed.headers).sort();
  const rawPublicKey = decodeCanonicalBase64Url(signed.publicKey, 32);
  if (
    actualHeaderNames.length !== expectedHeaderNames.length ||
    !actualHeaderNames.every((name, index) => name === expectedHeaderNames[index]) ||
    signed.deviceId !== identity.deviceId ||
    signed.publicKey !== identity.publicKey ||
    rawPublicKey === null ||
    sha256Hex(rawPublicKey) !== identity.deviceId ||
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
    throw recoveryConflict("设备授权签名恢复栅栏不匹配");
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
    throw transportError("desktop_device_not_registered", "设备尚未安全登记");
  }
}

function validateClaimResponse(value: unknown, handoffId: string): ClaimDesktopHandoffResponse {
  if (
    !exactObject(value, [
      "handoffId",
      "executorId",
      "claimToken",
      "expiresAt",
      "sessionRevision",
      "replayed"
    ])
  ) {
    throw invalidResponse("Desktop 认领响应不是安全投影");
  }
  const response = value as unknown as ClaimDesktopHandoffResponse;
  if (
    response.handoffId !== handoffId ||
    !isOpaque(response.executorId) ||
    !isTicket(response.claimToken) ||
    !canonicalServerTime(response.expiresAt) ||
    !isPositiveRevision(response.sessionRevision) ||
    typeof response.replayed !== "boolean"
  ) {
    throw invalidResponse("Desktop 认领响应无效");
  }
  return { ...response };
}

function validateProofResponse(
  value: unknown,
  expectedResult: DesktopAuthorizationProofResult
): SubmitDesktopAuthorizationProofResponse {
  const baseKeys = ["proofId", "result", "sessionRevision", "replayed"];
  const succeededKeys = [
    ...baseKeys,
    "operationId",
    "activationId",
    "credentialRevision",
    "leaseEpoch",
    "sourceCredentialRevision",
    "revocationEpoch",
    "bindingDigest",
    "activationToken",
    "expiresAt"
  ];
  if (!exactObject(value, expectedResult === "succeeded" ? succeededKeys : baseKeys)) {
    throw invalidResponse("Desktop 登录证明响应不是安全投影");
  }
  const response = value as Record<string, unknown>;
  if (
    !isOpaque(response.proofId) ||
    response.result !== expectedResult ||
    !isPositiveRevision(response.sessionRevision) ||
    typeof response.replayed !== "boolean"
  ) {
    throw invalidResponse("Desktop 登录证明响应无效");
  }
  if (expectedResult !== "succeeded") {
    return {
      proofId: response.proofId,
      result: expectedResult,
      sessionRevision: response.sessionRevision,
      replayed: response.replayed
    };
  }
  if (
    !isOpaque(response.operationId) ||
    !isOpaque(response.activationId) ||
    !isPositiveRevision(response.credentialRevision) ||
    !isPositiveRevision(response.leaseEpoch) ||
    !isNonNegativeRevision(response.sourceCredentialRevision) ||
    !isNonNegativeRevision(response.revocationEpoch) ||
    typeof response.bindingDigest !== "string" ||
    !DIGEST_PATTERN.test(response.bindingDigest) ||
    typeof response.activationToken !== "string" ||
    !isTicket(response.activationToken) ||
    !canonicalServerTime(response.expiresAt)
  ) {
    throw invalidResponse("Desktop 登录证明激活响应无效");
  }
  return {
    proofId: response.proofId,
    result: "succeeded",
    sessionRevision: response.sessionRevision,
    replayed: response.replayed,
    operationId: response.operationId,
    activationId: response.activationId,
    credentialRevision: response.credentialRevision,
    leaseEpoch: response.leaseEpoch,
    sourceCredentialRevision: response.sourceCredentialRevision,
    revocationEpoch: response.revocationEpoch,
    bindingDigest: response.bindingDigest,
    activationToken: response.activationToken,
    expiresAt: response.expiresAt
  };
}

function validateActivationResponse(
  value: unknown,
  activationId: string,
  credentialRevision: number
): AcknowledgeDesktopCredentialActivationResponse {
  if (!exactObject(value, [
    "activationId",
    "executorId",
    "credentialRevision",
    "sessionRevision",
    "replayed"
  ])) {
    throw invalidResponse("Desktop 激活确认响应不是安全投影");
  }
  const response = value as unknown as AcknowledgeDesktopCredentialActivationResponse;
  if (
    response.activationId !== activationId ||
    !isOpaque(response.executorId) ||
    response.credentialRevision !== credentialRevision ||
    !isPositiveRevision(response.sessionRevision) ||
    typeof response.replayed !== "boolean"
  ) {
    throw invalidResponse("Desktop 激活确认响应无效");
  }
  return { ...response };
}

function parseSuccessfulResponse<T>(text: string, validate: (value: unknown) => T): T {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse("设备授权响应格式无效");
  }
  if (!exactObject(envelope, ["data", "requestId"])) {
    throw invalidResponse("设备授权响应 envelope 无效");
  }
  const typed = envelope as { data: unknown; requestId: unknown };
  if (
    typeof typed.requestId !== "string" ||
    typed.requestId.length < 1 ||
    typed.requestId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(typed.requestId)
  ) {
    throw invalidResponse("设备授权响应 requestId 无效");
  }
  return validate(typed.data);
}

async function readBoundedText(response: HttpResponseLike): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw invalidResponse("设备授权响应无法读取");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw invalidResponse("设备授权响应过大");
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

function trustedResult<T>(
  record: DesktopDeviceRequestJournalRecord,
  data: T
): DesktopTrustedTransportResult<T> {
  return {
    requestReference: record.reference,
    requestHash: record.signed.requestHash,
    data
  };
}

function trustedApiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw transportError("desktop_host_api_untrusted", "Host API 地址无效");
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
    throw transportError("desktop_host_api_untrusted", "Host API 地址不受信");
  }
  return url.origin;
}

function validOpaque(value: string, name: string): string {
  if (!isOpaque(value)) {
    throw contractInvalid(`${name} 无效`);
  }
  return value;
}

function isOpaque(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 160 &&
    OPAQUE_ID_PATTERN.test(value)
  );
}

function validTicket(value: string, name: string): string {
  if (!isTicket(value)) throw contractInvalid(`${name} 无效`);
  return value;
}

function isTicket(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_AUTHORIZATION_BYTES - 32 &&
    COMPACT_JWS_PATTERN.test(value) &&
    value.trim() === value
  );
}

function validDigest(value: string, name: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw contractInvalid(`${name} 无效`);
  }
  return value;
}

function emptyString(value: string, name: string): "" {
  if (value !== "") throw contractInvalid(`${name} 必须为空`);
  return "";
}

function positiveRevision(value: number, name: string): number {
  if (!isPositiveRevision(value)) throw contractInvalid(`${name} 无效`);
  return value;
}

function nonNegativeRevision(value: number, name: string): number {
  if (!isNonNegativeRevision(value)) throw contractInvalid(`${name} 无效`);
  return value;
}

function isPositiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validProofResult(value: string): DesktopAuthorizationProofResult {
  if (value !== "succeeded" && value !== "failed" && value !== "cancelled") {
    throw contractInvalid("result 无效");
  }
  return value;
}

function validClientTime(
  value: string,
  name: string,
  now: Date,
  policy: "symmetric" | "past_only"
): string {
  if (!canonicalDeviceTime(value) || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw contractInvalid(`${name} 无效`);
  }
  const milliseconds = Date.parse(value);
  const earliest = now.getTime() - DEVICE_CLOCK_WINDOW_MS;
  const latest = policy === "past_only" ? now.getTime() : now.getTime() + DEVICE_CLOCK_WINDOW_MS;
  if (milliseconds < earliest || milliseconds > latest) {
    throw contractInvalid(`${name} 超出设备时钟窗口`);
  }
  return value;
}

function canonicalDeviceTime(value: unknown): value is string {
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

function canonicalServerTime(value: unknown): value is string {
  return canonicalDeviceTime(value);
}

function canonicalJournalNow(value: Date, message: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw contractInvalid(message);
  }
  return value.toISOString();
}

function canonicalDeviceNow(value: Date, message: string): string {
  return canonicalJournalNow(value, message)
    .replace(/\.000Z$/, "Z")
    .replace(/(\.\d*?[1-9])0+Z$/, "$1Z");
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

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60_000) {
    throw contractInvalid("设备授权超时配置无效");
  }
  return value;
}

function validServerCode(value: string | undefined): boolean {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value);
}

function encodeJson(value: object): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function buildAuthorization(
  scheme: "AiCRM-Handoff" | "AiCRM-Claim" | "AiCRM-Activation",
  token: string
): string {
  const authorization = `${scheme} ${token}`;
  if (Buffer.byteLength(authorization, "utf8") > MAX_AUTHORIZATION_BYTES) {
    throw contractInvalid("设备授权票据超过安全上限");
  }
  return authorization;
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

function parseJson(body: Uint8Array, message: string): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    throw recoveryConflict(message);
  }
}

function requireCanonicalEncoding(body: Uint8Array, value: object): void {
  requireExactBody(body, encodeJson(value), "设备授权恢复 body 不是规范编码");
}

function requireExactBody(actual: Uint8Array, expected: Uint8Array, message: string): void {
  if (!Buffer.from(actual).equals(Buffer.from(expected))) throw recoveryConflict(message);
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function contractInvalid(message: string): DesktopAuthorizationTransportError {
  return transportError("desktop_authorization_transport_contract_invalid", message);
}

function recoveryConflict(message: string): DesktopAuthorizationTransportError {
  return transportError("desktop_authorization_transport_recovery_conflict", message);
}

function invalidResponse(message: string): DesktopAuthorizationTransportError {
  return transportError("desktop_authorization_transport_response_invalid", message);
}

function transportError(
  code: DesktopAuthorizationTransportErrorCode,
  message: string
): DesktopAuthorizationTransportError {
  return new DesktopAuthorizationTransportError(code, message);
}
