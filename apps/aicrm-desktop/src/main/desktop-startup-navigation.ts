export type DesktopStartupPhase = "loading" | "ready" | "offline" | "disposed";

export interface DesktopStartupDiagnostic {
  event: "startup_navigation_failed" | "startup_navigation_timeout" | "startup_navigation_retry";
  host: string | null;
  errorCode: number | null;
}

export interface DesktopStartupNavigationOptions {
  webUrl: string;
  offlineUrl: string;
  loadUrl: (url: string) => void | Promise<unknown>;
  showWindow: () => void;
  isWebUrl: (url: string) => boolean;
  log: (diagnostic: DesktopStartupDiagnostic) => void;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  shellDelayMs?: number;
  navigationTimeoutMs?: number;
}

function safeHost(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname || null;
  } catch {
    return null;
  }
}

export function createDesktopStartupNavigationController(options: DesktopStartupNavigationOptions) {
  const schedule = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const shellDelayMs = options.shellDelayMs ?? 5_000;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 60_000;
  let phase: DesktopStartupPhase = "loading";
  let shellTimer: unknown = null;
  let navigationTimer: unknown = null;
  let shown = false;

  const attemptLoad = (url: string, onError: () => void) => {
    try {
      void Promise.resolve(options.loadUrl(url)).catch(onError);
    } catch {
      onError();
    }
  };

  const clear = (timer: unknown) => {
    if (timer !== null) cancel(timer);
  };
  const showShell = () => {
    if (phase === "disposed" || shown) return;
    shown = true;
    clear(shellTimer);
    shellTimer = null;
    options.showWindow();
  };
  const clearNavigationTimeout = () => {
    clear(navigationTimer);
    navigationTimer = null;
  };
  const loadOffline = (event: DesktopStartupDiagnostic["event"], errorCode: number | null) => {
    if (phase !== "loading") return false;
    phase = "offline";
    clearNavigationTimeout();
    options.log({ event, host: safeHost(options.webUrl), errorCode });
    attemptLoad(options.offlineUrl, () => undefined);
    return true;
  };
  const armTimeout = () => {
    clearNavigationTimeout();
    navigationTimer = schedule(() => loadOffline("startup_navigation_timeout", null), navigationTimeoutMs);
  };
  const navigateToWeb = (isRetry: boolean) => {
    if (phase === "disposed") return false;
    phase = "loading";
    armTimeout();
    if (isRetry) options.log({ event: "startup_navigation_retry", host: safeHost(options.webUrl), errorCode: null });
    attemptLoad(options.webUrl, () => {
      loadOffline("startup_navigation_failed", null);
    });
    return true;
  };

  return {
    start() {
      if (phase === "disposed") return;
      shellTimer = schedule(showShell, shellDelayMs);
      navigateToWeb(false);
    },
    onReadyToShow() {
      showShell();
    },
    onMainFrameFinished(url: string) {
      if (phase !== "loading" || !options.isWebUrl(url)) return false;
      phase = "ready";
      clearNavigationTimeout();
      showShell();
      return true;
    },
    onMainFrameFailed(errorCode: number, url: string, isMainFrame: boolean) {
      if (!isMainFrame || errorCode === -3 || phase !== "loading" || url.startsWith("kww-offline:")) return false;
      return loadOffline("startup_navigation_failed", errorCode);
    },
    retry() {
      return navigateToWeb(true);
    },
    dispose() {
      if (phase === "disposed") return;
      phase = "disposed";
      clear(shellTimer);
      clearNavigationTimeout();
      shellTimer = navigationTimer = null;
    },
    get phase() {
      return phase;
    }
  };
}
