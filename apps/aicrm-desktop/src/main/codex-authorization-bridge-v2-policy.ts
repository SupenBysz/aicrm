import type {
  CodexAuthorizationCapabilities,
  CodexAuthorizationSnapshot,
  CodexAuthorizationStartInput,
  CodexCredentialLogoutCommandInput,
  CodexCredentialLogoutResult,
  CodexCredentialVerificationResult,
  CodexModelCatalogRefreshCommandInput,
  CodexModelCatalogSnapshot,
  CodexReadinessCheckCommandInput,
  CodexReadinessCheckResult,
  CodexSessionCommandInput,
  CodexVerifyCommandInput,
  DesktopCommandResult
} from "../shared/types";

export const CODEX_AUTHORIZATION_RUNTIME_UNAVAILABLE_ERROR = {
  code: "desktop_device_not_bound",
  message: "Codex 可信设备运行时尚未关联"
} as const;

export const CODEX_AUTHORIZATION_INPUT_INVALID_ERROR = {
  code: "validation_error",
  message: "Codex 授权命令参数无效"
} as const;

export const CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR = {
  code: "desktop_codex_authorization_runtime_failed",
  message: "Codex 授权运行时执行失败"
} as const;

/**
 * Production remains fail-closed until the trusted runtime is independently
 * completed and reviewed. Runtime injection alone must never enable Bridge v2.
 */
export const CODEX_DESKTOP_AUTHORIZATION_RUNTIME_READY = false;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const LOWER_HEX_256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,95}$/;
const AUTHORIZATION_STATUSES = new Set([
  "starting", "waiting_user", "verifying", "succeeded", "failed",
  "cancelled", "expired", "interrupted", "superseded"
]);
const READINESS_REASONS = new Set([
  "network_error", "model_unavailable", "default_model_missing", "quota_exceeded",
  "runtime_error", "desktop_offline", "credential_expired"
]);

type JsonRecord = Record<string, unknown>;

export interface CodexAuthorizationBridgeV2Runtime {
  capabilities(): Promise<DesktopCommandResult<CodexAuthorizationCapabilities>>;
  start(input: CodexAuthorizationStartInput): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  getSnapshot(sessionId: string): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  cancel(input: CodexSessionCommandInput): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  reopen(input: CodexSessionCommandInput): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  verify(input: CodexVerifyCommandInput): Promise<DesktopCommandResult<CodexCredentialVerificationResult>>;
  readiness(input: CodexReadinessCheckCommandInput): Promise<DesktopCommandResult<CodexReadinessCheckResult>>;
  getCatalog(executorId: string): Promise<DesktopCommandResult<CodexModelCatalogSnapshot>>;
  refresh(input: CodexModelCatalogRefreshCommandInput): Promise<DesktopCommandResult<CodexModelCatalogSnapshot>>;
  logout(input: CodexCredentialLogoutCommandInput): Promise<DesktopCommandResult<CodexCredentialLogoutResult>>;
}

export type CodexAuthorizationBridgeV2RuntimeProvider =
  () => CodexAuthorizationBridgeV2Runtime | null;

export interface CodexAuthorizationBridgeV2Handlers {
  getCapabilities(): Promise<DesktopCommandResult<CodexAuthorizationCapabilities>>;
  start(input: unknown): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  getSnapshot(input: unknown): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  cancel(input: unknown): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  reopen(input: unknown): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  verify(input: unknown): Promise<DesktopCommandResult<CodexCredentialVerificationResult>>;
  readiness(input: unknown): Promise<DesktopCommandResult<CodexReadinessCheckResult>>;
  getCatalog(input: unknown): Promise<DesktopCommandResult<CodexModelCatalogSnapshot>>;
  refresh(input: unknown): Promise<DesktopCommandResult<CodexModelCatalogSnapshot>>;
  logout(input: unknown): Promise<DesktopCommandResult<CodexCredentialLogoutResult>>;
}

export interface CreateCodexAuthorizationBridgeV2HandlersOptions {
  ready?: boolean;
  runtime?: CodexAuthorizationBridgeV2Runtime | null;
  runtimeProvider?: CodexAuthorizationBridgeV2RuntimeProvider;
}

type CodexAuthorizationBridgeV2SafeError =
  | typeof CODEX_AUTHORIZATION_RUNTIME_UNAVAILABLE_ERROR
  | typeof CODEX_AUTHORIZATION_INPUT_INVALID_ERROR
  | typeof CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR;

function failure<T>(error: CodexAuthorizationBridgeV2SafeError): DesktopCommandResult<T> {
  return { ok: false, error: { ...error } };
}

function unavailable<T>(): DesktopCommandResult<T> {
  return failure<T>(CODEX_AUTHORIZATION_RUNTIME_UNAVAILABLE_ERROR);
}

function invalid<T>(): DesktopCommandResult<T> {
  return failure<T>(CODEX_AUTHORIZATION_INPUT_INVALID_ERROR);
}

function runtimeFailed<T>(): DesktopCommandResult<T> {
  return failure<T>(CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR);
}

function captureExactObject(
  value: unknown,
  keys: readonly string[]
): Readonly<JsonRecord> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return null;
    const actual = ownKeys as string[];
    if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) return null;
    const captured: JsonRecord = Object.create(null);
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function captureOptionalObject(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKey: string
): Readonly<JsonRecord> | null {
  return captureExactObject(value, requiredKeys) ??
    captureExactObject(value, [...requiredKeys, optionalKey]);
}

function captureDenseArray(value: unknown, maximumItems: number): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return null;
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    const lengthValue = lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (!lengthDescriptor || !("value" in lengthDescriptor) ||
        typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) ||
        lengthValue < 0 || lengthValue > maximumItems) {
      return null;
    }
    const length = lengthValue;
    const expected = ["length", ...Array.from({ length }, (_, index) => String(index))];
    const actual = ownKeys as string[];
    if (actual.length !== expected.length || expected.some((key) => !actual.includes(key))) {
      return null;
    }
    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && OPAQUE_ID_PATTERN.test(value);
}

function isPositiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCatalogRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCompactTicket(value: unknown): value is string {
  return typeof value === "string" && value.length <= 8192 && COMPACT_JWS_PATTERN.test(value);
}

function captureStartInput(value: unknown): Readonly<CodexAuthorizationStartInput> | null {
  const captured = captureExactObject(value, [
    "sessionId", "executorId", "sessionRevision", "handoffId", "handoffTicket"
  ]);
  if (!captured || !isOpaqueId(captured.sessionId) || !isOpaqueId(captured.executorId) ||
      !isPositiveRevision(captured.sessionRevision) || !isOpaqueId(captured.handoffId) ||
      !isCompactTicket(captured.handoffTicket)) return null;
  return Object.freeze({
    sessionId: captured.sessionId,
    executorId: captured.executorId,
    sessionRevision: captured.sessionRevision,
    handoffId: captured.handoffId,
    handoffTicket: captured.handoffTicket
  });
}

function captureSessionCommand(value: unknown): Readonly<CodexSessionCommandInput> | null {
  const captured = captureExactObject(value, [
    "sessionId", "operationId", "expectedSessionRevision", "commandTicket"
  ]);
  if (!captured || !isOpaqueId(captured.sessionId) || !isOpaqueId(captured.operationId) ||
      !isPositiveRevision(captured.expectedSessionRevision) ||
      !isCompactTicket(captured.commandTicket)) return null;
  return Object.freeze({
    sessionId: captured.sessionId,
    operationId: captured.operationId,
    expectedSessionRevision: captured.expectedSessionRevision,
    commandTicket: captured.commandTicket
  });
}

function captureVerifyCommand(value: unknown): Readonly<CodexVerifyCommandInput> | null {
  const captured = captureExactObject(value, [
    "executorId", "operationId", "expectedExecutorRevision",
    "expectedCredentialRevision", "commandTicket"
  ]);
  if (!captured || !isOpaqueId(captured.executorId) || !isOpaqueId(captured.operationId) ||
      !isPositiveRevision(captured.expectedExecutorRevision) ||
      !isPositiveRevision(captured.expectedCredentialRevision) ||
      !isCompactTicket(captured.commandTicket)) return null;
  return Object.freeze({
    executorId: captured.executorId,
    operationId: captured.operationId,
    expectedExecutorRevision: captured.expectedExecutorRevision,
    expectedCredentialRevision: captured.expectedCredentialRevision,
    commandTicket: captured.commandTicket
  });
}

function captureCatalogRefreshCommand(
  value: unknown
): Readonly<CodexModelCatalogRefreshCommandInput> | null {
  const captured = captureExactObject(value, [
    "executorId", "operationId", "expectedExecutorRevision",
    "expectedCatalogRevision", "commandTicket"
  ]);
  if (!captured || !isOpaqueId(captured.executorId) || !isOpaqueId(captured.operationId) ||
      !isPositiveRevision(captured.expectedExecutorRevision) ||
      !isCatalogRevision(captured.expectedCatalogRevision) ||
      !isCompactTicket(captured.commandTicket)) return null;
  return Object.freeze({
    executorId: captured.executorId,
    operationId: captured.operationId,
    expectedExecutorRevision: captured.expectedExecutorRevision,
    expectedCatalogRevision: captured.expectedCatalogRevision,
    commandTicket: captured.commandTicket
  });
}

function captureReadinessCommand(value: unknown): Readonly<CodexReadinessCheckCommandInput> | null {
  const captured = captureExactObject(value, [
    "executorId", "operationId", "expectedExecutorRevision", "expectedCredentialRevision",
    "expectedCatalogRevision", "commandTicket"
  ]);
  if (!captured || !isOpaqueId(captured.executorId) || !isOpaqueId(captured.operationId) ||
      !isPositiveRevision(captured.expectedExecutorRevision) ||
      !isPositiveRevision(captured.expectedCredentialRevision) ||
      !isCatalogRevision(captured.expectedCatalogRevision) ||
      !isCompactTicket(captured.commandTicket)) return null;
  return Object.freeze({
    executorId: captured.executorId,
    operationId: captured.operationId,
    expectedExecutorRevision: captured.expectedExecutorRevision,
    expectedCredentialRevision: captured.expectedCredentialRevision,
    expectedCatalogRevision: captured.expectedCatalogRevision,
    commandTicket: captured.commandTicket
  });
}

function captureLogoutCommand(value: unknown): Readonly<CodexCredentialLogoutCommandInput> | null {
  const captured = captureExactObject(value, [
    "executorId", "revocationId", "operationId", "credentialRevision", "commandTicket"
  ]);
  if (!captured || !isOpaqueId(captured.executorId) || !isOpaqueId(captured.revocationId) ||
      !isOpaqueId(captured.operationId) || !isPositiveRevision(captured.credentialRevision) ||
      !isCompactTicket(captured.commandTicket)) return null;
  return Object.freeze({
    executorId: captured.executorId,
    revocationId: captured.revocationId,
    operationId: captured.operationId,
    credentialRevision: captured.credentialRevision,
    commandTicket: captured.commandTicket
  });
}

function validateRuntimeResult<T>(
  value: unknown,
  validateData: (data: unknown) => T | null
): DesktopCommandResult<T> | null {
  const captured = captureExactObject(value, ["ok", "data"]);
  if (!captured || captured.ok !== true) return null;
  const data = validateData(captured.data);
  return data === null ? null : Object.freeze({ ok: true, data });
}

function validateCapabilities(value: unknown): CodexAuthorizationCapabilities | null {
  const captured = captureExactObject(value, [
    "bridgeVersion", "supportsAppServerAuth", "supportsDeviceProof", "supportsSignedCatalog"
  ]);
  if (
    !captured ||
    captured.bridgeVersion !== 2 ||
    captured.supportsAppServerAuth !== true ||
    captured.supportsDeviceProof !== true ||
    captured.supportsSignedCatalog !== true
  ) {
    return null;
  }
  return Object.freeze({
    bridgeVersion: 2,
    supportsAppServerAuth: true,
    supportsDeviceProof: true,
    supportsSignedCatalog: true
  });
}

function validateSnapshot(value: unknown): CodexAuthorizationSnapshot | null {
  const captured = captureOptionalObject(
    value,
    ["sessionId", "executorId", "sequence", "status", "canReopen", "canCancel"],
    "localFailureCode"
  );
  if (!captured) return null;
  const hasFailure = Object.hasOwn(captured, "localFailureCode");
  const status = typeof captured.status === "string" ? captured.status : "";
  const canReopen = status === "waiting_user";
  const canCancel = status === "starting" || status === "waiting_user" || status === "verifying";
  const requiresFailure = status === "failed" || status === "interrupted";
  if (
    !isOpaqueId(captured.sessionId) ||
    !isOpaqueId(captured.executorId) ||
    !isPositiveRevision(captured.sequence) ||
    !AUTHORIZATION_STATUSES.has(status) ||
    captured.canReopen !== canReopen ||
    captured.canCancel !== canCancel ||
    requiresFailure !== hasFailure ||
    (hasFailure && (typeof captured.localFailureCode !== "string" ||
      !SAFE_CODE_PATTERN.test(captured.localFailureCode)))
  ) {
    return null;
  }
  const snapshot: CodexAuthorizationSnapshot = {
    sessionId: captured.sessionId,
    executorId: captured.executorId,
    sequence: captured.sequence,
    status: status as CodexAuthorizationSnapshot["status"],
    canReopen,
    canCancel
  };
  if (hasFailure) snapshot.localFailureCode = captured.localFailureCode as string;
  return Object.freeze(snapshot);
}

function validateVerificationResult(value: unknown): CodexCredentialVerificationResult | null {
  const captured = captureOptionalObject(value, [
    "executorId", "operationId", "credentialRevision", "accountFingerprint",
    "checkedAt", "authorized"
  ], "failureCode");
  if (!captured) return null;
  const hasFailure = Object.hasOwn(captured, "failureCode");
  if (
    !isOpaqueId(captured.executorId) ||
    !isOpaqueId(captured.operationId) ||
    !isPositiveRevision(captured.credentialRevision) ||
    typeof captured.accountFingerprint !== "string" ||
    !LOWER_HEX_256_PATTERN.test(captured.accountFingerprint) ||
    !isCanonicalTime(captured.checkedAt) ||
    typeof captured.authorized !== "boolean" ||
    (captured.authorized === hasFailure) ||
    (hasFailure && (typeof captured.failureCode !== "string" ||
      !SAFE_CODE_PATTERN.test(captured.failureCode)))
  ) {
    return null;
  }
  const result: CodexCredentialVerificationResult = {
    executorId: captured.executorId,
    operationId: captured.operationId,
    credentialRevision: captured.credentialRevision,
    accountFingerprint: captured.accountFingerprint,
    checkedAt: captured.checkedAt,
    authorized: captured.authorized
  };
  if (hasFailure) result.failureCode = captured.failureCode as string;
  return Object.freeze(result);
}

function validateReadinessResult(value: unknown): CodexReadinessCheckResult | null {
  const captured = captureOptionalObject(value, [
    "executorId", "operationId", "credentialRevision", "catalogRevision", "status", "observedAt"
  ], "reasonCode");
  if (!captured) return null;
  const hasReason = Object.hasOwn(captured, "reasonCode");
  if (
    !isOpaqueId(captured.executorId) ||
    !isOpaqueId(captured.operationId) ||
    !isPositiveRevision(captured.credentialRevision) ||
    !isCatalogRevision(captured.catalogRevision) ||
    typeof captured.status !== "string" ||
    !["ready", "degraded", "unavailable"].includes(captured.status) ||
    (captured.status === "ready") === hasReason ||
    (hasReason && (typeof captured.reasonCode !== "string" ||
      !READINESS_REASONS.has(captured.reasonCode))) ||
    !isCanonicalTime(captured.observedAt)
  ) {
    return null;
  }
  const result: CodexReadinessCheckResult = {
    executorId: captured.executorId,
    operationId: captured.operationId,
    credentialRevision: captured.credentialRevision,
    catalogRevision: captured.catalogRevision,
    status: captured.status as CodexReadinessCheckResult["status"],
    observedAt: captured.observedAt
  };
  if (hasReason) {
    result.reasonCode = captured.reasonCode as CodexReadinessCheckResult["reasonCode"];
  }
  return Object.freeze(result);
}

function validateCatalog(value: unknown): CodexModelCatalogSnapshot | null {
  const captured = captureExactObject(value, [
    "executorId", "credentialRevision", "catalogRevision", "models", "observedAt"
  ]);
  if (!captured) return null;
  const rawModels = captureDenseArray(captured.models, 512);
  if (
    !isOpaqueId(captured.executorId) ||
    !isPositiveRevision(captured.credentialRevision) ||
    !isCatalogRevision(captured.catalogRevision) ||
    rawModels === null ||
    !isCanonicalTime(captured.observedAt)
  ) {
    return null;
  }
  const models = rawModels.map(validateCatalogItem);
  if (models.some((item) => item === null)) return null;
  const modelKeys = models.map((item) => item!.modelKey);
  if (new Set(modelKeys).size !== modelKeys.length) return null;
  return Object.freeze({
    executorId: captured.executorId,
    credentialRevision: captured.credentialRevision,
    catalogRevision: captured.catalogRevision,
    models: Object.freeze(models) as unknown as CodexModelCatalogSnapshot["models"],
    observedAt: captured.observedAt
  });
}

function validateCatalogItem(value: unknown): CodexModelCatalogSnapshot["models"][number] | null {
  const captured = captureOptionalObject(value, [
    "modelKey", "displayName", "inputModalities", "supportedReasoningEfforts", "hidden", "status"
  ], "upgradeModelKey");
  if (!captured) return null;
  const hasUpgrade = Object.hasOwn(captured, "upgradeModelKey");
  const inputModalities = captureSafeStringArray(captured.inputModalities, 16, 64);
  const reasoningEfforts = captureSafeStringArray(
    captured.supportedReasoningEfforts,
    16,
    64
  );
  if (
    !isSafeText(captured.modelKey, 200) ||
    !isSafeText(captured.displayName, 240) ||
    inputModalities === null ||
    reasoningEfforts === null ||
    typeof captured.hidden !== "boolean" ||
    typeof captured.status !== "string" ||
    !SAFE_CODE_PATTERN.test(captured.status) ||
    (hasUpgrade && !isSafeText(captured.upgradeModelKey, 200))
  ) {
    return null;
  }
  const item: CodexModelCatalogSnapshot["models"][number] = {
    modelKey: captured.modelKey,
    displayName: captured.displayName,
    inputModalities: inputModalities as unknown as string[],
    supportedReasoningEfforts: reasoningEfforts as unknown as string[],
    hidden: captured.hidden,
    status: captured.status
  };
  if (hasUpgrade) item.upgradeModelKey = captured.upgradeModelKey as string;
  return Object.freeze(item);
}

function validateLogoutResult(value: unknown): CodexCredentialLogoutResult | null {
  const captured = captureOptionalObject(value, [
    "executorId", "operationId", "revocationId", "credentialRevision",
    "revocationEpoch", "result", "completedAt"
  ], "failureCode");
  if (!captured) return null;
  const hasFailure = Object.hasOwn(captured, "failureCode");
  if (
    !isOpaqueId(captured.executorId) ||
    !isOpaqueId(captured.operationId) ||
    !isOpaqueId(captured.revocationId) ||
    !isPositiveRevision(captured.credentialRevision) ||
    !isCatalogRevision(captured.revocationEpoch) ||
    typeof captured.result !== "string" ||
    !["succeeded", "failed", "stale_target"].includes(captured.result) ||
    (captured.result === "failed") !== hasFailure ||
    (hasFailure && (typeof captured.failureCode !== "string" ||
      !SAFE_CODE_PATTERN.test(captured.failureCode))) ||
    !isCanonicalTime(captured.completedAt)
  ) {
    return null;
  }
  const result: CodexCredentialLogoutResult = {
    executorId: captured.executorId,
    operationId: captured.operationId,
    revocationId: captured.revocationId,
    credentialRevision: captured.credentialRevision,
    revocationEpoch: captured.revocationEpoch,
    result: captured.result as CodexCredentialLogoutResult["result"],
    completedAt: captured.completedAt
  };
  if (hasFailure) result.failureCode = captured.failureCode as string;
  return Object.freeze(result);
}

function isCanonicalTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isSafeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function captureSafeStringArray(
  value: unknown,
  maximumItems: number,
  maximumText: number
): readonly string[] | null {
  const captured = captureDenseArray(value, maximumItems);
  if (captured === null || !captured.every((item) => isSafeText(item, maximumText))) {
    return null;
  }
  return captured as readonly string[];
}

/**
 * Creates the only Bridge v2 delegation surface. DTO validation always runs
 * before the gate, and the provider is not even consulted while `ready` is
 * false. Runtime exceptions are collapsed to one fixed, non-sensitive error.
 */
export function createCodexAuthorizationBridgeV2Handlers(
  options: CreateCodexAuthorizationBridgeV2HandlersOptions = {}
): CodexAuthorizationBridgeV2Handlers {
  const ready = options.ready ?? CODEX_DESKTOP_AUTHORIZATION_RUNTIME_READY;
  const provider = options.runtimeProvider ?? (() => options.runtime ?? null);

  async function delegate<T>(
    operation: (runtime: CodexAuthorizationBridgeV2Runtime) => Promise<DesktopCommandResult<T>>,
    validateData: (data: unknown) => T | null
  ): Promise<DesktopCommandResult<T>> {
    if (ready !== true) return unavailable();
    try {
      const runtime = provider();
      if (!runtime) return unavailable();
      return validateRuntimeResult(await operation(runtime), validateData) ?? runtimeFailed();
    } catch {
      return runtimeFailed();
    }
  }

  return {
    getCapabilities: () => delegate((runtime) => runtime.capabilities(), validateCapabilities),
    start: (input) => {
      const captured = captureStartInput(input);
      return captured
        ? delegate((runtime) => runtime.start(captured), validateSnapshot)
        : Promise.resolve(invalid());
    },
    getSnapshot: (input) =>
      isOpaqueId(input)
        ? delegate((runtime) => runtime.getSnapshot(input), validateSnapshot)
        : Promise.resolve(invalid()),
    cancel: (input) => {
      const captured = captureSessionCommand(input);
      return captured
        ? delegate((runtime) => runtime.cancel(captured), validateSnapshot)
        : Promise.resolve(invalid());
    },
    reopen: (input) => {
      const captured = captureSessionCommand(input);
      return captured
        ? delegate((runtime) => runtime.reopen(captured), validateSnapshot)
        : Promise.resolve(invalid());
    },
    verify: (input) => {
      const captured = captureVerifyCommand(input);
      return captured
        ? delegate((runtime) => runtime.verify(captured), validateVerificationResult)
        : Promise.resolve(invalid());
    },
    readiness: (input) => {
      const captured = captureReadinessCommand(input);
      return captured
        ? delegate((runtime) => runtime.readiness(captured), validateReadinessResult)
        : Promise.resolve(invalid());
    },
    getCatalog: (input) =>
      isOpaqueId(input)
        ? delegate((runtime) => runtime.getCatalog(input), validateCatalog)
        : Promise.resolve(invalid()),
    refresh: (input) => {
      const captured = captureCatalogRefreshCommand(input);
      return captured
        ? delegate((runtime) => runtime.refresh(captured), validateCatalog)
        : Promise.resolve(invalid());
    },
    logout: (input) => {
      const captured = captureLogoutCommand(input);
      return captured
        ? delegate((runtime) => runtime.logout(captured), validateLogoutResult)
        : Promise.resolve(invalid());
    }
  };
}

export function queryCodexAuthorizationCapabilities(
  args: readonly unknown[]
): DesktopCommandResult<CodexAuthorizationCapabilities> {
  return args.length === 0 ? unavailable() : invalid();
}

export function startCodexAuthorization(input: unknown): DesktopCommandResult<CodexAuthorizationSnapshot> {
  return captureStartInput(input) ? unavailable() : invalid();
}

export function queryCodexAuthorizationSnapshot(input: unknown): DesktopCommandResult<CodexAuthorizationSnapshot> {
  return isOpaqueId(input) ? unavailable() : invalid();
}

export function cancelCodexAuthorization(input: unknown): DesktopCommandResult<CodexAuthorizationSnapshot> {
  return captureSessionCommand(input) ? unavailable() : invalid();
}

export function reopenCodexAuthorization(input: unknown): DesktopCommandResult<CodexAuthorizationSnapshot> {
  return captureSessionCommand(input) ? unavailable() : invalid();
}

export function verifyCodexAuthorization(input: unknown): DesktopCommandResult<CodexCredentialVerificationResult> {
  return captureVerifyCommand(input) ? unavailable() : invalid();
}

export function checkCodexAuthorizationReadiness(input: unknown): DesktopCommandResult<CodexReadinessCheckResult> {
  return captureReadinessCommand(input) ? unavailable() : invalid();
}

export function queryCodexModelCatalog(input: unknown): DesktopCommandResult<CodexModelCatalogSnapshot> {
  return isOpaqueId(input) ? unavailable() : invalid();
}

export function refreshCodexModelCatalog(input: unknown): DesktopCommandResult<CodexModelCatalogSnapshot> {
  return captureCatalogRefreshCommand(input) ? unavailable() : invalid();
}

export function logoutCodexCredential(input: unknown): DesktopCommandResult<CodexCredentialLogoutResult> {
  return captureLogoutCommand(input) ? unavailable() : invalid();
}
