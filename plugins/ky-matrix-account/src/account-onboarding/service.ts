import {
  cancelMatrixAccountOnboarding,
  getMatrixAccountLoginQrCode,
  hasMatrixAccountOnboardingDesktopCapability,
  refreshMatrixAccountLoginQrCode,
  sealMatrixAccountSessionSnapshot,
  startMatrixAccountOnboarding,
  subscribeMatrixAccountOnboarding,
  type DesktopCommandResult,
  type MatrixAccountOnboardingCancelInput as DesktopCancelInput,
  type MatrixAccountOnboardingEvent as DesktopOnboardingEvent,
  type MatrixAccountOnboardingQrCodeView as DesktopQrCodeView,
  type MatrixAccountOnboardingRefreshQrInput as DesktopRefreshQrInput,
  type MatrixAccountOnboardingStartInput as DesktopStartInput,
  type MatrixAccountOnboardingView as DesktopOnboardingView,
  type MatrixAccountSessionSnapshotSealInput as DesktopSnapshotSealInput,
  type MatrixAccountSessionSnapshotVerificationResult as DesktopSnapshotVerification,
  type MatrixAccountPlatform,
  type MatrixAccountWorkspaceType,
  type RequestClient
} from "@ky/admin-core";
import {
  cancelAccountOnboardingRequest,
  completeAccountOnboardingRequest,
  confirmAccountBindingRequest,
  executeAccountCapabilityRequest,
  getAccountOnboardingRequest,
  listAccountOnboardingEventsRequest,
  refreshAccountOnboardingQrRequest,
  retryAccountOnboardingStepRequest,
  startAccountOnboardingRequest,
  submitAccountOnboardingStepResultRequest,
  type AccountOnboardingEventsTransport,
  type AccountOnboardingEventTransport,
  type AccountOnboardingTransport
} from "./api";
import type {
  AccountBindingDecision,
  AccountCapabilityExecutionInput,
  AccountCapabilityExecutionView,
  AccountOnboardingCandidate,
  AccountOnboardingError,
  AccountOnboardingEvent,
  AccountOnboardingEventData,
  AccountOnboardingEventListener,
  AccountOnboardingEventsView,
  AccountOnboardingNextAction,
  AccountOnboardingSubscription,
  AccountOnboardingSubscriptionOptions,
  AccountOnboardingView,
  AccountLoginObservedPhase,
  CancelAccountOnboardingInput,
  CompleteAccountOnboardingInput,
  ConfirmAccountBindingInput,
  LoginQrCodeView,
  MatrixAccountReadyView,
  RefreshLoginQrCodeInput,
  RetryAccountOnboardingStepInput,
  StartAccountOnboardingInput,
  SubmitAccountOnboardingStepResultInput
} from "./types";

export interface AccountOnboardingRuntimePort {
  isAvailable(): boolean;
  start(input: DesktopStartInput): Promise<DesktopCommandResult<DesktopOnboardingView>>;
  getLoginQrCode(attemptId: string, revision?: number): Promise<DesktopCommandResult<DesktopQrCodeView>>;
  refreshLoginQrCode(input: DesktopRefreshQrInput): Promise<DesktopCommandResult<DesktopQrCodeView>>;
  cancel(input: DesktopCancelInput): Promise<DesktopCommandResult<DesktopOnboardingView>>;
  sealSessionSnapshot(
    input: DesktopSnapshotSealInput
  ): Promise<DesktopCommandResult<DesktopSnapshotVerification>>;
  subscribe(attemptId: string, afterSequence: number, listener: (event: DesktopOnboardingEvent) => void): () => void;
}

export interface MatrixAccountAutomationService {
  startAccountOnboarding(input: StartAccountOnboardingInput): Promise<AccountOnboardingView>;
  getAccountOnboarding(attemptId: string): Promise<AccountOnboardingView>;
  getLoginQrCode(attemptId: string, revision?: number): Promise<LoginQrCodeView>;
  listAccountOnboardingEvents(attemptId: string, afterSequence?: number): Promise<AccountOnboardingEventsView>;
  refreshLoginQrCode(input: RefreshLoginQrCodeInput): Promise<AccountOnboardingView>;
  retryAccountOnboardingStep(input: RetryAccountOnboardingStepInput): Promise<AccountOnboardingView>;
  confirmAccountBinding(input: ConfirmAccountBindingInput): Promise<AccountOnboardingView>;
  cancelAccountOnboarding(input: CancelAccountOnboardingInput): Promise<AccountOnboardingView>;
  submitStepResult(attemptId: string, input: SubmitAccountOnboardingStepResultInput): Promise<AccountOnboardingView>;
  /** Called by the trusted runtime only, with a snapshot verification receipt. */
  completeAccountOnboarding(input: CompleteAccountOnboardingInput): Promise<AccountOnboardingView>;
  subscribeAccountOnboarding(
    attemptId: string,
    listener: AccountOnboardingEventListener,
    options?: AccountOnboardingSubscriptionOptions
  ): AccountOnboardingSubscription;
  executeAccountCapability<TInput, TData>(
    input: AccountCapabilityExecutionInput<TInput>
  ): Promise<AccountCapabilityExecutionView<TData>>;
}

export interface MatrixAccountAutomationServiceOptions {
  runtime?: AccountOnboardingRuntimePort;
  pollIntervalMs?: number;
}

export function createMatrixAccountAutomationService(
  client: RequestClient,
  options: MatrixAccountAutomationServiceOptions = {}
): MatrixAccountAutomationService {
  const runtime = options.runtime ?? desktopAccountOnboardingRuntime;
  const defaultPollIntervalMs = clampPollInterval(options.pollIntervalMs ?? 1_500);

  return {
    async startAccountOnboarding(input) {
      assertRuntimeAvailable(runtime);
      const attempt = await startAccountOnboardingRequest(client, input);
      const desktop = await runtime.start(runtimeStartInput(attempt, input));
      const desktopView = requireDesktopData(desktop);
      const reconciled = await reconcileDesktopStart(client, attempt, desktopView);
      return sanitizeOnboardingView(reconciled);
    },

    async getAccountOnboarding(attemptId) {
      return sanitizeOnboardingView(await getAccountOnboardingRequest(client, attemptId));
    },

    async getLoginQrCode(attemptId, revision) {
      assertRuntimeAvailable(runtime);
      return sanitizeDesktopQrCode(requireDesktopData(await runtime.getLoginQrCode(attemptId, revision)));
    },

    async listAccountOnboardingEvents(attemptId, afterSequence = 0) {
      const response = await listAccountOnboardingEventsRequest(client, attemptId, afterSequence);
      return sanitizeEventsView(response);
    },

    async refreshLoginQrCode(input) {
      assertRuntimeAvailable(runtime);
      const commanded = await refreshAccountOnboardingQrRequest(client, input);
      if (commanded.currentStep !== "login.qr.refresh.v1") return sanitizeOnboardingView(commanded);

      const desktop = await runtime.refreshLoginQrCode({
        attemptId: input.attemptId,
        operationId: input.commandId,
        expectedQrRevision: input.expectedRevision
      });
      const reconciled = await reconcileDesktopRefresh(client, commanded, input.commandId, desktop);
      return sanitizeOnboardingView(reconciled);
    },

    async retryAccountOnboardingStep(input) {
      return sanitizeOnboardingView(await retryAccountOnboardingStepRequest(client, input));
    },

    async confirmAccountBinding(input) {
      assertRuntimeAvailable(runtime);
      let attempt = await confirmAccountBindingRequest(client, input);
      if (attempt.status !== "active" || attempt.currentStep !== "session.snapshot.seal.v1") {
        return sanitizeOnboardingView(attempt);
      }

      const sealOperationId = operationId(input.commandId, "snapshot-seal");
      const sealed = await runtime.sealSessionSnapshot({
        attemptId: input.attemptId,
        operationId: sealOperationId
      });
      if (!sealed.ok || !sealed.data) {
        attempt = await submitAccountOnboardingStepResultRequest(client, input.attemptId, {
          operationId: sealOperationId,
          methodKey: "session.snapshot.seal.v1",
          status: "failed",
          errorCode: sealed.error?.code || "SESSION_SNAPSHOT_SEAL_FAILED",
          resultSummary: {}
        });
        return sanitizeOnboardingView(attempt);
      }

      const snapshot = sealed.data;
      attempt = await submitAccountOnboardingStepResultRequest(client, input.attemptId, {
        operationId: sealOperationId,
        methodKey: "session.snapshot.seal.v1",
        status: "success",
        resultSummary: {
          snapshotId: snapshot.snapshotId,
          fingerprintHash: snapshot.fingerprintHash,
          contentHash: snapshot.contentHash,
          verified: snapshot.status === "verified",
          size: snapshot.sizeBytes,
          sourceBytes: snapshot.sourceBytes,
          fileCount: snapshot.fileCount,
          schemaVersion: snapshot.schemaVersion
        },
        verificationReceipt: snapshot.verificationReceipt
      });
      if (attempt.status !== "active" || attempt.currentStep !== "business.onboarding.complete.v1") {
        return sanitizeOnboardingView(attempt);
      }

      return sanitizeOnboardingView(
        await completeAccountOnboardingRequest(client, {
          attemptId: input.attemptId,
          operationId: operationId(input.commandId, "complete"),
          snapshotId: snapshot.snapshotId,
          snapshotVerificationReceipt: snapshot.verificationReceipt,
          bindingDecision: input.decision,
          businessAssignment: {
            accountId: input.accountId,
            ownerMemberId: input.ownerMemberId,
            departmentId: input.departmentId,
            teamId: input.teamId,
            remark: input.remark
          }
        })
      );
    },

    async cancelAccountOnboarding(input) {
      assertRuntimeAvailable(runtime);
      const commanded = await cancelAccountOnboardingRequest(client, input);
      if (commanded.status !== "active" || commanded.currentStep !== "web_space.cleanup.v1") {
        return sanitizeOnboardingView(commanded);
      }
      const desktop = await runtime.cancel({ attemptId: input.attemptId, operationId: input.commandId });
      const cleanupSucceeded = Boolean(desktop.ok && desktop.data?.status === "cancelled");
      const completed = await submitAccountOnboardingStepResultRequest(client, input.attemptId, {
        operationId: operationId(input.commandId, "cleanup"),
        methodKey: "web_space.cleanup.v1",
        status: cleanupSucceeded ? "success" : "failed",
        errorCode: cleanupSucceeded ? undefined : desktop.error?.code || "ONBOARDING_CLEANUP_FAILED",
        resultSummary: { cleared: cleanupSucceeded }
      });
      return sanitizeOnboardingView(completed);
    },

    async submitStepResult(attemptId, input) {
      return sanitizeOnboardingView(await submitAccountOnboardingStepResultRequest(client, attemptId, input));
    },

    async completeAccountOnboarding(input) {
      if (!input.snapshotId.trim()) {
        throw new Error("verified_snapshot_required");
      }
      if (!input.snapshotVerificationReceipt.trim()) {
        throw new Error("snapshot_verification_receipt_required");
      }
      return sanitizeOnboardingView(await completeAccountOnboardingRequest(client, input));
    },

    subscribeAccountOnboarding(attemptId, listener, subscriptionOptions = {}) {
      let closed = false;
      let cursor = Math.max(0, subscriptionOptions.afterSequence ?? 0);
      let desktopCursor = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribeDesktop: () => void = () => undefined;
      const pollIntervalMs = clampPollInterval(subscriptionOptions.pollIntervalMs ?? defaultPollIntervalMs);

      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        unsubscribeDesktop();
        subscriptionOptions.signal?.removeEventListener("abort", close);
      };

      const schedule = (delay = pollIntervalMs) => {
        if (closed) return;
        timer = setTimeout(() => void poll(), delay);
      };

      const poll = async () => {
        if (closed) return;
        let hasMore = false;
        try {
          const response = sanitizeEventsView(
            await listAccountOnboardingEventsRequest(client, attemptId, cursor)
          );
          const events = [...response.events].sort((a, b) => a.sequence - b.sequence);
          for (const event of events) {
            if (closed || event.sequence <= cursor) continue;
            listener(event);
            cursor = event.sequence;
          }
          cursor = Math.max(cursor, response.lastSequence);
          hasMore = response.hasMore;
        } catch (error) {
          if (!closed) subscriptionOptions.onError?.(error);
        } finally {
          schedule(hasMore ? 0 : pollIntervalMs);
        }
      };

      unsubscribeDesktop = runtime.isAvailable()
        ? runtime.subscribe(attemptId, 0, (event) => {
            if (event.sequence <= desktopCursor || closed) return;
            desktopCursor = event.sequence;
            void reportDesktopEvent(client, event).catch((error) => subscriptionOptions.onError?.(error));
          })
        : () => undefined;
      subscriptionOptions.signal?.addEventListener("abort", close, { once: true });
      void poll();

      return {
        get closed() {
          return closed;
        },
        unsubscribe: close
      };
    },

    async executeAccountCapability<TInput, TData>(input: AccountCapabilityExecutionInput<TInput>) {
      return executeAccountCapabilityRequest<TInput, TData>(client, input);
    }
  };
}

const desktopAccountOnboardingRuntime: AccountOnboardingRuntimePort = {
  isAvailable: hasMatrixAccountOnboardingDesktopCapability,
  start: startMatrixAccountOnboarding,
  getLoginQrCode: (attemptId, revision) => getMatrixAccountLoginQrCode({ attemptId, qrRevision: revision }),
  refreshLoginQrCode: refreshMatrixAccountLoginQrCode,
  cancel: cancelMatrixAccountOnboarding,
  sealSessionSnapshot: sealMatrixAccountSessionSnapshot,
  subscribe: subscribeMatrixAccountOnboarding
};

function assertRuntimeAvailable(runtime: AccountOnboardingRuntimePort): void {
  if (!runtime.isAvailable()) throw new Error("account_onboarding_runtime_unavailable");
}

function runtimeStartInput(
  attempt: AccountOnboardingTransport,
  input: StartAccountOnboardingInput
): DesktopStartInput {
  if (!attempt.webSpaceId || !attempt.workspaceId || !attempt.workspaceType) {
    throw new Error("account_onboarding_runtime_context_incomplete");
  }
  return {
    attemptId: attempt.id,
    operationId: operationId(attempt.id, "start"),
    webSpaceId: attempt.webSpaceId,
    workspaceId: attempt.workspaceId,
    workspaceType: attempt.workspaceType as MatrixAccountWorkspaceType,
    platform: attempt.platform,
    memberId: attempt.memberId,
    deviceId: attempt.deviceId,
    idempotencyKey: input.idempotencyKey
  };
}

async function reconcileDesktopStart(
  client: RequestClient,
  initial: AccountOnboardingTransport,
  desktop: DesktopOnboardingView
): Promise<AccountOnboardingTransport> {
  let attempt = initial;
  let progressed = false;
  if (attempt.status !== "active") return attempt;

  if (attempt.currentStep === "login.open.v1") {
    const openFailed = desktop.methodKey === "login.open.v1" && Boolean(desktop.errorCode);
    attempt = await submitAccountOnboardingStepResultRequest(client, attempt.id, {
      operationId: operationId(desktop.operationId, "open"),
      methodKey: "login.open.v1",
      status: openFailed ? "failed" : "success",
      observedPhase: desktopObservedPhase(desktop.phase),
      errorCode: openFailed ? desktop.errorCode : undefined,
      errorMessage: openFailed ? desktop.errorMessage : undefined,
      resultSummary: {}
    });
    if (openFailed) return attempt;
    progressed = true;
  }

  if (attempt.currentStep === "login.qr.get.v1") {
    const qrAvailable = desktop.qrRevision > 0 && !desktop.errorCode;
    attempt = await submitAccountOnboardingStepResultRequest(client, attempt.id, {
      operationId: operationId(desktop.operationId, "qr-get"),
      methodKey: "login.qr.get.v1",
      status: qrAvailable ? "success" : "failed",
      observedPhase: desktopObservedPhase(desktop.phase),
      errorCode: qrAvailable ? undefined : desktop.errorCode || "qr_not_ready",
      errorMessage: qrAvailable ? undefined : desktop.errorMessage,
      resultSummary: { qrRevision: desktop.qrRevision, readable: qrAvailable }
    });
    if (!qrAvailable) return attempt;
    progressed = true;
  }

  if (progressed && attempt.currentStep === "login.status.probe.v1" && desktop.phase === "waiting_scan") {
    attempt = await submitAccountOnboardingStepResultRequest(client, attempt.id, {
      operationId: operationId(desktop.operationId, "status-probe"),
      methodKey: "login.status.probe.v1",
      status: "success",
      observedPhase: "waiting_scan",
      resultSummary: { phase: "waiting_scan" }
    });
  }
  return attempt;
}

async function reconcileDesktopRefresh(
  client: RequestClient,
  initial: AccountOnboardingTransport,
  commandId: string,
  desktop: DesktopCommandResult<DesktopQrCodeView>
): Promise<AccountOnboardingTransport> {
  let attempt = initial;
  if (!desktop.ok || !desktop.data) {
    return submitAccountOnboardingStepResultRequest(client, attempt.id, {
      operationId: operationId(commandId, "refresh"),
      methodKey: "login.qr.refresh.v1",
      status: "failed",
      errorCode: desktop.error?.code || "qr_refresh_failed",
      errorMessage: desktop.error?.message,
      resultSummary: {}
    });
  }

  const qr = desktop.data;
  attempt = await submitAccountOnboardingStepResultRequest(client, attempt.id, {
    operationId: operationId(qr.operationId, "refresh"),
    methodKey: "login.qr.refresh.v1",
    status: "success",
    observedPhase: desktopObservedPhase(qr.phase),
    resultSummary: {}
  });

  const qrAvailable = Boolean(qr.qrCodeDataUrl);
  attempt = await submitAccountOnboardingStepResultRequest(client, attempt.id, {
    operationId: operationId(qr.operationId, "qr-get"),
    methodKey: "login.qr.get.v1",
    status: qrAvailable ? "success" : "failed",
    observedPhase: desktopObservedPhase(qr.phase),
    errorCode: qrAvailable ? undefined : qr.reasonCode || "qr_not_ready",
    errorMessage: qrAvailable ? undefined : qr.message,
    resultSummary: {
      qrRevision: qr.qrRevision,
      readable: qr.recognized !== false
    }
  });
  if (!qrAvailable) return attempt;

  return submitAccountOnboardingStepResultRequest(client, attempt.id, {
    operationId: operationId(qr.operationId, "status-probe"),
    methodKey: "login.status.probe.v1",
    status: "success",
    observedPhase: "waiting_scan",
    resultSummary: { phase: "waiting_scan" }
  });
}

async function reportDesktopEvent(client: RequestClient, event: DesktopOnboardingEvent): Promise<void> {
  if (!isReportableDesktopMethod(event.methodKey)) return;
  const attempt = await getAccountOnboardingRequest(client, event.attemptId);
  // Desktop events may race with the command response. Only the method that the
  // durable aggregate currently expects is allowed to advance business state.
  if (attempt.status !== "active" || attempt.currentStep !== event.methodKey) return;
  await submitAccountOnboardingStepResultRequest(client, event.attemptId, {
    operationId: operationId(event.operationId, `event-${event.sequence}`),
    methodKey: event.methodKey,
    status: event.type === "onboarding.failed" ? "failed" : "success",
    observedPhase: desktopObservedPhase(event.phase),
    errorCode: event.type === "onboarding.failed" ? event.sanitizedResult.reasonCode : undefined,
    errorMessage: event.type === "onboarding.failed" ? event.sanitizedResult.message : undefined,
    resultSummary: {
      qrRevision: event.qrRevision,
      readable: event.sanitizedResult.qrAvailable,
      phase: desktopObservedPhase(event.phase)
    }
  });
}

function isReportableDesktopMethod(methodKey: string): boolean {
  return ["login.status.probe.v1", "account.identity.get.v1", "account.profile.get.v1"].includes(methodKey);
}

function desktopObservedPhase(phase: DesktopOnboardingView["phase"]): AccountLoginObservedPhase {
  switch (phase) {
    case "qr_ready":
    case "waiting_scan":
    case "authenticated":
    case "verification_required":
    case "risk_controlled":
      return phase;
    case "authenticating":
      return "confirming";
    default:
      return "unknown";
  }
}

function requireDesktopData<T>(result: DesktopCommandResult<T>): T {
  if (result.ok && result.data) return result.data;
  const error = new Error(result.error?.message || "account_onboarding_runtime_failed") as Error & { code?: string };
  error.code = result.error?.code;
  throw error;
}

function operationId(base: string, suffix: string): string {
  const safeBase = String(base || "operation").replace(/[^a-zA-Z0-9_.:-]/g, "_");
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return `${safeBase.slice(0, Math.max(1, 159 - safeSuffix.length))}:${safeSuffix}`;
}

function clampPollInterval(value: number): number {
  if (!Number.isFinite(value)) return 1_500;
  return Math.max(500, Math.min(30_000, Math.round(value)));
}

function sanitizeOnboardingView(value: AccountOnboardingTransport): AccountOnboardingView {
  const derivedError = value.lastErrorCode
    ? {
        code: value.lastErrorCode,
        message: value.lastErrorMessage || "",
        recoverable: value.status === "active",
        repairable: value.activity === "repairing_adapter"
      }
    : undefined;
  return compactObject({
    id: String(value.id || ""),
    platform: value.platform as MatrixAccountPlatform,
    status: value.status,
    phase: value.phase,
    activity: value.activity,
    currentStep: String(value.currentStep || ""),
    qrRevision: finiteNumber(value.qrRevision),
    sequence: finiteNumber(value.sequence),
    nextActions: sanitizeNextActions(value.nextActions?.length ? value.nextActions : inferNextActions(value)),
    accountCandidate: sanitizeCandidate(value.accountCandidate),
    bindingDecision: value.bindingDecision as AccountBindingDecision | undefined,
    account: sanitizeReadyAccount(value.account),
    accountId: optionalString(value.accountId),
    error: sanitizeError(value.error ?? derivedError),
    expiresAt: nullableString(value.expiresAt),
    createdAt: String(value.createdAt || ""),
    updatedAt: String(value.updatedAt || ""),
    completedAt: nullableString(value.completedAt)
  }) as AccountOnboardingView;
}

function sanitizeEventsView(value: AccountOnboardingEventsTransport): AccountOnboardingEventsView {
  const events = Array.isArray(value.events) ? value.events.map(sanitizeEvent) : [];
  return {
    attempt: sanitizeOnboardingView(value.attempt),
    events,
    lastSequence: Math.max(finiteNumber(value.lastSequence), ...events.map((event) => event.sequence), 0),
    hasMore: value.hasMore === true
  };
}

function sanitizeEvent(value: AccountOnboardingEventTransport): AccountOnboardingEvent {
  return compactObject({
    attemptId: String(value.attemptId || ""),
    sequence: finiteNumber(value.sequence),
    type: value.type,
    phase: value.phase,
    occurredAt: String(value.occurredAt || value.createdAt || ""),
    recoverable: value.recoverable === true,
    nextActions: sanitizeNextActions(value.nextActions),
    data: sanitizeEventData(value.data)
  }) as AccountOnboardingEvent;
}

function sanitizeEventData(value: AccountOnboardingEventData | undefined): AccountOnboardingEventData | undefined {
  if (!value) return undefined;
  return compactObject({
    qrRevision: value.qrRevision === undefined ? undefined : finiteNumber(value.qrRevision),
    loginPhase: value.loginPhase ?? ((value as AccountOnboardingEventData & { observedPhase?: AccountOnboardingEventData["loginPhase"] }).observedPhase),
    reasonCode: optionalString(value.reasonCode),
    accountCandidate: sanitizeCandidate(value.accountCandidate),
    bindingDecision: value.bindingDecision,
    accountId: optionalString(value.accountId),
    message: optionalString(value.message)
  }) as AccountOnboardingEventData | undefined;
}

function sanitizeCandidate(value: AccountOnboardingCandidate | undefined): AccountOnboardingCandidate | undefined {
  if (!value?.identityKey) return undefined;
  return compactObject({
    identityKey: value.identityKey,
    platformUid: optionalString(value.platformUid),
    displayName: optionalString(value.displayName),
    nickname: optionalString(value.nickname),
    avatarUrl: optionalString(value.avatarUrl),
    homeUrl: optionalString(value.homeUrl)
  }) as AccountOnboardingCandidate;
}

function sanitizeReadyAccount(value: MatrixAccountReadyView | undefined): MatrixAccountReadyView | undefined {
  if (!value?.id) return undefined;
  return {
    id: value.id,
    platform: value.platform,
    displayName: value.displayName || "",
    platformUid: value.platformUid || "",
    nickname: value.nickname || "",
    avatarUrl: value.avatarUrl || "",
    homeUrl: value.homeUrl || "",
    ownerMemberId: value.ownerMemberId || "",
    ownerName: value.ownerName || "",
    departmentName: value.departmentName || "",
    teamName: value.teamName || "",
    loginStatus: value.loginStatus || "unknown",
    status: value.status || "normal",
    remark: value.remark || "",
    lastLoginAt: nullableString(value.lastLoginAt),
    lastCheckAt: nullableString(value.lastCheckAt)
  };
}

function sanitizeError(value: AccountOnboardingError | undefined): AccountOnboardingError | undefined {
  if (!value?.code) return undefined;
  return compactObject({
    code: value.code,
    message: value.message || "",
    recoverable: value.recoverable === true,
    repairable: value.repairable === true,
    retryAfterMs: value.retryAfterMs === undefined ? undefined : finiteNumber(value.retryAfterMs)
  }) as AccountOnboardingError;
}

function sanitizeDesktopQrCode(value: DesktopQrCodeView): LoginQrCodeView {
  return {
    attemptId: String(value.attemptId || ""),
    revision: finiteNumber(value.qrRevision),
    dataUrl: String(value.qrCodeDataUrl || ""),
    expiresAt: null,
    refreshable: value.status === "active",
    observedAt: String(value.observedAt || "")
  };
}

function sanitizeNextActions(value: AccountOnboardingNextAction[] | undefined): AccountOnboardingNextAction[] {
  return Array.isArray(value) ? [...new Set(value)] : [];
}

function inferNextActions(value: AccountOnboardingTransport): AccountOnboardingNextAction[] {
  if (value.status !== "active") return [];
  switch (value.phase) {
    case "created":
    case "opening":
      return ["open_controlled_window", "cancel"];
    case "qr_ready":
    case "waiting_scan":
      return ["wait", "refresh_qr", "open_controlled_window", "cancel"];
    case "qr_expired":
      return ["refresh_qr", "cancel"];
    case "verification_required":
      return ["complete_platform_verification", "open_controlled_window", "cancel"];
    case "risk_controlled":
      return ["open_controlled_window", "cancel"];
    case "awaiting_confirmation":
      return ["confirm_binding", "cancel"];
    case "blocked_repair":
    case "snapshot_retryable":
      return ["retry_step", "cancel"];
    default:
      return ["wait", "cancel"];
  }
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  const result = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
  return result as T;
}
