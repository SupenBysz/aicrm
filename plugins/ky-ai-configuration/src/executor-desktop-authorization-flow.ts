import type {
  AiExecutorDesktopTrustBridgeContract,
  CodexAuthorizationDesktopBridgeContract
} from "@ky/admin-core";
import type {
  AiExecutorAuthorizationIntent,
  AiExecutorAuthorizationSession,
  AiExecutorDesktopHandoff
} from "./api";

const TERMINAL_AUTHORIZATION_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "interrupted",
  "superseded"
]);
const DESKTOP_HANDOFF_TTL_MS = 120_000;
const DESKTOP_HANDOFF_CLOCK_SKEW_MS = 5_000;

export const DESKTOP_HANDOFF_TARGET_MISMATCH = "desktop_handoff_target_mismatch";
export const DESKTOP_BINDING_ACTIVE = "device_binding_active";

export type AiExecutorDesktopAuthorizationFlowErrorCode =
  | "desktop_bridge_unavailable"
  | "desktop_registration_unavailable"
  | "desktop_session_invalid"
  | "desktop_binding_requires_assistance"
  | "desktop_binding_failed"
  | "desktop_authorization_start_failed";

/** A deliberately redacted error that is safe for the Admin UI to display. */
export class AiExecutorDesktopAuthorizationFlowError extends Error {
  readonly code: AiExecutorDesktopAuthorizationFlowErrorCode;

  constructor(code: AiExecutorDesktopAuthorizationFlowErrorCode, message: string) {
    super(message);
    this.name = "AiExecutorDesktopAuthorizationFlowError";
    this.code = code;
  }
}

export interface AiExecutorDesktopAuthorizationFlowDependencies {
  createSession: (
    executorId: string,
    intent: AiExecutorAuthorizationIntent
  ) => Promise<AiExecutorAuthorizationSession>;
  createHandoff: (
    sessionId: string,
    deviceId: string,
    expectedSessionRevision: number,
    idempotencyKey: string
  ) => Promise<AiExecutorDesktopHandoff>;
  getSession: (sessionId: string) => Promise<AiExecutorAuthorizationSession>;
  cancelSession: (
    session: Pick<AiExecutorAuthorizationSession, "id" | "revision">
  ) => Promise<AiExecutorAuthorizationSession>;
  createIdempotencyKey?: () => string;
  now?: () => number;
}

export interface StartAiExecutorDesktopAuthorizationInput {
  executorId: string;
  intent: AiExecutorAuthorizationIntent;
  trustBridge: AiExecutorDesktopTrustBridgeContract | null;
  authorizationBridge: CodexAuthorizationDesktopBridgeContract | null;
}

/**
 * Creates a server session and immediately transfers it to trusted Desktop
 * Main. Only the server's exact initial-binding mismatch may trigger a bind;
 * every other failure remains fail closed and cleans up the fresh session.
 */
export async function startAiExecutorDesktopAuthorization(
  input: StartAiExecutorDesktopAuthorizationInput,
  dependencies: AiExecutorDesktopAuthorizationFlowDependencies
): Promise<AiExecutorAuthorizationSession> {
  const { authorizationBridge, executorId, intent, trustBridge } = input;
  if (!trustBridge || !authorizationBridge) {
    throw safeFlowError("desktop_bridge_unavailable", "AiCRM Desktop 可信授权桥接不可用");
  }

  const deviceId = await ensureRegisteredDevice(trustBridge);
  let session: AiExecutorAuthorizationSession | null = null;
  try {
    session = await dependencies.createSession(executorId, intent);
    if (!validDesktopSession(session, executorId, intent)) {
      throw safeFlowError("desktop_session_invalid", "Desktop 授权会话目标无效");
    }
    const handoffKey = (dependencies.createIdempotencyKey ?? defaultIdempotencyKey)();
    let handoff: AiExecutorDesktopHandoff;
    try {
      handoff = await dependencies.createHandoff(session.id, deviceId, session.revision, handoffKey);
    } catch (error) {
      if (exactErrorCode(error) !== DESKTOP_HANDOFF_TARGET_MISMATCH) throw error;
      await bindInitialExecutorDevice(trustBridge, executorId, deviceId);
      handoff = await dependencies.createHandoff(session.id, deviceId, session.revision, handoffKey);
    }

    if (!validHandoffForBridge(handoff, (dependencies.now ?? Date.now)())) {
      throw safeFlowError("desktop_authorization_start_failed", "Desktop 授权交接响应无效");
    }
    await startDesktopAuthorization(authorizationBridge, session, handoff);
    return session;
  } catch (error) {
    if (session) await bestEffortCancelFreshSession(session.id, dependencies);
    throw error;
  }
}

async function ensureRegisteredDevice(bridge: AiExecutorDesktopTrustBridgeContract): Promise<string> {
  let result: Awaited<ReturnType<AiExecutorDesktopTrustBridgeContract["ensureRegistration"]>>;
  try {
    result = await bridge.ensureRegistration();
  } catch {
    throw safeFlowError("desktop_registration_unavailable", "AiCRM Desktop 设备注册失败");
  }
  const registration = result.data;
  if (
    !result.ok ||
    !registration ||
    registration.status !== "registered" ||
    registration.registrationStatus !== "registered" ||
    !validBridgeIdentifier(registration.deviceId)
  ) {
    throw safeFlowError("desktop_registration_unavailable", "AiCRM Desktop 设备尚未完成可信注册");
  }
  return registration.deviceId;
}

async function bindInitialExecutorDevice(
  bridge: AiExecutorDesktopTrustBridgeContract,
  executorId: string,
  deviceId: string
): Promise<void> {
  let result: Awaited<ReturnType<AiExecutorDesktopTrustBridgeContract["bindExecutorDevice"]>>;
  try {
    result = await bridge.bindExecutorDevice({ executorId, expectedRevision: 0 });
  } catch (error) {
    if (exactErrorCode(error) === DESKTOP_BINDING_ACTIVE) throw bindingAssistanceError();
    throw safeFlowError("desktop_binding_failed", "AiCRM Desktop 执行器设备绑定失败");
  }
  if (!result.ok) {
    if (result.error?.code === DESKTOP_BINDING_ACTIVE) throw bindingAssistanceError();
    throw safeFlowError("desktop_binding_failed", "AiCRM Desktop 执行器设备绑定失败");
  }
  const binding = result.data?.binding;
  if (
    !binding ||
    binding.executorId !== executorId ||
    binding.deviceId !== deviceId ||
    binding.status !== "active" ||
    binding.force !== false ||
    !Number.isSafeInteger(binding.revision) ||
    binding.revision <= 0
  ) {
    throw safeFlowError("desktop_binding_failed", "AiCRM Desktop 执行器设备绑定结果无效");
  }
}

async function startDesktopAuthorization(
  bridge: CodexAuthorizationDesktopBridgeContract,
  session: AiExecutorAuthorizationSession,
  handoff: AiExecutorDesktopHandoff
): Promise<void> {
  let result: Awaited<ReturnType<CodexAuthorizationDesktopBridgeContract["start"]>>;
  try {
    result = await bridge.start({
      sessionId: session.id,
      executorId: session.executorId,
      sessionRevision: session.revision,
      handoffId: handoff.handoffId,
      handoffTicket: handoff.handoffTicket
    });
  } catch {
    throw safeFlowError("desktop_authorization_start_failed", "AiCRM Desktop 本地授权启动失败");
  }
  if (
    !result.ok ||
    !result.data ||
    result.data.sessionId !== session.id ||
    result.data.executorId !== session.executorId
  ) {
    throw safeFlowError("desktop_authorization_start_failed", "AiCRM Desktop 本地授权启动失败");
  }
}

async function bestEffortCancelFreshSession(
  sessionId: string,
  dependencies: AiExecutorDesktopAuthorizationFlowDependencies
): Promise<void> {
  try {
    const current = await dependencies.getSession(sessionId);
    if (
      current.id !== sessionId ||
      !Number.isSafeInteger(current.revision) ||
      current.revision <= 0
    ) {
      return;
    }
    if (TERMINAL_AUTHORIZATION_STATUSES.has(current.status)) return;
    await dependencies.cancelSession({ id: current.id, revision: current.revision });
  } catch {
    // Cleanup must never replace the original authorization failure.
  }
}

function bindingAssistanceError(): AiExecutorDesktopAuthorizationFlowError {
  return safeFlowError(
    "desktop_binding_requires_assistance",
    "该执行器已绑定其他设备，需要协助授权后才能重新绑定"
  );
}

function validDesktopSession(
  value: AiExecutorAuthorizationSession,
  executorId: string,
  intent: AiExecutorAuthorizationIntent
): boolean {
  return (
    Boolean(value) &&
    validBridgeIdentifier(value.id) &&
    value.executorId === executorId &&
    value.runtimeType === "desktop" &&
    value.intent === intent &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0
  );
}

function validHandoffForBridge(value: AiExecutorDesktopHandoff, now: number): boolean {
  const expiresAt = Date.parse(value?.expiresAt);
  return (
    Boolean(value) &&
    validBridgeIdentifier(value.handoffId) &&
    validCompactJws(value.handoffTicket) &&
    validDesktopHandoffNonce(value.nonce) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value.expiresAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > now - DESKTOP_HANDOFF_CLOCK_SKEW_MS &&
    expiresAt <= now + DESKTOP_HANDOFF_TTL_MS + DESKTOP_HANDOFF_CLOCK_SKEW_MS
  );
}

function validCompactJws(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16 << 10) return false;
  const parts = value.split(".");
  return parts.length === 3 && parts.every(validCanonicalBase64UrlSegment);
}

function validCanonicalBase64UrlSegment(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return false;
  const remainder = value.length % 4;
  if (remainder === 2) return /[AQgw]$/.test(value);
  if (remainder === 3) return /[AEIMQUYcgkosw048]$/.test(value);
  return true;
}

function validDesktopHandoffNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(value);
}

function validBridgeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function exactErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

function defaultIdempotencyKey(): string {
  return crypto.randomUUID();
}

function safeFlowError(
  code: AiExecutorDesktopAuthorizationFlowErrorCode,
  message: string
): AiExecutorDesktopAuthorizationFlowError {
  return new AiExecutorDesktopAuthorizationFlowError(code, message);
}
