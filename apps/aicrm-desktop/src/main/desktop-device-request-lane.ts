/**
 * Main-owned serialization boundary for every device-signed request.
 *
 * Sequence allocation alone is insufficient: if request N+1 reaches the
 * server before request N, the persistent high-water fence correctly rejects
 * N as a replay. Every heartbeat, claim, proof and ACK must therefore hold the
 * same lane from before signing until its response (or transport failure) is
 * fully consumed.
 */
export class DesktopDeviceRequestLane {
  private tail: Promise<void> = Promise.resolve();
  private pinnedReference: string | null = null;
  private readonly unpinnedWaiters = new Set<() => void>();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.pinnedReference !== null) {
        throw new DesktopDeviceRequestLanePinnedError();
      }
      return operation();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Runs an exact-replay-capable request. If the operation leaves a durable
   * unsigned-response journal behind, the lane stays pinned to that semantic
   * request until the same reference obtains and persists a response.
   */
  runPinned<T>(
    reference: string,
    operation: () => Promise<T>,
    shouldRemainPinned: () => boolean | Promise<boolean>
  ): Promise<T> {
    assertReference(reference);
    const result = this.tail.then(async () => {
      if (this.pinnedReference !== null && this.pinnedReference !== reference) {
        throw new DesktopDeviceRequestLanePinnedError();
      }
      try {
        const value = await operation();
        if (this.pinnedReference === reference) this.clearPin();
        return value;
      } catch (error) {
        try {
          if (await shouldRemainPinned()) {
            this.pinnedReference = reference;
          } else if (this.pinnedReference === reference) {
            this.clearPin();
          }
        } catch {
          this.pinnedReference = reference;
        }
        throw error;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Resolves only after the restored ambiguous request has been recovered.
   * This observer deliberately does not join `tail`: doing so would prevent
   * the exact `runPinned` recovery operation from reaching the head.
   */
  waitUntilUnpinned(): Promise<void> {
    return this.tail.then(() => {
      if (this.pinnedReference === null) return;
      return new Promise<void>((resolve) => {
        this.unpinnedWaiters.add(resolve);
      });
    });
  }

  /** Restores the single unresolved request fence before heartbeat startup. */
  restorePin(reference: string): Promise<void> {
    assertReference(reference);
    const result = this.tail.then(() => {
      if (this.pinnedReference !== null && this.pinnedReference !== reference) {
        throw new DesktopDeviceRequestLanePinnedError();
      }
      this.pinnedReference = reference;
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private clearPin(): void {
    this.pinnedReference = null;
    const waiters = [...this.unpinnedWaiters];
    this.unpinnedWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}

export class DesktopDeviceRequestLanePinnedError extends Error {
  readonly code = "desktop_device_request_lane_pinned";

  constructor() {
    super("设备请求存在待恢复的签名序列");
  }
}

function assertReference(reference: string): void {
  if (!/^[0-9a-f]{64}$/.test(reference)) {
    throw new TypeError("设备请求引用无效");
  }
}
