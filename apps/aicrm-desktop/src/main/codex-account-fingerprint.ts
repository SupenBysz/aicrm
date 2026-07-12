import { createHash } from "node:crypto";
import type { CodexChatGPTAccount } from "./codex-app-server-auth-client.ts";

const MAX_ACCOUNT_TYPE_BYTES = 64;
const MAX_ACCOUNT_EMAIL_BYTES = 320;

/**
 * Stable cross-runtime account identity. planType is intentionally excluded so
 * subscription changes never look like a different authorized account.
 */
export function codexAccountFingerprint(
  account: Pick<CodexChatGPTAccount, "type" | "email">
): string {
  const type = normalizedPart(account?.type, MAX_ACCOUNT_TYPE_BYTES, false);
  const email = normalizedPart(account?.email, MAX_ACCOUNT_EMAIL_BYTES, true);
  return createHash("sha256").update(`${type}\n${email}`, "utf8").digest("hex");
}

function normalizedPart(
  value: string | null | undefined,
  maximumBytes: number,
  lowercase: boolean
): string {
  if (typeof value !== "string") throw new TypeError("Codex 账号身份字段缺失");
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    Buffer.byteLength(trimmed, "utf8") > maximumBytes ||
    Array.from(trimmed).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new TypeError("Codex 账号身份字段无效");
  }
  return lowercase ? trimmed.toLowerCase() : trimmed;
}
