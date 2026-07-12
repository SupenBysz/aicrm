export interface ControlledWindowCloseTarget {
  isDestroyed(): boolean;
  close(): void;
  destroy(): void;
  once(event: "closed", listener: () => void): unknown;
}

type Delay = (ms: number) => Promise<void>;

const defaultDelay: Delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function controlledWindowReleaseMode(input: {
  releaseWindowOnDetect?: boolean;
  hasDetectedIdentity: boolean;
}): "before_detect" | "after_detect" | "keep" {
  if (input.releaseWindowOnDetect === true) return "before_detect";
  if (input.hasDetectedIdentity && input.releaseWindowOnDetect !== false) return "after_detect";
  return "keep";
}

export async function closeControlledWindow(
  target: ControlledWindowCloseTarget,
  delay: Delay = defaultDelay
): Promise<boolean> {
  if (target.isDestroyed()) return true;
  const closed = new Promise<boolean>((resolve) => target.once("closed", () => resolve(true)));
  target.close();
  let released = await Promise.race([closed, delay(1500).then(() => false)]);
  if (!released && !target.isDestroyed()) {
    target.destroy();
    released = await Promise.race([closed, delay(500).then(() => target.isDestroyed())]);
  }
  return released || target.isDestroyed();
}
