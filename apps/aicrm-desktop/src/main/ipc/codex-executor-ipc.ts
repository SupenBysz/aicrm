import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import {
  queryLegacyCodexExecutorAuthStatus,
  rejectLegacyCodexExecutorAuthorization
} from "../codex-executor-auth-safety-policy";
import {
  cancelCodexAuthorization,
  checkCodexAuthorizationReadiness,
  logoutCodexCredential,
  queryCodexAuthorizationCapabilities,
  queryCodexAuthorizationSnapshot,
  queryCodexModelCatalog,
  refreshCodexModelCatalog,
  reopenCodexAuthorization,
  startCodexAuthorization,
  verifyCodexAuthorization
} from "../codex-authorization-bridge-v2-policy";

type FailClosedHandler = (input: unknown) => unknown;

function invokeSingleArgument(args: readonly unknown[], handler: FailClosedHandler) {
  return handler(args.length === 1 ? args[0] : undefined);
}

/**
 * Keep the legacy IPC ABI registered for one compatibility window, but never
 * start Codex, inspect credential directories, or report authorization state.
 * Bridge v2 will replace these channels with ticket-bound trusted commands.
 */
export function registerCodexExecutorIpc() {
  ipcMain.handle(IPC_CHANNELS.codexExecutorAuthorize, async () => rejectLegacyCodexExecutorAuthorization());
  ipcMain.handle(IPC_CHANNELS.codexExecutorGetAuthStatus, async (_event, ...args: unknown[]) =>
    queryLegacyCodexExecutorAuthStatus(args)
  );

  // Bridge v2 is intentionally registered before the trusted device runtime
  // exists. Every method validates the locked DTO and then fails closed. No
  // ticket is decoded, no App Server starts, and no credential state changes.
  ipcMain.handle(IPC_CHANNELS.codexAuthorizationGetCapabilities, async (_event, ...args: unknown[]) =>
    queryCodexAuthorizationCapabilities(args)
  );
  ipcMain.handle(IPC_CHANNELS.codexAuthorizationStart, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, startCodexAuthorization)
  );
  ipcMain.handle(IPC_CHANNELS.codexAuthorizationGetSnapshot, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, queryCodexAuthorizationSnapshot)
  );
  ipcMain.handle(IPC_CHANNELS.codexAuthorizationCancel, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, cancelCodexAuthorization)
  );
  ipcMain.handle(IPC_CHANNELS.codexAuthorizationReopen, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, reopenCodexAuthorization)
  );
  ipcMain.handle(IPC_CHANNELS.codexAuthorizationVerify, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, verifyCodexAuthorization)
  );
  ipcMain.handle(IPC_CHANNELS.codexAuthorizationCheckReadiness, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, checkCodexAuthorizationReadiness)
  );
  ipcMain.handle(IPC_CHANNELS.codexAuthorizationGetModelCatalog, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, queryCodexModelCatalog)
  );
  ipcMain.handle(IPC_CHANNELS.codexAuthorizationRefreshModelCatalog, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, refreshCodexModelCatalog)
  );
  ipcMain.handle(IPC_CHANNELS.codexAuthorizationLogout, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, logoutCodexCredential)
  );
}
