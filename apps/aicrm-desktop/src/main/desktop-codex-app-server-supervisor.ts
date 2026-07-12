import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import type {
  CodexAccountReadResult,
  CodexAppServerAuthClient,
  CodexBrowserLoginChallenge,
  CodexLoginCompletion
} from "./codex-app-server-auth-client.ts";

const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const OPAQUE_LOGIN_ID = /^[A-Za-z0-9_-]{1,160}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SAFE_PLAN = /^[A-Za-z0-9_-]{1,80}$/;
const AUTH_HOSTS = new Set(["auth.openai.com", "platform.openai.com", "chatgpt.com"]);
const BOOT_HASH_DOMAIN = "AICRM-CODEX-APP-SERVER-BOOT-V1\n";
const INSTANCE_HASH_DOMAIN = "AICRM-CODEX-APP-SERVER-INSTANCE-V1\n";

export type DesktopCodexAppServerState =
  | "starting"
  | "ready"
  | "waiting_user"
  | "login_completed"
  | "stopping"
  | "stopped"
  | "failed";

export type DesktopCodexAppServerSupervisorErrorCode =
  | "desktop_codex_app_server_conflict"
  | "desktop_codex_app_server_invalid_input"
  | "desktop_codex_app_server_operation_failed"
  | "desktop_codex_app_server_stale_receipt"
  | "desktop_codex_app_server_start_failed"
  | "desktop_codex_app_server_stop_failed"
  | "desktop_codex_app_server_stopped";

export class DesktopCodexAppServerSupervisorError extends Error {
  readonly code: DesktopCodexAppServerSupervisorErrorCode;

  constructor(code: DesktopCodexAppServerSupervisorErrorCode, message: string) {
    super(message);
    this.name = "DesktopCodexAppServerSupervisorError";
    this.code = code;
    // Keep normalized failures free of host-local call-site details.
    this.stack = `${this.name}: ${message}`;
  }
}

export interface DesktopCodexAppServerBinding {
  executorId: string;
  sessionId: string;
  stagingOwnershipDigest: string;
}

export interface DesktopCodexAppServerReceipt extends DesktopCodexAppServerBinding {
  version: 1;
  bootIdHash: string;
  instanceIdHash: string;
}

export interface DesktopCodexAppServerSnapshot extends DesktopCodexAppServerReceipt {
  state: DesktopCodexAppServerState;
  errorCode: DesktopCodexAppServerSupervisorErrorCode | null;
}

export interface DesktopCodexAppServerLoginCompletion
  extends DesktopCodexAppServerSnapshot {
  state: "login_completed";
  errorCode: null;
  loginIdHash: string;
}

export interface DesktopCodexAppServerStateEvent extends DesktopCodexAppServerSnapshot {
  previousState: DesktopCodexAppServerState | null;
}

export type DesktopCodexAppServerClient = Pick<
  CodexAppServerAuthClient,
  | "start"
  | "startBrowserLogin"
  | "waitForLogin"
  | "readAccount"
  | "cancelLogin"
  | "stop"
>;

export interface DesktopCodexAppServerSupervisorOptions {
  createClient(
    binding: Readonly<DesktopCodexAppServerBinding>
  ): DesktopCodexAppServerClient | Promise<DesktopCodexAppServerClient>;
  openTrustedUrl(authUrl: string): void | Promise<void>;
  randomBytes?: (size: number) => Uint8Array;
  onStateChange?: (event: Readonly<DesktopCodexAppServerStateEvent>) => void;
}

interface RuntimeInstance {
  readonly binding: Readonly<DesktopCodexAppServerBinding>;
  readonly receipt: Readonly<DesktopCodexAppServerReceipt>;
  state: DesktopCodexAppServerState;
  errorCode: DesktopCodexAppServerSupervisorErrorCode | null;
  client: DesktopCodexAppServerClient | null;
  loginId: string | null;
  startPromise: Promise<Readonly<DesktopCodexAppServerReceipt>>;
  loginStartPromise: Promise<Readonly<DesktopCodexAppServerSnapshot>> | null;
  loginWaitPromise: Promise<Readonly<DesktopCodexAppServerLoginCompletion>> | null;
  stopPromise: Promise<Readonly<DesktopCodexAppServerSnapshot>> | null;
  stopCompleted: boolean;
}

/**
 * Main-only owner for Codex App Server clients created during this process
 * boot. It intentionally has no recovery or external-process control surface.
 */
export class DesktopCodexAppServerSupervisor {
  private readonly createClient: DesktopCodexAppServerSupervisorOptions["createClient"];
  private readonly openTrustedUrl: DesktopCodexAppServerSupervisorOptions["openTrustedUrl"];
  private readonly makeRandomBytes: (size: number) => Uint8Array;
  private readonly onStateChange: (event: Readonly<DesktopCodexAppServerStateEvent>) => void;
  private readonly bootIdHash: string;
  private readonly instances = new Map<string, RuntimeInstance>();
  private shuttingDown = false;

  constructor(options: DesktopCodexAppServerSupervisorOptions) {
    if (!options || typeof options.createClient !== "function" ||
        typeof options.openTrustedUrl !== "function") {
      throw supervisorError(
        "desktop_codex_app_server_invalid_input",
        "Codex App Server supervisor 配置无效"
      );
    }
    this.createClient = options.createClient;
    this.openTrustedUrl = options.openTrustedUrl;
    this.makeRandomBytes = options.randomBytes ?? secureRandomBytes;
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.bootIdHash = randomDigest(BOOT_HASH_DOMAIN, this.makeRandomBytes);
  }

  start(
    input: DesktopCodexAppServerBinding
  ): Promise<Readonly<DesktopCodexAppServerReceipt>> {
    const binding = validateBinding(input);
    if (this.shuttingDown) {
      return Promise.reject(supervisorError(
        "desktop_codex_app_server_stopped",
        "Codex App Server supervisor 已停止"
      ));
    }
    const existing = this.instances.get(binding.executorId);
    if (existing) {
      if (!sameBinding(existing.binding, binding)) {
        return Promise.reject(supervisorError(
          "desktop_codex_app_server_conflict",
          "Codex App Server executor 已绑定其他授权会话"
        ));
      }
      return existing.startPromise;
    }

    const receipt = Object.freeze({
      version: 1 as const,
      bootIdHash: this.bootIdHash,
      instanceIdHash: randomDigest(INSTANCE_HASH_DOMAIN, this.makeRandomBytes),
      executorId: binding.executorId,
      sessionId: binding.sessionId,
      stagingOwnershipDigest: binding.stagingOwnershipDigest
    });
    const instance: RuntimeInstance = {
      binding: Object.freeze({
        executorId: binding.executorId,
        sessionId: binding.sessionId,
        stagingOwnershipDigest: binding.stagingOwnershipDigest
      }),
      receipt,
      state: "starting",
      errorCode: null,
      client: null,
      loginId: null,
      startPromise: Promise.resolve(receipt),
      loginStartPromise: null,
      loginWaitPromise: null,
      stopPromise: null,
      stopCompleted: false
    };
    this.instances.set(binding.executorId, instance);
    this.emitState(instance, null);
    instance.startPromise = this.performStart(instance);
    return instance.startPromise;
  }

  getSnapshot(
    receipt: DesktopCodexAppServerReceipt
  ): Readonly<DesktopCodexAppServerSnapshot> {
    return this.snapshot(this.resolveReceipt(receipt));
  }

  startBrowserLogin(
    receipt: DesktopCodexAppServerReceipt
  ): Promise<Readonly<DesktopCodexAppServerSnapshot>> {
    const instance = this.resolveReceipt(receipt);
    if (instance.loginStartPromise) return instance.loginStartPromise;
    if (instance.state !== "ready" || !instance.client) {
      return Promise.reject(this.stateError(instance));
    }
    const operation = this.performStartBrowserLogin(instance);
    instance.loginStartPromise = operation;
    void operation.catch(() => undefined);
    return operation;
  }

  waitForLogin(
    receipt: DesktopCodexAppServerReceipt
  ): Promise<Readonly<DesktopCodexAppServerLoginCompletion>> {
    const instance = this.resolveReceipt(receipt);
    if (instance.loginWaitPromise) return instance.loginWaitPromise;
    if (instance.state !== "waiting_user" || !instance.client || instance.loginId === null) {
      return Promise.reject(this.stateError(instance));
    }
    const operation = this.performWaitForLogin(instance, instance.client, instance.loginId);
    instance.loginWaitPromise = operation;
    void operation.catch(() => undefined);
    return operation;
  }

  async readAccount(
    receipt: DesktopCodexAppServerReceipt,
    refreshToken: boolean
  ): Promise<CodexAccountReadResult> {
    const instance = this.resolveReceipt(receipt);
    if (typeof refreshToken !== "boolean") {
      throw supervisorError(
        "desktop_codex_app_server_invalid_input",
        "Codex App Server 账户读取参数无效"
      );
    }
    if (!instance.client ||
        !(["ready", "waiting_user", "login_completed"] as const).includes(
          instance.state as "ready" | "waiting_user" | "login_completed"
        )) {
      throw this.stateError(instance);
    }
    const state = instance.state;
    try {
      const value = validateAccountRead(await instance.client.readAccount(refreshToken));
      if (instance.state !== state) throw this.stateError(instance);
      return value;
    } catch (error) {
      if (instance.state !== state) {
        throw this.stateError(instance);
      }
      const invalid = normalizedInvalidInput(error);
      this.fail(
        instance,
        invalid?.code ?? "desktop_codex_app_server_operation_failed"
      );
      if (invalid) throw invalid;
      throw supervisorError(
        "desktop_codex_app_server_operation_failed",
        "Codex App Server 账户读取失败"
      );
    }
  }

  async cancelLogin(
    receipt: DesktopCodexAppServerReceipt
  ): Promise<Readonly<DesktopCodexAppServerSnapshot>> {
    const instance = this.resolveReceipt(receipt);
    if (instance.state !== "waiting_user" || !instance.client || instance.loginId === null) {
      throw this.stateError(instance);
    }
    return this.stopInstance(instance, true);
  }

  stop(
    receipt: DesktopCodexAppServerReceipt
  ): Promise<Readonly<DesktopCodexAppServerSnapshot>> {
    return this.stopInstance(this.resolveReceipt(receipt), false);
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    const results = await Promise.allSettled(
      [...this.instances.values()].map((instance) => this.stopInstance(instance, false))
    );
    if (results.some((result) => result.status === "rejected")) {
      throw supervisorError(
        "desktop_codex_app_server_stop_failed",
        "Codex App Server supervisor 停止失败"
      );
    }
  }

  private async performStart(
    instance: RuntimeInstance
  ): Promise<Readonly<DesktopCodexAppServerReceipt>> {
    let client: DesktopCodexAppServerClient;
    try {
      client = validateClient(await this.createClient(instance.binding));
      instance.client = client;
      await client.start();
      this.transition(instance, "ready");
      return instance.receipt;
    } catch {
      if (instance.client) {
        try {
          await instance.client.stop();
          instance.stopCompleted = true;
        } catch {
          instance.stopCompleted = false;
        }
      }
      this.fail(instance, "desktop_codex_app_server_start_failed");
      throw supervisorError(
        "desktop_codex_app_server_start_failed",
        "Codex App Server 当前启动失败"
      );
    }
  }

  private async performStartBrowserLogin(
    instance: RuntimeInstance
  ): Promise<Readonly<DesktopCodexAppServerSnapshot>> {
    const client = instance.client!;
    let challenge: CodexBrowserLoginChallenge;
    try {
      challenge = validateBrowserChallenge(await client.startBrowserLogin());
    } catch (error) {
      if (!this.isExactReadyInstance(instance, client)) {
        throw this.stateError(instance);
      }
      const invalid = normalizedInvalidInput(error);
      this.fail(
        instance,
        invalid?.code ?? "desktop_codex_app_server_operation_failed"
      );
      if (invalid) throw invalid;
      throw supervisorError(
        "desktop_codex_app_server_operation_failed",
        "Codex App Server 浏览器授权启动失败"
      );
    }
    if (!this.isExactReadyInstance(instance, client)) {
      await client.cancelLogin(challenge.loginId).catch(() => undefined);
      throw this.stateError(instance);
    }
    instance.loginId = challenge.loginId;
    try {
      await this.openTrustedUrl(challenge.authUrl);
      if (!this.isExactReadyInstance(instance, client)) throw this.stateError(instance);
      this.transition(instance, "waiting_user");
      return this.snapshot(instance);
    } catch {
      // A valid challenge is always cancelled before any terminal/race error is
      // normalized, including when shutdown completed while the effect waited.
      await client.cancelLogin(challenge.loginId).catch(() => undefined);
      if (instance.loginId === challenge.loginId) instance.loginId = null;
      if (!this.isExactReadyInstance(instance, client)) throw this.stateError(instance);
      this.fail(instance, "desktop_codex_app_server_operation_failed");
      throw supervisorError(
        "desktop_codex_app_server_operation_failed",
        "Codex App Server 浏览器授权启动失败"
      );
    }
  }

  private async performWaitForLogin(
    instance: RuntimeInstance,
    client: DesktopCodexAppServerClient,
    loginId: string
  ): Promise<Readonly<DesktopCodexAppServerLoginCompletion>> {
    try {
      const completion = validateLoginCompletion(await client.waitForLogin(loginId));
      if (instance.state !== "waiting_user") throw this.stateError(instance);
      if (completion.loginId !== loginId || !completion.success) {
        throw supervisorError(
          "desktop_codex_app_server_operation_failed",
          "Codex App Server 浏览器授权未完成"
        );
      }
      instance.loginId = null;
      this.transition(instance, "login_completed");
      return this.loginCompletion(instance, loginId);
    } catch (error) {
      if (instance.state === "stopping" || instance.state === "stopped") {
        throw this.stateError(instance);
      }
      instance.loginId = null;
      const invalid = normalizedInvalidInput(error);
      this.fail(
        instance,
        invalid?.code ?? "desktop_codex_app_server_operation_failed"
      );
      if (invalid) throw invalid;
      throw supervisorError(
        "desktop_codex_app_server_operation_failed",
        "Codex App Server 浏览器授权等待失败"
      );
    }
  }

  private stopInstance(
    instance: RuntimeInstance,
    cancelLogin: boolean
  ): Promise<Readonly<DesktopCodexAppServerSnapshot>> {
    if (instance.stopCompleted) return Promise.resolve(this.snapshot(instance));
    if (instance.stopPromise) return instance.stopPromise;
    const operation = this.performStop(instance, cancelLogin);
    const tracked = operation.then(
      (value) => {
        if (instance.stopPromise === tracked) instance.stopPromise = null;
        return value;
      },
      (error: unknown) => {
        if (instance.stopPromise === tracked) instance.stopPromise = null;
        throw error;
      }
    );
    instance.stopPromise = tracked;
    void tracked.catch(() => undefined);
    return tracked;
  }

  private async performStop(
    instance: RuntimeInstance,
    cancelLogin: boolean
  ): Promise<Readonly<DesktopCodexAppServerSnapshot>> {
    if (instance.state === "starting") {
      await instance.startPromise.catch(() => undefined);
    }
    if (instance.stopCompleted) return this.snapshot(instance);
    const client = instance.client;
    if (!client) {
      instance.stopCompleted = true;
      return this.snapshot(instance);
    }
    const wasFailed = instance.state === "failed";
    if (!wasFailed) this.transition(instance, "stopping");
    const loginId = instance.loginId;
    instance.loginId = null;
    let failed = false;
    if (cancelLogin && loginId !== null) {
      try {
        await client.cancelLogin(loginId);
      } catch {
        failed = true;
      }
    }
    try {
      await client.stop();
      instance.stopCompleted = true;
    } catch {
      instance.stopCompleted = false;
      failed = true;
    }
    if (failed) {
      if (!wasFailed) this.fail(instance, "desktop_codex_app_server_stop_failed");
      throw supervisorError(
        "desktop_codex_app_server_stop_failed",
        "Codex App Server 当前实例停止失败"
      );
    }
    if (!wasFailed) this.transition(instance, "stopped");
    return this.snapshot(instance);
  }

  private resolveReceipt(receipt: DesktopCodexAppServerReceipt): RuntimeInstance {
    const value = validateReceipt(receipt);
    if (value.bootIdHash !== this.bootIdHash) throw staleReceiptError();
    const instance = this.instances.get(value.executorId);
    if (!instance || !sameReceipt(instance.receipt, value)) throw staleReceiptError();
    return instance;
  }

  private isExactReadyInstance(
    instance: RuntimeInstance,
    client: DesktopCodexAppServerClient
  ): boolean {
    return !this.shuttingDown && instance.state === "ready" && instance.client === client &&
      this.instances.get(instance.binding.executorId) === instance;
  }

  private stateError(instance: RuntimeInstance): DesktopCodexAppServerSupervisorError {
    return supervisorError(
      instance.state === "failed"
        ? (instance.errorCode ?? "desktop_codex_app_server_operation_failed")
        : "desktop_codex_app_server_stopped",
      instance.state === "failed"
        ? "Codex App Server 当前实例失败"
        : "Codex App Server 当前状态不可操作"
    );
  }

  private fail(
    instance: RuntimeInstance,
    code: DesktopCodexAppServerSupervisorErrorCode
  ): void {
    if (instance.state === "failed" || instance.state === "stopped") return;
    instance.errorCode = code;
    this.transition(instance, "failed");
  }

  private transition(instance: RuntimeInstance, next: DesktopCodexAppServerState): void {
    if (!validTransition(instance.state, next)) {
      throw supervisorError(
        "desktop_codex_app_server_operation_failed",
        "Codex App Server 状态迁移失败"
      );
    }
    const previous = instance.state;
    instance.state = next;
    this.emitState(instance, previous);
  }

  private emitState(instance: RuntimeInstance, previousState: DesktopCodexAppServerState | null): void {
    const event = Object.freeze({ ...this.snapshot(instance), previousState });
    try {
      this.onStateChange(event);
    } catch {
      // Observers are not part of the lifecycle transaction.
    }
  }

  private snapshot(instance: RuntimeInstance): Readonly<DesktopCodexAppServerSnapshot> {
    return Object.freeze({
      ...instance.receipt,
      state: instance.state,
      errorCode: instance.errorCode
    });
  }

  private loginCompletion(
    instance: RuntimeInstance,
    loginId: string
  ): Readonly<DesktopCodexAppServerLoginCompletion> {
    if (instance.state !== "login_completed" || instance.errorCode !== null ||
        this.instances.get(instance.binding.executorId) !== instance) {
      throw this.stateError(instance);
    }
    return Object.freeze({
      version: instance.receipt.version,
      bootIdHash: instance.receipt.bootIdHash,
      instanceIdHash: instance.receipt.instanceIdHash,
      executorId: instance.receipt.executorId,
      sessionId: instance.receipt.sessionId,
      stagingOwnershipDigest: instance.receipt.stagingOwnershipDigest,
      state: "login_completed",
      errorCode: null,
      loginIdHash: createHash("sha256").update(loginId, "utf8").digest("hex")
    });
  }
}

function validateBinding(value: DesktopCodexAppServerBinding): Readonly<DesktopCodexAppServerBinding> {
  const captured = captureOwnData(value, ["executorId", "sessionId", "stagingOwnershipDigest"]);
  const executorId = captured.executorId;
  const sessionId = captured.sessionId;
  const stagingOwnershipDigest = captured.stagingOwnershipDigest;
  if (typeof executorId !== "string" || !SAFE_ID.test(executorId) ||
      typeof sessionId !== "string" || !SAFE_ID.test(sessionId) ||
      typeof stagingOwnershipDigest !== "string" || !DIGEST.test(stagingOwnershipDigest)) {
    throw supervisorError(
      "desktop_codex_app_server_invalid_input",
      "Codex App Server 绑定参数无效"
    );
  }
  return Object.freeze({ executorId, sessionId, stagingOwnershipDigest });
}

function validateReceipt(value: DesktopCodexAppServerReceipt): DesktopCodexAppServerReceipt {
  const captured = captureOwnData(value, [
    "version", "bootIdHash", "instanceIdHash", "executorId", "sessionId",
    "stagingOwnershipDigest"
  ]);
  const version = captured.version;
  const bootIdHash = captured.bootIdHash;
  const instanceIdHash = captured.instanceIdHash;
  const executorId = captured.executorId;
  const sessionId = captured.sessionId;
  const stagingOwnershipDigest = captured.stagingOwnershipDigest;
  if (version !== 1 || typeof bootIdHash !== "string" || !DIGEST.test(bootIdHash) ||
      typeof instanceIdHash !== "string" || !DIGEST.test(instanceIdHash) ||
      typeof executorId !== "string" || !SAFE_ID.test(executorId) ||
      typeof sessionId !== "string" || !SAFE_ID.test(sessionId) ||
      typeof stagingOwnershipDigest !== "string" || !DIGEST.test(stagingOwnershipDigest)) {
    throw supervisorError(
      "desktop_codex_app_server_invalid_input",
      "Codex App Server 实例收据无效"
    );
  }
  return { version, bootIdHash, instanceIdHash, executorId, sessionId, stagingOwnershipDigest };
}

function validateClient(value: DesktopCodexAppServerClient): DesktopCodexAppServerClient {
  if (!value || typeof value !== "object" ||
      !(["start", "startBrowserLogin", "waitForLogin", "readAccount", "cancelLogin", "stop"] as const)
        .every((method) => typeof value[method] === "function")) {
    throw supervisorError(
      "desktop_codex_app_server_start_failed",
      "Codex App Server client 无效"
    );
  }
  return value;
}

function validateBrowserChallenge(value: CodexBrowserLoginChallenge): CodexBrowserLoginChallenge {
  const captured = captureOwnData(value, ["type", "loginId", "authUrl"]);
  const type = captured.type;
  const loginId = captured.loginId;
  const authUrl = captured.authUrl;
  if (type !== "chatgpt" || typeof loginId !== "string" ||
      !OPAQUE_LOGIN_ID.test(loginId) || !trustedAuthUrl(authUrl)) {
    throw supervisorError(
      "desktop_codex_app_server_operation_failed",
      "Codex App Server 浏览器授权响应无效"
    );
  }
  return { type, loginId, authUrl };
}

function validateLoginCompletion(value: CodexLoginCompletion): CodexLoginCompletion {
  const captured = captureOwnData(value, ["loginId", "success"]);
  const loginId = captured.loginId;
  const success = captured.success;
  if (typeof loginId !== "string" || !OPAQUE_LOGIN_ID.test(loginId) ||
      typeof success !== "boolean") {
    throw supervisorError(
      "desktop_codex_app_server_operation_failed",
      "Codex App Server 浏览器授权完成响应无效"
    );
  }
  return { loginId, success };
}

function validateAccountRead(value: CodexAccountReadResult): CodexAccountReadResult {
  const captured = captureOwnData(value, ["account", "requiresOpenaiAuth"]);
  const account = captured.account;
  const requiresOpenaiAuth = captured.requiresOpenaiAuth;
  if (typeof requiresOpenaiAuth !== "boolean") {
    throw supervisorError(
      "desktop_codex_app_server_operation_failed",
      "Codex App Server 账户响应无效"
    );
  }
  if (account === null) return { account: null, requiresOpenaiAuth };
  const capturedAccount = captureOwnData(account, ["type", "email", "planType"]);
  const type = capturedAccount.type;
  const email = capturedAccount.email;
  const planType = capturedAccount.planType;
  if (type !== "chatgpt" ||
      (email !== null && (typeof email !== "string" || email.length > 320)) ||
      typeof planType !== "string" || !SAFE_PLAN.test(planType)) {
    throw supervisorError(
      "desktop_codex_app_server_operation_failed",
      "Codex App Server 账户响应无效"
    );
  }
  return {
    account: { type, email, planType },
    requiresOpenaiAuth
  };
}

function randomDigest(domain: string, source: (size: number) => Uint8Array): string {
  let entropy: Buffer;
  try {
    const value = source(32);
    if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new Error();
    entropy = Buffer.from(value);
  } catch {
    throw supervisorError(
      "desktop_codex_app_server_invalid_input",
      "Codex App Server 随机源无效"
    );
  }
  try {
    return createHash("sha256").update(domain, "utf8").update(entropy).digest("hex");
  } finally {
    entropy.fill(0);
  }
}

function trustedAuthUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" &&
      parsed.port === "" && parsed.hash === "" && AUTH_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function validTransition(
  current: DesktopCodexAppServerState,
  next: DesktopCodexAppServerState
): boolean {
  switch (current) {
    case "starting":
      return next === "ready" || next === "failed";
    case "ready":
      return next === "waiting_user" || next === "stopping" || next === "failed";
    case "waiting_user":
      return next === "login_completed" || next === "stopping" || next === "failed";
    case "login_completed":
      return next === "stopping" || next === "failed";
    case "stopping":
      return next === "stopped" || next === "failed";
    case "stopped":
    case "failed":
      return false;
  }
}

function sameBinding(
  left: Readonly<DesktopCodexAppServerBinding>,
  right: Readonly<DesktopCodexAppServerBinding>
): boolean {
  return left.executorId === right.executorId && left.sessionId === right.sessionId &&
    left.stagingOwnershipDigest === right.stagingOwnershipDigest;
}

function sameReceipt(
  left: Readonly<DesktopCodexAppServerReceipt>,
  right: Readonly<DesktopCodexAppServerReceipt>
): boolean {
  return left.version === right.version && left.bootIdHash === right.bootIdHash &&
    left.instanceIdHash === right.instanceIdHash && sameBinding(left, right);
}

function captureOwnData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) throw new Error();
    const actual = (ownKeys as string[]).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length ||
        actual.some((key, index) => key !== expected[index])) throw new Error();
    const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expected) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      captured[key] = descriptor.value;
    }
    return captured;
  } catch {
    throw supervisorError(
      "desktop_codex_app_server_invalid_input",
      "Codex App Server 数据对象无效"
    );
  }
}

function staleReceiptError(): DesktopCodexAppServerSupervisorError {
  return supervisorError(
    "desktop_codex_app_server_stale_receipt",
    "Codex App Server 实例收据已失效"
  );
}

function normalizedInvalidInput(
  error: unknown
): DesktopCodexAppServerSupervisorError | null {
  try {
    if (!(error instanceof DesktopCodexAppServerSupervisorError)) return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(error, "code");
    if (!descriptor || !("value" in descriptor) ||
        descriptor.value !== "desktop_codex_app_server_invalid_input") return null;
    return supervisorError(
      "desktop_codex_app_server_invalid_input",
      "Codex App Server 数据对象无效"
    );
  } catch {
    return null;
  }
}

function supervisorError(
  code: DesktopCodexAppServerSupervisorErrorCode,
  message: string
): DesktopCodexAppServerSupervisorError {
  return new DesktopCodexAppServerSupervisorError(code, message);
}
