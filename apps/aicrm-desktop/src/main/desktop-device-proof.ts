import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as ed25519Sign,
  verify as ed25519Verify
} from "node:crypto";

export const DEVICE_SIGNATURE_DOMAIN = "AICRM-DEVICE-V1";
export const DEVICE_PROOF_CLOCK_WINDOW_MS = 5 * 60 * 1000;

export const DEVICE_PROOF_HEADERS = {
  deviceId: "X-AiCRM-Device-Id",
  timestamp: "X-AiCRM-Device-Timestamp",
  nonce: "X-AiCRM-Device-Nonce",
  sequence: "X-AiCRM-Device-Sequence",
  contentSha256: "X-AiCRM-Content-SHA256",
  signature: "X-AiCRM-Device-Signature"
} as const;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const LOWER_HEX_256 = /^[0-9a-f]{64}$/;
const CANONICAL_METHOD = /^[A-Z]+$/;
const CANONICAL_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
const AUTHORIZATION_SCHEME = /^[A-Za-z][A-Za-z0-9-]*$/;

export type DesktopDeviceProofErrorCode =
  | "desktop_device_key_invalid"
  | "desktop_device_request_invalid"
  | "desktop_device_authorization_invalid"
  | "desktop_device_signature_invalid";

export class DesktopDeviceProofError extends Error {
  readonly code: DesktopDeviceProofErrorCode;

  constructor(code: DesktopDeviceProofErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DesktopDeviceKeyMaterial {
  publicKey: string;
  privateKeyPkcs8: string;
  deviceId: string;
}

export interface DesktopDeviceProofInput {
  key: DesktopDeviceKeyMaterial;
  method: string;
  path: string;
  body: Uint8Array;
  authorization?: string;
  allowedAuthorizationSchemes?: string[];
  timestamp: number;
  nonce: string;
  sequence: bigint;
}

export interface DesktopDeviceProof {
  headers: Record<string, string>;
  bodySha256: string;
  authorizationTokenHash: string;
  signingInput: string;
  requestHash: string;
}

export function generateDesktopDeviceKeyMaterial(): DesktopDeviceKeyMaterial {
  return desktopDeviceKeyMaterialFromSeed(randomBytes(32));
}

export function desktopDeviceKeyMaterialFromSeed(seed: Uint8Array): DesktopDeviceKeyMaterial {
  if (seed.byteLength !== 32) throw proofError("desktop_device_key_invalid", "设备密钥种子无效");
  const privateDer = Buffer.concat([ED25519_PKCS8_SEED_PREFIX, Buffer.from(seed)]);
  const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  const publicDer = createPublicKey(
    privateKey as unknown as Parameters<typeof createPublicKey>[0]
  ).export({ format: "der", type: "spki" });
  const publicBuffer = Buffer.from(publicDer);
  if (
    publicBuffer.byteLength !== ED25519_SPKI_PREFIX.byteLength + 32 ||
    !publicBuffer.subarray(0, ED25519_SPKI_PREFIX.byteLength).equals(ED25519_SPKI_PREFIX)
  ) {
    throw proofError("desktop_device_key_invalid", "设备公钥格式无效");
  }
  const publicRaw = publicBuffer.subarray(ED25519_SPKI_PREFIX.byteLength);
  return {
    publicKey: encodeBase64Url(publicRaw),
    privateKeyPkcs8: encodeBase64Url(privateDer),
    deviceId: sha256Hex(publicRaw)
  };
}

export function validateDesktopDeviceKeyMaterial(value: DesktopDeviceKeyMaterial): DesktopDeviceKeyMaterial {
  if (!value || typeof value !== "object") throw proofError("desktop_device_key_invalid", "设备密钥无效");
  const publicRaw = decodeCanonicalBase64Url(value.publicKey, 32);
  const privateDer = decodeCanonicalBase64Url(value.privateKeyPkcs8, 48);
  if (publicRaw.byteLength !== 32 || privateDer.byteLength !== 48 || !privateDer.subarray(0, 16).equals(ED25519_PKCS8_SEED_PREFIX)) {
    throw proofError("desktop_device_key_invalid", "设备密钥格式无效");
  }
  if (!LOWER_HEX_256.test(value.deviceId) || sha256Hex(publicRaw) !== value.deviceId) {
    throw proofError("desktop_device_key_invalid", "设备标识与公钥不匹配");
  }
  const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  const derivedPublic = Buffer.from(createPublicKey(
    privateKey as unknown as Parameters<typeof createPublicKey>[0]
  ).export({ format: "der", type: "spki" })).subarray(
    ED25519_SPKI_PREFIX.byteLength
  );
  if (!derivedPublic.equals(publicRaw)) throw proofError("desktop_device_key_invalid", "设备公私钥不匹配");
  return { ...value };
}

export function buildDesktopDeviceProof(input: DesktopDeviceProofInput): DesktopDeviceProof {
  const key = validateDesktopDeviceKeyMaterial(input.key);
  const method = canonicalDeviceMethod(input.method);
  const path = canonicalDevicePath(input.path);
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp <= 0 || input.sequence <= 0n || input.sequence > 0xffff_ffff_ffff_ffffn) {
    throw proofError("desktop_device_request_invalid", "设备请求序列或时间无效");
  }
  validateDeviceNonce(input.nonce);
  const bodySha256 = sha256Hex(input.body);
  const authorizationTokenHash = hashAuthorizationToken(
    input.authorization ?? "",
    input.allowedAuthorizationSchemes ?? []
  );
  const signingInput = [
    DEVICE_SIGNATURE_DOMAIN,
    method,
    path,
    String(input.timestamp),
    input.nonce,
    input.sequence.toString(10),
    bodySha256,
    authorizationTokenHash
  ].join("\n");
  const privateDer = decodeCanonicalBase64Url(key.privateKeyPkcs8, 48);
  const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  const signature = ed25519Sign(null, Buffer.from(signingInput, "utf8"), privateKey);
  return {
    headers: {
      [DEVICE_PROOF_HEADERS.deviceId]: key.deviceId,
      [DEVICE_PROOF_HEADERS.timestamp]: String(input.timestamp),
      [DEVICE_PROOF_HEADERS.nonce]: input.nonce,
      [DEVICE_PROOF_HEADERS.sequence]: input.sequence.toString(10),
      [DEVICE_PROOF_HEADERS.contentSha256]: bodySha256,
      [DEVICE_PROOF_HEADERS.signature]: encodeBase64Url(signature)
    },
    bodySha256,
    authorizationTokenHash,
    signingInput,
    requestHash: sha256Hex(Buffer.from(signingInput, "utf8"))
  };
}

export function verifyDesktopDeviceSigningInput(
  publicKey: string,
  signingInput: string,
  signature: string
): boolean {
	try {
		const publicRaw = decodeCanonicalBase64Url(publicKey, 32, "desktop_device_signature_invalid");
		const signatureRaw = decodeCanonicalBase64Url(signature, 64, "desktop_device_signature_invalid");
		if (publicRaw.byteLength !== 32 || signatureRaw.byteLength !== 64) return false;
		const publicKeyObject = createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, publicRaw]),
			format: "der",
			type: "spki"
		});
		return ed25519Verify(null, Buffer.from(signingInput, "utf8"), publicKeyObject, signatureRaw);
	} catch {
		return false;
	}
}

export function canonicalDeviceMethod(method: string): string {
  if (typeof method !== "string" || method.length === 0 || method.length > 16 || !CANONICAL_METHOD.test(method)) {
    throw proofError("desktop_device_request_invalid", "设备请求方法无效");
  }
  return method;
}

export function canonicalDevicePath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length < 2 ||
    path.length > 2048 ||
    !path.startsWith("/") ||
    path.endsWith("/") ||
    /[?#+%\\]/.test(path)
  ) {
    throw proofError("desktop_device_request_invalid", "设备请求路径无效");
  }
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) throw proofError("desktop_device_request_invalid", "设备请求路径无效");
  }
  for (const segment of path.slice(1).split("/")) {
    if (!segment || segment === "." || segment === ".." || segment.length > 160 || !CANONICAL_PATH_SEGMENT.test(segment)) {
      throw proofError("desktop_device_request_invalid", "设备请求路径无效");
    }
  }
  return path;
}

export function hashAuthorizationToken(authorization: string, allowedSchemes: string[]): string {
  if (authorization === "") return "";
  if (
    typeof authorization !== "string" ||
    authorization.length > 8192 ||
    authorization.trim() !== authorization
  ) {
    throw proofError("desktop_device_authorization_invalid", "设备命令授权头无效");
  }
  const separator = authorization.indexOf(" ");
  if (separator < 1 || authorization.indexOf(" ", separator + 1) !== -1) {
    throw proofError("desktop_device_authorization_invalid", "设备命令授权头无效");
  }
  const scheme = authorization.slice(0, separator);
  const token = authorization.slice(separator + 1);
	if (
		!AUTHORIZATION_SCHEME.test(scheme) ||
		!token ||
		!allowedSchemes.some(
			(value) => AUTHORIZATION_SCHEME.test(value) && value.toLowerCase() === scheme.toLowerCase()
		)
	) {
    throw proofError("desktop_device_authorization_invalid", "设备命令授权类型无效");
  }
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) throw proofError("desktop_device_authorization_invalid", "设备命令票据无效");
  }
  return sha256Hex(Buffer.from(token, "ascii"));
}

export function validateDeviceNonce(nonce: string): void {
	const raw = decodeCanonicalBase64Url(nonce, 16, "desktop_device_request_invalid");
  if (raw.byteLength !== 16) throw proofError("desktop_device_request_invalid", "设备请求 nonce 无效");
}

export function createDeviceNonce(): string {
  return encodeBase64Url(randomBytes(16));
}

export function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeCanonicalBase64Url(
	value: string,
	maximum: number,
	code: DesktopDeviceProofErrorCode = "desktop_device_key_invalid"
): Buffer {
	if (typeof value !== "string" || !value || value.includes("=") || !/^[A-Za-z0-9_-]+$/.test(value)) {
		throw proofError(code, "设备安全编码无效");
	}
	const decoded = Buffer.from(value, "base64url");
	if (decoded.byteLength > maximum || encodeBase64Url(decoded) !== value) {
		throw proofError(code, "设备安全编码无效");
  }
  return decoded;
}

function proofError(code: DesktopDeviceProofErrorCode, message: string): DesktopDeviceProofError {
  return new DesktopDeviceProofError(code, message);
}
