import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import {
  queryLegacyCodexExecutorAuthStatus,
  rejectLegacyCodexExecutorAuthorization
} from "../codex-executor-auth-safety-policy";
import {
  CODEX_AUTHORIZATION_INPUT_INVALID_ERROR,
  CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR,
  CODEX_DESKTOP_AUTHORIZATION_RUNTIME_READY,
  createCodexAuthorizationBridgeV2Handlers,
  type CodexAuthorizationBridgeV2Handlers,
  type CodexAuthorizationBridgeV2RuntimeProvider
} from "../codex-authorization-bridge-v2-policy";
import type { DesktopCommandResult } from "../../shared/types";

type BridgeHandler<T = unknown> = (input: unknown) => Promise<DesktopCommandResult<T>>;

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ): unknown;
}

export interface RegisterCodexExecutorIpcOptions {
  registrar?: IpcMainLike;
  bridgeV2Handlers?: CodexAuthorizationBridgeV2Handlers;
  runtimeProvider?: CodexAuthorizationBridgeV2RuntimeProvider;
  ready?: boolean;
}

function invalid<T>(): DesktopCommandResult<T> {
  return { ok: false, error: { ...CODEX_AUTHORIZATION_INPUT_INVALID_ERROR } };
}

function runtimeFailed<T>(): DesktopCommandResult<T> {
  return { ok: false, error: { ...CODEX_AUTHORIZATION_RUNTIME_FAILED_ERROR } };
}

async function invokeSafely<T>(
  operation: () => Promise<DesktopCommandResult<T>>
): Promise<DesktopCommandResult<T>> {
  try {
    return await operation();
  } catch {
    return runtimeFailed();
  }
}

function invokeNoArguments<T>(
  args: readonly unknown[],
  handler: () => Promise<DesktopCommandResult<T>>
): Promise<DesktopCommandResult<T>> {
  return args.length === 0 ? invokeSafely(handler) : Promise.resolve(invalid());
}

function invokeSingleArgument<T>(
  args: readonly unknown[],
  handler: BridgeHandler<T>
): Promise<DesktopCommandResult<T>> {
  return args.length === 1
    ? invokeSafely(() => handler(args[0]))
    : Promise.resolve(invalid());
}

/**
 * Keep the legacy IPC ABI registered for one compatibility window, but never
 * start Codex, inspect credential directories, or report authorization state.
 * Bridge v2 will replace these channels with ticket-bound trusted commands.
 */
export function registerCodexExecutorIpc(
  options: RegisterCodexExecutorIpcOptions = {}
): void {
  const registrar = options.registrar ?? ipcMain;
  const bridge = options.bridgeV2Handlers ?? createCodexAuthorizationBridgeV2Handlers({
    ready: options.ready ?? CODEX_DESKTOP_AUTHORIZATION_RUNTIME_READY,
    runtimeProvider: options.runtimeProvider
  });

  registrar.handle(IPC_CHANNELS.codexExecutorAuthorize, async () => rejectLegacyCodexExecutorAuthorization());
  registrar.handle(IPC_CHANNELS.codexExecutorGetAuthStatus, async (_event, ...args: unknown[]) =>
    queryLegacyCodexExecutorAuthStatus(args)
  );

  // Production passes no runtime provider and keeps the independent ready gate
  // false. Tests may inject either the already-gated handler set or a provider.
  registrar.handle(IPC_CHANNELS.codexAuthorizationGetCapabilities, async (_event, ...args: unknown[]) =>
    invokeNoArguments(args, bridge.getCapabilities)
  );
  registrar.handle(IPC_CHANNELS.codexAuthorizationStart, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, bridge.start)
  );
  registrar.handle(IPC_CHANNELS.codexAuthorizationGetSnapshot, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, bridge.getSnapshot)
  );
  registrar.handle(IPC_CHANNELS.codexAuthorizationCancel, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, bridge.cancel)
  );
  registrar.handle(IPC_CHANNELS.codexAuthorizationReopen, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, bridge.reopen)
  );
  registrar.handle(IPC_CHANNELS.codexAuthorizationVerify, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, bridge.verify)
  );
  registrar.handle(IPC_CHANNELS.codexAuthorizationCheckReadiness, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, bridge.readiness)
  );
  registrar.handle(IPC_CHANNELS.codexAuthorizationGetModelCatalog, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, bridge.getCatalog)
  );
  registrar.handle(IPC_CHANNELS.codexAuthorizationRefreshModelCatalog, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, bridge.refresh)
  );
  registrar.handle(IPC_CHANNELS.codexAuthorizationLogout, async (_event, ...args: unknown[]) =>
    invokeSingleArgument(args, bridge.logout)
  );
}
