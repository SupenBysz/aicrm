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

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

type JsonRecord = Record<string, unknown>;

function failure<T>(error: typeof CODEX_AUTHORIZATION_RUNTIME_UNAVAILABLE_ERROR | typeof CODEX_AUTHORIZATION_INPUT_INVALID_ERROR): DesktopCommandResult<T> {
  return { ok: false, error: { ...error } };
}

function unavailable<T>(): DesktopCommandResult<T> {
  return failure<T>(CODEX_AUTHORIZATION_RUNTIME_UNAVAILABLE_ERROR);
}

function invalid<T>(): DesktopCommandResult<T> {
  return failure<T>(CODEX_AUTHORIZATION_INPUT_INVALID_ERROR);
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
  if (!isRecord(value) || !hasExactKeys(value, ["sessionId", "executorId", "handoffId", "handoffTicket"])) return false;
  return isOpaqueId(value.sessionId) && isOpaqueId(value.executorId) && isOpaqueId(value.handoffId) && isCompactTicket(value.handoffTicket);
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
