import { IPC_CHANNELS } from "../../shared/constants.ts";
import type {
  AiExecutorBindDeviceInput,
  AiExecutorBindDeviceResult,
  DesktopCommandResult
} from "../../shared/types.ts";
import type { DesktopExecutorDeviceBindingClient } from "../desktop-executor-device-binding-client.ts";

const EXECUTOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const DEVICE_ID_PATTERN = /^[0-9a-f]{64}$/;
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SAFE_BINDING_ERROR_CODES = new Set([
  "desktop_executor_device_binding_cancelled",
  "desktop_executor_device_binding_contract_invalid",
  "desktop_executor_device_binding_recovery_conflict",
  "desktop_executor_device_binding_rejected",
  "desktop_executor_device_binding_response_invalid",
  "desktop_executor_device_binding_transport_failed",
  "desktop_device_not_registered",
  "desktop_device_request_journal_conflict",
  "desktop_device_request_journal_corrupt",
  "desktop_device_request_journal_not_completed",
  "desktop_device_request_journal_unsafe",
  "desktop_device_request_lane_pinned",
  "desktop_host_api_untrusted",
  "desktop_host_session_expired",
  "desktop_host_session_unavailable",
  "desktop_secure_storage_unavailable"
]);
const SAFE_BINDING_SERVER_CODES = new Set([
  "authorization_proof_invalid",
  "device_binding_active",
  "device_binding_conflict",
  "device_binding_replay_mismatch",
  "device_binding_unavailable",
  "permission_denied",
  "workspace_forbidden"
]);

interface BindingClient
  extends Pick<DesktopExecutorDeviceBindingClient, "bindExecutorDevice"> {}

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ): unknown;
}

export function registerDesktopExecutorDeviceBindingIpc(
  client: BindingClient,
  registrar: IpcMainLike
): void {
  registrar.handle(
    IPC_CHANNELS.aiExecutorBindDevice,
    createDesktopExecutorDeviceBindingHandler(client)
  );
}

export function createDesktopExecutorDeviceBindingHandler(client: BindingClient) {
  return async (
    _event: unknown,
    ...args: unknown[]
  ): Promise<DesktopCommandResult<AiExecutorBindDeviceResult>> => {
    if (args.length !== 1 || !validInput(args[0])) {
      return failure("validation_error", "执行器设备绑定参数无效");
    }
    const input: AiExecutorBindDeviceInput = {
      executorId: args[0].executorId,
      expectedRevision: args[0].expectedRevision
    };
    try {
      const result = await client.bindExecutorDevice(input);
      const projected = safeResult(result.data, input);
      if (!projected) {
        return failure(
          "desktop_executor_device_binding_response_invalid",
          "执行器设备绑定响应无效"
        );
      }
      return { ok: true, data: projected };
    } catch (error) {
      return safeFailure(error);
    }
  };
}

function validInput(value: unknown): value is AiExecutorBindDeviceInput {
  if (!exactObject(value, ["executorId", "expectedRevision"])) return false;
  return (
    typeof value.executorId === "string" &&
    EXECUTOR_ID_PATTERN.test(value.executorId) &&
    Number.isSafeInteger(value.expectedRevision) &&
    (value.expectedRevision as number) >= 0 &&
    (value.expectedRevision as number) < Number.MAX_SAFE_INTEGER
  );
}

function safeResult(
  value: unknown,
  input: AiExecutorBindDeviceInput
): AiExecutorBindDeviceResult | null {
  if (!exactObject(value, ["binding", "replayed"])) return null;
  if (
    typeof value.replayed !== "boolean" ||
    !exactObject(value.binding, [
      "executorId",
      "deviceId",
      "status",
      "revision",
      "force",
      "updatedAt"
    ])
  ) {
    return null;
  }
  const binding = value.binding;
  if (
    binding.executorId !== input.executorId ||
    typeof binding.deviceId !== "string" ||
    !DEVICE_ID_PATTERN.test(binding.deviceId) ||
    binding.status !== "active" ||
    binding.revision !== input.expectedRevision + 1 ||
    binding.force !== false ||
    !canonicalServerTime(binding.updatedAt)
  ) {
    return null;
  }
  return {
    binding: {
      executorId: input.executorId,
      deviceId: binding.deviceId,
      status: "active",
      revision: binding.revision,
      force: false,
      updatedAt: binding.updatedAt
    },
    replayed: value.replayed
  };
}

function safeFailure<T>(error: unknown): DesktopCommandResult<T> {
  const serverCode = ownDataProperty(error, "serverCode");
  if (serverCode.present && !serverCode.data) {
    return failure(
      "desktop_executor_device_binding_failed",
      "执行器设备绑定失败"
    );
  }
  if (serverCode.present && serverCode.value !== null && serverCode.value !== undefined) {
    if (
      typeof serverCode.value === "string" &&
      SAFE_BINDING_SERVER_CODES.has(serverCode.value)
    ) {
      return failure(serverCode.value, "执行器设备绑定失败");
    }
    return failure(
      "desktop_executor_device_binding_failed",
      "执行器设备绑定失败"
    );
  }
  const rawCode = ownDataProperty(error, "code").value;
  const candidate = typeof rawCode === "string" ? rawCode : "";
  const code = SAFE_BINDING_ERROR_CODES.has(candidate)
    ? candidate
    : "desktop_executor_device_binding_failed";
  return failure(code, "执行器设备绑定失败");
}

function ownDataProperty(
  value: unknown,
  key: string
): { present: boolean; data: boolean; value: unknown } {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return { present: false, data: false, value: undefined };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { present: false, data: false, value: undefined };
    if (!("value" in descriptor)) {
      return { present: true, data: false, value: undefined };
    }
    return { present: true, data: true, value: descriptor.value };
  } catch {
    return { present: true, data: false, value: undefined };
  }
}

function failure<T>(code: string, message: string): DesktopCommandResult<T> {
  return { ok: false, error: { code, message } };
}

function canonicalServerTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    RFC3339_UTC_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
