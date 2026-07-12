import { randomUUID } from "node:crypto";
import type {
  CodexAuthorizationChangedEvent,
  CodexAuthorizationSnapshot,
  CodexAuthorizationStatus
} from "../shared/types.ts";

const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_FAILURE_CODE = /^[a-z][a-z0-9_]{0,95}$/;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SNAPSHOT_KEYS = [
  "sessionId",
  "executorId",
  "sequence",
  "status",
  "canReopen",
  "canCancel"
] as const;
const SNAPSHOT_KEYS_WITH_FAILURE = [...SNAPSHOT_KEYS, "localFailureCode"] as const;
const STATUSES = new Set<CodexAuthorizationStatus>([
  "starting",
  "waiting_user",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "interrupted",
  "superseded"
]);

export const DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR = {
  code: "desktop_codex_authorization_event_invalid",
  message: "Codex 授权安全事件参数无效"
} as const;

export const DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR = {
  code: "desktop_codex_authorization_event_conflict",
  message: "Codex 授权安全事件代次冲突"
} as const;

export const DESKTOP_CODEX_AUTHORIZATION_EVENT_SINK_ERROR = {
  code: "desktop_codex_authorization_event_sink_failed",
  message: "Codex 授权安全事件发送失败"
} as const;

export type DesktopCodexAuthorizationEventErrorCode =
  | typeof DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR.code
  | typeof DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR.code
  | typeof DESKTOP_CODEX_AUTHORIZATION_EVENT_SINK_ERROR.code;

export class DesktopCodexAuthorizationEventError extends Error {
  readonly code: DesktopCodexAuthorizationEventErrorCode;

  constructor(
    code: DesktopCodexAuthorizationEventErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DesktopCodexAuthorizationEventError";
    this.code = code;
  }
}

export type DesktopCodexAuthorizationEventSink = (
  event: Readonly<CodexAuthorizationChangedEvent>
) => void | Promise<void>;

export interface DesktopCodexAuthorizationEventBroadcasterOptions {
  sink: DesktopCodexAuthorizationEventSink;
  now?: () => Date;
  idFactory?: () => string;
}

interface HighWater {
  readonly sequence: number;
  readonly payload: Readonly<CodexAuthorizationSnapshot>;
}

interface PendingDelivery extends HighWater {
  readonly event: Readonly<CodexAuthorizationChangedEvent>;
}

/**
 * Main-only safe event broadcaster. The in-memory high-water marks are solely
 * delivery-order fences; authorization truth must always be restored from the
 * durable session store through `restoreHighWater` before live publication.
 */
export class DesktopCodexAuthorizationEventBroadcaster {
  private readonly sink: DesktopCodexAuthorizationEventSink;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly highWater = new Map<string, HighWater>();
  private readonly pending = new Map<string, PendingDelivery>();
  private tail: Promise<void> = Promise.resolve();

  constructor(options: DesktopCodexAuthorizationEventBroadcasterOptions) {
    if (!options || typeof options.sink !== "function") throw invalidError();
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /**
   * Restores a delivery high-water mark from a durable session-store snapshot.
   * It never emits an event and may advance across gaps because the supplied
   * snapshot, not the event stream, is the business source of truth.
   */
  restoreHighWater(snapshot: unknown): Promise<void> {
    let payload: Readonly<CodexAuthorizationSnapshot>;
    try {
      payload = captureSnapshot(snapshot);
    } catch (error) {
      return Promise.reject(normalizePublicError(error));
    }
    return this.enqueue(async () => {
      const current = this.highWater.get(payload.sessionId);
      const pending = this.pending.get(payload.sessionId);
      if (pending) {
        if (
          current &&
          payload.sequence === current.sequence &&
          samePayload(payload, current.payload)
        ) {
          return;
        }
        throw conflictError();
      }
      if (current) {
        if (payload.sequence < current.sequence) throw conflictError();
        if (payload.sequence === current.sequence) {
          if (!samePayload(payload, current.payload)) throw conflictError();
          return;
        }
      }
      this.highWater.set(payload.sessionId, {
        sequence: payload.sequence,
        payload
      });
    });
  }

  /** Returns the emitted immutable envelope, or null for an exact duplicate. */
  broadcast(snapshot: unknown): Promise<Readonly<CodexAuthorizationChangedEvent> | null> {
    let payload: Readonly<CodexAuthorizationSnapshot>;
    try {
      payload = captureSnapshot(snapshot);
    } catch (error) {
      return Promise.reject(normalizePublicError(error));
    }
    return this.enqueue(async () => {
      const current = this.highWater.get(payload.sessionId);
      if (current) {
        if (payload.sequence < current.sequence) throw conflictError();
        if (payload.sequence === current.sequence) {
          if (!samePayload(payload, current.payload)) throw conflictError();
          return null;
        }
      }

      const pending = this.pending.get(payload.sessionId);
      let event: Readonly<CodexAuthorizationChangedEvent>;
      if (pending) {
        if (payload.sequence !== pending.sequence || !samePayload(payload, pending.payload)) {
          throw conflictError();
        }
        event = pending.event;
      } else {
        event = createEvent(payload, this.idFactory, this.now);
      }

      try {
        await this.sink(event);
      } catch {
        this.pending.set(payload.sessionId, {
          sequence: payload.sequence,
          payload,
          event
        });
        throw sinkError();
      }

      this.pending.delete(payload.sessionId);
      this.highWater.set(payload.sessionId, {
        sequence: payload.sequence,
        payload
      });
      return event;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result.catch((error: unknown) => {
      if (error instanceof DesktopCodexAuthorizationEventError) throw error;
      throw invalidError();
    });
  }
}

function captureSnapshot(value: unknown): Readonly<CodexAuthorizationSnapshot> {
  try {
    if (!isRecord(value)) throw invalidError();
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidError();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) throw invalidError();
    const keys = (ownKeys as string[]).sort();
    const hasFailureCode = keys.includes("localFailureCode");
    const expected = [...(hasFailureCode ? SNAPSHOT_KEYS_WITH_FAILURE : SNAPSHOT_KEYS)].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw invalidError();
    }
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of expected) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw invalidError();
      }
      descriptors.set(key, descriptor);
    }
    const sessionId = descriptors.get("sessionId")!.value;
    const executorId = descriptors.get("executorId")!.value;
    const sequence = descriptors.get("sequence")!.value;
    const status = descriptors.get("status")!.value;
    const canReopen = descriptors.get("canReopen")!.value;
    const canCancel = descriptors.get("canCancel")!.value;
    const localFailureCode = hasFailureCode
      ? descriptors.get("localFailureCode")!.value
      : undefined;
    if (
      !isSafeId(sessionId) ||
      !isSafeId(executorId) ||
      !isPositiveSequence(sequence) ||
      !isStatus(status) ||
      typeof canReopen !== "boolean" ||
      typeof canCancel !== "boolean" ||
      !validCanFlags(status, canReopen, canCancel) ||
      (hasFailureCode &&
        (typeof localFailureCode !== "string" ||
          !SAFE_FAILURE_CODE.test(localFailureCode)))
    ) {
      throw invalidError();
    }
    const snapshot: CodexAuthorizationSnapshot = {
      sessionId,
      executorId,
      sequence,
      status,
      canReopen,
      canCancel
    };
    if (hasFailureCode) snapshot.localFailureCode = localFailureCode as string;
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof DesktopCodexAuthorizationEventError) throw error;
    throw invalidError();
  }
}

function createEvent(
  payload: Readonly<CodexAuthorizationSnapshot>,
  idFactory: () => string,
  now: () => Date
): Readonly<CodexAuthorizationChangedEvent> {
  try {
    const id = idFactory();
    const instant = now();
    const occurredAt = instant instanceof Date ? instant.toISOString() : "";
    if (
      typeof id !== "string" ||
      !CANONICAL_UUID.test(id) ||
      !isCanonicalTime(occurredAt)
    ) {
      throw invalidError();
    }
    return Object.freeze({
      id,
      name: "codex.authorization.changed",
      version: 1,
      source: "aicrm-desktop",
      scope: "system",
      occurredAt,
      correlationId: payload.sessionId,
      payload
    });
  } catch (error) {
    if (error instanceof DesktopCodexAuthorizationEventError) throw error;
    throw invalidError();
  }
}

function validCanFlags(
  status: CodexAuthorizationStatus,
  canReopen: boolean,
  canCancel: boolean
): boolean {
  if (status === "waiting_user") return canReopen && canCancel;
  if (status === "starting" || status === "verifying") {
    return !canReopen && canCancel;
  }
  return !canReopen && !canCancel;
}

function samePayload(
  left: Readonly<CodexAuthorizationSnapshot>,
  right: Readonly<CodexAuthorizationSnapshot>
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.executorId === right.executorId &&
    left.sequence === right.sequence &&
    left.status === right.status &&
    left.canReopen === right.canReopen &&
    left.canCancel === right.canCancel &&
    left.localFailureCode === right.localFailureCode &&
    Object.prototype.hasOwnProperty.call(left, "localFailureCode") ===
      Object.prototype.hasOwnProperty.call(right, "localFailureCode")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isPositiveSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isStatus(value: unknown): value is CodexAuthorizationStatus {
  return typeof value === "string" && STATUSES.has(value as CodexAuthorizationStatus);
}

function isCanonicalTime(value: string): boolean {
  return (
    CANONICAL_UTC.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function invalidError(): DesktopCodexAuthorizationEventError {
  return new DesktopCodexAuthorizationEventError(
    DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR.code,
    DESKTOP_CODEX_AUTHORIZATION_EVENT_INVALID_ERROR.message
  );
}

function conflictError(): DesktopCodexAuthorizationEventError {
  return new DesktopCodexAuthorizationEventError(
    DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR.code,
    DESKTOP_CODEX_AUTHORIZATION_EVENT_CONFLICT_ERROR.message
  );
}

function sinkError(): DesktopCodexAuthorizationEventError {
  return new DesktopCodexAuthorizationEventError(
    DESKTOP_CODEX_AUTHORIZATION_EVENT_SINK_ERROR.code,
    DESKTOP_CODEX_AUTHORIZATION_EVENT_SINK_ERROR.message
  );
}

function normalizePublicError(error: unknown): DesktopCodexAuthorizationEventError {
  return error instanceof DesktopCodexAuthorizationEventError ? error : invalidError();
}
