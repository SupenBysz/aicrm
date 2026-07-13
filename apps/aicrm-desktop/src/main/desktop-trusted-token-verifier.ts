import { createPublicKey, verify as verifyEd25519 } from "node:crypto";

import type {
  DesktopTrustedTokenKeyring,
  DesktopTrustedTokenVerificationKey
} from "./desktop-trusted-token-keyring.ts";

const TOKEN_MAXIMUM_BYTES = 16 << 10;
const HEADER_MAXIMUM_BYTES = 2 << 10;
const PAYLOAD_MAXIMUM_BYTES = 12 << 10;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const MAXIMUM_TOKEN_LIFETIME_SECONDS = 600;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const ISSUER = "aicrm-agent-executor";
const AUDIENCE_DESKTOP = "aicrm-desktop";
const AUDIENCE_CLAIM = "aicrm-desktop-claim";
const AUDIENCE_ACTIVATION = "aicrm-desktop-activation";
const AUDIENCE_COMMAND = "aicrm-desktop-command";

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LOWER_HEX_256 = /^[0-9a-f]{64}$/;
const BASE64_URL = /^[A-Za-z0-9_-]+$/;
const CANONICAL_UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const OPTIONAL_STRING_FIELDS = [
  "actorId",
  "sessionId",
  "executorId",
  "deviceId",
  "handoffId",
  "activationId",
  "operationId",
  "revocationId",
  "fromDeviceId",
  "targetDeviceId",
  "bindingDigest"
] as const;

const OPTIONAL_REVISION_FIELDS = [
  "expectedRevision",
  "expectedSessionRevision",
  "expectedExecutorRevision",
  "expectedCredentialRevision",
  "expectedCatalogRevision",
  "credentialRevision",
  "leaseEpoch",
  "sourceCredentialRevision",
  "revocationEpoch"
] as const;

export type DesktopTrustedTokenAudience =
  | typeof AUDIENCE_DESKTOP
  | typeof AUDIENCE_CLAIM
  | typeof AUDIENCE_ACTIVATION
  | typeof AUDIENCE_COMMAND;

export type DesktopTrustedTokenPurpose =
  | "authorization_handoff"
  | "authorization_claim"
  | "credential_activation"
  | "authorization_cancel"
  | "authorization_reopen"
  | "credential_verify"
  | "model_catalog_refresh"
  | "readiness_check"
  | "credential_logout";

interface BaseExpectedTarget {
  audience: DesktopTrustedTokenAudience;
  purpose: DesktopTrustedTokenPurpose;
  executorId: string;
}

export type DesktopTrustedTokenExpectedTarget =
  | (BaseExpectedTarget & {
      audience: typeof AUDIENCE_DESKTOP;
      purpose: "authorization_handoff";
      actorId: string;
      sessionId: string;
      handoffId: string;
      expectedSessionRevision: number;
    })
  | (BaseExpectedTarget & {
      audience: typeof AUDIENCE_CLAIM;
      purpose: "authorization_claim";
      sessionId: string;
      handoffId: string;
      expectedSessionRevision: number;
    })
  | (BaseExpectedTarget & {
      audience: typeof AUDIENCE_ACTIVATION;
      purpose: "credential_activation";
      sessionId: string;
      operationId: string;
      activationId: string;
      bindingDigest: string;
      credentialRevision: number;
      leaseEpoch: number;
      sourceCredentialRevision: number;
      revocationEpoch: number;
    })
  | (BaseExpectedTarget & {
      audience: typeof AUDIENCE_COMMAND;
      purpose: "authorization_cancel" | "authorization_reopen";
      actorId: string;
      sessionId: string;
      operationId: string;
      expectedSessionRevision: number;
    })
  | (BaseExpectedTarget & {
      audience: typeof AUDIENCE_COMMAND;
      purpose: "credential_verify";
      actorId: string;
      operationId: string;
      expectedExecutorRevision: number;
      expectedCredentialRevision: number;
    })
  | (BaseExpectedTarget & {
      audience: typeof AUDIENCE_COMMAND;
      purpose: "model_catalog_refresh";
      actorId: string;
      operationId: string;
      expectedExecutorRevision: number;
      expectedCatalogRevision: number;
    })
  | (BaseExpectedTarget & {
      audience: typeof AUDIENCE_COMMAND;
      purpose: "readiness_check";
      actorId: string;
      operationId: string;
      expectedExecutorRevision: number;
      expectedCredentialRevision: number;
      expectedCatalogRevision: number;
    })
  | (BaseExpectedTarget & {
      audience: typeof AUDIENCE_COMMAND;
      purpose: "credential_logout";
      actorId: string;
      operationId: string;
      revocationId: string;
      credentialRevision: number;
      revocationEpoch: number;
    });

export interface DesktopTrustedTokenClaims {
  v: 1;
  iss: typeof ISSUER;
  aud: DesktopTrustedTokenAudience;
  jti: string;
  purpose: DesktopTrustedTokenPurpose;
  nonce: string;
  iat: number;
  exp: number;
  actorId?: string;
  sessionId?: string;
  executorId?: string;
  deviceId?: string;
  handoffId?: string;
  activationId?: string;
  operationId?: string;
  revocationId?: string;
  fromDeviceId?: string;
  targetDeviceId?: string;
  bindingDigest?: string;
  expectedRevision?: number;
  expectedSessionRevision?: number;
  expectedExecutorRevision?: number;
  expectedCredentialRevision?: number;
  expectedCatalogRevision?: number;
  credentialRevision?: number;
  leaseEpoch?: number;
  sourceCredentialRevision?: number;
  revocationEpoch?: number;
}

export type DesktopTrustedTokenVerificationErrorCode =
  | "desktop_trusted_token_input_invalid"
  | "desktop_trusted_token_malformed"
  | "desktop_trusted_token_unknown_key"
  | "desktop_trusted_token_signature_invalid"
  | "desktop_trusted_token_claims_invalid"
  | "desktop_trusted_token_unsupported"
  | "desktop_trusted_token_key_window_mismatch"
  | "desktop_trusted_token_key_retired"
  | "desktop_trusted_token_not_yet_valid"
  | "desktop_trusted_token_expired"
  | "desktop_trusted_token_device_mismatch"
  | "desktop_trusted_token_target_mismatch";

export class DesktopTrustedTokenVerificationError extends Error {
  readonly code: DesktopTrustedTokenVerificationErrorCode;

  constructor(code: DesktopTrustedTokenVerificationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface VerifyDesktopTrustedTokenInput {
  token: string;
  keyring: DesktopTrustedTokenKeyring;
  now: Date;
  registeredDeviceId: string;
  expectedTarget: DesktopTrustedTokenExpectedTarget;
}

export interface VerifyDesktopAuthorizationHandoffTokenInput {
  token: string;
  keyring: DesktopTrustedTokenKeyring;
  now: Date;
  registeredDeviceId: string;
  sessionId: string;
  executorId: string;
  handoffId: string;
}

export interface DesktopAuthorizationHandoffTrustedFacts {
  actorId: string;
  expectedSessionRevision: number;
}

export type DesktopAuthorizationSessionCommandPurpose =
  | "authorization_cancel"
  | "authorization_reopen";

export interface VerifyDesktopAuthorizationSessionCommandTokenInput {
  token: string;
  keyring: DesktopTrustedTokenKeyring;
  now: Date;
  registeredDeviceId: string;
  sessionId: string;
  executorId: string;
  operationId: string;
  expectedSessionRevision: number;
  purpose: DesktopAuthorizationSessionCommandPurpose;
}

export interface DesktopAuthorizationSessionCommandTrustedFacts {
  actorId: string;
  sessionId: string;
  executorId: string;
  operationId: string;
  expectedSessionRevision: number;
  purpose: DesktopAuthorizationSessionCommandPurpose;
}

interface VerifyDesktopTrustedTokenEnvelopeInput {
  token: string;
  keyring: DesktopTrustedTokenKeyring;
  now: Date;
  registeredDeviceId: string;
}

/**
 * Main-only verifier for server-issued compact JWS trust-plane tokens. The
 * returned projection contains no signature, raw token, or keyring material.
 */
export function verifyDesktopTrustedToken(
  input: VerifyDesktopTrustedTokenInput
): Readonly<DesktopTrustedTokenClaims> {
  const target = validateExpectedTarget(input?.expectedTarget);
  const claims = verifyDesktopTrustedTokenEnvelope(input);
  if (claims.aud !== target.audience || claims.purpose !== target.purpose) {
    throw tokenError("desktop_trusted_token_target_mismatch", "受信票据用途与目标不匹配");
  }
  if (!matchesExpectedTarget(claims, target)) {
    throw tokenError("desktop_trusted_token_target_mismatch", "受信票据目标状态已变化");
  }
  return Object.freeze({ ...claims });
}

/**
 * Verifies a Desktop authorization handoff without accepting renderer-supplied
 * actor or revision facts. Only the signed actor and session revision are
 * projected after the complete trust-token verification pipeline succeeds.
 */
export function verifyDesktopAuthorizationHandoffToken(
  input: VerifyDesktopAuthorizationHandoffTokenInput
): Readonly<DesktopAuthorizationHandoffTrustedFacts> {
  const expected = validateAuthorizationHandoffInput(input);
  const claims = verifyDesktopTrustedTokenEnvelope(expected);
  if (
    claims.aud !== AUDIENCE_DESKTOP ||
    claims.purpose !== "authorization_handoff" ||
    claims.sessionId !== expected.sessionId ||
    claims.executorId !== expected.executorId ||
    claims.handoffId !== expected.handoffId
  ) {
    throw tokenError(
      "desktop_trusted_token_target_mismatch",
      "Desktop 授权 handoff 目标状态已变化"
    );
  }
  if (
    typeof claims.actorId !== "string" ||
    !OPAQUE_ID.test(claims.actorId) ||
    !positiveSafeInteger(claims.expectedSessionRevision)
  ) {
    throw tokenError(
      "desktop_trusted_token_claims_invalid",
      "Desktop 授权 handoff 受信事实无效"
    );
  }
  return Object.freeze({
    actorId: claims.actorId,
    expectedSessionRevision: claims.expectedSessionRevision
  });
}

/**
 * Verifies a cancel/reopen command ticket without accepting renderer-supplied
 * actor identity as truth. The target tuple is only a CAS expectation; every
 * returned fact is projected from the signed command after exact matching.
 */
export function verifyDesktopAuthorizationSessionCommandToken(
  input: VerifyDesktopAuthorizationSessionCommandTokenInput
): Readonly<DesktopAuthorizationSessionCommandTrustedFacts> {
  const expected = validateAuthorizationSessionCommandInput(input);
  const claims = verifyDesktopTrustedTokenEnvelope(expected);
  if (
    claims.aud !== AUDIENCE_COMMAND ||
    claims.purpose !== expected.purpose ||
    claims.sessionId !== expected.sessionId ||
    claims.executorId !== expected.executorId ||
    claims.operationId !== expected.operationId ||
    claims.expectedSessionRevision !== expected.expectedSessionRevision
  ) {
    throw tokenError(
      "desktop_trusted_token_target_mismatch",
      "Desktop 授权会话命令目标状态已变化"
    );
  }
  if (typeof claims.actorId !== "string" || !OPAQUE_ID.test(claims.actorId)) {
    throw tokenError(
      "desktop_trusted_token_claims_invalid",
      "Desktop 授权会话命令受信事实无效"
    );
  }
  return Object.freeze({
    actorId: claims.actorId,
    sessionId: claims.sessionId,
    executorId: claims.executorId,
    operationId: claims.operationId,
    expectedSessionRevision: claims.expectedSessionRevision,
    purpose: claims.purpose
  });
}

function verifyDesktopTrustedTokenEnvelope(
  input: VerifyDesktopTrustedTokenEnvelopeInput
): DesktopTrustedTokenClaims {
  if (!LOWER_HEX_256.test(input?.registeredDeviceId ?? "")) {
    throw tokenError("desktop_trusted_token_input_invalid", "当前注册设备标识无效");
  }
  const now = canonicalCurrentSecond(input?.now);
  const parts = splitCompactToken(input?.token);
  const headerBytes = decodeCanonicalSegment(parts[0], HEADER_MAXIMUM_BYTES);
  const payloadBytes = decodeCanonicalSegment(parts[1], PAYLOAD_MAXIMUM_BYTES);
  const signature = decodeCanonicalSegment(parts[2], ED25519_SIGNATURE_BYTES);
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw tokenError("desktop_trusted_token_malformed", "受信票据签名格式无效");
  }

  const header = parseCanonicalHeader(headerBytes);
  const key = resolveVerificationKey(input.keyring, header.kid);
  const publicKey = publicKeyObject(key);
  if (
    !verifyEd25519(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
      publicKey,
      signature
    )
  ) {
    throw tokenError("desktop_trusted_token_signature_invalid", "受信票据签名无效");
  }

  const claims = parseCanonicalClaims(payloadBytes);
  if (!isSupportedPair(claims.aud, claims.purpose)) {
    throw tokenError("desktop_trusted_token_unsupported", "受信票据用途不受客户端支持");
  }

  enforceKeyWindow(key, claims.iat, now);
  if (now < claims.iat) {
    throw tokenError("desktop_trusted_token_not_yet_valid", "受信票据尚未生效");
  }
  if (now >= claims.exp) {
    throw tokenError("desktop_trusted_token_expired", "受信票据已过期");
  }
  if (claims.deviceId !== input.registeredDeviceId) {
    throw tokenError("desktop_trusted_token_device_mismatch", "受信票据未绑定当前注册设备");
  }
  return claims;
}

function splitCompactToken(value: unknown): [string, string, string] {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > TOKEN_MAXIMUM_BYTES) {
    throw tokenError("desktop_trusted_token_malformed", "受信票据格式无效");
  }
  const parts = value.split(".");
  if (parts.length !== 3) {
    throw tokenError("desktop_trusted_token_malformed", "受信票据格式无效");
  }
  return [parts[0], parts[1], parts[2]];
}

function decodeCanonicalSegment(value: string, maximumBytes: number): Buffer {
  if (!value || value.includes("=") || !BASE64_URL.test(value)) {
    throw tokenError("desktop_trusted_token_malformed", "受信票据编码无效");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw tokenError("desktop_trusted_token_malformed", "受信票据编码无效");
  }
  if (decoded.byteLength > maximumBytes || decoded.toString("base64url") !== value) {
    throw tokenError("desktop_trusted_token_malformed", "受信票据编码无效");
  }
  return decoded;
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw tokenError("desktop_trusted_token_malformed", "受信票据 JSON 编码无效");
  }
}

function parseCanonicalHeader(raw: Buffer): { alg: "EdDSA"; kid: string; typ: "JWT" } {
  const text = decodeUtf8(raw);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw tokenError("desktop_trusted_token_malformed", "受信票据头无效");
  }
  if (
    !isRecord(value) ||
    value.alg !== "EdDSA" ||
    value.typ !== "JWT" ||
    typeof value.kid !== "string" ||
    !KEY_ID.test(value.kid) ||
    text !== JSON.stringify({ alg: value.alg, kid: value.kid, typ: value.typ })
  ) {
    throw tokenError("desktop_trusted_token_malformed", "受信票据头无效");
  }
  return { alg: "EdDSA", kid: value.kid, typ: "JWT" };
}

function parseCanonicalClaims(raw: Buffer): DesktopTrustedTokenClaims {
  const text = decodeUtf8(raw);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw tokenError("desktop_trusted_token_claims_invalid", "受信票据声明无效");
  }
  if (!isRecord(value)) {
    throw tokenError("desktop_trusted_token_claims_invalid", "受信票据声明无效");
  }
  const claims = value as unknown as DesktopTrustedTokenClaims;
  if (
    claims.v !== 1 ||
    claims.iss !== ISSUER ||
    typeof claims.aud !== "string" ||
    typeof claims.purpose !== "string" ||
    typeof claims.jti !== "string" ||
    !OPAQUE_ID.test(claims.jti) ||
    typeof claims.nonce !== "string" ||
    !validNonce(claims.nonce) ||
    !positiveSafeInteger(claims.iat) ||
    !positiveSafeInteger(claims.exp)
  ) {
    throw tokenError("desktop_trusted_token_claims_invalid", "受信票据声明无效");
  }

  const allowedFields = new Set<string>([
    "v",
    "iss",
    "aud",
    "jti",
    "purpose",
    "nonce",
    "iat",
    "exp",
    ...OPTIONAL_STRING_FIELDS,
    ...OPTIONAL_REVISION_FIELDS
  ]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw tokenError("desktop_trusted_token_claims_invalid", "受信票据声明包含未知字段");
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    const candidate = claims[field];
    if (candidate !== undefined && typeof candidate !== "string") {
      throw tokenError("desktop_trusted_token_claims_invalid", "受信票据目标声明无效");
    }
  }
  for (const field of OPTIONAL_REVISION_FIELDS) {
    const candidate = claims[field];
    if (candidate !== undefined && !nonNegativeSafeInteger(candidate)) {
      throw tokenError("desktop_trusted_token_claims_invalid", "受信票据版本声明无效");
    }
  }
  for (const field of [
    "actorId",
    "sessionId",
    "executorId",
    "handoffId",
    "activationId",
    "operationId",
    "revocationId"
  ] as const) {
    const candidate = claims[field];
    if (candidate !== undefined && !OPAQUE_ID.test(candidate)) {
      throw tokenError("desktop_trusted_token_claims_invalid", "受信票据目标标识无效");
    }
  }
  for (const field of ["deviceId", "fromDeviceId", "targetDeviceId", "bindingDigest"] as const) {
    const candidate = claims[field];
    if (candidate !== undefined && !LOWER_HEX_256.test(candidate)) {
      throw tokenError("desktop_trusted_token_claims_invalid", "受信票据摘要声明无效");
    }
  }

  const ttl = purposeLifetime(claims.aud, claims.purpose);
  if (ttl === undefined) {
    throw tokenError("desktop_trusted_token_unsupported", "受信票据用途不受客户端支持");
  }
  if (claims.exp !== claims.iat + ttl || !validPurposeShape(claims)) {
    throw tokenError("desktop_trusted_token_claims_invalid", "受信票据用途声明无效");
  }
  const canonical = canonicalClaims(claims);
  if (text !== JSON.stringify(canonical)) {
    throw tokenError("desktop_trusted_token_claims_invalid", "受信票据声明不是规范 JSON");
  }
  return canonical;
}

function canonicalClaims(value: DesktopTrustedTokenClaims): DesktopTrustedTokenClaims {
  const output: Record<string, unknown> = {
    v: 1,
    iss: ISSUER,
    aud: value.aud,
    jti: value.jti,
    purpose: value.purpose,
    nonce: value.nonce,
    iat: value.iat,
    exp: value.exp
  };
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (value[field] !== undefined) output[field] = value[field];
  }
  for (const field of OPTIONAL_REVISION_FIELDS) {
    if (value[field] !== undefined) output[field] = value[field];
  }
  return output as unknown as DesktopTrustedTokenClaims;
}

function validPurposeShape(claims: DesktopTrustedTokenClaims): boolean {
  const shape = purposeShape(claims.aud, claims.purpose);
  if (shape === undefined) return false;
  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = claims[field];
    if (shape.requiredStrings.includes(field)) {
      if (typeof value !== "string" || value.length === 0) return false;
    } else if (value !== undefined) {
      return false;
    }
  }
  for (const field of OPTIONAL_REVISION_FIELDS) {
    const value = claims[field];
    if (shape.positiveRevisions.includes(field)) {
      if (!positiveSafeInteger(value)) return false;
    } else if (shape.nonNegativeRevisions.includes(field)) {
      if (!nonNegativeSafeInteger(value)) return false;
    } else if (value !== undefined) {
      return false;
    }
  }
  if (!validTokenIDRelationship(claims)) return false;
  return claims.purpose !== "credential_activation" || claims.bindingDigest !== undefined;
}

type StringField = (typeof OPTIONAL_STRING_FIELDS)[number];
type RevisionField = (typeof OPTIONAL_REVISION_FIELDS)[number];

interface PurposeShape {
  requiredStrings: readonly StringField[];
  positiveRevisions: readonly RevisionField[];
  nonNegativeRevisions: readonly RevisionField[];
}

function purposeShape(audience: string, purpose: string): PurposeShape | undefined {
  const none: readonly RevisionField[] = [];
  if (audience === AUDIENCE_DESKTOP && purpose === "authorization_handoff") {
    return {
      requiredStrings: ["actorId", "sessionId", "executorId", "deviceId", "handoffId"],
      positiveRevisions: ["expectedSessionRevision"],
      nonNegativeRevisions: none
    };
  }
  if (audience === AUDIENCE_CLAIM && purpose === "authorization_claim") {
    return {
      requiredStrings: ["sessionId", "executorId", "deviceId", "handoffId"],
      positiveRevisions: ["expectedSessionRevision"],
      nonNegativeRevisions: none
    };
  }
  if (audience === AUDIENCE_ACTIVATION && purpose === "credential_activation") {
    return {
      requiredStrings: [
        "sessionId",
        "executorId",
        "deviceId",
        "activationId",
        "operationId",
        "bindingDigest"
      ],
      positiveRevisions: ["credentialRevision", "leaseEpoch"],
      nonNegativeRevisions: ["sourceCredentialRevision", "revocationEpoch"]
    };
  }
  if (
    audience === AUDIENCE_COMMAND &&
    (purpose === "authorization_cancel" || purpose === "authorization_reopen")
  ) {
    return {
      requiredStrings: ["actorId", "sessionId", "executorId", "deviceId", "operationId"],
      positiveRevisions: ["expectedSessionRevision"],
      nonNegativeRevisions: none
    };
  }
  if (audience === AUDIENCE_COMMAND && purpose === "credential_verify") {
    return {
      requiredStrings: ["actorId", "executorId", "deviceId", "operationId"],
      positiveRevisions: ["expectedExecutorRevision", "expectedCredentialRevision"],
      nonNegativeRevisions: none
    };
  }
  if (audience === AUDIENCE_COMMAND && purpose === "model_catalog_refresh") {
    return {
      requiredStrings: ["actorId", "executorId", "deviceId", "operationId"],
      positiveRevisions: ["expectedExecutorRevision"],
      nonNegativeRevisions: ["expectedCatalogRevision"]
    };
  }
  if (audience === AUDIENCE_COMMAND && purpose === "readiness_check") {
    return {
      requiredStrings: ["actorId", "executorId", "deviceId", "operationId"],
      positiveRevisions: ["expectedExecutorRevision", "expectedCredentialRevision"],
      nonNegativeRevisions: ["expectedCatalogRevision"]
    };
  }
  if (audience === AUDIENCE_COMMAND && purpose === "credential_logout") {
    return {
      requiredStrings: [
        "actorId",
        "executorId",
        "deviceId",
        "operationId",
        "revocationId"
      ],
      positiveRevisions: ["credentialRevision", "revocationEpoch"],
      nonNegativeRevisions: none
    };
  }
  return undefined;
}

function validTokenIDRelationship(claims: DesktopTrustedTokenClaims): boolean {
  switch (claims.purpose) {
    case "authorization_handoff":
    case "authorization_claim":
      return claims.jti === claims.handoffId;
    case "credential_activation":
      return claims.jti === claims.activationId;
    case "credential_logout":
      return claims.jti === claims.revocationId;
    case "authorization_cancel":
    case "authorization_reopen":
    case "credential_verify":
    case "model_catalog_refresh":
    case "readiness_check":
      return claims.jti === claims.operationId;
    default:
      return false;
  }
}

function purposeLifetime(audience: string, purpose: string): number | undefined {
  if (audience === AUDIENCE_DESKTOP && purpose === "authorization_handoff") return 120;
  if (audience === AUDIENCE_CLAIM && purpose === "authorization_claim") return 300;
  if (audience === AUDIENCE_ACTIVATION && purpose === "credential_activation") return 600;
  if (
    audience === AUDIENCE_COMMAND &&
    [
      "authorization_cancel",
      "authorization_reopen",
      "credential_verify",
      "model_catalog_refresh",
      "readiness_check",
      "credential_logout"
    ].includes(purpose)
  ) {
    return 120;
  }
  return undefined;
}

function isSupportedPair(audience: string, purpose: string): boolean {
  return purposeLifetime(audience, purpose) !== undefined;
}

function resolveVerificationKey(
  keyring: DesktopTrustedTokenKeyring,
  keyID: string
): DesktopTrustedTokenVerificationKey {
  if (
    !keyring ||
    keyring.issuer !== ISSUER ||
    keyring.maxTokenLifetimeSeconds !== MAXIMUM_TOKEN_LIFETIME_SECONDS ||
    !Array.isArray(keyring.keys) ||
    keyring.keys.length < 1 ||
    keyring.keys.length > 8 ||
    keyring.keys.some((candidate) => !isRecord(candidate))
  ) {
    throw tokenError("desktop_trusted_token_input_invalid", "受信公钥环无效");
  }
  const matches = keyring.keys.filter((candidate) => candidate.kid === keyID);
  if (matches.length !== 1) {
    throw tokenError("desktop_trusted_token_unknown_key", "受信票据签名密钥未知");
  }
  return matches[0];
}

function publicKeyObject(key: DesktopTrustedTokenVerificationKey) {
  if (
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    key.alg !== "EdDSA" ||
    key.use !== "sig" ||
    !KEY_ID.test(key.kid)
  ) {
    throw tokenError("desktop_trusted_token_unknown_key", "受信票据签名密钥无效");
  }
  let raw: Buffer;
  try {
    raw = decodeCanonicalSegment(key.x, ED25519_PUBLIC_KEY_BYTES);
  } catch {
    throw tokenError("desktop_trusted_token_unknown_key", "受信票据签名密钥无效");
  }
  if (raw.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw tokenError("desktop_trusted_token_unknown_key", "受信票据签名密钥无效");
  }
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki"
    });
  } catch {
    throw tokenError("desktop_trusted_token_unknown_key", "受信票据签名密钥无效");
  }
}

function enforceKeyWindow(
  key: DesktopTrustedTokenVerificationKey,
  issuedAt: number,
  current: number
): void {
  const notBefore = parseCanonicalUtcSecond(key.signingNotBefore);
  const paired = (key.signingNotAfter === null) === (key.verifyUntil === null);
  if (!paired) {
    throw tokenError("desktop_trusted_token_input_invalid", "受信公钥时间窗口无效");
  }
  if (key.signingNotAfter === null || key.verifyUntil === null) {
    if (issuedAt < notBefore) {
      throw tokenError(
        "desktop_trusted_token_key_window_mismatch",
        "票据签发时间不在密钥窗口内"
      );
    }
    return;
  }
  const notAfter = parseCanonicalUtcSecond(key.signingNotAfter);
  const verifyUntil = parseCanonicalUtcSecond(key.verifyUntil);
  if (notAfter <= notBefore || verifyUntil !== notAfter + MAXIMUM_TOKEN_LIFETIME_SECONDS) {
    throw tokenError("desktop_trusted_token_input_invalid", "受信公钥时间窗口无效");
  }
  if (issuedAt < notBefore || issuedAt >= notAfter) {
    throw tokenError(
      "desktop_trusted_token_key_window_mismatch",
      "票据签发时间不在密钥窗口内"
    );
  }
  if (current >= verifyUntil) {
    throw tokenError("desktop_trusted_token_key_retired", "受信票据签名密钥已退役");
  }
}

function validateAuthorizationHandoffInput(
  value: unknown
): VerifyDesktopAuthorizationHandoffTokenInput {
  const fields = [
    "token",
    "keyring",
    "now",
    "registeredDeviceId",
    "sessionId",
    "executorId",
    "handoffId"
  ] as const;
  if (!isRecord(value) || !exactKeys(value, fields)) {
    throw tokenError(
      "desktop_trusted_token_input_invalid",
      "Desktop 授权 handoff 验签输入结构无效"
    );
  }
  const input = value as unknown as VerifyDesktopAuthorizationHandoffTokenInput;
  if (
    typeof input.token !== "string" ||
    !isRecord(input.keyring) ||
    !(input.now instanceof Date) ||
    !Number.isFinite(input.now.getTime()) ||
    !LOWER_HEX_256.test(input.registeredDeviceId) ||
    !OPAQUE_ID.test(input.sessionId) ||
    !OPAQUE_ID.test(input.executorId) ||
    !OPAQUE_ID.test(input.handoffId)
  ) {
    throw tokenError(
      "desktop_trusted_token_input_invalid",
      "Desktop 授权 handoff 验签输入字段无效"
    );
  }
  return {
    token: input.token,
    keyring: input.keyring,
    now: new Date(input.now.getTime()),
    registeredDeviceId: input.registeredDeviceId,
    sessionId: input.sessionId,
    executorId: input.executorId,
    handoffId: input.handoffId
  };
}

function validateAuthorizationSessionCommandInput(
  value: unknown
): VerifyDesktopAuthorizationSessionCommandTokenInput {
  const captured = captureExactDataObject(value, [
    "token",
    "keyring",
    "now",
    "registeredDeviceId",
    "sessionId",
    "executorId",
    "operationId",
    "expectedSessionRevision",
    "purpose"
  ]);
  if (!captured) {
    throw tokenError(
      "desktop_trusted_token_input_invalid",
      "Desktop 授权会话命令验签输入结构无效"
    );
  }

  let nowMilliseconds: number;
  try {
    if (Object.getPrototypeOf(captured.now) !== Date.prototype) throw new Error("invalid date");
    nowMilliseconds = Date.prototype.getTime.call(captured.now);
  } catch {
    throw tokenError(
      "desktop_trusted_token_input_invalid",
      "Desktop 授权会话命令验签输入字段无效"
    );
  }
  const keyring = captureDesktopTrustedTokenKeyring(captured.keyring);
  if (
    typeof captured.token !== "string" ||
    !keyring ||
    !Number.isFinite(nowMilliseconds) ||
    typeof captured.registeredDeviceId !== "string" ||
    !LOWER_HEX_256.test(captured.registeredDeviceId) ||
    typeof captured.sessionId !== "string" ||
    !OPAQUE_ID.test(captured.sessionId) ||
    typeof captured.executorId !== "string" ||
    !OPAQUE_ID.test(captured.executorId) ||
    typeof captured.operationId !== "string" ||
    !OPAQUE_ID.test(captured.operationId) ||
    !positiveSafeInteger(captured.expectedSessionRevision) ||
    (captured.purpose !== "authorization_cancel" &&
      captured.purpose !== "authorization_reopen")
  ) {
    throw tokenError(
      "desktop_trusted_token_input_invalid",
      "Desktop 授权会话命令验签输入字段无效"
    );
  }
  return Object.freeze({
    token: captured.token,
    keyring,
    now: new Date(nowMilliseconds),
    registeredDeviceId: captured.registeredDeviceId,
    sessionId: captured.sessionId,
    executorId: captured.executorId,
    operationId: captured.operationId,
    expectedSessionRevision: captured.expectedSessionRevision,
    purpose: captured.purpose
  });
}

function validateExpectedTarget(value: unknown): DesktopTrustedTokenExpectedTarget {
  if (!isRecord(value) || typeof value.audience !== "string" || typeof value.purpose !== "string") {
    throw tokenError("desktop_trusted_token_input_invalid", "受信票据目标无效");
  }
  const target = value as unknown as DesktopTrustedTokenExpectedTarget;
  const fields = expectedTargetFields(target.audience, target.purpose);
  if (!fields || !exactKeys(value, fields)) {
    throw tokenError("desktop_trusted_token_unsupported", "受信票据目标用途不受支持");
  }
  for (const [field, candidate] of Object.entries(value)) {
    if (field === "audience" || field === "purpose") continue;
    if (field.endsWith("Revision") || field === "leaseEpoch" || field === "revocationEpoch") {
      const allowZero =
        field === "sourceCredentialRevision" ||
        field === "revocationEpoch" ||
        field === "expectedCatalogRevision";
      if (!(allowZero ? nonNegativeSafeInteger(candidate) : positiveSafeInteger(candidate))) {
        throw tokenError("desktop_trusted_token_input_invalid", "受信票据目标版本无效");
      }
      continue;
    }
    if (field === "bindingDigest") {
      if (typeof candidate !== "string" || !LOWER_HEX_256.test(candidate)) {
        throw tokenError("desktop_trusted_token_input_invalid", "受信票据目标摘要无效");
      }
      continue;
    }
    if (typeof candidate !== "string" || !OPAQUE_ID.test(candidate)) {
      throw tokenError("desktop_trusted_token_input_invalid", "受信票据目标标识无效");
    }
  }
  return { ...target };
}

function expectedTargetFields(audience: string, purpose: string): readonly string[] | undefined {
  const base = ["audience", "purpose", "executorId"];
  if (audience === AUDIENCE_DESKTOP && purpose === "authorization_handoff") {
    return [...base, "actorId", "sessionId", "handoffId", "expectedSessionRevision"];
  }
  if (audience === AUDIENCE_CLAIM && purpose === "authorization_claim") {
    return [...base, "sessionId", "handoffId", "expectedSessionRevision"];
  }
  if (audience === AUDIENCE_ACTIVATION && purpose === "credential_activation") {
    return [
      ...base,
      "sessionId",
      "operationId",
      "activationId",
      "bindingDigest",
      "credentialRevision",
      "leaseEpoch",
      "sourceCredentialRevision",
      "revocationEpoch"
    ];
  }
  if (
    audience === AUDIENCE_COMMAND &&
    (purpose === "authorization_cancel" || purpose === "authorization_reopen")
  ) {
    return [...base, "actorId", "sessionId", "operationId", "expectedSessionRevision"];
  }
  if (audience === AUDIENCE_COMMAND && purpose === "credential_verify") {
    return [
      ...base,
      "actorId",
      "operationId",
      "expectedExecutorRevision",
      "expectedCredentialRevision"
    ];
  }
  if (audience === AUDIENCE_COMMAND && purpose === "model_catalog_refresh") {
    return [
      ...base,
      "actorId",
      "operationId",
      "expectedExecutorRevision",
      "expectedCatalogRevision"
    ];
  }
  if (audience === AUDIENCE_COMMAND && purpose === "readiness_check") {
    return [
      ...base,
      "actorId",
      "operationId",
      "expectedExecutorRevision",
      "expectedCredentialRevision",
      "expectedCatalogRevision"
    ];
  }
  if (audience === AUDIENCE_COMMAND && purpose === "credential_logout") {
    return [
      ...base,
      "actorId",
      "operationId",
      "revocationId",
      "credentialRevision",
      "revocationEpoch"
    ];
  }
  return undefined;
}

function matchesExpectedTarget(
  claims: DesktopTrustedTokenClaims,
  expected: DesktopTrustedTokenExpectedTarget
): boolean {
  const claimsTarget: Record<string, unknown> = {
    audience: claims.aud,
    purpose: claims.purpose,
    executorId: claims.executorId
  };
  for (const field of [
    "actorId",
    "sessionId",
    "handoffId",
    "operationId",
    "activationId",
    "revocationId",
    "bindingDigest",
    "expectedSessionRevision",
    "expectedExecutorRevision",
    "expectedCredentialRevision",
    "expectedCatalogRevision",
    "credentialRevision",
    "leaseEpoch",
    "sourceCredentialRevision",
    "revocationEpoch"
  ] as const) {
    if (claims[field] !== undefined) claimsTarget[field] = claims[field];
  }
  const actualFields = Object.keys(claimsTarget).sort();
  const expectedFields = Object.keys(expected).sort();
  return (
    actualFields.length === expectedFields.length &&
    actualFields.every(
      (field, index) =>
        field === expectedFields[index] && claimsTarget[field] === expected[field as keyof typeof expected]
    )
  );
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((field, index) => field === canonical[index]);
}

function captureExactDataObject(
  value: unknown,
  expected: readonly string[]
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const actual = Reflect.ownKeys(value);
    if (
      actual.length !== expected.length ||
      actual.some((key) => typeof key !== "string" || !expected.includes(key))
    ) {
      return null;
    }
    const captured: Record<string, unknown> = Object.create(null);
    for (const key of expected) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
        return null;
      }
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function captureDenseDataArray(value: unknown, maximumItems: number): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) return null;
    const actual = Reflect.ownKeys(value);
    if (actual.some((key) => typeof key !== "string")) return null;
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return null;
    const length = lengthDescriptor.value;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximumItems
    ) return null;
    const expected = ["length", ...Array.from({ length }, (_, index) => String(index))];
    if (actual.length !== expected.length || expected.some((key) => !actual.includes(key))) {
      return null;
    }
    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return null;
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function captureDesktopTrustedTokenKeyring(
  value: unknown
): DesktopTrustedTokenKeyring | null {
  const ring = captureExactDataObject(value, [
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
  ]);
  if (!ring) return null;
  const audiences = captureDenseDataArray(ring.desktopAudiences, 4);
  const keys = captureDenseDataArray(ring.keys, 8);
  if (!audiences || audiences.length !== 4 || !keys || keys.length < 1) return null;
  const capturedKeys: DesktopTrustedTokenVerificationKey[] = [];
  for (const value of keys) {
    const key = captureExactDataObject(value, [
      "kid",
      "kty",
      "crv",
      "alg",
      "use",
      "x",
      "signingNotBefore",
      "signingNotAfter",
      "verifyUntil"
    ]);
    if (!key) return null;
    capturedKeys.push(Object.freeze({
      kid: key.kid,
      kty: key.kty,
      crv: key.crv,
      alg: key.alg,
      use: key.use,
      x: key.x,
      signingNotBefore: key.signingNotBefore,
      signingNotAfter: key.signingNotAfter,
      verifyUntil: key.verifyUntil
    }) as unknown as DesktopTrustedTokenVerificationKey);
  }
  return Object.freeze({
    schemaVersion: ring.schemaVersion,
    issuer: ring.issuer,
    revision: ring.revision,
    activeKid: ring.activeKid,
    generatedAt: ring.generatedAt,
    refreshAfterSeconds: ring.refreshAfterSeconds,
    maxTokenLifetimeSeconds: ring.maxTokenLifetimeSeconds,
    keyringDigest: ring.keyringDigest,
    desktopAudiences: Object.freeze([...audiences]),
    keys: Object.freeze(capturedKeys)
  }) as unknown as DesktopTrustedTokenKeyring;
}

function validNonce(value: string): boolean {
  try {
    const raw = decodeCanonicalSegment(value, 16);
    return raw.byteLength === 16;
  } catch {
    return false;
  }
}

function parseCanonicalUtcSecond(value: string): number {
  if (typeof value !== "string" || !CANONICAL_UTC_SECOND.test(value)) {
    throw tokenError("desktop_trusted_token_input_invalid", "受信公钥时间窗口无效");
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    new Date(milliseconds).toISOString().replace(".000Z", "Z") !== value
  ) {
    throw tokenError("desktop_trusted_token_input_invalid", "受信公钥时间窗口无效");
  }
  return milliseconds / 1000;
}

function canonicalCurrentSecond(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw tokenError("desktop_trusted_token_input_invalid", "受信票据校验时间无效");
  }
  return Math.floor(value.getTime() / 1000);
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenError(
  code: DesktopTrustedTokenVerificationErrorCode,
  message: string
): DesktopTrustedTokenVerificationError {
  return new DesktopTrustedTokenVerificationError(code, message);
}
