import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  AICRM_CODEX_APP_SERVER_VERSION,
  CodexAppServerAuthClient
} from "./codex-app-server-auth-client.ts";

class FakeAppServerProcess extends EventEmitter {
  constructor(handler) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = 987654321;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.messages = [];
    this.buffer = "";
    this.handler = handler;
    this.stdin.on("data", (chunk) => this.consume(chunk));
  }

  consume(chunk) {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const message = JSON.parse(line);
      this.messages.push(message);
      this.handler?.(message, this);
    }
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(value) {
    this.stdout.write(value);
  }

  kill(signal = "SIGTERM") {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }

  crash(code = 1) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    queueMicrotask(() => this.emit("exit", code, null));
  }
}

async function fixture(handler, overrides = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-codex-app-server-"));
  const home = path.join(base, "credential-home");
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  const canonicalHome = await realpath(home);
  let child;
  let spawnCall;
  const client = new CodexAppServerAuthClient({
    codexHome: home,
    codexExecutable: overrides.codexExecutable ?? "/opt/aicrm/bin/codex",
    expectedCodexVersion: overrides.expectedCodexVersion ?? AICRM_CODEX_APP_SERVER_VERSION,
    clientName: "aicrm_desktop",
    clientTitle: "AiCRM",
    clientVersion: "0.1.0",
    baseEnvironment: {
      PATH: "/usr/bin:/bin",
      HTTPS_PROXY: "http://127.0.0.1:8080",
      OPENAI_API_KEY: "must-not-leak",
      DATABASE_URL: "must-not-leak",
      INTERNAL_ACCESS_TOKEN: "must-not-leak",
      CODEX_HOME: "/global/must-not-leak",
      RUST_LOG: "trace"
    },
    spawn: (executable, args, options) => {
      spawnCall = { executable, args: [...args], options };
      child = new FakeAppServerProcess(handler);
      return child;
    },
    requestTimeoutMs: overrides.requestTimeoutMs ?? 1_000,
    stopTimeoutMs: 100
  });
  return {
    base,
    home,
    canonicalHome,
    client,
    child: () => child,
    spawnCall: () => spawnCall
  };
}

function successfulHandler(context, overrides = {}) {
  return (message, child) => {
    if (message.method === "initialize") {
      child.send({
        method: "remoteControl/status/changed",
        params: { status: "disabled" }
      });
      child.send({
        id: message.id,
        result: {
          userAgent:
            overrides.userAgent ??
            `aicrm_desktop/${AICRM_CODEX_APP_SERVER_VERSION} (Linux; x86_64)`,
          codexHome: context.canonicalHome,
          platformFamily: "unix",
          platformOs: "linux"
        }
      });
      return;
    }
    if (message.method === "account/read") {
      child.send({
        id: message.id,
        result:
          overrides.accountRead ??
          ({ account: null, requiresOpenaiAuth: true })
      });
      return;
    }
    if (message.method === "account/login/start") {
      if (message.params.type === "chatgptDeviceCode") {
        child.send({
          id: message.id,
          result: {
            type: "chatgptDeviceCode",
            loginId: "login_device_1",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "ABCD-1234"
          }
        });
      } else {
        child.send({
          id: message.id,
          result: {
            type: "chatgpt",
            loginId: "login_browser_1",
            authUrl: overrides.authUrl ?? "https://chatgpt.com/auth/codex?state=opaque"
          }
        });
      }
      return;
    }
    if (message.method === "account/login/cancel") {
      child.send({ id: message.id, result: { status: "canceled" } });
      return;
    }
    if (message.method === "account/logout") {
      child.send({ id: message.id, result: {} });
    }
  };
}

test("stdio handshake locks version and credential home while stripping inherited secrets", async (t) => {
  let context;
  context = await fixture((message, child) => successfulHandler(context)(message, child));
  t.after(() => rm(context.base, { recursive: true, force: true }));
  const runtime = await context.client.start();
  assert.deepEqual(runtime, {
    userAgent: `aicrm_desktop/${AICRM_CODEX_APP_SERVER_VERSION} (Linux; x86_64)`,
    platformFamily: "unix",
    platformOs: "linux"
  });
  const child = context.child();
  const initialize = child.messages[0];
  assert.deepEqual(initialize, {
    method: "initialize",
    id: 1,
    params: {
      clientInfo: { name: "aicrm_desktop", title: "AiCRM", version: "0.1.0" },
      capabilities: { experimentalApi: false, requestAttestation: false }
    }
  });
  assert.deepEqual(child.messages[1], { method: "initialized", params: {} });
  const spawnCall = context.spawnCall();
  assert.equal(spawnCall.executable, "/opt/aicrm/bin/codex");
  assert.deepEqual(spawnCall.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(spawnCall.options.env.CODEX_HOME, context.home);
  assert.equal(spawnCall.options.env.HOME, context.home);
  assert.equal(spawnCall.options.env.USERPROFILE, context.home);
  assert.equal(spawnCall.options.env.PATH, "/usr/bin:/bin");
  assert.equal(spawnCall.options.env.HTTPS_PROXY, "http://127.0.0.1:8080");
  for (const forbidden of [
    "OPENAI_API_KEY",
    "DATABASE_URL",
    "INTERNAL_ACCESS_TOKEN",
    "RUST_LOG"
  ]) {
    assert.equal(forbidden in spawnCall.options.env, false);
  }
  assert.deepEqual(await context.client.readAccount(false), {
    account: null,
    requiresOpenaiAuth: true
  });
  await context.client.stop();
});

test("stop fails closed until the exact App Server child exit is observed", async (t) => {
  let context;
  context = await fixture((message, child) => successfulHandler(context)(message, child));
  t.after(() => rm(context.base, { recursive: true, force: true }));
  await context.client.start();
  const child = context.child();
  const originalKill = child.kill.bind(child);
  child.kill = () => true;
  await assert.rejects(context.client.stop(), {
    code: "executor_app_server_stop_failed"
  });
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);

  child.kill = originalKill;
  await context.client.stop();
  assert.equal(child.signalCode, "SIGTERM");
});

test("protocol failure keeps an unconfirmed writer visible to explicit stop", async (t) => {
  let context;
  context = await fixture((message, child) => successfulHandler(context)(message, child));
  t.after(() => rm(context.base, { recursive: true, force: true }));
  await context.client.start();
  const child = context.child();
  const originalKill = child.kill.bind(child);
  child.kill = () => true;
  child.sendRaw("{invalid-json}\n");
  await Promise.resolve();
  await assert.rejects(context.client.stop(), {
    code: "executor_app_server_stop_failed"
  });
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);

  child.kill = originalKill;
  await context.client.stop();
  assert.equal(child.signalCode, "SIGTERM");
});

test("browser login, cached completion and refreshed account stay Main-only safe projections", async (t) => {
  let accountAuthorized = false;
  let context;
  const handler = (message, child) => {
    if (message.method === "initialize") {
      child.send({
        id: message.id,
        result: {
          userAgent: `aicrm_desktop/${AICRM_CODEX_APP_SERVER_VERSION} (Windows; x86_64)`,
          codexHome: context.canonicalHome,
          platformFamily: "windows",
          platformOs: "windows"
        }
      });
    } else if (message.method === "account/login/start") {
      child.send({
        id: message.id,
        result: {
          type: "chatgpt",
          loginId: "login_browser_1",
          authUrl: "https://chatgpt.com/auth/codex?state=opaque"
        }
      });
    } else if (message.method === "account/read") {
      child.send({
        id: message.id,
        result: accountAuthorized
          ? {
              account: { type: "chatgpt", email: "Owner@Example.com", planType: "plus" },
              requiresOpenaiAuth: true
            }
          : { account: null, requiresOpenaiAuth: true }
      });
    }
  };
  context = await fixture(handler);
  t.after(() => rm(context.base, { recursive: true, force: true }));
  await context.client.start();
  const challenge = await context.client.startBrowserLogin();
  assert.deepEqual(challenge, {
    type: "chatgpt",
    loginId: "login_browser_1",
    authUrl: "https://chatgpt.com/auth/codex?state=opaque"
  });
  context.child().send({
    method: "account/login/completed",
    params: { loginId: challenge.loginId, success: true, error: null }
  });
  assert.deepEqual(await context.client.waitForLogin(challenge.loginId), {
    loginId: challenge.loginId,
    success: true
  });
  accountAuthorized = true;
  assert.deepEqual(await context.client.readAccount(true), {
    account: { type: "chatgpt", email: "Owner@Example.com", planType: "plus" },
    requiresOpenaiAuth: true
  });
  const requests = context.child().messages;
  assert.deepEqual(requests.find((item) => item.method === "account/login/start").params, {
    type: "chatgpt",
    useHostedLoginSuccessPage: true,
    appBrand: "codex"
  });
  assert.deepEqual(requests.filter((item) => item.method === "account/read").at(-1).params, {
    refreshToken: true
  });
  await context.client.stop();
});

test("device code, cancellation and logout use only stable protocol methods", async (t) => {
  let context;
  context = await fixture((message, child) => successfulHandler(context)(message, child));
  t.after(() => rm(context.base, { recursive: true, force: true }));
  await context.client.start();
  assert.deepEqual(await context.client.startDeviceCodeLogin(), {
    type: "chatgptDeviceCode",
    loginId: "login_device_1",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234"
  });
  assert.equal(await context.client.cancelLogin("login_device_1"), "canceled");
  await context.client.logout();
  assert.deepEqual(
    context.child().messages.filter((message) => message.id).map((message) => message.method),
    ["initialize", "account/login/start", "account/login/cancel", "account/logout"]
  );
  await context.client.stop();
});

test("untrusted browser URLs and a mismatched Codex version fail closed", async (t) => {
  const badUrls = [
    "http://chatgpt.com/auth",
    "https://chatgpt.com.evil.example/auth",
    "https://user:secret@chatgpt.com/auth",
    "https://chatgpt.com:444/auth",
    "https://chatgpt.com/auth#token"
  ];
  for (const authUrl of badUrls) {
    let context;
    context = await fixture((message, child) =>
      successfulHandler(context, { authUrl })(message, child)
    );
    t.after(() => rm(context.base, { recursive: true, force: true }));
    await context.client.start();
    await assert.rejects(context.client.startBrowserLogin(), {
      code: "executor_app_server_protocol_invalid"
    });
    await context.client.stop();
  }

  let mismatch;
  mismatch = await fixture((message, child) =>
    successfulHandler(mismatch, { userAgent: "aicrm_desktop/0.143.0 (Linux; x86_64)" })(
      message,
      child
    )
  );
  t.after(() => rm(mismatch.base, { recursive: true, force: true }));
  await assert.rejects(mismatch.client.start(), { code: "executor_app_server_unsupported" });
});

test("malformed protocol, stderr overflow and process exit reject waiters without echoing secrets", async (t) => {
  let malformed;
  malformed = await fixture((message, child) => {
    if (message.method === "initialize") {
      successfulHandler(malformed)(message, child);
    } else if (message.method === "account/read") {
      child.sendRaw("not-json\n");
    }
  });
  t.after(() => rm(malformed.base, { recursive: true, force: true }));
  await malformed.client.start();
  await assert.rejects(malformed.client.readAccount(false), {
    code: "executor_app_server_protocol_invalid"
  });

  let noisy;
  noisy = await fixture((message, child) => successfulHandler(noisy)(message, child));
  t.after(() => rm(noisy.base, { recursive: true, force: true }));
  await noisy.client.start();
  const waiting = noisy.client.waitForLogin("login_waiting_1");
  const canary = "secret-token-canary";
  noisy.child().stderr.write(Buffer.alloc((256 << 10) + 1, canary));
  await assert.rejects(waiting, (error) => {
    assert.equal(error.code, "executor_app_server_protocol_invalid");
    assert.equal(error.message.includes(canary), false);
    return true;
  });

  let crashed;
  crashed = await fixture((message, child) => successfulHandler(crashed)(message, child));
  t.after(() => rm(crashed.base, { recursive: true, force: true }));
  await crashed.client.start();
  const completion = crashed.client.waitForLogin("login_crash_1");
  crashed.child().crash();
  await assert.rejects(completion, { code: "executor_app_server_stopped" });
});

test("unsafe staging and non-absolute executable are rejected before spawn", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicrm-codex-home-unsafe-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const unsafe = path.join(base, "unsafe");
  await mkdir(unsafe, { mode: 0o755 });
  await chmod(unsafe, 0o755);
  const client = new CodexAppServerAuthClient({
    codexHome: unsafe,
    codexExecutable: "/opt/aicrm/bin/codex",
    clientName: "aicrm_desktop",
    clientTitle: "AiCRM",
    clientVersion: "0.1.0",
    spawn: () => {
      throw new Error("must not spawn");
    }
  });
  await assert.rejects(client.start(), { code: "executor_app_server_home_unsafe" });
  assert.throws(
    () =>
      new CodexAppServerAuthClient({
        codexHome: unsafe,
        codexExecutable: "codex",
        clientName: "aicrm_desktop",
        clientTitle: "AiCRM",
        clientVersion: "0.1.0"
      }),
    { code: "executor_app_server_start_failed" }
  );
});
