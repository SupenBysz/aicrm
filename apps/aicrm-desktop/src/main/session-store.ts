import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { DesktopSession } from "../shared/types";

const SESSION_FILE = "session.json";

function sessionPath() {
  return join(app.getPath("userData"), SESSION_FILE);
}

function isSession(value: unknown): value is DesktopSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<DesktopSession>;
  return typeof session.token === "string" && typeof session.expiresAt === "string";
}

export async function loadSession(): Promise<DesktopSession | null> {
  try {
    const raw = await readFile(sessionPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveSession(session: DesktopSession): Promise<void> {
  if (!isSession(session)) {
    throw new Error("Invalid desktop session payload");
  }
  const target = sessionPath();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(session, null, 2), { mode: 0o600 });
}

export async function clearSession(): Promise<void> {
  await rm(sessionPath(), { force: true });
}
