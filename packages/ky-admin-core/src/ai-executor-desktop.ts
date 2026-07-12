import type { DesktopCommandResult } from "./matrix-account-desktop";

export interface CodexAuthorizationCapabilities {
  bridgeVersion: 2;
  supportsAppServerAuth: true;
  supportsDeviceProof: true;
  supportsSignedCatalog: true;
}

export interface CodexAuthorizationStartInput {
  sessionId: string;
  executorId: string;
  handoffId: string;
  handoffTicket: string;
}

export interface CodexSessionCommandInput {
  sessionId: string;
  operationId: string;
  expectedSessionRevision: number;
  commandTicket: string;
}

export interface CodexVerifyCommandInput {
  executorId: string;
  operationId: string;
  expectedExecutorRevision: number;
  expectedCredentialRevision: number;
  commandTicket: string;
}

export interface CodexModelCatalogRefreshCommandInput {
  executorId: string;
  operationId: string;
  expectedExecutorRevision: number;
  expectedCatalogRevision: number;
  commandTicket: string;
}

export interface CodexReadinessCheckCommandInput {
  executorId: string;
  operationId: string;
  expectedExecutorRevision: number;
  expectedCredentialRevision: number;
  expectedCatalogRevision: number;
  commandTicket: string;
}

export interface CodexCredentialLogoutCommandInput {
  executorId: string;
  revocationId: string;
  operationId: string;
  credentialRevision: number;
  commandTicket: string;
}

export type CodexAuthorizationStatus =
  | "starting"
  | "waiting_user"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "interrupted"
  | "superseded";

export interface CodexAuthorizationSnapshot {
  sessionId: string;
  executorId: string;
  sequence: number;
  status: CodexAuthorizationStatus;
  canReopen: boolean;
  canCancel: boolean;
  localFailureCode?: string;
}

export interface CodexModelCatalogItem {
  modelKey: string;
  displayName: string;
  hidden: boolean;
  status: string;
}

export interface CodexModelCatalogSnapshot {
  executorId: string;
  catalogRevision: number;
  items: CodexModelCatalogItem[];
}

export interface CodexAuthorizationEventEnvelope {
  id: string;
  name: "codex.authorization.changed";
  version: 1;
  source: "aicrm-desktop";
  scope: "system";
  occurredAt: string;
  correlationId: string;
  payload: CodexAuthorizationSnapshot;
}

export interface CodexAuthorizationDesktopBridgeContract {
  getCapabilities: () => Promise<DesktopCommandResult<CodexAuthorizationCapabilities>>;
  start: (input: CodexAuthorizationStartInput) => Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  getSnapshot: (sessionId: string) => Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  cancel: (input: CodexSessionCommandInput) => Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  reopen: (input: CodexSessionCommandInput) => Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  verify: (input: CodexVerifyCommandInput) => Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
  checkReadiness: (input: CodexReadinessCheckCommandInput) => Promise<DesktopCommandResult<unknown>>;
  getModelCatalog: (executorId: string) => Promise<DesktopCommandResult<CodexModelCatalogSnapshot>>;
  refreshModelCatalog: (input: CodexModelCatalogRefreshCommandInput) => Promise<DesktopCommandResult<CodexModelCatalogSnapshot>>;
  logout: (input: CodexCredentialLogoutCommandInput) => Promise<DesktopCommandResult<unknown>>;
  onChanged: (listener: (event: CodexAuthorizationEventEnvelope) => void) => () => void;
}

export interface AiExecutorDesktopPort {
  isDesktopRuntime(): boolean;
  getAuthorizationBridge(): CodexAuthorizationDesktopBridgeContract | null;
}

let installedDesktopPort: AiExecutorDesktopPort | null = null;

export function installAiExecutorDesktopPort(port: AiExecutorDesktopPort): () => void {
  const previous = installedDesktopPort;
  installedDesktopPort = port;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (installedDesktopPort === port) installedDesktopPort = previous;
  };
}

export function isAiExecutorDesktopRuntime(): boolean {
  return installedDesktopPort?.isDesktopRuntime() ?? false;
}

export function getAiExecutorAuthorizationBridge(): CodexAuthorizationDesktopBridgeContract | null {
  return installedDesktopPort?.getAuthorizationBridge() ?? null;
}

export async function getCodexAuthorizationCapabilities(): Promise<CodexAuthorizationCapabilities | null> {
  const bridge = getAiExecutorAuthorizationBridge();
  if (!bridge) return null;
  const result = await bridge.getCapabilities();
  if (!result.ok || result.data?.bridgeVersion !== 2) return null;
  return result.data;
}
