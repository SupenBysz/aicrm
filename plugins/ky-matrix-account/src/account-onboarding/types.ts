import type { MatrixAccountPlatform } from "@ky/admin-core";

/**
 * Business-facing state of an account onboarding flow.
 *
 * Keep WebSpace, browser partition, script ids/versions and snapshot storage
 * details out of this contract. They belong to the orchestration/runtime layer.
 */
export type AccountOnboardingStatus = "active" | "completed" | "failed" | "cancelled" | "expired";

export type AccountOnboardingPhase =
  | "created"
  | "opening"
  | "qr_preparing"
  | "qr_ready"
  | "waiting_scan"
  | "authenticating"
  | "authenticated"
  | "identifying"
  | "awaiting_confirmation"
  | "snapshot_sealing"
  | "committing"
  | "ready"
  | "verification_required"
  | "risk_controlled"
  | "qr_expired"
  | "blocked_repair"
  | "snapshot_retryable"
  | "cancelling"
  | "cleanup_pending"
  | "cancelled";

export type AccountLoginObservedPhase =
  | "login_page"
  | "qr_ready"
  | "waiting_scan"
  | "scanned"
  | "confirming"
  | "authenticated"
  | "verification_required"
  | "risk_controlled"
  | "qr_expired"
  | "unknown";

export type AccountOnboardingActivity =
  | "executing"
  | "waiting_user"
  | "repairing_adapter"
  | "retrying"
  | "none";

export type AccountOnboardingNextAction =
  | "wait"
  | "refresh_qr"
  | "open_controlled_window"
  | "complete_platform_verification"
  | "confirm_binding"
  | "retry_snapshot"
  | "retry_step"
  | "cancel";

export type AccountBindingDecision =
  | "create_new"
  | "attach_existing"
  | "replace_device_session"
  | "conflict_requires_review"
  | "identity_uncertain";

export interface AccountOnboardingCandidate {
  identityKey: string;
  platformUid?: string;
  displayName?: string;
  nickname?: string;
  avatarUrl?: string;
  homeUrl?: string;
}

export interface AccountOnboardingError {
  code: string;
  message: string;
  recoverable: boolean;
  repairable: boolean;
  retryAfterMs?: number;
}

export interface MatrixAccountReadyView {
  id: string;
  platform: MatrixAccountPlatform;
  displayName: string;
  platformUid: string;
  nickname: string;
  avatarUrl: string;
  homeUrl: string;
  ownerMemberId: string;
  ownerName: string;
  departmentName: string;
  teamName: string;
  loginStatus: string;
  status: string;
  remark: string;
  lastLoginAt: string | null;
  lastCheckAt: string | null;
}

export interface AccountOnboardingView {
  id: string;
  platform: MatrixAccountPlatform;
  status: AccountOnboardingStatus;
  phase: AccountOnboardingPhase;
  activity: AccountOnboardingActivity;
  currentStep: string;
  qrRevision: number;
  sequence: number;
  nextActions: AccountOnboardingNextAction[];
  accountCandidate?: AccountOnboardingCandidate;
  bindingDecision?: AccountBindingDecision;
  account?: MatrixAccountReadyView;
  accountId?: string;
  error?: AccountOnboardingError;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface StartAccountOnboardingInput {
  platform: MatrixAccountPlatform;
  idempotencyKey: string;
  ownerMemberId?: string;
  departmentId?: string;
  teamId?: string;
  remark?: string;
}

export interface LoginQrCodeView {
  attemptId: string;
  revision: number;
  dataUrl: string;
  expiresAt: string | null;
  refreshable: boolean;
  observedAt: string;
}

export type AccountOnboardingEventType =
  | "onboarding.created"
  | "onboarding.retry_requested"
  | "onboarding.step_failed"
  | "web_space.ready"
  | "qr.ready"
  | "qr.refreshed"
  | "qr.refresh_requested"
  | "qr.expired"
  | "login.phase.changed"
  | "login.authenticated"
  | "user.action.required"
  | "adapter.repairing"
  | "account.identified"
  | "account.identity_detected"
  | "binding.review_required"
  | "snapshot.sealing"
  | "snapshot.verified"
  | "binding.confirmed"
  | "account.bound"
  | "account.ready"
  | "onboarding.failed"
  | "onboarding.cancel_requested"
  | "onboarding.cleanup_pending"
  | "onboarding.cancelled";

/** Only explicitly approved, non-secret event payload fields are exposed. */
export interface AccountOnboardingEventData {
  qrRevision?: number;
  loginPhase?: AccountOnboardingPhase;
  reasonCode?: string;
  accountCandidate?: AccountOnboardingCandidate;
  bindingDecision?: AccountBindingDecision;
  accountId?: string;
  message?: string;
}

export interface AccountOnboardingEvent {
  attemptId: string;
  sequence: number;
  type: AccountOnboardingEventType;
  phase: AccountOnboardingPhase;
  occurredAt: string;
  recoverable: boolean;
  nextActions: AccountOnboardingNextAction[];
  data?: AccountOnboardingEventData;
}

export interface AccountOnboardingEventsView {
  attempt: AccountOnboardingView;
  events: AccountOnboardingEvent[];
  lastSequence: number;
  hasMore: boolean;
}

export interface RefreshLoginQrCodeInput {
  attemptId: string;
  commandId: string;
  /** Mandatory compare-and-swap guard against replacing a newer QR revision. */
  expectedRevision: number;
}

export interface RetryAccountOnboardingStepInput {
  attemptId: string;
  commandId: string;
  expectedSequence: number;
}

export interface CancelAccountOnboardingInput {
  attemptId: string;
  commandId: string;
  reason?: string;
}

export interface ConfirmAccountBindingInput {
  attemptId: string;
  commandId: string;
  decision: Extract<AccountBindingDecision, "create_new" | "attach_existing" | "replace_device_session">;
  accountId?: string;
  ownerMemberId?: string;
  departmentId?: string;
  teamId?: string;
  remark?: string;
}

export type AccountOnboardingStepResultStatus = "success" | "failed" | "timeout" | "cancelled";

export interface SubmitAccountOnboardingStepResultInput {
  operationId: string;
  methodKey: string;
  status: AccountOnboardingStepResultStatus;
  observedPhase?: AccountLoginObservedPhase | AccountOnboardingPhase;
  resultSummary?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  durationMs?: number;
}

export interface AccountCapabilityExecutionInput<TInput = Record<string, unknown>> {
  accountId: string;
  capability: string;
  version: number;
  input: TInput;
  idempotencyKey: string;
}

export interface AccountCapabilityExecutionView<TData = unknown> {
  id: string;
  accountId: string;
  capability: string;
  version: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  data?: TData;
  error?: AccountOnboardingError;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface AccountOnboardingSubscriptionOptions {
  afterSequence?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
}

export type AccountOnboardingEventListener = (event: AccountOnboardingEvent) => void;

export interface AccountOnboardingSubscription {
  readonly closed: boolean;
  unsubscribe(): void;
}
