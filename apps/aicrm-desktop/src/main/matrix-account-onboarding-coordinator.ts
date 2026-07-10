import { randomUUID } from "node:crypto";
import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../shared/constants";
import type {
  DesktopCommandResult,
  MatrixAccountOnboardingCancelInput,
  MatrixAccountOnboardingEvent,
  MatrixAccountOnboardingEventType,
  MatrixAccountOnboardingLookupInput,
  MatrixAccountOnboardingNextAction,
  MatrixAccountOnboardingQrCodeView,
  MatrixAccountOnboardingQrInput,
  MatrixAccountOnboardingRefreshQrInput,
  MatrixAccountOnboardingSanitizedResult,
  MatrixAccountOnboardingStartInput,
  MatrixAccountOnboardingView,
  MatrixAccountSessionSnapshotSealInput,
  MatrixAccountSessionWebSpaceCleanupInput,
  MatrixAccountWebSpaceBrowserResult,
  MatrixAccountWebSpaceClearResult,
  MatrixAccountWebSpaceInput
} from "../shared/types";

interface MatrixAccountOnboardingRuntime {
  openLogin: (
    event: IpcMainInvokeEvent,
    input: MatrixAccountWebSpaceInput
  ) => Promise<DesktopCommandResult<MatrixAccountWebSpaceBrowserResult>>;
  refreshQr: (input: MatrixAccountWebSpaceInput) => Promise<DesktopCommandResult<MatrixAccountWebSpaceBrowserResult>>;
  cancel: (input: MatrixAccountWebSpaceInput) => Promise<DesktopCommandResult<MatrixAccountWebSpaceClearResult>>;
}

interface CachedQrCode {
  dataUrl?: string;
  recognized?: boolean;
  payloadLength?: number;
  reasonCode?: string;
  message?: string;
  observedAt: string;
}

interface InternalOnboardingAttempt {
  input: MatrixAccountOnboardingStartInput;
  webSpaceInput: MatrixAccountWebSpaceInput;
  view: MatrixAccountOnboardingView;
  qrCode: CachedQrCode;
  verifiedSnapshotId?: string;
}

interface TransitionOptions {
  type: MatrixAccountOnboardingEventType;
  operationId: string;
  methodKey: string;
  phase?: MatrixAccountOnboardingView["phase"];
  status?: MatrixAccountOnboardingView["status"];
  activity?: MatrixAccountOnboardingView["activity"];
  nextActions?: MatrixAccountOnboardingNextAction[];
  recoverable?: boolean;
  errorCode?: string;
  errorMessage?: string;
  sanitizedResult?: MatrixAccountOnboardingSanitizedResult;
}

const ACTIVE_NEXT_ACTIONS: MatrixAccountOnboardingNextAction[] = ["wait", "refresh_qr", "open_controlled_window", "cancel"];

export class MatrixAccountOnboardingCoordinator {
  private readonly attempts = new Map<string, InternalOnboardingAttempt>();
  private readonly attemptIdByIdempotencyKey = new Map<string, string>();
  private readonly refreshInFlight = new Map<string, Promise<DesktopCommandResult<MatrixAccountOnboardingQrCodeView>>>();

  constructor(private readonly runtime: MatrixAccountOnboardingRuntime) {}

  async start(
    event: IpcMainInvokeEvent,
    input: MatrixAccountOnboardingStartInput
  ): Promise<DesktopCommandResult<MatrixAccountOnboardingView>> {
    const invalid = validateStartInput(input);
    if (invalid) return fail("validation_error", invalid);

    const idempotencyScope = input.idempotencyKey ? scopedIdempotencyKey(input) : "";
    const existingAttemptId = idempotencyScope ? this.attemptIdByIdempotencyKey.get(idempotencyScope) : undefined;
    if (existingAttemptId) {
      const existing = this.attempts.get(existingAttemptId);
      if (existing) return ok(cloneView(existing.view));
      this.attemptIdByIdempotencyKey.delete(idempotencyScope);
    }

    const attemptId = normalizeExternalId(input.attemptId) || randomUUID();
    const collision = this.attempts.get(attemptId);
    if (collision) {
      if (sameAttemptScope(collision.input, input)) return ok(cloneView(collision.view));
      return fail("onboarding_attempt_conflict", "登录流程标识已被其他业务上下文使用");
    }

    const operationId = normalizeExternalId(input.operationId) || randomUUID();
    const now = new Date().toISOString();
    const attempt: InternalOnboardingAttempt = {
      input: { ...input, attemptId, operationId },
      webSpaceInput: {
        webSpaceId: input.webSpaceId,
        workspaceId: input.workspaceId,
        workspaceType: input.workspaceType,
        platform: input.platform,
        deviceId: input.deviceId,
        showWindow: input.showWindow === true
      },
      view: {
        attemptId,
        operationId,
        methodKey: "login.open.v1",
        workspaceId: input.workspaceId,
        platform: input.platform,
        phase: "created",
        status: "active",
        activity: "executing",
        qrRevision: 0,
        sequence: 0,
        nextActions: ["wait", "cancel"],
        createdAt: now,
        updatedAt: now
      },
      qrCode: {
        reasonCode: "qr_not_requested",
        message: "二维码尚未获取",
        observedAt: now
      }
    };

    this.attempts.set(attemptId, attempt);
    if (idempotencyScope) this.attemptIdByIdempotencyKey.set(idempotencyScope, attemptId);
    this.transition(attempt, {
      type: "onboarding.created",
      operationId,
      methodKey: "login.open.v1",
      sanitizedResult: { reasonCode: "onboarding_created" }
    });
    this.transition(attempt, {
      type: "login.phase.changed",
      operationId,
      methodKey: "login.open.v1",
      phase: "opening",
      nextActions: ["wait", "cancel"],
      sanitizedResult: { reasonCode: "opening_login_page" }
    });

    const opened = await this.runtime.openLogin(event, attempt.webSpaceInput);
    if (!opened.ok || !opened.data) {
      const code = opened.error?.code || "login_open_failed";
      const message = opened.error?.message || "登录空间打开失败";
      this.transition(attempt, {
        type: "onboarding.failed",
        operationId,
        methodKey: "login.open.v1",
        phase: "failed",
        status: "failed",
        activity: "none",
        nextActions: ["retry_step", "cancel"],
        recoverable: true,
        errorCode: code,
        errorMessage: message,
        sanitizedResult: { reasonCode: code, message: sanitizeMessage(message) }
      });
      return ok(cloneView(attempt.view));
    }

    this.applyQrResult(attempt, opened.data, operationId, "qr.ready", "login.qr.get.v1");
    return ok(cloneView(attempt.view));
  }

  get(input: MatrixAccountOnboardingLookupInput): DesktopCommandResult<MatrixAccountOnboardingView> {
    return this.findAttempt(input);
  }

  getQr(input: MatrixAccountOnboardingQrInput): DesktopCommandResult<MatrixAccountOnboardingQrCodeView> {
    const found = this.findInternalAttempt(input);
    if (!found.ok || !found.data) return copyFailure(found);
    const attempt = found.data;
    if (input.qrRevision !== undefined && input.qrRevision !== attempt.view.qrRevision) {
      return fail("qr_revision_not_available", "请求的二维码版本已不是当前版本");
    }
    return ok(this.qrCodeView(attempt, "login.qr.get.v1"));
  }

  refreshQr(input: MatrixAccountOnboardingRefreshQrInput): Promise<DesktopCommandResult<MatrixAccountOnboardingQrCodeView>> {
    const active = this.refreshInFlight.get(input.attemptId);
    if (active) return active;
    const pending = this.refreshQrInternal(input).finally(() => {
      if (this.refreshInFlight.get(input.attemptId) === pending) this.refreshInFlight.delete(input.attemptId);
    });
    this.refreshInFlight.set(input.attemptId, pending);
    return pending;
  }

  async cancel(input: MatrixAccountOnboardingCancelInput): Promise<DesktopCommandResult<MatrixAccountOnboardingView>> {
    const found = this.findInternalAttempt(input);
    if (!found.ok || !found.data) return copyFailure(found);
    const attempt = found.data;
    if (attempt.view.status === "cancelled") return ok(cloneView(attempt.view));
    if (attempt.view.status === "completed") {
      return fail("onboarding_already_completed", "已完成的登录流程不能取消");
    }

    const operationId = normalizeExternalId(input.operationId) || randomUUID();
    const cleared = await this.runtime.cancel(attempt.webSpaceInput);
    if (!cleared.ok || !cleared.data?.cleared) {
      const code = cleared.error?.code || "onboarding_cleanup_failed";
      const message = cleared.error?.message || "登录空间清理失败";
      this.transition(attempt, {
        type: "onboarding.failed",
        operationId,
        methodKey: "onboarding.cancel.v1",
        nextActions: ["retry_step", "cancel"],
        recoverable: true,
        errorCode: code,
        errorMessage: message,
        sanitizedResult: { reasonCode: code, message: sanitizeMessage(message) }
      });
      return fail(code, message);
    }

    this.transition(attempt, {
      type: "onboarding.cancelled",
      operationId,
      methodKey: "onboarding.cancel.v1",
      phase: "cancelled",
      status: "cancelled",
      activity: "none",
      nextActions: [],
      sanitizedResult: { reasonCode: "cancelled_and_cleaned" }
    });
    return ok(cloneView(attempt.view));
  }

  beginSessionSnapshotSeal(
    input: MatrixAccountSessionSnapshotSealInput
  ): DesktopCommandResult<MatrixAccountWebSpaceInput> {
    const found = this.findInternalAttempt(input);
    if (!found.ok || !found.data) return copyFailure(found);
    const attempt = found.data;
    if (attempt.view.status !== "active") {
      return fail("onboarding_not_active", "当前登录流程不允许封存登录态快照");
    }
    if (attempt.view.phase !== "awaiting_confirmation" && attempt.view.phase !== "snapshot_sealing") {
      return fail("snapshot_seal_not_ready", "业务绑定确认完成后才能封存登录态快照");
    }
    const operationId = normalizeExternalId(input.operationId) || randomUUID();
    this.transition(attempt, {
      type: "snapshot.sealing",
      operationId,
      methodKey: "session.snapshot.seal.v1",
      phase: "snapshot_sealing",
      activity: "executing",
      nextActions: ["wait", "cancel"],
      sanitizedResult: { reasonCode: "snapshot_sealing" }
    });
    return ok({ ...attempt.webSpaceInput });
  }

  completeSessionSnapshotSeal(
    attemptId: string,
    snapshotId: string,
    operationId?: string
  ): DesktopCommandResult<MatrixAccountOnboardingView> {
    const found = this.findInternalAttempt({ attemptId });
    if (!found.ok || !found.data) return copyFailure(found);
    const attempt = found.data;
    attempt.verifiedSnapshotId = snapshotId;
    attempt.view.snapshotId = snapshotId;
    if (attempt.view.status !== "active") return ok(cloneView(attempt.view));
    this.transition(attempt, {
      type: "snapshot.verified",
      operationId: normalizeExternalId(operationId) || randomUUID(),
      methodKey: "session.snapshot.verify.v1",
      phase: "committing",
      activity: "executing",
      nextActions: ["wait"],
      sanitizedResult: { reasonCode: "snapshot_verified" }
    });
    return ok(cloneView(attempt.view));
  }

  failSessionSnapshotSeal(attemptId: string, operationId: string | undefined, code: string, message: string): void {
    const found = this.findInternalAttempt({ attemptId });
    if (!found.ok || !found.data) return;
    this.transition(found.data, {
      type: "user.action.required",
      operationId: normalizeExternalId(operationId) || randomUUID(),
      methodKey: "session.snapshot.seal.v1",
      phase: "snapshot_sealing",
      activity: "waiting_user",
      nextActions: ["retry_snapshot", "cancel"],
      recoverable: true,
      errorCode: code,
      errorMessage: message,
      sanitizedResult: { reasonCode: code, message: sanitizeMessage(message) }
    });
  }

  resolveTrustedVaultWebSpace(attemptId: string): DesktopCommandResult<MatrixAccountWebSpaceInput> {
    const found = this.findInternalAttempt({ attemptId });
    if (!found.ok || !found.data) return copyFailure(found);
    return ok({ ...found.data.webSpaceInput });
  }

  resolveVerifiedCleanupWebSpace(
    input: MatrixAccountSessionWebSpaceCleanupInput
  ): DesktopCommandResult<MatrixAccountWebSpaceInput> {
    const found = this.findInternalAttempt(input);
    if (!found.ok || !found.data) return copyFailure(found);
    if (!found.data.verifiedSnapshotId || found.data.verifiedSnapshotId !== input.verifiedSnapshotId) {
      return fail("verified_snapshot_required", "只有当前登录流程已验证的快照才能授权物理清理 WebSpace");
    }
    return ok({ ...found.data.webSpaceInput });
  }

  switchToRestoredWebSpace(attemptId: string, trustedBrowserPartition: string, snapshotId: string): void {
    const found = this.findInternalAttempt({ attemptId });
    if (!found.ok || !found.data) return;
    found.data.webSpaceInput.browserPartition = trustedBrowserPartition;
    found.data.verifiedSnapshotId = snapshotId;
    found.data.view.snapshotId = snapshotId;
  }

  private async refreshQrInternal(
    input: MatrixAccountOnboardingRefreshQrInput
  ): Promise<DesktopCommandResult<MatrixAccountOnboardingQrCodeView>> {
    const found = this.findInternalAttempt(input);
    if (!found.ok || !found.data) return copyFailure(found);
    const attempt = found.data;
    if (attempt.view.status !== "active") {
      return fail("onboarding_not_active", "当前登录流程不允许刷新二维码");
    }
    if (input.expectedQrRevision !== undefined && input.expectedQrRevision !== attempt.view.qrRevision) {
      return fail("qr_revision_conflict", "二维码已经被其他操作刷新，请读取最新版本");
    }

    const operationId = normalizeExternalId(input.operationId) || randomUUID();
    this.transition(attempt, {
      type: "login.phase.changed",
      operationId,
      methodKey: "login.qr.refresh.v1",
      phase: "qr_preparing",
      activity: "retrying",
      nextActions: ["wait", "cancel"],
      sanitizedResult: { reasonCode: "refreshing_qr" }
    });

    const refreshed = await this.runtime.refreshQr(attempt.webSpaceInput);
    if (!refreshed.ok || !refreshed.data) {
      const code = refreshed.error?.code || "qr_refresh_failed";
      const message = refreshed.error?.message || "二维码刷新失败";
      this.transition(attempt, {
        type: "user.action.required",
        operationId,
        methodKey: "login.qr.refresh.v1",
        phase: "waiting_scan",
        activity: "waiting_user",
        nextActions: ACTIVE_NEXT_ACTIONS,
        recoverable: true,
        errorCode: code,
        errorMessage: message,
        sanitizedResult: { reasonCode: code, message: sanitizeMessage(message) }
      });
      return fail(code, message);
    }

    this.applyQrResult(attempt, refreshed.data, operationId, "qr.refreshed", "login.qr.refresh.v1");
    return ok(this.qrCodeView(attempt, "login.qr.refresh.v1"));
  }

  private applyQrResult(
    attempt: InternalOnboardingAttempt,
    result: MatrixAccountWebSpaceBrowserResult,
    operationId: string,
    eventType: "qr.ready" | "qr.refreshed",
    methodKey: "login.qr.get.v1" | "login.qr.refresh.v1"
  ): void {
    const observedAt = new Date().toISOString();
    const hasQrCode = Boolean(result.qrCodeDataUrl);
    if (hasQrCode) attempt.view.qrRevision += 1;
    attempt.qrCode = {
      dataUrl: result.qrCodeDataUrl,
      recognized: result.qrCodeRecognized,
      payloadLength: result.qrCodePayloadLength,
      reasonCode: hasQrCode ? undefined : "qr_not_ready",
      message: sanitizeMessage(result.qrCodeReason || result.qrCodeVerifyReason),
      observedAt
    };

    if (!hasQrCode) {
      this.transition(attempt, {
        type: "user.action.required",
        operationId,
        methodKey,
        phase: "qr_preparing",
        activity: "waiting_user",
        nextActions: ["refresh_qr", "open_controlled_window", "cancel"],
        recoverable: true,
        errorCode: "qr_not_ready",
        errorMessage: attempt.qrCode.message || "平台登录页尚未生成二维码",
        sanitizedResult: {
          qrAvailable: false,
          reasonCode: "qr_not_ready",
          message: attempt.qrCode.message
        }
      });
      return;
    }

    this.transition(attempt, {
      type: eventType,
      operationId,
      methodKey,
      phase: "qr_ready",
      activity: "executing",
      nextActions: ACTIVE_NEXT_ACTIONS,
      sanitizedResult: {
        qrAvailable: true,
        qrRecognized: result.qrCodeRecognized,
        qrPayloadLength: result.qrCodePayloadLength,
        reasonCode: result.qrCodeRecognized === false ? "qr_decode_unverified" : "qr_ready"
      }
    });
    this.transition(attempt, {
      type: "login.phase.changed",
      operationId,
      methodKey: "login.status.probe.v1",
      phase: "waiting_scan",
      activity: "waiting_user",
      nextActions: ACTIVE_NEXT_ACTIONS,
      sanitizedResult: { reasonCode: "waiting_for_scan", qrAvailable: true }
    });
  }

  private transition(attempt: InternalOnboardingAttempt, options: TransitionOptions): void {
    const now = new Date().toISOString();
    attempt.view.operationId = options.operationId;
    attempt.view.methodKey = options.methodKey;
    if (options.phase) attempt.view.phase = options.phase;
    if (options.status) attempt.view.status = options.status;
    if (options.activity) attempt.view.activity = options.activity;
    if (options.nextActions) attempt.view.nextActions = [...options.nextActions];
    attempt.view.errorCode = options.errorCode;
    attempt.view.errorMessage = options.errorMessage ? sanitizeMessage(options.errorMessage) : undefined;
    attempt.view.sequence += 1;
    attempt.view.updatedAt = now;

    const payload: MatrixAccountOnboardingEvent = {
      attemptId: attempt.view.attemptId,
      operationId: options.operationId,
      methodKey: options.methodKey,
      sequence: attempt.view.sequence,
      type: options.type,
      phase: attempt.view.phase,
      status: attempt.view.status,
      qrRevision: attempt.view.qrRevision,
      occurredAt: now,
      recoverable: options.recoverable === true,
      nextActions: [...attempt.view.nextActions],
      sanitizedResult: { ...(options.sanitizedResult || {}) }
    };
    broadcastOnboardingEvent(payload);
  }

  private findAttempt(input: MatrixAccountOnboardingLookupInput): DesktopCommandResult<MatrixAccountOnboardingView> {
    const found = this.findInternalAttempt(input);
    if (!found.ok || !found.data) return copyFailure(found);
    return ok(cloneView(found.data.view));
  }

  private findInternalAttempt(input: MatrixAccountOnboardingLookupInput): DesktopCommandResult<InternalOnboardingAttempt> {
    if (!input || typeof input !== "object" || !normalizeExternalId(input.attemptId)) {
      return fail("validation_error", "登录流程标识无效");
    }
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) return fail("onboarding_attempt_not_found", "本机未找到该登录流程，请重新开始登录");
    return ok(attempt);
  }

  private qrCodeView(
    attempt: InternalOnboardingAttempt,
    methodKey: MatrixAccountOnboardingQrCodeView["methodKey"]
  ): MatrixAccountOnboardingQrCodeView {
    return {
      attemptId: attempt.view.attemptId,
      operationId: attempt.view.operationId,
      methodKey,
      phase: attempt.view.phase,
      status: attempt.view.status,
      qrRevision: attempt.view.qrRevision,
      qrCodeDataUrl: attempt.qrCode.dataUrl,
      recognized: attempt.qrCode.recognized,
      payloadLength: attempt.qrCode.payloadLength,
      reasonCode: attempt.qrCode.reasonCode,
      message: attempt.qrCode.message,
      observedAt: attempt.qrCode.observedAt
    };
  }
}

function validateStartInput(input: MatrixAccountOnboardingStartInput): string | null {
  if (!input || typeof input !== "object") return "登录流程参数无效";
  if (!input.webSpaceId || !input.workspaceId || !input.workspaceType || !input.platform) return "登录流程参数不完整";
  if (!(["platform", "agency", "enterprise"] as string[]).includes(input.workspaceType)) return "工作区类型无效";
  if (!(["douyin", "kuaishou", "xiaohongshu"] as string[]).includes(input.platform)) return "平台类型无效";
  if (input.attemptId && !normalizeExternalId(input.attemptId)) return "登录流程标识格式无效";
  if (input.operationId && !normalizeExternalId(input.operationId)) return "业务操作标识格式无效";
  if (!normalizeExternalId(input.webSpaceId)) return "WebSpace 标识格式无效";
  if (input.idempotencyKey && input.idempotencyKey.length > 160) return "幂等键过长";
  return null;
}

function normalizeExternalId(value: string | undefined): string {
  const normalized = String(value || "").trim();
  return /^[a-zA-Z0-9_.:-]{1,160}$/.test(normalized) ? normalized : "";
}

function scopedIdempotencyKey(input: MatrixAccountOnboardingStartInput): string {
  return [input.workspaceType, input.workspaceId, input.platform, input.deviceId || "default", input.idempotencyKey].join(":");
}

function sameAttemptScope(left: MatrixAccountOnboardingStartInput, right: MatrixAccountOnboardingStartInput): boolean {
  return (
    left.workspaceType === right.workspaceType &&
    left.workspaceId === right.workspaceId &&
    left.platform === right.platform &&
    left.webSpaceId === right.webSpaceId &&
    String(left.deviceId || "") === String(right.deviceId || "")
  );
}

function cloneView(view: MatrixAccountOnboardingView): MatrixAccountOnboardingView {
  return { ...view, nextActions: [...view.nextActions] };
}

function sanitizeMessage(value: string | undefined): string | undefined {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

function broadcastOnboardingEvent(payload: MatrixAccountOnboardingEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(IPC_CHANNELS.matrixAccountOnboardingEvent, payload);
  }
}

function ok<T>(data: T): DesktopCommandResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): DesktopCommandResult<never> {
  return { ok: false, error: { code, message } };
}

function copyFailure<T>(result: DesktopCommandResult<unknown>): DesktopCommandResult<T> {
  return {
    ok: false,
    error: result.error || { code: "unknown_error", message: "登录流程操作失败" },
    requestId: result.requestId
  };
}
