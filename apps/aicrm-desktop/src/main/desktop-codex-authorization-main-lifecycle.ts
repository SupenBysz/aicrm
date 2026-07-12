export type DesktopCodexAuthorizationMainLifecycleState =
  | "idle"
  | "initializing"
  | "ready"
  | "failed"
  | "stopping"
  | "stopped";

export interface DesktopCodexAuthorizationMainLifecycleOptions {
  waitForRequestFence(): Promise<unknown>;
  initializeCredentials(): Promise<void>;
  recoverOnStartup(): Promise<unknown>;
  shutdownRuntime(): Promise<void>;
}

export interface DesktopBeforeQuitEvent {
  preventDefault(): void;
}

export interface DesktopCodexAuthorizationQuitFenceOptions {
  shutdown(): Promise<void>;
  quit(): void;
}

export class DesktopCodexAuthorizationMainLifecycleError extends Error {
  readonly code = "desktop_codex_authorization_main_unavailable" as const;

  constructor() {
    super("Codex 授权 Main 运行时不可用");
    this.name = "DesktopCodexAuthorizationMainLifecycleError";
    this.stack = `${this.name}: ${this.message}`;
  }
}

/** Keeps every quit request blocked until the one Main shutdown is settled. */
export class DesktopCodexAuthorizationQuitFence {
  private readonly shutdownRuntime: DesktopCodexAuthorizationQuitFenceOptions["shutdown"];
  private readonly quitApplication: DesktopCodexAuthorizationQuitFenceOptions["quit"];
  private state: "idle" | "stopping" | "stopped" = "idle";

  constructor(options: DesktopCodexAuthorizationQuitFenceOptions) {
    if (!options || typeof options.shutdown !== "function" || typeof options.quit !== "function") {
      throw lifecycleError();
    }
    this.shutdownRuntime = options.shutdown;
    this.quitApplication = options.quit;
  }

  handleBeforeQuit(event: DesktopBeforeQuitEvent): void {
    if (this.state === "stopped") return;
    if (!event || typeof event.preventDefault !== "function") throw lifecycleError();
    event.preventDefault();
    if (this.state === "stopping") return;
    this.state = "stopping";
    void Promise.resolve()
      .then(() => this.shutdownRuntime())
      .catch(() => undefined)
      .then(() => {
        this.state = "stopped";
        this.quitApplication();
      });
  }
}

/** One-shot production readiness and shutdown fence with no Electron dependency. */
export class DesktopCodexAuthorizationMainLifecycle {
  private readonly waitForRequestFence: DesktopCodexAuthorizationMainLifecycleOptions["waitForRequestFence"];
  private readonly initializeCredentials: DesktopCodexAuthorizationMainLifecycleOptions["initializeCredentials"];
  private readonly recoverOnStartup: DesktopCodexAuthorizationMainLifecycleOptions["recoverOnStartup"];
  private readonly shutdownRuntime: DesktopCodexAuthorizationMainLifecycleOptions["shutdownRuntime"];
  private state: DesktopCodexAuthorizationMainLifecycleState = "idle";
  private initializePromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: DesktopCodexAuthorizationMainLifecycleOptions) {
    if (
      !options ||
      typeof options.waitForRequestFence !== "function" ||
      typeof options.initializeCredentials !== "function" ||
      typeof options.recoverOnStartup !== "function" ||
      typeof options.shutdownRuntime !== "function"
    ) {
      throw lifecycleError();
    }
    this.waitForRequestFence = options.waitForRequestFence;
    this.initializeCredentials = options.initializeCredentials;
    this.recoverOnStartup = options.recoverOnStartup;
    this.shutdownRuntime = options.shutdownRuntime;
  }

  getState(): DesktopCodexAuthorizationMainLifecycleState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === "ready";
  }

  initialize(): Promise<void> {
    if (
      (this.state === "initializing" || this.state === "ready") &&
      this.initializePromise
    ) {
      return this.initializePromise;
    }
    if (this.state !== "idle") return Promise.reject(lifecycleError());
    this.state = "initializing";
    const operation = this.performInitialize();
    this.initializePromise = operation;
    void operation.catch(() => undefined);
    return operation;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.state === "stopped") return Promise.resolve();
    this.state = "stopping";
    const operation = this.performShutdown();
    this.shutdownPromise = operation;
    void operation.catch(() => undefined);
    return operation;
  }

  private async performInitialize(): Promise<void> {
    try {
      await this.waitForRequestFence();
      await this.initializeCredentials();
      await this.recoverOnStartup();
      if (this.state === "initializing") this.state = "ready";
    } catch {
      if (this.state === "initializing") this.state = "failed";
      throw lifecycleError();
    }
  }

  private async performShutdown(): Promise<void> {
    const initializing = this.initializePromise;
    if (initializing) await initializing.catch(() => undefined);
    try {
      await this.shutdownRuntime();
    } catch {
      this.state = "stopped";
      throw lifecycleError();
    }
    this.state = "stopped";
  }
}

function lifecycleError(): DesktopCodexAuthorizationMainLifecycleError {
  return new DesktopCodexAuthorizationMainLifecycleError();
}
