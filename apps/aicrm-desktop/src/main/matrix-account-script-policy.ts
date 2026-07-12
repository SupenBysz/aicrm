import { createHash } from "node:crypto";
import type { MatrixAccountLoginScriptDsl, MatrixAccountLoginScriptPurpose } from "../shared/types";

export interface MatrixAccountScriptPolicyViolation {
  code: "sensitive_method_forbidden";
  message: string;
}

export interface LegacyCredentialAdapterSubstitution {
  scriptVersionId: string;
  expiresAt: string;
  reasonCode: "legacy_credential_adapter_substituted";
}

export type MatrixAccountScriptExecutionDecision =
  | { kind: "allow" }
  | { kind: "substitute"; substitution: LegacyCredentialAdapterSubstitution }
  | { kind: "deny"; violation: MatrixAccountScriptPolicyViolation };

const LEGACY_DOUYIN_ACCOUNT_DETECT_VERSION_ID = "malsv_643d906e3d4d52c6f30e31258e29a062";
const LEGACY_DOUYIN_ACCOUNT_DETECT_CANONICAL_SHA256 = "808c429273b69c2b4362516b62ca93556a0829154deb51c5b39d67239b819867";
const LEGACY_DOUYIN_ACCOUNT_DETECT_EXPIRES_AT = "2026-07-31T23:59:59+08:00";

/**
 * Temporary fail-closed bridge for the single credential-reading adapter that
 * was active before the policy boundary existed. A match never authorizes the
 * DSL: the caller must skip every original step and substitute the trusted
 * public DOM/URL detector. Version id, canonical payload hash and expiry must
 * all match so the compatibility marker cannot become a general bypass.
 */
export function getLegacyCredentialAdapterSubstitution(
  scriptVersionId: string,
  dsl: MatrixAccountLoginScriptDsl,
  now = Date.now()
): LegacyCredentialAdapterSubstitution | null {
  if (scriptVersionId !== LEGACY_DOUYIN_ACCOUNT_DETECT_VERSION_ID) return null;
  if (now > Date.parse(LEGACY_DOUYIN_ACCOUNT_DETECT_EXPIRES_AT)) return null;
  if (canonicalDslHash(dsl) !== LEGACY_DOUYIN_ACCOUNT_DETECT_CANONICAL_SHA256) return null;
  return {
    scriptVersionId,
    expiresAt: LEGACY_DOUYIN_ACCOUNT_DETECT_EXPIRES_AT,
    reasonCode: "legacy_credential_adapter_substituted"
  };
}

export function getMatrixAccountScriptPolicyViolation(
  _purpose: MatrixAccountLoginScriptPurpose,
  dsl: MatrixAccountLoginScriptDsl
): MatrixAccountScriptPolicyViolation | null {
  const readsSensitiveState = dsl.steps.some((step) => step.action === "readStorage" || step.action === "readIndexedDB");
  if (!readsSensitiveState) return null;
  return {
    code: "sensitive_method_forbidden",
    message: "登录脚本不得读取 Cookie、Storage 或 IndexedDB，请改用公开页面信息"
  };
}

/**
 * Central execution decision used at both the IPC boundary and immediately
 * before running steps. The exact legacy adapter is the only temporary
 * exception, and an exception always substitutes the original steps rather
 * than authorizing them.
 */
export function resolveMatrixAccountScriptExecutionDecision(
  scriptVersionId: string,
  purpose: MatrixAccountLoginScriptPurpose,
  dsl: MatrixAccountLoginScriptDsl,
  now = Date.now()
): MatrixAccountScriptExecutionDecision {
  const substitution = getLegacyCredentialAdapterSubstitution(scriptVersionId, dsl, now);
  if (substitution) return { kind: "substitute", substitution };
  const violation = getMatrixAccountScriptPolicyViolation(purpose, dsl);
  return violation ? { kind: "deny", violation } : { kind: "allow" };
}

function canonicalDslHash(dsl: MatrixAccountLoginScriptDsl): string {
  return createHash("sha256").update(JSON.stringify(sortCanonicalValue(dsl)), "utf8").digest("hex");
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortCanonicalValue(child)])
  );
}
