import { EventEmitter, once } from "node:events";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const MAX_PROTOCOL_LINE_BYTES = 1 << 20;
const MAX_STDERR_BYTES = 256 << 10;
const MAX_COMPLETIONS = 32;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const CLIENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const USER_CODE_PATTERN = /^[A-Z0-9-]{4,64}$/;
const SAFE_PROTOCOL_TEXT_PATTERN = /^[\x20-\x7e]+$/;
const OFFICIAL_AUTH_HOSTS = new Set([
  "auth.openai.com",
  "platform.openai.com",
  "chatgpt.com"
]);
const SAFE_ENVIRONMENT_NAMES = new Set([
  "ALL_PROXY",
  "COMSPEC",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "WINDIR",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy"
]);
const PLAN_TYPES = new Set([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown"
]);

export const AICRM_CODEX_APP_SERVER_VERSION = "0.144.1";

export type CodexAppServerAuthErrorCode =
  | "executor_app_server_cancelled"
  | "executor_app_server_home_unsafe"
  | "executor_app_server_protocol_invalid"
  | "executor_app_server_rejected"
  | "executor_app_server_start_failed"
  | "executor_app_server_stop_failed"
  | "executor_app_server_stopped"
  | "executor_app_server_timeout"
  | "executor_app_server_unsupported";

export class CodexAppServerAuthError extends Error {
  readonly code: CodexAppServerAuthErrorCode;
  readonly rpcCode: number | null;

  constructor(
    code: CodexAppServerAuthErrorCode,
    message: string,
    options: { rpcCode?: number } = {}
  ) {
    super(message);
    this.code = code;
    this.rpcCode = Number.isSafeInteger(options.rpcCode) ? (options.rpcCode ?? null) : null;
  }
}

export interface CodexAppServerRuntimeInfo {
  userAgent: string;
  platformFamily: string;
  platformOs: string;
}

export interface CodexChatGPTAccount {
  type: "chatgpt";
  email: string | null;
  planType: string;
}

export interface CodexAccountReadResult {
  account: CodexChatGPTAccount | null;
  requiresOpenaiAuth: boolean;
}

export interface CodexBrowserLoginChallenge {
  type: "chatgpt";
  loginId: string;
  authUrl: string;
}

export interface CodexDeviceCodeLoginChallenge {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface CodexLoginCompletion {
  loginId: string;
  success: boolean;
}

export interface CodexAccountUpdate {
  authMode: string | null;
  planType: string | null;
}

interface JsonRpcPending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: CodexAppServerAuthError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LoginWaiter {
  resolve: (value: CodexLoginCompletion) => void;
  reject: (error: CodexAppServerAuthError) => void;
  signal: AbortSignal | null;
  abortHandler: (() => void) | null;
}

interface CodexLoginCompletionNotification {
  loginId: string | null;
  success: boolean;
}

type SpawnAppServer = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcessWithoutNullStreams;

export interface CodexAppServerAuthClientOptions {
  codexHome: string;
  clientName: string;
  clientTitle: string;
  clientVersion: string;
  codexExecutable?: string;
  expectedCodexVersion?: string;
  baseEnvironment?: NodeJS.ProcessEnv;
  spawn?: SpawnAppServer;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/**
 * Main-only, stdio-only Codex authorization protocol client.
 *
 * Raw protocol messages, stderr, auth URLs and login identifiers never leave
 * this object. The caller may use a validated URL directly with
 * `shell.openExternal`, but must not put it in snapshots, IPC, logs or storage.
 */
export class CodexAppServerAuthClient extends EventEmitter {
  private readonly codexHome: string;
  private readonly clientName: string;
  private readonly clientTitle: string;
  private readonly clientVersion: string;
  private readonly codexExecutable: string;
  private readonly expectedCodexVersion: string;
  private readonly baseEnvironment: NodeJS.ProcessEnv;
  private readonly spawnAppServer: SpawnAppServer;
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly pending = new Map<number, JsonRpcPending>();
  private readonly completions = new Map<string, CodexLoginCompletion>();
  private readonly loginWaiters = new Map<string, Set<LoginWaiter>>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrBytes = 0;
  private nextRequestId = 1;
  private writeTail: Promise<void> = Promise.resolve();
  private state: "idle" | "starting" | "ready" | "stopping" | "stopped" | "failed" =
    "idle";

  constructor(options: CodexAppServerAuthClientOptions) {
    super();
    this.codexHome = validateCodexHome(options.codexHome);
    this.clientName = validateClientName(options.clientName);
    this.clientTitle = validatePrintable(options.clientTitle, 120, "App Server 客户端标题无效");
    this.clientVersion = validatePrintable(options.clientVersion, 64, "App Server 客户端版本无效");
    this.codexExecutable = validateExecutable(options.codexExecutable ?? "codex");
    this.expectedCodexVersion = validateVersion(
      options.expectedCodexVersion ?? AICRM_CODEX_APP_SERVER_VERSION
    );
    this.baseEnvironment = { ...(options.baseEnvironment ?? process.env) };
    this.spawnAppServer = options.spawn ?? defaultSpawn;
    this.requestTimeoutMs = validateTimeout(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "App Server 请求超时配置无效"
    );
    this.stopTimeoutMs = validateTimeout(
      options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      "App Server 停止超时配置无效"
    );
  }

  async start(): Promise<CodexAppServerRuntimeInfo> {
    if (this.state !== "idle") {
      throw appServerError("executor_app_server_start_failed", "App Server 已启动或已终止");
    }
    this.state = "starting";
    const canonicalCodexHome = await assertPrivateCodexHome(this.codexHome);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnAppServer(
        this.codexExecutable,
        ["app-server", "--listen", "stdio://"],
        {
          cwd: canonicalCodexHome,
          detached: process.platform !== "win32",
          env: buildCodexEnvironment(this.baseEnvironment, canonicalCodexHome),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        }
      );
    } catch {
      this.state = "failed";
      throw appServerError("executor_app_server_start_failed", "无法启动 Codex App Server");
    }
    this.child = child;
    this.bindChild(child);
    try {
      const initialized = validateInitializeResponse(
        await this.requestDuringStart("initialize", {
          clientInfo: {
            name: this.clientName,
            title: this.clientTitle,
            version: this.clientVersion
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false
          }
        }),
        canonicalCodexHome,
        this.clientName,
        this.expectedCodexVersion
      );
      await this.send({ method: "initialized", params: {} });
      this.state = "ready";
      return initialized;
    } catch (error) {
      this.state = "failed";
      await this.stopChild(child);
      throw normalizeAppServerError(error, "executor_app_server_start_failed");
    }
  }

  async readAccount(refreshToken: boolean): Promise<CodexAccountReadResult> {
    const value = await this.request("account/read", { refreshToken });
    return validateAccountRead(value);
  }

  async startBrowserLogin(): Promise<CodexBrowserLoginChallenge> {
    const value = await this.request("account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "codex"
    });
    return validateBrowserChallenge(value);
  }

  async startDeviceCodeLogin(): Promise<CodexDeviceCodeLoginChallenge> {
    const value = await this.request("account/login/start", { type: "chatgptDeviceCode" });
    return validateDeviceCodeChallenge(value);
  }

  async cancelLogin(loginId: string): Promise<"canceled" | "notFound"> {
    const canonicalLoginId = validateOpaqueId(loginId, "App Server loginId 无效");
    const value = await this.request("account/login/cancel", { loginId: canonicalLoginId });
    if (!exactObject(value, ["status"])) {
      throw protocolError("App Server 取消响应无效");
    }
    const status = (value as { status?: unknown }).status;
    if (status !== "canceled" && status !== "notFound") {
      throw protocolError("App Server 取消状态无效");
    }
    return status;
  }

  async logout(): Promise<void> {
    const value = await this.request("account/logout", undefined);
    if (!exactObject(value, [])) throw protocolError("App Server 注销响应无效");
  }

  waitForLogin(loginId: string, signal?: AbortSignal): Promise<CodexLoginCompletion> {
    const canonicalLoginId = validateOpaqueId(loginId, "App Server loginId 无效");
    const completed = this.completions.get(canonicalLoginId);
    if (completed) return Promise.resolve({ ...completed });
    if (this.state !== "ready") {
      return Promise.reject(appServerError("executor_app_server_stopped", "App Server 不可用"));
    }
    if (signal?.aborted) {
      return Promise.reject(appServerError("executor_app_server_cancelled", "授权等待已取消"));
    }
    return new Promise<CodexLoginCompletion>((resolve, reject) => {
      const waiter: LoginWaiter = {
        resolve,
        reject,
        signal: signal ?? null,
        abortHandler: null
      };
      if (signal) {
        waiter.abortHandler = () => {
          this.removeLoginWaiter(canonicalLoginId, waiter);
          reject(appServerError("executor_app_server_cancelled", "授权等待已取消"));
        };
        signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }
      const waiters = this.loginWaiters.get(canonicalLoginId) ?? new Set<LoginWaiter>();
      waiters.add(waiter);
      this.loginWaiters.set(canonicalLoginId, waiters);
    });
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    const child = this.child;
    this.rejectAll(appServerError("executor_app_server_stopped", "App Server 已停止"));
    if (child) {
      try {
        await this.stopChild(child);
      } catch {
        this.state = "failed";
        throw appServerError(
          "executor_app_server_stop_failed",
          "App Server 进程退出未确认"
        );
      }
    }
    if (this.child === child) this.child = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBytes = 0;
    this.completions.clear();
    this.state = "stopped";
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.state !== "ready") {
      return Promise.reject(appServerError("executor_app_server_stopped", "App Server 尚未就绪"));
    }
    return this.requestInternal(method, params);
  }

  private requestDuringStart(method: string, params: unknown): Promise<unknown> {
    if (this.state !== "starting") {
      return Promise.reject(appServerError("executor_app_server_start_failed", "App Server 启动状态无效"));
    }
    return this.requestInternal(method, params);
  }

  private requestInternal(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId;
    if (!Number.isSafeInteger(id) || id < 1) {
      return Promise.reject(protocolError("App Server 请求序列耗尽"));
    }
    this.nextRequestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(appServerError("executor_app_server_timeout", "App Server 请求超时"));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      void this.send({ method, id, params }).catch(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(appServerError("executor_app_server_stopped", "App Server 写入失败"));
      });
    });
  }

  private send(message: unknown): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(appServerError("executor_app_server_stopped", "App Server 输入流不可用"));
    }
    let serialized: string;
    try {
      serialized = `${JSON.stringify(message)}\n`;
    } catch {
      return Promise.reject(protocolError("App Server 请求无法编码"));
    }
    const operation = this.writeTail.then(async () => {
      if (!this.child || this.child !== child || child.stdin.destroyed || !child.stdin.writable) {
        throw appServerError("executor_app_server_stopped", "App Server 输入流不可用");
      }
      if (!child.stdin.write(serialized, "utf8")) await once(child.stdin, "drain");
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private bindChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer | string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrBytes += Buffer.byteLength(chunk);
      if (this.stderrBytes > MAX_STDERR_BYTES) {
        this.failProtocol("App Server stderr 超出安全上限");
      }
    });
    child.once("error", () => {
      this.failRuntime("executor_app_server_start_failed", "App Server 进程启动失败");
    });
    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      if (this.state !== "stopping" && this.state !== "stopped") {
        this.state = "failed";
        this.rejectAll(appServerError("executor_app_server_stopped", "App Server 意外退出"));
      }
    });
  }

  private consumeStdout(chunk: Buffer | string): void {
    if (this.state === "failed" || this.state === "stopped") return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const raw = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (raw.byteLength < 1 || raw.byteLength > MAX_PROTOCOL_LINE_BYTES) {
        this.failProtocol("App Server 协议行大小无效");
        return;
      }
      const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(line);
      } catch {
        this.failProtocol("App Server 协议不是有效 UTF-8");
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(text) as unknown;
      } catch {
        this.failProtocol("App Server 协议不是有效 JSON");
        return;
      }
      try {
        this.handleMessage(message);
      } catch {
        this.failProtocol("App Server 协议消息无效");
        return;
      }
    }
    if (this.stdoutBuffer.byteLength > MAX_PROTOCOL_LINE_BYTES) {
      this.failProtocol("App Server 协议缓冲区超出安全上限");
    }
  }

  private handleMessage(value: unknown): void {
    if (!isRecord(value)) throw protocolError("App Server 消息无效");
    const hasId = Object.prototype.hasOwnProperty.call(value, "id");
    const hasMethod = Object.prototype.hasOwnProperty.call(value, "method");
    if (hasId && hasMethod) {
      if (!exactObject(value, ["method", "id", "params"]) || !validRequestId(value.id)) {
        throw protocolError("App Server 反向请求无效");
      }
      void this.send({
        id: value.id,
        error: { code: -32601, message: "Method not supported" }
      }).catch(() => undefined);
      return;
    }
    if (hasId) {
      this.handleResponse(value);
      return;
    }
    if (!hasMethod || !exactObject(value, ["method", "params"]) || typeof value.method !== "string") {
      throw protocolError("App Server 通知无效");
    }
    this.handleNotification(value.method, value.params);
  }

  private handleResponse(value: Record<string, unknown>): void {
    if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) {
      throw protocolError("App Server 响应 id 无效");
    }
    const id = value.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    const response: unknown = value;
    if (exactObject(response, ["id", "result"])) {
      pending.resolve(response.result);
      return;
    }
    if (!exactObject(response, ["id", "error"]) || !isRecord(response.error)) {
      pending.reject(protocolError("App Server 错误响应无效"));
      return;
    }
    const rpcError = response.error;
    if (
      !Object.keys(rpcError).every((key) => ["code", "message", "data"].includes(key)) ||
      !Number.isSafeInteger(rpcError.code) ||
      typeof rpcError.message !== "string"
    ) {
      pending.reject(protocolError("App Server 错误响应无效"));
      return;
    }
    const unsupported = /not found|not supported|unknown method/i.test(rpcError.message);
    pending.reject(
      new CodexAppServerAuthError(
        unsupported ? "executor_app_server_unsupported" : "executor_app_server_rejected",
        unsupported ? "Codex App Server 缺少必要授权方法" : "Codex App Server 拒绝授权请求",
        { rpcCode: rpcError.code as number }
      )
    );
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "account/login/completed") {
      const completion = validateLoginCompletion(params);
      if (completion.loginId === null) return;
      this.recordCompletion({
        loginId: completion.loginId,
        success: completion.success
      });
      return;
    }
    if (method === "account/updated") {
      const update = validateAccountUpdate(params);
      this.emit("accountUpdated", update);
    }
  }

  private recordCompletion(completion: CodexLoginCompletion): void {
    this.completions.delete(completion.loginId);
    this.completions.set(completion.loginId, { ...completion });
    while (this.completions.size > MAX_COMPLETIONS) {
      const oldest = this.completions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completions.delete(oldest);
    }
    const waiters = this.loginWaiters.get(completion.loginId);
    if (!waiters) return;
    this.loginWaiters.delete(completion.loginId);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.abortHandler) {
        waiter.signal.removeEventListener("abort", waiter.abortHandler);
      }
      waiter.resolve({ ...completion });
    }
  }

  private removeLoginWaiter(loginId: string, waiter: LoginWaiter): void {
    const waiters = this.loginWaiters.get(loginId);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.loginWaiters.delete(loginId);
  }

  private failProtocol(message: string): void {
    this.failRuntime("executor_app_server_protocol_invalid", message);
  }

  private failRuntime(code: CodexAppServerAuthErrorCode, message: string): void {
    if (this.state === "failed" || this.state === "stopped") return;
    this.state = "failed";
    const child = this.child;
    this.rejectAll(appServerError(code, message));
    if (child) {
      void this.stopChild(child).then(
        () => {
          if (this.child === child) this.child = null;
        },
        () => {
          // Keep the exact child visible so a later explicit stop retries and
          // cannot fabricate writer termination.
        }
      );
    }
  }

  private rejectAll(error: CodexAppServerAuthError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.loginWaiters.values()) {
      for (const waiter of waiters) {
        if (waiter.signal && waiter.abortHandler) {
          waiter.signal.removeEventListener("abort", waiter.abortHandler);
        }
        waiter.reject(error);
      }
    }
    this.loginWaiters.clear();
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const timedOut = new Promise<false>((resolve) => {
      setTimeout(() => resolve(false), this.stopTimeoutMs);
    });
    const exited = once(child, "exit").then(() => true, () => true);
    terminateChild(child, "SIGTERM");
    if (!(await Promise.race([exited, timedOut]))) {
      terminateChild(child, "SIGKILL");
      const killed = await Promise.race([
        exited,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), this.stopTimeoutMs))
      ]);
      if (!killed && child.exitCode === null && child.signalCode === null) {
        throw appServerError(
          "executor_app_server_stop_failed",
          "App Server 进程退出未确认"
        );
      }
    }
  }
}

function defaultSpawn(
  executable: string,
  args: readonly string[],
  options: SpawnOptions
): ChildProcessWithoutNullStreams {
  return spawn(executable, [...args], options) as ChildProcessWithoutNullStreams;
}

function buildCodexEnvironment(base: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    const allowed =
      SAFE_ENVIRONMENT_NAMES.has(name) ||
      (process.platform === "win32" &&
        [...SAFE_ENVIRONMENT_NAMES].some((candidate) => candidate.toLowerCase() === name.toLowerCase()));
    if (allowed && typeof value === "string" && value !== "") {
      environment[name] = value;
    }
  }
  environment.CODEX_HOME = codexHome;
  environment.HOME = codexHome;
  environment.USERPROFILE = codexHome;
  return environment;
}

function terminateChild(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when a test double or OS denies group signaling.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Stopping is best-effort after all protocol promises have already been fenced.
  }
}

async function assertPrivateCodexHome(codexHome: string): Promise<string> {
  let info;
  try {
    info = await lstat(codexHome);
  } catch {
    throw appServerError("executor_app_server_home_unsafe", "Codex staging 不可用");
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  ) {
    throw appServerError("executor_app_server_home_unsafe", "Codex staging 不安全");
  }
  try {
    return await realpath(codexHome);
  } catch {
    throw appServerError("executor_app_server_home_unsafe", "Codex staging 无法规范化");
  }
}

function validateInitializeResponse(
  value: unknown,
  expectedCodexHome: string,
  clientName: string,
  expectedCodexVersion: string
): CodexAppServerRuntimeInfo {
  if (!exactObject(value, ["userAgent", "codexHome", "platformFamily", "platformOs"])) {
    throw protocolError("App Server initialize 响应无效");
  }
  const response = value as Record<string, unknown>;
  if (
    typeof response.codexHome !== "string" ||
    path.resolve(response.codexHome) !== expectedCodexHome
  ) {
    throw protocolError("App Server 未使用受控 Codex staging");
  }
  const userAgent = validatePrintable(response.userAgent, 512, "App Server userAgent 无效");
  if (!userAgent.startsWith(`${clientName}/${expectedCodexVersion} (`)) {
    throw appServerError(
      "executor_app_server_unsupported",
      "Codex App Server 版本与锁定协议不匹配"
    );
  }
  return {
    userAgent,
    platformFamily: validateProtocolName(response.platformFamily, "App Server 平台族无效"),
    platformOs: validateProtocolName(response.platformOs, "App Server 平台无效")
  };
}

function validateAccountRead(value: unknown): CodexAccountReadResult {
  if (!exactObject(value, ["account", "requiresOpenaiAuth"])) {
    throw protocolError("App Server account/read 响应无效");
  }
  const response = value as Record<string, unknown>;
  if (typeof response.requiresOpenaiAuth !== "boolean") {
    throw protocolError("App Server account/read 授权要求无效");
  }
  if (response.account === null) {
    return { account: null, requiresOpenaiAuth: response.requiresOpenaiAuth };
  }
  if (!isRecord(response.account) || response.account.type !== "chatgpt") {
    throw appServerError("executor_app_server_unsupported", "App Server 账号类型不受支持");
  }
  if (!exactObject(response.account, ["type", "email", "planType"])) {
    throw protocolError("App Server ChatGPT 账号投影无效");
  }
  const account = response.account as Record<string, unknown>;
  if (!PLAN_TYPES.has(String(account.planType))) {
    throw protocolError("App Server ChatGPT 账号套餐无效");
  }
  let email: string | null = null;
  if (account.email !== null) {
    if (
      typeof account.email !== "string" ||
      account.email.length < 1 ||
      Buffer.byteLength(account.email, "utf8") > 320 ||
      account.email.trim() !== account.email ||
      Array.from(account.email).some((character) => {
        const code = character.codePointAt(0)!;
        return code < 0x20 || code === 0x7f;
      })
    ) {
      throw protocolError("App Server 账号邮箱无效");
    }
    email = account.email;
  }
  return {
    account: { type: "chatgpt", email, planType: String(account.planType) },
    requiresOpenaiAuth: response.requiresOpenaiAuth
  };
}

function validateBrowserChallenge(value: unknown): CodexBrowserLoginChallenge {
  if (!exactObject(value, ["type", "loginId", "authUrl"])) {
    throw protocolError("App Server 浏览器授权 challenge 无效");
  }
  const challenge = value as Record<string, unknown>;
  if (challenge.type !== "chatgpt") {
    throw protocolError("App Server 浏览器授权类型无效");
  }
  return {
    type: "chatgpt",
    loginId: validateOpaqueId(challenge.loginId, "App Server loginId 无效"),
    authUrl: validateOfficialAuthUrl(challenge.authUrl, false)
  };
}

function validateDeviceCodeChallenge(value: unknown): CodexDeviceCodeLoginChallenge {
  if (!exactObject(value, ["type", "loginId", "verificationUrl", "userCode"])) {
    throw protocolError("App Server 设备码 challenge 无效");
  }
  const challenge = value as Record<string, unknown>;
  if (
    challenge.type !== "chatgptDeviceCode" ||
    typeof challenge.userCode !== "string" ||
    !USER_CODE_PATTERN.test(challenge.userCode)
  ) {
    throw protocolError("App Server 设备码 challenge 字段无效");
  }
  return {
    type: "chatgptDeviceCode",
    loginId: validateOpaqueId(challenge.loginId, "App Server loginId 无效"),
    verificationUrl: validateOfficialAuthUrl(challenge.verificationUrl, true),
    userCode: challenge.userCode
  };
}

function validateLoginCompletion(value: unknown): CodexLoginCompletionNotification {
  if (!exactObject(value, ["loginId", "success", "error"])) {
    throw protocolError("App Server 登录完成通知无效");
  }
  const notification = value as Record<string, unknown>;
  if (
    (notification.loginId !== null && !isOpaqueId(notification.loginId)) ||
    typeof notification.success !== "boolean" ||
    (notification.error !== null && typeof notification.error !== "string")
  ) {
    throw protocolError("App Server 登录完成通知字段无效");
  }
  return {
    loginId: notification.loginId as string | null,
    success: notification.success
  };
}

function validateAccountUpdate(value: unknown): CodexAccountUpdate {
  if (!exactObject(value, ["authMode", "planType"])) {
    throw protocolError("App Server 账号更新通知无效");
  }
  const update = value as Record<string, unknown>;
  if (
    (update.authMode !== null && !isProtocolName(update.authMode)) ||
    (update.planType !== null && !PLAN_TYPES.has(String(update.planType)))
  ) {
    throw protocolError("App Server 账号更新通知字段无效");
  }
  return {
    authMode: update.authMode as string | null,
    planType: update.planType as string | null
  };
}

function validateOfficialAuthUrl(value: unknown, requireNoQuery: boolean): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192) {
    throw protocolError("App Server 授权 URL 无效");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw protocolError("App Server 授权 URL 无效");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    !OFFICIAL_AUTH_HOSTS.has(url.hostname.toLowerCase()) ||
    url.hash !== "" ||
    (requireNoQuery && url.search !== "")
  ) {
    throw protocolError("App Server 授权 URL 不受信");
  }
  return url.toString();
}

function validateCodexHome(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0")) {
    throw appServerError("executor_app_server_home_unsafe", "Codex staging 路径无效");
  }
  const resolved = path.resolve(value);
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root) {
    throw appServerError("executor_app_server_home_unsafe", "Codex staging 路径无效");
  }
  return resolved;
}

function validateClientName(value: string): string {
  if (typeof value !== "string" || !CLIENT_NAME_PATTERN.test(value)) {
    throw appServerError("executor_app_server_protocol_invalid", "App Server 客户端名称无效");
  }
  return value;
}

function validateExecutable(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4096 ||
    value.includes("\0") ||
    value.trim() !== value ||
    !path.isAbsolute(value)
  ) {
    throw appServerError("executor_app_server_start_failed", "Codex 可执行文件无效");
  }
  return value;
}

function validateVersion(value: string): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw appServerError("executor_app_server_protocol_invalid", "Codex 版本配置无效");
  }
  return value;
}

function validatePrintable(value: unknown, maximum: number, message: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !SAFE_PROTOCOL_TEXT_PATTERN.test(value)
  ) {
    throw protocolError(message);
  }
  return value;
}

function validateProtocolName(value: unknown, message: string): string {
  if (!isProtocolName(value)) throw protocolError(message);
  return value;
}

function isProtocolName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value);
}

function validateOpaqueId(value: unknown, message: string): string {
  if (!isOpaqueId(value)) throw protocolError(message);
  return value;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function validRequestId(value: unknown): boolean {
  return (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && value.length >= 1 && value.length <= 160)
  );
}

function validateTimeout(value: number, message: string): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 120_000) {
    throw appServerError("executor_app_server_protocol_invalid", message);
  }
  return value;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAppServerError(
  error: unknown,
  fallback: CodexAppServerAuthErrorCode
): CodexAppServerAuthError {
  if (error instanceof CodexAppServerAuthError) return error;
  return appServerError(fallback, "Codex App Server 操作失败");
}

function protocolError(message: string): CodexAppServerAuthError {
  return appServerError("executor_app_server_protocol_invalid", message);
}

function appServerError(
  code: CodexAppServerAuthErrorCode,
  message: string
): CodexAppServerAuthError {
  return new CodexAppServerAuthError(code, message);
}
