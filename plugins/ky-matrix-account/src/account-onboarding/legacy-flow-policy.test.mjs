import assert from "node:assert/strict";
import test from "node:test";

import {
  isLegacyLoginCompletionSurface,
  isLegacyWebSpaceFlowCurrent,
  legacyAutoRepairDecision,
  legacyClosedBindingDisposition,
  legacyFailureRetryDecision,
  legacyFailureRetryDelayMs,
  isLegacyAccountDetectionFlow,
  legacyNewAccountFlowDescription,
  legacyPostScanFlowLabel,
  legacyRepairAttemptKey,
  legacyShouldDelayWebSpaceRelease,
  legacyRepairTaskBlocksDetection,
  supportsLegacyDeferredWindowRelease
} from "./legacy-flow-policy.ts";

test("legacy detection remains pollable after scan changes the phase", () => {
  assert.equal(isLegacyAccountDetectionFlow("qr_ready"), true);
  assert.equal(isLegacyAccountDetectionFlow("detecting_account"), true);
  assert.equal(isLegacyAccountDetectionFlow("waiting_qr"), false);
  assert.equal(isLegacyAccountDetectionFlow("failed"), false);
});

test("only executing repair tasks block account detection", () => {
  for (const status of ["pending", "waiting_executor", "running", "waiting_user_scan"]) {
    assert.equal(legacyRepairTaskBlocksDetection(status), true, status);
  }
  for (const status of [undefined, "completed", "failed", "timeout", "cancelled"]) {
    assert.equal(legacyRepairTaskBlocksDetection(status), false, String(status));
  }
});

test("post-scan progress is not hidden behind stale QR instructions", () => {
  assert.equal(
    legacyNewAccountFlowDescription({
      status: "detecting_account",
      qrAvailable: true,
      progressDescription: "正在匹配账号识别脚本。"
    }),
    "正在匹配账号识别脚本。"
  );
  assert.equal(
    legacyNewAccountFlowDescription({ status: "qr_ready", qrAvailable: true }),
    "请使用平台 App 扫码完成登录，登录成功后系统会自动进入账号识别。"
  );
  assert.equal(
    legacyNewAccountFlowDescription({
      status: "failed",
      qrAvailable: true,
      scanConfirmed: true
    }),
    "扫码已确认；账号识别适配尚未完成，当前登录空间会保留。"
  );
});

test("one flow can create at most one automatic repair per WebSpace purpose", () => {
  assert.equal(legacyRepairAttemptKey(" maws_1 ", " account_detect "), "maws_1:account_detect");
  assert.equal(
    legacyAutoRepairDecision({ alreadyAttempted: false, hasExistingSamePurposeTask: false }),
    "create"
  );
  assert.equal(
    legacyAutoRepairDecision({ alreadyAttempted: false, hasExistingSamePurposeTask: true }),
    "reuse"
  );
  assert.equal(
    legacyAutoRepairDecision({
      alreadyAttempted: true,
      hasExistingSamePurposeTask: false,
      hasInFlightSamePurposeRepair: true
    }),
    "reuse"
  );
  assert.equal(
    legacyAutoRepairDecision({ alreadyAttempted: true, hasExistingSamePurposeTask: false }),
    "blocked"
  );
});

test("post-scan labels never fall back to waiting for another scan", () => {
  assert.equal(legacyPostScanFlowLabel({ scanConfirmed: false, status: "qr_ready" }), undefined);
  assert.equal(legacyPostScanFlowLabel({ scanConfirmed: true, status: "detecting_account" }), "已扫码，识别中");
  assert.equal(legacyPostScanFlowLabel({ scanConfirmed: true, status: "failed" }), "已扫码，识别待修复");
});

test("post-scan failures retry with a bound budget", () => {
  assert.equal(legacyFailureRetryDecision(1, 3), "retry");
  assert.equal(legacyFailureRetryDecision(2, 3), "retry");
  assert.equal(legacyFailureRetryDecision(3, 3), "fail");
  assert.equal(legacyFailureRetryDelayMs(1), 1200);
  assert.equal(legacyFailureRetryDelayMs(2), 2400);
  assert.equal(legacyFailureRetryDelayMs(4), 6000);
});

test("a login QR takes precedence over an authenticated-looking URL", () => {
  assert.equal(
    isLegacyLoginCompletionSurface({
      url: "https://creator.douyin.com/creator-micro/home",
      visibleText: "扫码登录，请使用抖音 App 扫一扫"
    }),
    false
  );
  assert.equal(
    isLegacyLoginCompletionSurface({
      url: "https://creator.douyin.com/creator-micro/home",
      visibleText: "作品管理 数据中心"
    }),
    true
  );
});

test("stale or cancelled WebSpace flows cannot update the active flow", () => {
  const current = {
    expectedFlowId: 7,
    currentFlowId: 7,
    cancelled: false,
    drawerOpen: true,
    activeWebSpaceId: "maws_7",
    expectedWebSpaceId: "maws_7"
  };
  assert.equal(isLegacyWebSpaceFlowCurrent(current), true);
  assert.equal(isLegacyWebSpaceFlowCurrent({ ...current, currentFlowId: 8 }), false);
  assert.equal(isLegacyWebSpaceFlowCurrent({ ...current, cancelled: true }), false);
  assert.equal(isLegacyWebSpaceFlowCurrent({ ...current, drawerOpen: false }), false);
  assert.equal(isLegacyWebSpaceFlowCurrent({ ...current, activeWebSpaceId: "maws_8" }), false);
});

test("WebSpace release waits for repair creation and executing tasks", () => {
  assert.equal(legacyShouldDelayWebSpaceRelease({ bindingPending: true, repairCreationPending: false }), true);
  assert.equal(legacyShouldDelayWebSpaceRelease({ repairCreationPending: true }), true);
  assert.equal(legacyShouldDelayWebSpaceRelease({ repairCreationPending: false, inFlightRepairCount: 1 }), true);
  assert.equal(legacyShouldDelayWebSpaceRelease({ repairCreationPending: false, repairTaskStatus: "running" }), true);
  assert.equal(legacyShouldDelayWebSpaceRelease({ repairCreationPending: false, repairTaskStatus: "completed" }), false);
});

test("legacy auto-detect requires an explicit deferred-release capability", () => {
  assert.equal(supportsLegacyDeferredWindowRelease(undefined), false);
  assert.equal(supportsLegacyDeferredWindowRelease({ bridgeVersion: 1, supportsDeferredWindowRelease: false }), false);
  assert.equal(supportsLegacyDeferredWindowRelease({ bridgeVersion: 1, supportsDeferredWindowRelease: true }), true);
});

test("closing during bind never clears a successful or uncertain login", () => {
  assert.equal(
    legacyClosedBindingDisposition({ bindingPending: true, bindingOutcomeUnknown: false, bindSucceeded: false }),
    "wait"
  );
  assert.equal(
    legacyClosedBindingDisposition({ bindingPending: false, bindingOutcomeUnknown: false, bindSucceeded: true }),
    "preserve"
  );
  assert.equal(
    legacyClosedBindingDisposition({ bindingPending: false, bindingOutcomeUnknown: true, bindSucceeded: false }),
    "preserve"
  );
  assert.equal(
    legacyClosedBindingDisposition({ bindingPending: false, bindingOutcomeUnknown: false, bindSucceeded: false }),
    "clear"
  );
});
