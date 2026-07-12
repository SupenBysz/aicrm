import type { CodexExecutorAuthStatusProjection, DesktopCommandResult } from "../shared/types";

export const LEGACY_CODEX_AUTHORIZATION_ERROR = {
  code: "desktop_bridge_upgrade_required",
  message: "Codex 可信授权桥正在升级，请使用新版授权流程"
} as const;

export function rejectLegacyCodexExecutorAuthorization(): DesktopCommandResult<never> {
  return {
    ok: false,
    error: { ...LEGACY_CODEX_AUTHORIZATION_ERROR }
  };
}

export function queryLegacyCodexExecutorAuthStatus(
  args: readonly unknown[]
): DesktopCommandResult<CodexExecutorAuthStatusProjection> {
  if (args.length !== 0) {
    return rejectLegacyCodexExecutorAuthorization();
  }
  return {
    ok: true,
    data: {
      bridgeVersion: 1,
      authStatus: "not_authorized",
      appServerListen: "stdio://",
      capabilities: {
        trustedAuthorization: false
      },
      message: "旧版 Codex 授权状态仅提供安全兼容投影，请升级到可信授权桥"
    }
  };
}
