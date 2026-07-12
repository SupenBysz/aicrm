import type { RequestClient } from "@ky/admin-core";
import type {
  AccountCapabilityExecutionInput,
  AccountCapabilityExecutionView,
  AccountOnboardingEvent,
  AccountOnboardingEventsView,
  AccountOnboardingView,
  CancelAccountOnboardingInput,
  ConfirmAccountBindingInput,
  RefreshLoginQrCodeInput,
  RetryAccountOnboardingStepInput,
  StartAccountOnboardingInput,
  SubmitAccountOnboardingStepResultInput
} from "./types";

const loginAttemptsBase = "/api/v1/matrix-account-login-attempts";
const trustedRuntimeOnlySuccessMethods = new Set(["session.snapshot.seal.v1", "web_space.cleanup.v1"]);

export type AccountOnboardingTransport = AccountOnboardingView & {
  workspaceType?: string;
  workspaceId?: string;
  memberId?: string;
  deviceId?: string;
  webSpaceId?: string;
  blockedMethod?: string;
  snapshotId?: string;
  repairTaskId?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
};

export type AccountOnboardingEventTransport = AccountOnboardingEvent & {
  createdAt?: string;
};

export type AccountOnboardingEventsTransport = Omit<AccountOnboardingEventsView, "attempt" | "events"> & {
  attempt: AccountOnboardingTransport;
  events: AccountOnboardingEventTransport[];
};

type AccountOnboardingWrappedResponse =
  | AccountOnboardingTransport
  | { attempt: AccountOnboardingTransport; command?: unknown; run?: unknown; event?: unknown };

function attemptPath(attemptId: string, suffix = ""): string {
  return `${loginAttemptsBase}/${encodeURIComponent(attemptId)}${suffix}`;
}

export function startAccountOnboardingRequest(
  client: RequestClient,
  input: StartAccountOnboardingInput
): Promise<AccountOnboardingTransport> {
  return client.request<AccountOnboardingWrappedResponse>(loginAttemptsBase, {
    method: "POST",
    body: input
  }).then(unwrapAttempt);
}

export function getAccountOnboardingRequest(
  client: RequestClient,
  attemptId: string
): Promise<AccountOnboardingTransport> {
  return client.request<AccountOnboardingWrappedResponse>(attemptPath(attemptId)).then(unwrapAttempt);
}

export function listAccountOnboardingEventsRequest(
  client: RequestClient,
  attemptId: string,
  afterSequence = 0
): Promise<AccountOnboardingEventsTransport> {
  const query = new URLSearchParams({ afterSequence: String(Math.max(0, afterSequence)) });
  return client.request<AccountOnboardingEventsTransport>(attemptPath(attemptId, `/events?${query.toString()}`));
}

function submitAccountOnboardingCommand<TBody extends object>(
  client: RequestClient,
  attemptId: string,
  command: "refresh-qr" | "retry" | "cancel",
  body: TBody
): Promise<AccountOnboardingTransport> {
  return client.request<AccountOnboardingWrappedResponse>(attemptPath(attemptId, `/commands/${command}`), {
    method: "POST",
    body
  }).then(unwrapAttempt);
}

export function refreshAccountOnboardingQrRequest(
  client: RequestClient,
  input: RefreshLoginQrCodeInput
): Promise<AccountOnboardingView> {
  return submitAccountOnboardingCommand(client, input.attemptId, "refresh-qr", {
    commandId: input.commandId,
    expectedRevision: input.expectedRevision
  });
}

export function retryAccountOnboardingStepRequest(
  client: RequestClient,
  input: RetryAccountOnboardingStepInput
): Promise<AccountOnboardingView> {
  return submitAccountOnboardingCommand(client, input.attemptId, "retry", {
    commandId: input.commandId,
    expectedSequence: input.expectedSequence
  });
}

export function cancelAccountOnboardingRequest(
  client: RequestClient,
  input: CancelAccountOnboardingInput
): Promise<AccountOnboardingView> {
  return submitAccountOnboardingCommand(client, input.attemptId, "cancel", {
    commandId: input.commandId,
    reason: input.reason
  });
}

export function submitAccountOnboardingStepResultRequest(
  client: RequestClient,
  attemptId: string,
  input: SubmitAccountOnboardingStepResultInput
): Promise<AccountOnboardingTransport> {
  assertRendererStepResultAllowed(input);
  return client.request<AccountOnboardingWrappedResponse>(attemptPath(attemptId, "/step-results"), {
    method: "POST",
    body: rendererStepResultBody(input)
  }).then(unwrapAttempt);
}

/**
 * Binding confirmation is a business step, not a direct account upsert. The
 * backend must advance to snapshot_sealing; completion happens only after a
 * trusted runtime reports a verified snapshot.
 */
export function confirmAccountBindingRequest(
  client: RequestClient,
  input: ConfirmAccountBindingInput
): Promise<AccountOnboardingView> {
  const { attemptId, commandId, ...bindingInput } = input;
  return submitAccountOnboardingStepResultRequest(client, attemptId, {
    operationId: commandId,
    methodKey: "business.binding.confirm.v1",
    status: "success",
    observedPhase: "awaiting_confirmation",
    resultSummary: { bindingInput }
  });
}

export function executeAccountCapabilityRequest<TInput, TData>(
  client: RequestClient,
  input: AccountCapabilityExecutionInput<TInput>
): Promise<AccountCapabilityExecutionView<TData>> {
  const { accountId, ...body } = input;
  return client.request<AccountCapabilityExecutionView<TData>>(
    `/api/v1/matrix-accounts/${encodeURIComponent(accountId)}/capability-executions`,
    { method: "POST", body }
  );
}

function unwrapAttempt(value: AccountOnboardingWrappedResponse): AccountOnboardingTransport {
  return "attempt" in value ? value.attempt : value;
}

function assertRendererStepResultAllowed(input: SubmitAccountOnboardingStepResultInput): void {
  if (input.methodKey === "business.onboarding.complete.v1") {
    throw new Error("trusted_runtime_step_required");
  }
  if (input.status === "success" && trustedRuntimeOnlySuccessMethods.has(input.methodKey)) {
    throw new Error("trusted_runtime_step_required");
  }
}

function rendererStepResultBody(input: SubmitAccountOnboardingStepResultInput): SubmitAccountOnboardingStepResultInput {
  return {
    operationId: input.operationId,
    methodKey: input.methodKey,
    status: input.status,
    observedPhase: input.observedPhase,
    resultSummary: sanitizeRendererSummary(input.resultSummary),
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    durationMs: input.durationMs
  };
}

function sanitizeRendererSummary(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return sanitizeRendererValue(value, 0) as Record<string, unknown>;
}

function sanitizeRendererValue(value: unknown, depth: number): unknown {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeRendererValue(entry, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(?:proof|receipt)/i.test(key))
      .map(([key, entry]) => [key, sanitizeRendererValue(entry, depth + 1)])
      .filter(([, entry]) => entry !== undefined)
  );
}
