export type LegacyWebSpaceFlowStatus =
  | "idle"
  | "initializing"
  | "waiting_qr"
  | "refreshing_qr"
  | "qr_ready"
  | "detecting_account"
  | "failed"
  | "success"
  | "releasing";

export function isLegacyAccountDetectionFlow(status: LegacyWebSpaceFlowStatus): boolean {
  return status === "qr_ready" || status === "detecting_account";
}

export function supportsLegacyDeferredWindowRelease(
  capabilities: { bridgeVersion?: number; supportsDeferredWindowRelease?: boolean } | null | undefined
): boolean {
  return capabilities?.bridgeVersion === 1 && capabilities.supportsDeferredWindowRelease === true;
}

export function legacyRepairTaskBlocksDetection(status: string | undefined): boolean {
  return status === "pending" || status === "waiting_executor" || status === "running" || status === "waiting_user_scan";
}

export function isLegacyWebSpaceFlowCurrent(input: {
  expectedFlowId: number;
  currentFlowId: number;
  cancelled: boolean;
  drawerOpen: boolean;
  activeWebSpaceId?: string;
  expectedWebSpaceId: string;
}): boolean {
  return (
    input.expectedFlowId === input.currentFlowId &&
    !input.cancelled &&
    input.drawerOpen &&
    input.activeWebSpaceId === input.expectedWebSpaceId
  );
}

export function legacyShouldDelayWebSpaceRelease(input: {
  bindingPending?: boolean;
  repairCreationPending: boolean;
  inFlightRepairCount?: number;
  repairTaskStatus?: string;
}): boolean {
  return (
    input.bindingPending === true ||
    input.repairCreationPending ||
    (input.inFlightRepairCount ?? 0) > 0 ||
    legacyRepairTaskBlocksDetection(input.repairTaskStatus)
  );
}

export function legacyClosedBindingDisposition(input: {
  bindingPending: boolean;
  bindingOutcomeUnknown: boolean;
  bindSucceeded: boolean;
}): "wait" | "preserve" | "clear" {
  if (input.bindingPending) return "wait";
  if (input.bindSucceeded || input.bindingOutcomeUnknown) return "preserve";
  return "clear";
}

export type LegacyAutoRepairDecision = "create" | "reuse" | "blocked";

export function legacyRepairAttemptKey(webSpaceId: string, purpose: string): string {
  return `${webSpaceId.trim()}:${purpose.trim()}`;
}

export function legacyAutoRepairDecision(input: {
  alreadyAttempted: boolean;
  hasExistingSamePurposeTask: boolean;
  hasInFlightSamePurposeRepair?: boolean;
}): LegacyAutoRepairDecision {
  if (input.hasExistingSamePurposeTask || input.hasInFlightSamePurposeRepair) return "reuse";
  return input.alreadyAttempted ? "blocked" : "create";
}

export function legacyFailureRetryDecision(consecutiveFailures: number, maxFailures = 3): "retry" | "fail" {
  return consecutiveFailures >= maxFailures ? "fail" : "retry";
}

export function legacyFailureRetryDelayMs(consecutiveFailures: number, baseDelayMs = 1200): number {
  return Math.min(baseDelayMs * 2 ** Math.max(0, consecutiveFailures - 1), 6000);
}

export function isLegacyLoginCompletionSurface(input: {
  url: string;
  title?: string;
  visibleText?: string;
  loginPhase?: string;
  hasAccount?: boolean;
  hasLogin?: boolean;
  hasQr?: boolean;
}): boolean {
  const value = `${input.url} ${input.title ?? ""} ${input.visibleText ?? ""}`.toLowerCase();
  const hasWaitingSignal = /扫码登录|二维码登录|验证码登录|密码登录|登录\/注册|打开.{0,16}扫一扫|qr|scan|安全验证/.test(value);
  if (input.hasQr === true || input.hasLogin === true || hasWaitingSignal) return false;
  if (input.loginPhase === "account" || input.hasAccount === true) return true;
  if (/\/creator-micro\/(home|content|manage|data|creator|message|notification|income|monetize)(\/|$|\?)/i.test(input.url)) {
    return true;
  }
  if (/\/(user|profile)\/[^/?#]{4,}|\/creator-micro\/user\/[^/?#]{4,}/i.test(input.url)) return true;
  return /退出登录|账号设置|个人主页|抖音号[:：]|快手号[:：]|小红书号[:：]|粉丝\s*\d|获赞\s*\d|高清发布|新的创作|发布视频|发布图文|作品管理|内容管理|数据中心|创作者服务中心|店铺管理|变现中心/.test(
    value
  );
}

export function legacyPostScanFlowLabel(input: {
  scanConfirmed: boolean;
  status: LegacyWebSpaceFlowStatus;
}): string | undefined {
  if (!input.scanConfirmed) return undefined;
  if (input.status === "success") return "已识别";
  if (input.status === "failed") return "已扫码，识别待修复";
  return "已扫码，识别中";
}

export function legacyNewAccountFlowDescription(input: {
  status: LegacyWebSpaceFlowStatus;
  qrAvailable: boolean;
  scanConfirmed?: boolean;
  progressDescription?: string;
}): string {
  if (input.scanConfirmed) {
    if (input.status === "failed") {
      return input.progressDescription || "扫码已确认；账号识别适配尚未完成，当前登录空间会保留。";
    }
    return input.progressDescription || "扫码已确认，正在识别账号。";
  }
  if (input.status === "detecting_account") {
    return input.progressDescription || "已检测到扫码成功，正在识别账号。";
  }
  if (input.status === "success") {
    return input.progressDescription || "账号已识别。";
  }
  if (input.status === "failed") {
    return input.progressDescription || "当前步骤未完成，请按提示处理后重试。";
  }
  if (input.qrAvailable) {
    return "请使用平台 App 扫码完成登录，登录成功后系统会自动进入账号识别。";
  }
  return input.progressDescription || "正在初始化登录空间，等待平台二维码...";
}
