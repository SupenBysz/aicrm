import type {
  DesktopApiRequest,
  DesktopApiResponse,
  AiExecutorTerminalWindowInput,
  AiExecutorTerminalWindowResult,
  CodexAuthorizationCapabilities,
  CodexAuthorizationChangedEvent,
  CodexAuthorizationSnapshot,
  CodexAuthorizationStartInput,
  CodexCredentialLogoutCommandInput,
  CodexExecutorAuthStatusProjection,
  CodexModelCatalogRefreshCommandInput,
  CodexModelCatalogSnapshot,
  CodexReadinessCheckCommandInput,
  CodexSessionCommandInput,
  CodexVerifyCommandInput,
  DesktopConfig,
  DesktopCommandResult,
  DesktopDeviceIdentityProjection,
  MatrixAccountBrowserInput,
  MatrixAccountBrowserResult,
  MatrixAccountCapabilities,
  MatrixAccountCheckResult,
  MatrixAccountClearProfileResult,
  MatrixAccountLoginStatePayload,
  MatrixAccountOnboardingCancelInput,
  MatrixAccountOnboardingEvent,
  MatrixAccountOnboardingLookupInput,
  MatrixAccountOnboardingQrCodeView,
  MatrixAccountOnboardingQrInput,
  MatrixAccountOnboardingRefreshQrInput,
  MatrixAccountOnboardingStartInput,
  MatrixAccountOnboardingView,
  MatrixAccountSessionSnapshotRestoreInput,
  MatrixAccountSessionSnapshotRestoreResult,
  MatrixAccountSessionSnapshotSealInput,
  MatrixAccountSessionSnapshotVerificationResult,
  MatrixAccountSessionSnapshotVerifyInput,
  MatrixAccountSessionWebSpaceCleanupInput,
  MatrixAccountSessionWebSpaceCleanupResult,
  MatrixAccountWebSpaceBrowserResult,
  MatrixAccountWebSpaceClearResult,
  MatrixAccountWebSpaceDetectResult,
  MatrixAccountWebSpaceInput,
  MatrixAccountWebSpaceScriptInput,
  MatrixAccountWebSpaceScriptResult,
  MatrixAccountWebSpaceSnapshotInput,
  MatrixAccountWebSpaceSnapshotResult,
  MatrixAccountWebSpaceStatePayload,
  DesktopNetworkLogSnapshot,
  DesktopOpenDevToolsResult,
  DesktopSession,
  DesktopWindowState
} from "../shared/types";

export interface AiCrmDesktopBridge {
  api: {
    request: <T = unknown>(request: DesktopApiRequest) => Promise<DesktopApiResponse<T>>;
  };
  app: {
    getConfig: () => Promise<DesktopConfig>;
    getVersion: () => Promise<string>;
  };
  session: {
    load: () => Promise<DesktopSession | null>;
    save: (session: DesktopSession) => Promise<boolean>;
    clear: () => Promise<boolean>;
  };
  window: {
    getState: () => Promise<DesktopWindowState>;
    minimize: () => Promise<DesktopWindowState>;
    toggleMaximize: () => Promise<DesktopWindowState>;
    setFullScreen: (enabled: boolean) => Promise<DesktopWindowState>;
    setAlwaysOnTop: (enabled: boolean) => Promise<DesktopWindowState>;
    openDevTools: () => Promise<DesktopOpenDevToolsResult>;
    close: () => Promise<boolean>;
    onStateChanged: (listener: (state: DesktopWindowState) => void) => () => void;
  };
  network: {
    getSnapshot: () => Promise<DesktopNetworkLogSnapshot>;
    clear: () => Promise<DesktopNetworkLogSnapshot>;
  };
  aiExecutor: {
    openTerminalWindow: (
      input: AiExecutorTerminalWindowInput
    ) => Promise<DesktopCommandResult<AiExecutorTerminalWindowResult>>;
  };
  codex: {
    authorize: () => Promise<DesktopCommandResult<never>>;
    getAuthStatus: () => Promise<DesktopCommandResult<CodexExecutorAuthStatusProjection>>;
    authorization: {
      getCapabilities: () => Promise<DesktopCommandResult<CodexAuthorizationCapabilities>>;
      start: (input: CodexAuthorizationStartInput) => Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
      getSnapshot: (sessionId: string) => Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
      cancel: (input: CodexSessionCommandInput) => Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
      reopen: (input: CodexSessionCommandInput) => Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
      verify: (input: CodexVerifyCommandInput) => Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
      checkReadiness: (
        input: CodexReadinessCheckCommandInput
      ) => Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
      getModelCatalog: (executorId: string) => Promise<DesktopCommandResult<CodexModelCatalogSnapshot>>;
      refreshModelCatalog: (
        input: CodexModelCatalogRefreshCommandInput
      ) => Promise<DesktopCommandResult<CodexModelCatalogSnapshot>>;
      logout: (input: CodexCredentialLogoutCommandInput) => Promise<DesktopCommandResult<CodexAuthorizationSnapshot>>;
      onChanged: (listener: (event: CodexAuthorizationChangedEvent) => void) => () => void;
    };
  };
  desktopDevice: {
    getIdentity: () => Promise<DesktopCommandResult<DesktopDeviceIdentityProjection>>;
  };
  matrixAccount: {
    getCapabilities: () => Promise<DesktopCommandResult<MatrixAccountCapabilities>>;
    startLogin: (input: MatrixAccountBrowserInput) => Promise<DesktopCommandResult<MatrixAccountBrowserResult>>;
    openAccount: (input: MatrixAccountBrowserInput) => Promise<DesktopCommandResult<MatrixAccountBrowserResult>>;
    checkSession: (input: MatrixAccountBrowserInput) => Promise<DesktopCommandResult<MatrixAccountCheckResult>>;
    clearProfile: (input: MatrixAccountBrowserInput) => Promise<DesktopCommandResult<MatrixAccountClearProfileResult>>;
    onLoginStateChanged: (listener: (payload: MatrixAccountLoginStatePayload) => void) => () => void;
    createWebSpaceLogin: (input: MatrixAccountWebSpaceInput) => Promise<DesktopCommandResult<MatrixAccountWebSpaceBrowserResult>>;
    openWebSpace: (input: MatrixAccountWebSpaceInput) => Promise<DesktopCommandResult<MatrixAccountWebSpaceBrowserResult>>;
    detectWebSpaceAccount: (input: MatrixAccountWebSpaceInput) => Promise<DesktopCommandResult<MatrixAccountWebSpaceDetectResult>>;
    clearWebSpace: (input: MatrixAccountWebSpaceInput) => Promise<DesktopCommandResult<MatrixAccountWebSpaceClearResult>>;
    captureWebSpaceSnapshot: (
      input: MatrixAccountWebSpaceSnapshotInput
    ) => Promise<DesktopCommandResult<MatrixAccountWebSpaceSnapshotResult>>;
    runWebSpaceLoginScript: (
      input: MatrixAccountWebSpaceScriptInput
    ) => Promise<DesktopCommandResult<MatrixAccountWebSpaceScriptResult>>;
    onWebSpaceStateChanged: (listener: (payload: MatrixAccountWebSpaceStatePayload) => void) => () => void;
    startAccountOnboarding: (
      input: MatrixAccountOnboardingStartInput
    ) => Promise<DesktopCommandResult<MatrixAccountOnboardingView>>;
    getAccountOnboarding: (
      input: MatrixAccountOnboardingLookupInput
    ) => Promise<DesktopCommandResult<MatrixAccountOnboardingView>>;
    getLoginQrCode: (
      input: MatrixAccountOnboardingQrInput
    ) => Promise<DesktopCommandResult<MatrixAccountOnboardingQrCodeView>>;
    refreshLoginQrCode: (
      input: MatrixAccountOnboardingRefreshQrInput
    ) => Promise<DesktopCommandResult<MatrixAccountOnboardingQrCodeView>>;
    cancelAccountOnboarding: (
      input: MatrixAccountOnboardingCancelInput
    ) => Promise<DesktopCommandResult<MatrixAccountOnboardingView>>;
    sealSessionSnapshot: (
      input: MatrixAccountSessionSnapshotSealInput
    ) => Promise<DesktopCommandResult<MatrixAccountSessionSnapshotVerificationResult>>;
    verifySessionSnapshot: (
      input: MatrixAccountSessionSnapshotVerifyInput
    ) => Promise<DesktopCommandResult<MatrixAccountSessionSnapshotVerificationResult>>;
    restoreSessionSnapshot: (
      input: MatrixAccountSessionSnapshotRestoreInput
    ) => Promise<DesktopCommandResult<MatrixAccountSessionSnapshotRestoreResult>>;
    cleanupSessionWebSpace: (
      input: MatrixAccountSessionWebSpaceCleanupInput
    ) => Promise<DesktopCommandResult<MatrixAccountSessionWebSpaceCleanupResult>>;
    onAccountOnboardingEvent: (listener: (payload: MatrixAccountOnboardingEvent) => void) => () => void;
  };
}
