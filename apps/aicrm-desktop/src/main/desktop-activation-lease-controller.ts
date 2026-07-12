import type {
  DesktopAuthorizationTransportClient,
  DesktopTrustedTransportResult,
  RenewDesktopCredentialActivationLeaseInput,
  RenewDesktopCredentialActivationLeaseResponse
} from "./desktop-authorization-transport-client.ts";

export const DESKTOP_ACTIVATION_LEASE_RENEWAL_INTERVAL_MS = 10_000;
export const DESKTOP_ACTIVATION_LEASE_REQUEST_TIMEOUT_MS = 5_000;

type RenewalResult = DesktopTrustedTransportResult<RenewDesktopCredentialActivationLeaseResponse>;
type SetTimer = (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
type ClearTimer = (timer: ReturnType<typeof setTimeout>) => void;

interface ActivationLeaseTransport
  extends Pick<
    DesktopAuthorizationTransportClient,
    "renewCredentialActivationLease" | "completeRequest"
  > {}

export interface DesktopActivationLeaseFenceStore {
  persistRenewal(
    target: RenewDesktopCredentialActivationLeaseInput,
    result: RenewalResult
  ): Promise<void>;
}

export type DesktopActivationLeaseControllerErrorCode =
  | "desktop_activation_lease_conflict"
  | "desktop_activation_lease_fresh_required"
  | "desktop_activation_lease_not_started";

export class DesktopActivationLeaseControllerError extends Error {
  readonly code: DesktopActivationLeaseControllerErrorCode;

  constructor(code: DesktopActivationLeaseControllerErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DesktopActivationLeaseControllerOptions {
  transport: ActivationLeaseTransport;
  fenceStore: DesktopActivationLeaseFenceStore;
  intervalMs?: number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  onRenewalFailure?: (error: unknown) => void;
}

/**
 * Main-only owner of the 30-second Desktop activation lease. Every successful
 * response is durably fenced before its exact outbound request is completed.
 */
export class DesktopActivationLeaseController {
  private readonly transport: ActivationLeaseTransport;
  private readonly fenceStore: DesktopActivationLeaseFenceStore;
  private readonly intervalMs: number;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly onRenewalFailure: (error: unknown) => void;
  private target: RenewDesktopCredentialActivationLeaseInput | null = null;
  private inFlight: Promise<RenewalResult> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private generation = 0;

  constructor(options: DesktopActivationLeaseControllerOptions) {
    this.transport = options.transport;
    this.fenceStore = options.fenceStore;
    this.intervalMs = positiveInteger(
      options.intervalMs ?? DESKTOP_ACTIVATION_LEASE_RENEWAL_INTERVAL_MS
    );
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.onRenewalFailure = options.onRenewalFailure ?? (() => undefined);
  }

  async start(
    target: RenewDesktopCredentialActivationLeaseInput
  ): Promise<RenewDesktopCredentialActivationLeaseResponse> {
    const validated = cloneTarget(target);
    if (this.target !== null && !sameTarget(this.target, validated)) {
      throw leaseError("desktop_activation_lease_conflict", "已有其他激活租约正在运行");
    }
    this.clearScheduledTimer();
    this.target = validated;
    this.running = true;
    const generation = ++this.generation;
    try {
      const result = await this.renewFresh(validated);
      if (this.running && generation === this.generation) this.schedule(generation);
      return { ...result.data };
    } catch (error) {
      if (generation === this.generation) this.running = false;
      throw error;
    }
  }

  async renewNow(): Promise<RenewDesktopCredentialActivationLeaseResponse> {
    if (this.target === null) {
      throw leaseError("desktop_activation_lease_not_started", "激活租约尚未启动");
    }
    return { ...(await this.renewFresh(this.target)).data };
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    this.clearScheduledTimer();
    const current = this.inFlight;
    if (current) await current;
  }

  async stopAndRenewFresh(): Promise<RenewDesktopCredentialActivationLeaseResponse> {
    if (this.target === null) {
      throw leaseError("desktop_activation_lease_not_started", "激活租约尚未启动");
    }
    const target = cloneTarget(this.target);
    await this.stop();
    return { ...(await this.renewFresh(target)).data };
  }

  clear(): void {
    if (this.inFlight !== null) {
      throw leaseError("desktop_activation_lease_conflict", "激活租约请求尚未结束");
    }
    this.running = false;
    this.generation += 1;
    this.clearScheduledTimer();
    this.target = null;
  }

  private renewFresh(
    target: RenewDesktopCredentialActivationLeaseInput
  ): Promise<RenewalResult> {
    if (this.inFlight !== null) return this.inFlight;
    const operation = this.performFreshRenewal(target);
    this.inFlight = operation;
    void operation
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
      })
      .catch(() => undefined);
    return operation;
  }

  private async performFreshRenewal(
    target: RenewDesktopCredentialActivationLeaseInput
  ): Promise<RenewalResult> {
    const first = await this.performOne(target);
    if (!first.recovered && !first.data.replayed) return first;
    const fresh = await this.performOne(target);
    if (fresh.recovered || fresh.data.replayed) {
      throw leaseError(
        "desktop_activation_lease_fresh_required",
        "激活租约恢复后仍需新的受信续租"
      );
    }
    return fresh;
  }

  private async performOne(
    target: RenewDesktopCredentialActivationLeaseInput
  ): Promise<RenewalResult> {
    const result = await this.transport.renewCredentialActivationLease(target);
    await this.fenceStore.persistRenewal(target, result);
    await this.transport.completeRequest(result.requestReference, result.requestHash);
    return result;
  }

  private schedule(generation: number): void {
    this.clearScheduledTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.running || generation !== this.generation || this.target === null) return;
      void this.renewFresh(this.target)
        .then(() => {
          if (this.running && generation === this.generation) this.schedule(generation);
        })
        .catch((error: unknown) => {
          if (generation === this.generation) this.running = false;
          this.onRenewalFailure(error);
        });
    }, this.intervalMs);
  }

  private clearScheduledTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}

function cloneTarget(
  value: RenewDesktopCredentialActivationLeaseInput
): RenewDesktopCredentialActivationLeaseInput {
  const keys = [
    "sessionId",
    "activationToken",
    "operationId",
    "activationId",
    "credentialRevision",
    "leaseEpoch",
    "sourceCredentialRevision",
    "revocationEpoch",
    "bindingDigest"
  ] as const;
  const actual = value && typeof value === "object" ? Object.keys(value).sort() : [];
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw leaseError("desktop_activation_lease_conflict", "激活租约目标结构无效");
  }
  return {
    sessionId: value.sessionId,
    activationToken: value.activationToken,
    operationId: value.operationId,
    activationId: value.activationId,
    credentialRevision: value.credentialRevision,
    leaseEpoch: value.leaseEpoch,
    sourceCredentialRevision: value.sourceCredentialRevision,
    revocationEpoch: value.revocationEpoch,
    bindingDigest: value.bindingDigest
  };
}

function sameTarget(
  left: RenewDesktopCredentialActivationLeaseInput,
  right: RenewDesktopCredentialActivationLeaseInput
): boolean {
  const keys = Object.keys(left) as Array<keyof RenewDesktopCredentialActivationLeaseInput>;
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("激活租约续租周期无效");
  }
  return value;
}

function leaseError(
  code: DesktopActivationLeaseControllerErrorCode,
  message: string
): DesktopActivationLeaseControllerError {
  return new DesktopActivationLeaseControllerError(code, message);
}
