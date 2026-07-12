import type {
  CodexAuthorizationCapabilities,
  CodexAuthorizationSnapshot,
  CodexAuthorizationStartInput,
  CodexCredentialLogoutCommandInput,
  CodexModelCatalogRefreshCommandInput,
  CodexModelCatalogSnapshot,
  CodexReadinessCheckCommandInput,
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

type JsonRecord = Record<string, unknown>;

export interface CodexAuthorizationBridgeV2Runtime {
  capabilities(): Promise<DesktopCommandResult<CodexAuthorizationCapabilities>>;
  start(input: CodexAuthorizationStartInput): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  getSnapshot(sessionId: string): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  cancel(input: CodexSessionCommandInput): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  reopen(input: CodexSessionCommandInput): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  verify(input: CodexVerifyCommandInput): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  readiness(input: CodexReadinessCheckCommandInput): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  getCatalog(executorId: string): Promise<DesktopCommandResult<CodexModelCatalogSnapshot>>;
  refresh(input: CodexModelCatalogRefreshCommandInput): Promise<DesktopCommandResult<CodexModelCatalogSnapshot>>;
  logout(input: CodexCredentialLogoutCommandInput): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
}

export type CodexAuthorizationBridgeV2RuntimeProvider =
  () => CodexAuthorizationBridgeV2Runtime | null;

export interface CodexAuthorizationBridgeV2Handlers {
  getCapabilities(): Promise<DesktopCommandResult<CodexAuthorizationCapabilities>>;
  start(input: unknown): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  getSnapshot(input: unknown): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  cancel(input: unknown): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  reopen(input: unknown): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  verify(input: unknown): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  readiness(input: unknown): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  getCatalog(input: unknown): Promise<DesktopCommandResult<CodexModelCatalogSnapshot>>;
  refresh(input: unknown): Promise<DesktopCommandResult<CodexModelCatalogSnapshot>>;
  logout(input: unknown): Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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

function isStartInput(value: unknown): value is CodexAuthorizationStartInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "sessionId",
      "executorId",
      "sessionRevision",
      "handoffId",
      "handoffTicket"
    ])
  ) {
    return false;
  }
  return (
    isOpaqueId(value.sessionId) &&
    isOpaqueId(value.executorId) &&
    isPositiveRevision(value.sessionRevision) &&
    isOpaqueId(value.handoffId) &&
    isCompactTicket(value.handoffTicket)
  );
}

function isSessionCommand(value: unknown): value is CodexSessionCommandInput {
  if (!isRecord(value) || !hasExactKeys(value, ["sessionId", "operationId", "expectedSessionRevision", "commandTicket"])) {
    return false;
  }
  return (
    isOpaqueId(value.sessionId) &&
    isOpaqueId(value.operationId) &&
    isPositiveRevision(value.expectedSessionRevision) &&
    isCompactTicket(value.commandTicket)
  );
}

function isVerifyCommand(value: unknown): value is CodexVerifyCommandInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "executorId",
      "operationId",
      "expectedExecutorRevision",
      "expectedCredentialRevision",
      "commandTicket"
    ])
  ) {
    return false;
  }
  return (
    isOpaqueId(value.executorId) &&
    isOpaqueId(value.operationId) &&
    isPositiveRevision(value.expectedExecutorRevision) &&
    isPositiveRevision(value.expectedCredentialRevision) &&
    isCompactTicket(value.commandTicket)
  );
}

function isCatalogRefreshCommand(value: unknown): value is CodexModelCatalogRefreshCommandInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "executorId",
      "operationId",
      "expectedExecutorRevision",
      "expectedCatalogRevision",
      "commandTicket"
    ])
  ) {
    return false;
  }
  return (
    isOpaqueId(value.executorId) &&
    isOpaqueId(value.operationId) &&
    isPositiveRevision(value.expectedExecutorRevision) &&
    isCatalogRevision(value.expectedCatalogRevision) &&
    isCompactTicket(value.commandTicket)
  );
}

function isReadinessCommand(value: unknown): value is CodexReadinessCheckCommandInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "executorId",
      "operationId",
      "expectedExecutorRevision",
      "expectedCredentialRevision",
      "expectedCatalogRevision",
      "commandTicket"
    ])
  ) {
    return false;
  }
  return (
    isOpaqueId(value.executorId) &&
    isOpaqueId(value.operationId) &&
    isPositiveRevision(value.expectedExecutorRevision) &&
    isPositiveRevision(value.expectedCredentialRevision) &&
    isCatalogRevision(value.expectedCatalogRevision) &&
    isCompactTicket(value.commandTicket)
  );
}

function isLogoutCommand(value: unknown): value is CodexCredentialLogoutCommandInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["executorId", "revocationId", "operationId", "credentialRevision", "commandTicket"])
  ) {
    return false;
  }
  return (
    isOpaqueId(value.executorId) &&
    isOpaqueId(value.revocationId) &&
    isOpaqueId(value.operationId) &&
    isPositiveRevision(value.credentialRevision) &&
    isCompactTicket(value.commandTicket)
  );
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
    operation: (runtime: CodexAuthorizationBridgeV2Runtime) => Promise<DesktopCommandResult<T>>
  ): Promise<DesktopCommandResult<T>> {
    if (ready !== true) return unavailable();
    try {
      const runtime = provider();
      if (!runtime) return unavailable();
      return await operation(runtime);
    } catch {
      return runtimeFailed();
    }
  }

  return {
    getCapabilities: () => delegate((runtime) => runtime.capabilities()),
    start: (input) =>
      isStartInput(input) ? delegate((runtime) => runtime.start(input)) : Promise.resolve(invalid()),
    getSnapshot: (input) =>
      isOpaqueId(input) ? delegate((runtime) => runtime.getSnapshot(input)) : Promise.resolve(invalid()),
    cancel: (input) =>
      isSessionCommand(input) ? delegate((runtime) => runtime.cancel(input)) : Promise.resolve(invalid()),
    reopen: (input) =>
      isSessionCommand(input) ? delegate((runtime) => runtime.reopen(input)) : Promise.resolve(invalid()),
    verify: (input) =>
      isVerifyCommand(input) ? delegate((runtime) => runtime.verify(input)) : Promise.resolve(invalid()),
    readiness: (input) =>
      isReadinessCommand(input) ? delegate((runtime) => runtime.readiness(input)) : Promise.resolve(invalid()),
    getCatalog: (input) =>
      isOpaqueId(input) ? delegate((runtime) => runtime.getCatalog(input)) : Promise.resolve(invalid()),
    refresh: (input) =>
      isCatalogRefreshCommand(input) ? delegate((runtime) => runtime.refresh(input)) : Promise.resolve(invalid()),
    logout: (input) =>
      isLogoutCommand(input) ? delegate((runtime) => runtime.logout(input)) : Promise.resolve(invalid())
  };
}

export function queryCodexAuthorizationCapabilities(
  args: readonly unknown[]
): DesktopCommandResult<CodexAuthorizationCapabilities> {
  return args.length === 0 ? unavailable() : invalid();
}

export function startCodexAuthorization(input: unknown): DesktopCommandResult<CodexAuthorizationSnapshot> {
  return isStartInput(input) ? unavailable() : invalid();
}

export function queryCodexAuthorizationSnapshot(input: unknown): DesktopCommandResult<CodexAuthorizationSnapshot> {
  return isOpaqueId(input) ? unavailable() : invalid();
}

export function cancelCodexAuthorization(input: unknown): DesktopCommandResult<CodexAuthorizationSnapshot> {
  return isSessionCommand(input) ? unavailable() : invalid();
}

export function reopenCodexAuthorization(input: unknown): DesktopCommandResult<CodexAuthorizationSnapshot> {
  return isSessionCommand(input) ? unavailable() : invalid();
}

export function verifyCodexAuthorization(input: unknown): DesktopCommandResult<CodexAuthorizationSnapshot> {
  return isVerifyCommand(input) ? unavailable() : invalid();
}

export function checkCodexAuthorizationReadiness(input: unknown): DesktopCommandResult<CodexAuthorizationSnapshot> {
  return isReadinessCommand(input) ? unavailable() : invalid();
}

export function queryCodexModelCatalog(input: unknown): DesktopCommandResult<CodexModelCatalogSnapshot> {
  return isOpaqueId(input) ? unavailable() : invalid();
}

export function refreshCodexModelCatalog(input: unknown): DesktopCommandResult<CodexModelCatalogSnapshot> {
  return isCatalogRefreshCommand(input) ? unavailable() : invalid();
}

export function logoutCodexCredential(input: unknown): DesktopCommandResult<CodexAuthorizationSnapshot> {
  return isLogoutCommand(input) ? unavailable() : invalid();
}
