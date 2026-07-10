import type { RequestClient } from "@ky/admin-core";
import type {
  AccountCapabilityExecutionInput,
  AccountCapabilityExecutionView,
  AccountOnboardingEvent,
  AccountOnboardingEventsView,
  AccountOnboardingView,
  CancelAccountOnboardingInput,
  CompleteAccountOnboardingInput,
  ConfirmAccountBindingInput,
  RefreshLoginQrCodeInput,
  RetryAccountOnboardingStepInput,
  StartAccountOnboardingInput,
  SubmitAccountOnboardingStepResultInput
} from "./types";

const loginAttemptsBase = "/api/v1/matrix-account-login-attempts";

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
  return client.request<AccountOnboardingWrappedResponse>(attemptPath(attemptId, "/step-results"), {
    method: "POST",
    body: input
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

/** Complete is accepted only after the trusted runtime sealed and verified the snapshot. */
export function completeAccountOnboardingRequest(
  client: RequestClient,
  input: CompleteAccountOnboardingInput
): Promise<AccountOnboardingView> {
  return submitAccountOnboardingStepResultRequest(client, input.attemptId, {
    operationId: input.operationId,
    methodKey: "business.onboarding.complete.v1",
    status: "success",
    observedPhase: "ready",
    resultSummary: {
      snapshotId: input.snapshotId,
      snapshotVerified: true,
      bindingDecision: input.bindingDecision,
      businessAssignment: input.businessAssignment
    },
    verificationReceipt: input.snapshotVerificationReceipt
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
