import type { MatrixAccountWebSpaceSnapshotResult } from "@ky/admin-core";

const sensitiveKeyPattern =
  /cookie|storage|token|password|passwd|secret|authorization|credential|captcha|sms|otp|mfa|indexeddb|localstorage|sessionstorage/i;

export interface AiSafePageContext {
  platform: MatrixAccountWebSpaceSnapshotResult["platform"];
  url: string;
  title: string;
  pageFingerprint: string;
  visibleText: string;
  domSummary: unknown;
  accessibilityTree: unknown;
  elementRects: MatrixAccountWebSpaceSnapshotResult["elementRects"];
  screenshotAvailable: boolean;
}

/**
 * Creates the only page context allowed to cross into an AI repair task.
 *
 * Deliberately omitted: sensitiveContext, browserPartition, WebSpace id and the
 * screenshot bytes. Unknown nested fields are filtered again even though the
 * desktop snapshot is already expected to be structurally sanitized.
 */
export function sanitizeMatrixAccountSnapshotForAi(
  snapshot: MatrixAccountWebSpaceSnapshotResult
): AiSafePageContext {
  return {
    platform: snapshot.platform,
    url: sanitizeUrl(snapshot.url),
    title: sanitizeDiagnosticText(snapshot.title, 240),
    pageFingerprint: snapshot.pageFingerprint,
    visibleText: sanitizeDiagnosticText(snapshot.visibleText, 5_000),
    domSummary: sanitizeUnknownContext(snapshot.domSummary),
    accessibilityTree: sanitizeUnknownContext(snapshot.accessibilityTree),
    elementRects: (snapshot.elementRects ?? []).slice(0, 80).map((item) => ({
      key: sanitizeDiagnosticText(item.key, 120),
      text: item.text ? sanitizeDiagnosticText(item.text, 240) : undefined,
      selector: item.selector ? sanitizeDiagnosticText(item.selector, 500) : undefined,
      rect: {
        x: finiteNumber(item.rect?.x),
        y: finiteNumber(item.rect?.y),
        width: finiteNumber(item.rect?.width),
        height: finiteNumber(item.rect?.height)
      }
    })),
    screenshotAvailable: Boolean(snapshot.screenshotDataUrl)
  };
}

export function sanitizeDiagnosticText(value: unknown, maxLength = 2_000): string {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b([a-z0-9_-]*(?:token|secret|session|cookie|authorization)[a-z0-9_-]*)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .replace(/\b1[3-9]\d{9}\b/g, "[REDACTED_PHONE]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .slice(0, Math.max(0, maxLength));
}

function sanitizeUrl(value: unknown): string {
  try {
    const url = new URL(String(value ?? ""));
    return `${url.origin}${url.pathname}`;
  } catch {
    return sanitizeDiagnosticText(value, 1_000).split(/[?#]/, 1)[0] ?? "";
  }
}

function sanitizeUnknownContext(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 400).map((entry) => sanitizeUnknownContext(entry, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? sanitizeDiagnosticText(value) : value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKeyPattern.test(key)) continue;
    output[key] = sanitizeUnknownContext(entry, depth + 1);
  }
  return output;
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
