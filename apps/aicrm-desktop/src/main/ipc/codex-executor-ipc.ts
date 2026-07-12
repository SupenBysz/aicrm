import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import {
  queryLegacyCodexExecutorAuthStatus,
  rejectLegacyCodexExecutorAuthorization
} from "../codex-executor-auth-safety-policy";

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
}
