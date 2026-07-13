const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[0-9a-f]{64}$/;

const DURABLE_CANCEL_STATUSES = new Set([
  "accepted",
  "effect_started",
  "effect_durable",
  "ack_prepared",
  "acknowledged",
  "ack_rejected",
  "indeterminate"
]);

const DURABLE_CANCEL_KEYS = [
  "purpose",
  "status",
  "semanticKey",
  "tokenHash",
  "payloadHash",
  "effectRecoveryReference",
  "sessionId",
  "executorId",
  "deviceId",
  "operationId",
  "expectedSessionRevision"
] as const;

export type DesktopCodexAuthorizationStartupHoldState =
  | "pending"
  | "committed"
  | "contained";

export interface DesktopCodexAuthorizationDurableCancelHoldInput {
  purpose: "authorization_cancel";
  status:
    | "accepted"
    | "effect_started"
    | "effect_durable"
    | "ack_prepared"
    | "acknowledged"
    | "ack_rejected"
    | "indeterminate";
  semanticKey: string;
  tokenHash: string;
  payloadHash: string;
  effectRecoveryReference: string;
  sessionId: string;
  executorId: string;
  deviceId: string;
  operationId: string;
  expectedSessionRevision: number;
}

export interface DesktopCodexAuthorizationStartupHoldCapability {
  readonly version: 1;
  readonly sessionId: string;
  readonly semanticKey: string;
}

export interface DesktopCodexAuthorizationStartupHoldProjection {
  version: 1;
  state: DesktopCodexAuthorizationStartupHoldState;
  journalStatus: DesktopCodexAuthorizationDurableCancelHoldInput["status"];
  semanticKey: string;
  tokenHash: string;
  payloadHash: string;
  effectRecoveryReference: string;
  sessionId: string;
  executorId: string;
  deviceId: string;
  operationId: string;
  expectedSessionRevision: number;
  containmentEvidenceHash: string | null;
}

export type DesktopCodexAuthorizationStartupHoldErrorCode =
  | "desktop_codex_authorization_startup_hold_invalid_input"
  | "desktop_codex_authorization_startup_hold_conflict"
  | "desktop_codex_authorization_startup_hold_invalid_capability"
  | "desktop_codex_authorization_startup_hold_invalid_state"
  | "desktop_codex_authorization_startup_hold_resume_blocked";

export class DesktopCodexAuthorizationStartupHoldError extends Error {
  readonly code: DesktopCodexAuthorizationStartupHoldErrorCode;

  constructor(code: DesktopCodexAuthorizationStartupHoldErrorCode, message: string) {
    super(message);
    this.name = "DesktopCodexAuthorizationStartupHoldError";
    this.code = code;
  }
}

interface InternalHold {
  readonly command: Readonly<DesktopCodexAuthorizationDurableCancelHoldInput>;
  readonly capability: Readonly<DesktopCodexAuthorizationStartupHoldCapability>;
  state: DesktopCodexAuthorizationStartupHoldState | "released";
  containmentEvidenceHash: string | null;
}

/**
 * Main-only, current-boot cancellation fence. Durability belongs to the
 * trusted-command journal; this registry is rebuilt before authorization
 * recovery and never persists a second source of truth.
 */
export class DesktopCodexAuthorizationStartupHoldRegistry {
  private readonly bySession = new Map<string, InternalHold>();
  private readonly bySemanticKey = new Map<string, InternalHold>();
  private readonly capabilities = new WeakMap<object, InternalHold>();

  installFromDurableCommand(
    input: DesktopCodexAuthorizationDurableCancelHoldInput
  ): Readonly<DesktopCodexAuthorizationStartupHoldCapability> {
    const command = validateDurableCancel(input);
    const sessionHold = this.bySession.get(command.sessionId);
    const semanticHold = this.bySemanticKey.get(command.semanticKey);
    if (sessionHold || semanticHold) {
      if (sessionHold && semanticHold === sessionHold &&
          sameDurableCancel(sessionHold.command, command) &&
          sessionHold.state !== "released") {
        return sessionHold.capability;
      }
      throw holdError(
        "desktop_codex_authorization_startup_hold_conflict",
        "Codex 授权取消启动栅栏冲突"
      );
    }

    const capability = Object.freeze({
      version: 1 as const,
      sessionId: command.sessionId,
      semanticKey: command.semanticKey
    });
    const hold: InternalHold = {
      command,
      capability,
      state: "pending",
      containmentEvidenceHash: null
    };
    this.bySession.set(command.sessionId, hold);
    this.bySemanticKey.set(command.semanticKey, hold);
    this.capabilities.set(capability, hold);
    return capability;
  }

  find(sessionId: string): Readonly<DesktopCodexAuthorizationStartupHoldProjection> | null {
    if (!safeId(sessionId)) throw invalidInputError();
    const hold = this.bySession.get(sessionId);
    return !hold || hold.state === "released" ? null : projectHold(hold);
  }

  commit(
    capability: DesktopCodexAuthorizationStartupHoldCapability
  ): Readonly<DesktopCodexAuthorizationStartupHoldProjection> {
    const hold = this.requireCapability(capability);
    if (hold.state === "pending") hold.state = "committed";
    if (hold.state !== "committed" && hold.state !== "contained") {
      throw invalidStateError();
    }
    return projectHold(hold);
  }

  markContained(
    capability: DesktopCodexAuthorizationStartupHoldCapability,
    containmentEvidenceHash: string
  ): Readonly<DesktopCodexAuthorizationStartupHoldProjection> {
    if (!digest(containmentEvidenceHash)) throw invalidInputError();
    const hold = this.requireCapability(capability);
    if (hold.state === "contained") {
      if (hold.containmentEvidenceHash !== containmentEvidenceHash) {
        throw holdError(
          "desktop_codex_authorization_startup_hold_conflict",
          "Codex 授权取消收敛证据冲突"
        );
      }
      return projectHold(hold);
    }
    if (hold.state !== "committed") throw invalidStateError();
    hold.state = "contained";
    hold.containmentEvidenceHash = containmentEvidenceHash;
    return projectHold(hold);
  }

  release(capability: DesktopCodexAuthorizationStartupHoldCapability): void {
    const hold = this.requireCapability(capability);
    if (hold.state === "released") return;
    if (hold.state !== "pending" && hold.state !== "contained") {
      throw invalidStateError();
    }
    hold.state = "released";
    this.bySession.delete(hold.command.sessionId);
    this.bySemanticKey.delete(hold.command.semanticKey);
  }

  assertResumeAllowed(input: Readonly<{ sessionId: string }>): void {
    const captured = captureExact(input, ["sessionId"]);
    if (!captured || !safeId(captured.sessionId)) throw invalidInputError();
    const hold = this.bySession.get(captured.sessionId);
    if (hold && hold.state !== "released") {
      throw holdError(
        "desktop_codex_authorization_startup_hold_resume_blocked",
        "Codex 授权会话受取消启动栅栏保护"
      );
    }
  }

  private requireCapability(
    capability: DesktopCodexAuthorizationStartupHoldCapability
  ): InternalHold {
    if ((typeof capability !== "object" && typeof capability !== "function") ||
        capability === null) {
      throw invalidCapabilityError();
    }
    const hold = this.capabilities.get(capability as object);
    if (!hold) throw invalidCapabilityError();
    return hold;
  }
}

function validateDurableCancel(
  input: unknown
): Readonly<DesktopCodexAuthorizationDurableCancelHoldInput> {
  const captured = captureExact(input, DURABLE_CANCEL_KEYS);
  if (!captured || captured.purpose !== "authorization_cancel" ||
      typeof captured.status !== "string" ||
      !DURABLE_CANCEL_STATUSES.has(captured.status) ||
      !digest(captured.semanticKey) || !digest(captured.tokenHash) ||
      !digest(captured.payloadHash) || !digest(captured.effectRecoveryReference) ||
      !safeId(captured.sessionId) || !safeId(captured.executorId) ||
      typeof captured.deviceId !== "string" || !DEVICE_ID.test(captured.deviceId) ||
      !safeId(captured.operationId) ||
      !positiveSafeInteger(captured.expectedSessionRevision)) {
    throw invalidInputError();
  }
  return Object.freeze({
    purpose: "authorization_cancel",
    status: captured.status as DesktopCodexAuthorizationDurableCancelHoldInput["status"],
    semanticKey: captured.semanticKey,
    tokenHash: captured.tokenHash,
    payloadHash: captured.payloadHash,
    effectRecoveryReference: captured.effectRecoveryReference,
    sessionId: captured.sessionId,
    executorId: captured.executorId,
    deviceId: captured.deviceId,
    operationId: captured.operationId,
    expectedSessionRevision: captured.expectedSessionRevision
  });
}

function projectHold(
  hold: InternalHold
): Readonly<DesktopCodexAuthorizationStartupHoldProjection> {
  if (hold.state === "released") throw invalidStateError();
  return Object.freeze({
    version: 1,
    state: hold.state,
    journalStatus: hold.command.status,
    semanticKey: hold.command.semanticKey,
    tokenHash: hold.command.tokenHash,
    payloadHash: hold.command.payloadHash,
    effectRecoveryReference: hold.command.effectRecoveryReference,
    sessionId: hold.command.sessionId,
    executorId: hold.command.executorId,
    deviceId: hold.command.deviceId,
    operationId: hold.command.operationId,
    expectedSessionRevision: hold.command.expectedSessionRevision,
    containmentEvidenceHash: hold.containmentEvidenceHash
  });
}

function sameDurableCancel(
  left: Readonly<DesktopCodexAuthorizationDurableCancelHoldInput>,
  right: Readonly<DesktopCodexAuthorizationDurableCancelHoldInput>
): boolean {
  return DURABLE_CANCEL_KEYS.every((key) => left[key] === right[key]);
}

function captureExact(
  value: unknown,
  keys: readonly string[]
): Record<string, any> | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string") || ownKeys.length !== keys.length ||
        keys.some((key) => !ownKeys.includes(key))) return null;
    const captured: Record<string, any> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      captured[key] = descriptor.value;
    }
    return captured;
  } catch {
    return null;
  }
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function invalidInputError(): DesktopCodexAuthorizationStartupHoldError {
  return holdError(
    "desktop_codex_authorization_startup_hold_invalid_input",
    "Codex 授权取消启动栅栏参数无效"
  );
}

function invalidCapabilityError(): DesktopCodexAuthorizationStartupHoldError {
  return holdError(
    "desktop_codex_authorization_startup_hold_invalid_capability",
    "Codex 授权取消启动栅栏能力无效"
  );
}

function invalidStateError(): DesktopCodexAuthorizationStartupHoldError {
  return holdError(
    "desktop_codex_authorization_startup_hold_invalid_state",
    "Codex 授权取消启动栅栏状态无效"
  );
}

function holdError(
  code: DesktopCodexAuthorizationStartupHoldErrorCode,
  message: string
): DesktopCodexAuthorizationStartupHoldError {
  return new DesktopCodexAuthorizationStartupHoldError(code, message);
}
