import path from "node:path";
import { app, safeStorage } from "electron";
import { DesktopCredentialTreeManager } from "./desktop-credential-tree-manager.ts";

const VAULT_DIRECTORY = "agent-executor-credential-vault";
let singleton: DesktopCredentialTreeManager | null = null;

/**
 * Returns the unique Main-owned credential Vault. This module is deliberately
 * not mounted into IPC or preload; local executor integration must stay in Main.
 */
export function getDesktopCredentialTreeManager(): DesktopCredentialTreeManager {
  if (singleton !== null) return singleton;
  if (!app.isReady()) {
    throw new Error("Desktop credential Vault requires Electron app readiness");
  }
  singleton = new DesktopCredentialTreeManager({
    root: path.join(app.getPath("userData"), VAULT_DIRECTORY),
    safeStorage
  });
  return singleton;
}
