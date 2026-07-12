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

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
