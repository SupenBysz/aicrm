import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DesktopCodexAppServerSupervisor,
  DesktopCodexAppServerSupervisorError
} from "./desktop-codex-app-server-supervisor.ts";

const OWNERSHIP = "a".repeat(64);
const RAW_LOGIN_ID = "login_secret_canary_123";
const RAW_URL = "https://chatgpt.com/auth/codex?state=raw-secret-canary";
const RAW_CANARY = "raw-secret-canary";
const RAW_LOGIN_ID_HASH = "684e7adf3efbb843d095fcc094406454f19d60a73b1c51ead56a510d3b2e816e";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function binding(overrides = {}) {
  return {
    executorId: "executor_1",
    sessionId: "session_1",
    stagingOwnershipDigest: OWNERSHIP,
    ...overrides
  };
}

class FakeClient {
  constructor(options = {}) {
    this.options = options;
    this.calls = {
      start: 0,
      startBrowserLogin: 0,
      waitForLogin: 0,
      readAccount: 0,
      cancelLogin: 0,
      stop: 0
    };
    this.waiting = options.waiting ?? null;
  }

  async start() {
    this.calls.start += 1;
    if (this.options.startGate) await this.options.startGate.promise;
    if (this.options.startError) throw this.options.startError;
    return { platformFamily: "test", platformOs: "test", userAgent: "test" };
  }

  async startBrowserLogin() {
    this.calls.startBrowserLogin += 1;
    if (this.options.loginStartGate) await this.options.loginStartGate.promise;
    if (this.options.loginStartError) throw this.options.loginStartError;
    return this.options.challenge ?? {
      type: "chatgpt",
      loginId: RAW_LOGIN_ID,
      authUrl: RAW_URL
    };
  }

  async waitForLogin(loginId) {
    this.calls.waitForLogin += 1;
    assert.equal(loginId, this.options.expectedLoginId ?? RAW_LOGIN_ID);
    if (this.options.waitError) throw this.options.waitError;
    if (this.waiting) return this.waiting.promise;
    return this.options.waitCompletion ?? { loginId, success: true };
  }

  async readAccount(refreshToken) {
    this.calls.readAccount += 1;
    assert.equal(typeof refreshToken, "boolean");
    if (this.options.readError) throw this.options.readError;
    return this.options.account ?? {
      account: { type: "chatgpt", email: "owner@example.com", planType: "plus" },
      requiresOpenaiAuth: true
    };
  }

  async cancelLogin(loginId) {
    this.calls.cancelLogin += 1;
    assert.equal(loginId, this.options.expectedLoginId ?? RAW_LOGIN_ID);
    if (this.options.cancelError) throw this.options.cancelError;
    this.waiting?.resolve({ loginId, success: false });
    return "canceled";
  }

  async stop() {
    this.calls.stop += 1;
    if (this.options.stopGate) await this.options.stopGate.promise;
    if ((this.options.stopFailures ?? 0) > 0) {
      this.options.stopFailures -= 1;
      throw this.options.stopError ?? new Error(`${RAW_CANARY}/stop-failure`);
    }
    if (this.options.stopError) throw this.options.stopError;
    this.waiting?.reject(new Error(`${RAW_CANARY}/waiter-stopped`));
  }
}

function fixture(options = {}) {
  const events = [];
  const effects = [];
  const factoryBindings = [];
  const clients = [];
  const randomCalls = [];
  let randomValue = options.randomStart ?? 0;
  const supervisor = new DesktopCodexAppServerSupervisor({
    randomBytes(size) {
      randomCalls.push(size);
      randomValue += 1;
      return Buffer.alloc(size, randomValue);
    },
    async createClient(value) {
      factoryBindings.push({ ...value });
      if (options.factoryGate) await options.factoryGate.promise;
      if (options.factoryError) throw options.factoryError;
      const client = options.clientFactory
        ? options.clientFactory(value)
        : new FakeClient(options.clientOptions);
      clients.push(client);
      return client;
    },
    async openTrustedUrl(value) {
      effects.push(value);
      if (options.effectHandler) {
        await options.effectHandler(value, effects.length);
        return;
      }
      if (options.effectGate) await options.effectGate.promise;
      if (options.effectError) throw options.effectError;
    },
    onStateChange(event) {
      events.push(event);
      options.onStateChange?.(event);
    }
  });
  return { supervisor, events, effects, factoryBindings, clients, randomCalls };
}

function assertSafe(value, forbidden = [RAW_LOGIN_ID, RAW_URL, RAW_CANARY, process.cwd()]) {
  const serialized = JSON.stringify(value);
  for (const item of forbidden) assert.equal(serialized.includes(item), false, serialized);
}

function brandedInvalidInput(canary) {
  const error = new DesktopCodexAppServerSupervisorError(
    "desktop_codex_app_server_invalid_input",
    canary
  );
  error.stack = `external-stack:${canary}`;
  error.rawLoginId = RAW_LOGIN_ID;
  error.loginIdHash = RAW_LOGIN_ID_HASH;
  error.credentialPath = "/private/codex/credential-home";
  return error;
}

async function rejectsRebrandedInvalid(execute, external, forbidden) {
  await assert.rejects(execute, (error) => {
    assert.notEqual(error, external);
    assert.equal(error.code, "desktop_codex_app_server_invalid_input");
    assert.equal(error.message, "Codex App Server 数据对象无效");
    const projections = [
      error.message,
      String(error),
      error.stack ?? "",
      JSON.stringify(error)
    ];
    for (const projection of projections) {
      for (const canary of forbidden) assert.equal(projection.includes(canary), false, projection);
    }
    return true;
  });
}

test("twenty exact concurrent starts share one factory, start, and immutable safe receipt", async () => {
  const startGate = deferred();
  const current = fixture({ clientOptions: { startGate } });
  const starts = Array.from({ length: 20 }, () => current.supervisor.start(binding()));
  await Promise.resolve();
  assert.equal(current.factoryBindings.length, 1);
  assert.equal(current.clients.length, 1);
  assert.equal(current.clients[0].calls.start, 1);
  startGate.resolve();
  const receipts = await Promise.all(starts);
  for (const receipt of receipts) assert.equal(receipt, receipts[0]);
  assert.deepEqual(current.randomCalls, [32, 32]);
  assert.deepEqual(current.factoryBindings, [binding()]);
  assert.deepEqual(Object.keys(receipts[0]).sort(), [
    "bootIdHash",
    "executorId",
    "instanceIdHash",
    "sessionId",
    "stagingOwnershipDigest",
    "version"
  ]);
  assert.match(receipts[0].bootIdHash, /^[0-9a-f]{64}$/);
  assert.match(receipts[0].instanceIdHash, /^[0-9a-f]{64}$/);
  assert.equal(await current.supervisor.start(binding()), receipts[0]);
  await assert.rejects(
    current.supervisor.start(binding({ sessionId: "session_2" })),
    { code: "desktop_codex_app_server_conflict" }
  );
  await assert.rejects(
    current.supervisor.start(binding({ stagingOwnershipDigest: "b".repeat(64) })),
    { code: "desktop_codex_app_server_conflict" }
  );
  assertSafe(receipts);
  await current.supervisor.shutdownAll();
  assert.equal(current.clients[0].calls.stop, 1);
});

test("browser login exposes raw challenge only to Main effects and advances every success state", async () => {
  const waiting = deferred();
  const stopGate = deferred();
  const current = fixture({ clientOptions: { waiting, stopGate } });
  const receipt = await current.supervisor.start(binding());
  const loginStarts = [
    current.supervisor.startBrowserLogin(receipt),
    current.supervisor.startBrowserLogin(receipt)
  ];
  const waitingSnapshots = await Promise.all(loginStarts);
  assert.equal(waitingSnapshots[0], waitingSnapshots[1]);
  assert.equal(current.clients[0].calls.startBrowserLogin, 1);
  assert.deepEqual(current.effects, [RAW_URL]);
  assert.equal(waitingSnapshots[0].state, "waiting_user");

  const loginWaits = [
    current.supervisor.waitForLogin(receipt),
    current.supervisor.waitForLogin(receipt)
  ];
  assert.equal(current.clients[0].calls.waitForLogin, 1);
  waiting.resolve({ loginId: RAW_LOGIN_ID, success: true });
  const completed = await Promise.all(loginWaits);
  assert.equal(completed[0], completed[1]);
  assert.equal(completed[0].state, "login_completed");
  assert.equal(Object.isFrozen(completed[0]), true);
  assert.equal(completed[0].loginIdHash, RAW_LOGIN_ID_HASH);
  assert.deepEqual(Object.keys(completed[0]).sort(), [
    "bootIdHash",
    "errorCode",
    "executorId",
    "instanceIdHash",
    "loginIdHash",
    "sessionId",
    "stagingOwnershipDigest",
    "state",
    "version"
  ]);
  for (const key of [
    "version", "bootIdHash", "instanceIdHash", "executorId", "sessionId",
    "stagingOwnershipDigest"
  ]) {
    assert.equal(completed[0][key], receipt[key]);
  }
  const ordinarySnapshot = current.supervisor.getSnapshot(receipt);
  assert.equal("loginIdHash" in ordinarySnapshot, false);
  assert.equal(current.events.some((event) => "loginIdHash" in event), false);
  assert.deepEqual(await current.supervisor.readAccount(receipt, true), {
    account: { type: "chatgpt", email: "owner@example.com", planType: "plus" },
    requiresOpenaiAuth: true
  });

  const stops = [current.supervisor.stop(receipt), current.supervisor.stop(receipt)];
  assert.equal(current.events.at(-1).state, "stopping");
  assert.equal(current.clients[0].calls.stop, 1);
  stopGate.resolve();
  const stopped = await Promise.all(stops);
  assert.equal(stopped[0], stopped[1]);
  assert.equal(stopped[0].state, "stopped");
  assert.deepEqual(current.events.map((event) => event.state), [
    "starting",
    "ready",
    "waiting_user",
    "login_completed",
    "stopping",
    "stopped"
  ]);
  assertSafe([receipt, waitingSnapshots, completed, stopped, current.events]);
});

test("reopen uses the exact in-memory validated challenge with concurrent singleflight", async () => {
  const reopenGate = deferred();
  const current = fixture({
    async effectHandler(value, callNumber) {
      assert.equal(value, RAW_URL);
      if (callNumber === 2) await reopenGate.promise;
    }
  });
  const receipt = await current.supervisor.start(binding());
  const waiting = await current.supervisor.startBrowserLogin(receipt);
  assert.equal(waiting.state, "waiting_user");

  const descriptorOnlyReceipt = new Proxy(receipt, {
    get() {
      throw new Error(`${RAW_CANARY}/receipt-get`);
    }
  });
  const first = current.supervisor.reopenBrowserLogin(descriptorOnlyReceipt);
  const second = current.supervisor.reopenBrowserLogin(receipt);
  assert.equal(first, second);
  await Promise.resolve();
  assert.deepEqual(current.effects, [RAW_URL, RAW_URL]);
  assert.deepEqual(current.events.map((event) => event.state), [
    "starting", "ready", "waiting_user"
  ]);

  reopenGate.resolve();
  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
  assert.equal(firstSnapshot, secondSnapshot);
  assert.equal(firstSnapshot.state, "waiting_user");
  assert.equal("authUrl" in firstSnapshot, false);
  assert.equal("loginId" in firstSnapshot, false);
  assertSafe([waiting, firstSnapshot, current.events]);
  await current.supervisor.shutdownAll();
});

test("reopen fails closed when cancel, completion, or shutdown wins the URL effect race", async (t) => {
  await t.test("cancel", async () => {
    const reopenGate = deferred();
    const current = fixture({
      async effectHandler(_value, callNumber) {
        if (callNumber === 2) await reopenGate.promise;
      }
    });
    const receipt = await current.supervisor.start(binding());
    await current.supervisor.startBrowserLogin(receipt);
    const reopening = current.supervisor.reopenBrowserLogin(receipt);
    await Promise.resolve();
    const canceled = await current.supervisor.cancelLogin(receipt);
    assert.equal(canceled.state, "stopped");
    await assert.rejects(current.supervisor.reopenBrowserLogin(receipt), {
      code: "desktop_codex_app_server_stopped"
    });
    reopenGate.resolve();
    await assert.rejects(reopening, { code: "desktop_codex_app_server_stopped" });
    assert.deepEqual(current.effects, [RAW_URL, RAW_URL]);
    assertSafe([canceled, current.events]);
  });

  await t.test("login completion", async () => {
    const waiting = deferred();
    const reopenGate = deferred();
    const current = fixture({
      clientOptions: { waiting },
      async effectHandler(_value, callNumber) {
        if (callNumber === 2) await reopenGate.promise;
      }
    });
    const receipt = await current.supervisor.start(binding());
    await current.supervisor.startBrowserLogin(receipt);
    const completion = current.supervisor.waitForLogin(receipt);
    const reopening = current.supervisor.reopenBrowserLogin(receipt);
    await Promise.resolve();
    waiting.resolve({ loginId: RAW_LOGIN_ID, success: true });
    const completed = await completion;
    assert.equal(completed.state, "login_completed");
    await assert.rejects(current.supervisor.reopenBrowserLogin(receipt), {
      code: "desktop_codex_app_server_stopped"
    });
    reopenGate.resolve();
    await assert.rejects(reopening, { code: "desktop_codex_app_server_stopped" });
    assert.deepEqual(current.effects, [RAW_URL, RAW_URL]);
    assertSafe([completed, current.events]);
    await current.supervisor.shutdownAll();
  });

  await t.test("shutdown", async () => {
    const reopenGate = deferred();
    const current = fixture({
      async effectHandler(_value, callNumber) {
        if (callNumber === 2) await reopenGate.promise;
      }
    });
    const receipt = await current.supervisor.start(binding());
    await current.supervisor.startBrowserLogin(receipt);
    const reopening = current.supervisor.reopenBrowserLogin(receipt);
    await Promise.resolve();
    await current.supervisor.shutdownAll();
    assert.equal(current.supervisor.getSnapshot(receipt).state, "stopped");
    await assert.rejects(current.supervisor.reopenBrowserLogin(receipt), {
      code: "desktop_codex_app_server_stopped"
    });
    reopenGate.resolve();
    await assert.rejects(reopening, { code: "desktop_codex_app_server_stopped" });
    assert.deepEqual(current.effects, [RAW_URL, RAW_URL]);
    assertSafe(current.events);
  });
});

test("reopen never leaks its URL through snapshots, events, or normalized failures", async () => {
  const failureCanary = `${RAW_URL}/${RAW_CANARY}/reopen-effect`;
  let authUrlDescriptorReads = 0;
  const challenge = new Proxy({
    type: "chatgpt",
    loginId: RAW_LOGIN_ID,
    authUrl: RAW_URL
  }, {
    get(_target, key) {
      if (key === "then") return undefined;
      throw new Error(`${RAW_CANARY}/challenge-get`);
    },
    getOwnPropertyDescriptor(target, key) {
      if (key === "authUrl") {
        authUrlDescriptorReads += 1;
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: authUrlDescriptorReads === 1
            ? RAW_URL
            : `https://chatgpt.com/auth/codex?state=${RAW_CANARY}`
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
  });
  const current = fixture({
    clientOptions: { challenge },
    async effectHandler(value, callNumber) {
      assert.equal(value, RAW_URL);
      if (callNumber === 2) throw new Error(failureCanary);
    }
  });
  const receipt = await current.supervisor.start(binding());
  await current.supervisor.startBrowserLogin(receipt);
  assert.equal(authUrlDescriptorReads, 1);
  await assert.rejects(current.supervisor.reopenBrowserLogin(receipt), (error) => {
    assert.equal(error.code, "desktop_codex_app_server_operation_failed");
    assert.equal(error.message, "Codex App Server 浏览器授权重开失败");
    assertSafe({ message: error.message, stack: error.stack }, [
      RAW_URL, RAW_LOGIN_ID, RAW_CANARY, failureCanary, process.cwd()
    ]);
    return true;
  });
  assert.equal(current.supervisor.getSnapshot(receipt).state, "failed");
  assert.equal("authUrl" in current.supervisor.getSnapshot(receipt), false);
  assert.equal(current.events.some((event) => "authUrl" in event || "loginId" in event), false);
  await assert.rejects(current.supervisor.reopenBrowserLogin(receipt), {
    code: "desktop_codex_app_server_operation_failed"
  });
  assert.deepEqual(current.effects, [RAW_URL, RAW_URL]);
  assertSafe(current.events);
  await current.supervisor.shutdownAll();
});

test("cancel wins a pending completion race and stops the exact in-memory client", async () => {
  const waiting = deferred();
  const current = fixture({ clientOptions: { waiting } });
  const receipt = await current.supervisor.start(binding());
  await current.supervisor.startBrowserLogin(receipt);
  const pendingWait = current.supervisor.waitForLogin(receipt);
  const canceled = await current.supervisor.cancelLogin(receipt);
  assert.equal(canceled.state, "stopped");
  assert.equal(current.clients[0].calls.cancelLogin, 1);
  assert.equal(current.clients[0].calls.stop, 1);
  await assert.rejects(pendingWait, { code: "desktop_codex_app_server_stopped" });
  assert.equal(current.events.some((event) => "loginIdHash" in event), false);
  assert.deepEqual(current.events.map((event) => event.state), [
    "starting", "ready", "waiting_user", "stopping", "stopped"
  ]);
  assertSafe([canceled, current.events]);
});

test("login completion hashes exact raw ids into instance-bound frozen receipts", async () => {
  const cases = [
    {
      loginId: RAW_LOGIN_ID,
      hash: RAW_LOGIN_ID_HASH,
      executorId: "executor_hash_1",
      sessionId: "session_hash_1",
      ownership: "d".repeat(64)
    },
    {
      loginId: "login_secret_canary_456",
      hash: "8326a78765ae9f58d12e951ea7f1194903c83cedef18103428fb36283a07d10f",
      executorId: "executor_hash_2",
      sessionId: "session_hash_2",
      ownership: "e".repeat(64)
    }
  ];
  const completions = [];
  for (const [index, item] of cases.entries()) {
    const current = fixture({
      randomStart: index * 10,
      clientOptions: {
        expectedLoginId: item.loginId,
        challenge: { type: "chatgpt", loginId: item.loginId, authUrl: RAW_URL }
      }
    });
    const receipt = await current.supervisor.start(binding({
      executorId: item.executorId,
      sessionId: item.sessionId,
      stagingOwnershipDigest: item.ownership
    }));
    await current.supervisor.startBrowserLogin(receipt);
    const completion = await current.supervisor.waitForLogin(receipt);
    completions.push(completion);
    assert.equal(completion.loginIdHash, item.hash);
    assert.equal(completion.bootIdHash, receipt.bootIdHash);
    assert.equal(completion.instanceIdHash, receipt.instanceIdHash);
    assert.equal(completion.executorId, item.executorId);
    assert.equal(completion.sessionId, item.sessionId);
    assert.equal(Object.isFrozen(completion), true);
    assert.equal("loginIdHash" in current.supervisor.getSnapshot(receipt), false);
    assert.equal(current.events.some((event) => "loginIdHash" in event), false);
    assertSafe([completion, current.events], [item.loginId, RAW_URL, process.cwd()]);
    await current.supervisor.shutdownAll();
  }
  assert.notEqual(completions[0].loginIdHash, completions[1].loginIdHash);
  assert.notEqual(completions[0].instanceIdHash, completions[1].instanceIdHash);
});

test("completion mismatch and shutdown races return no login hash", async (t) => {
  await t.test("mismatched completion", async () => {
    const mismatchId = "login_mismatched_private_canary";
    const current = fixture({
      clientOptions: {
        waitCompletion: { loginId: mismatchId, success: true }
      }
    });
    const receipt = await current.supervisor.start(binding());
    await current.supervisor.startBrowserLogin(receipt);
    await assert.rejects(current.supervisor.waitForLogin(receipt), (error) => {
      assert.equal(error.code, "desktop_codex_app_server_operation_failed");
      assertSafe({ message: error.message, stack: error.stack }, [
        RAW_LOGIN_ID, mismatchId, process.cwd()
      ]);
      return true;
    });
    assert.equal(current.events.some((event) => "loginIdHash" in event), false);
    assert.equal("loginIdHash" in current.supervisor.getSnapshot(receipt), false);
    await current.supervisor.shutdownAll();
  });

  await t.test("shutdown while waiting", async () => {
    const waiting = deferred();
    const current = fixture({ clientOptions: { waiting } });
    const receipt = await current.supervisor.start(binding());
    await current.supervisor.startBrowserLogin(receipt);
    const completion = current.supervisor.waitForLogin(receipt);
    await current.supervisor.shutdownAll();
    await assert.rejects(completion, { code: "desktop_codex_app_server_stopped" });
    assert.equal(current.events.some((event) => "loginIdHash" in event), false);
    assert.equal("loginIdHash" in current.supervisor.getSnapshot(receipt), false);
    assertSafe(current.events, [RAW_LOGIN_ID, RAW_URL, process.cwd()]);
  });
});

test("a browser challenge that returns after shutdown is cancelled without any URL effect", async () => {
  const loginStartGate = deferred();
  const current = fixture({ clientOptions: { loginStartGate } });
  const receipt = await current.supervisor.start(binding());
  const lateLogin = current.supervisor.startBrowserLogin(receipt);
  await Promise.resolve();
  assert.equal(current.clients[0].calls.startBrowserLogin, 1);

  await current.supervisor.shutdownAll();
  assert.equal(current.supervisor.getSnapshot(receipt).state, "stopped");
  assert.deepEqual(current.effects, []);
  loginStartGate.resolve();
  await assert.rejects(lateLogin, { code: "desktop_codex_app_server_stopped" });
  assert.equal(current.clients[0].calls.cancelLogin, 1);
  assert.deepEqual(current.effects, []);
  assertSafe(current.events);
});

test("failed stops release singleflight for exact retry and repeated shutdown convergence", async (t) => {
  await t.test("exact receipt retry", async () => {
    const current = fixture({ clientOptions: { stopFailures: 1 } });
    const receipt = await current.supervisor.start(binding());
    await assert.rejects(current.supervisor.stop(receipt), {
      code: "desktop_codex_app_server_stop_failed"
    });
    assert.equal(current.clients[0].calls.stop, 1);
    const recovered = await current.supervisor.stop(receipt);
    assert.equal(recovered.state, "stopped");
    assert.equal(current.clients[0].calls.stop, 2);
    await current.supervisor.stop(receipt);
    assert.equal(current.clients[0].calls.stop, 2);
  });

  await t.test("start failure binding-bound recovery", async () => {
    const current = fixture({
      clientOptions: { startError: new Error("start failed"), stopFailures: 1 }
    });
    await assert.rejects(current.supervisor.start(binding()), {
      code: "desktop_codex_app_server_start_failed"
    });
    assert.equal(current.clients[0].calls.stop, 1);
    const stopped = await current.supervisor.stopByBinding(binding());
    assert.equal(stopped.state, "stopped");
    assert.equal(current.clients[0].calls.stop, 2);
    await assert.rejects(
      current.supervisor.stopByBinding(binding({ sessionId: "foreign" })),
      { code: "desktop_codex_app_server_stale_receipt" }
    );
  });

  await t.test("start failure converges after its internal stop already completed", async () => {
    const current = fixture({
      clientOptions: { startError: new Error("start failed") }
    });
    await assert.rejects(current.supervisor.start(binding()), {
      code: "desktop_codex_app_server_start_failed"
    });
    assert.equal(current.clients[0].calls.stop, 1);
    const stopped = await current.supervisor.stopByBinding(binding());
    assert.equal(stopped.state, "stopped");
    assert.equal(current.clients[0].calls.stop, 1);
  });

  await t.test("closed admission and repeated shutdown", async () => {
    const current = fixture({ clientOptions: { stopFailures: 1 } });
    await current.supervisor.start(binding());
    await assert.rejects(current.supervisor.shutdownAll(), {
      code: "desktop_codex_app_server_stop_failed"
    });
    assert.equal(current.clients[0].calls.stop, 1);
    await assert.rejects(current.supervisor.start(binding({ executorId: "executor_2" })), {
      code: "desktop_codex_app_server_stopped"
    });
    await current.supervisor.shutdownAll();
    assert.equal(current.clients[0].calls.stop, 2);
    await current.supervisor.shutdownAll();
    assert.equal(current.clients[0].calls.stop, 2);
  });
});

test("shutdown waits for starting instances, stops every current-boot client, and closes admission", async () => {
  const startGate = deferred();
  const clientsByExecutor = new Map();
  const current = fixture({
    clientFactory(value) {
      const client = new FakeClient({ startGate });
      clientsByExecutor.set(value.executorId, client);
      return client;
    }
  });
  const firstStart = current.supervisor.start(binding());
  const secondStart = current.supervisor.start(binding({
    executorId: "executor_2",
    sessionId: "session_2",
    stagingOwnershipDigest: "c".repeat(64)
  }));
  const shutdown = current.supervisor.shutdownAll();
  startGate.resolve();
  const [first, second] = await Promise.all([firstStart, secondStart]);
  await shutdown;
  assert.equal(current.supervisor.getSnapshot(first).state, "stopped");
  assert.equal(current.supervisor.getSnapshot(second).state, "stopped");
  assert.equal(clientsByExecutor.get("executor_1").calls.stop, 1);
  assert.equal(clientsByExecutor.get("executor_2").calls.stop, 1);
  await assert.rejects(current.supervisor.start(binding({ executorId: "executor_3" })), {
    code: "desktop_codex_app_server_stopped"
  });
  assertSafe(current.events);
});

test("factory, client start, Main effect, account, and stop failures use fixed safe codes", async () => {
  const failureCanary = `${RAW_CANARY}/private/credential/home`;

  const factoryFailure = fixture({ factoryError: new Error(failureCanary) });
  await assert.rejects(factoryFailure.supervisor.start(binding()), (error) => {
    assert.equal(error.code, "desktop_codex_app_server_start_failed");
    assertSafe({ message: error.message, stack: error.stack }, [failureCanary, RAW_CANARY, process.cwd()]);
    return true;
  });
  assert.equal(factoryFailure.events.at(-1).state, "failed");

  const startFailure = fixture({ clientOptions: { startError: new Error(failureCanary) } });
  await assert.rejects(startFailure.supervisor.start(binding()), {
    code: "desktop_codex_app_server_start_failed"
  });
  assert.equal(startFailure.clients[0].calls.stop, 1);
  assert.equal(startFailure.events.at(-1).errorCode, "desktop_codex_app_server_start_failed");

  const effectFailure = fixture({ effectError: new Error(failureCanary) });
  const effectReceipt = await effectFailure.supervisor.start(binding());
  await assert.rejects(effectFailure.supervisor.startBrowserLogin(effectReceipt), (error) => {
    assert.equal(error.code, "desktop_codex_app_server_operation_failed");
    assertSafe({ message: error.message, stack: error.stack }, [failureCanary, RAW_CANARY, process.cwd()]);
    return true;
  });
  assert.equal(effectFailure.clients[0].calls.cancelLogin, 1);
  assert.equal(effectFailure.events.at(-1).state, "failed");

  const readFailure = fixture({ clientOptions: { readError: new Error(failureCanary) } });
  const readReceipt = await readFailure.supervisor.start(binding());
  await assert.rejects(readFailure.supervisor.readAccount(readReceipt, true), {
    code: "desktop_codex_app_server_operation_failed"
  });
  assert.equal(readFailure.events.at(-1).state, "failed");

  const stopFailure = fixture({ clientOptions: { stopError: new Error(failureCanary) } });
  const stopReceipt = await stopFailure.supervisor.start(binding());
  await assert.rejects(stopFailure.supervisor.stop(stopReceipt), (error) => {
    assert.equal(error.code, "desktop_codex_app_server_stop_failed");
    assertSafe({ message: error.message, stack: error.stack }, [failureCanary, RAW_CANARY, process.cwd()]);
    return true;
  });
  assert.equal(stopFailure.events.at(-1).state, "failed");
  await assert.rejects(stopFailure.supervisor.shutdownAll(), {
    code: "desktop_codex_app_server_stop_failed"
  });

  assertSafe([
    factoryFailure.events,
    startFailure.events,
    effectFailure.events,
    readFailure.events,
    stopFailure.events
  ], [failureCanary, RAW_LOGIN_ID, RAW_URL, RAW_CANARY, process.cwd()]);
});

test("branded invalid-input dependency errors are re-created locally on all three DTO paths", async (t) => {
  const privatePath = "/private/codex/credential-home";
  const canary = `${RAW_LOGIN_ID}:${RAW_LOGIN_ID_HASH}:${privatePath}`;
  const forbidden = [RAW_LOGIN_ID, RAW_LOGIN_ID_HASH, privatePath, canary, process.cwd()];

  await t.test("readAccount", async () => {
    const external = brandedInvalidInput(canary);
    const current = fixture({ clientOptions: { readError: external } });
    const receipt = await current.supervisor.start(binding());
    await rejectsRebrandedInvalid(
      () => current.supervisor.readAccount(receipt, true),
      external,
      forbidden
    );
    assertSafe(current.events, forbidden);
    await current.supervisor.shutdownAll();
  });

  await t.test("startBrowserLogin", async () => {
    const external = brandedInvalidInput(canary);
    const current = fixture({ clientOptions: { loginStartError: external } });
    const receipt = await current.supervisor.start(binding());
    await rejectsRebrandedInvalid(
      () => current.supervisor.startBrowserLogin(receipt),
      external,
      forbidden
    );
    assert.deepEqual(current.effects, []);
    assertSafe(current.events, forbidden);
    await current.supervisor.shutdownAll();
  });

  await t.test("waitForLogin", async () => {
    const external = brandedInvalidInput(canary);
    const current = fixture({ clientOptions: { waitError: external } });
    const receipt = await current.supervisor.start(binding());
    await current.supervisor.startBrowserLogin(receipt);
    await rejectsRebrandedInvalid(
      () => current.supervisor.waitForLogin(receipt),
      external,
      forbidden
    );
    assertSafe(current.events, forbidden);
    await current.supervisor.shutdownAll();
  });
});

test("old boots, forged instances, and malformed receipts are rejected without touching clients", async () => {
  const oldBoot = fixture({ randomStart: 0 });
  const receipt = await oldBoot.supervisor.start(binding());
  const newBoot = fixture({ randomStart: 20 });
  await assert.rejects(
    Promise.resolve().then(() => newBoot.supervisor.getSnapshot(receipt)),
    { code: "desktop_codex_app_server_stale_receipt" }
  );
  await assert.rejects(
    Promise.resolve().then(() => newBoot.supervisor.waitForLogin(receipt)),
    { code: "desktop_codex_app_server_stale_receipt" }
  );
  await assert.rejects(
    Promise.resolve().then(() => newBoot.supervisor.reopenBrowserLogin(receipt)),
    { code: "desktop_codex_app_server_stale_receipt" }
  );
  await assert.rejects(
    Promise.resolve().then(() => oldBoot.supervisor.getSnapshot({
      ...receipt,
      instanceIdHash: "f".repeat(64)
    })),
    { code: "desktop_codex_app_server_stale_receipt" }
  );
  await assert.rejects(
    Promise.resolve().then(() => oldBoot.supervisor.reopenBrowserLogin({
      ...receipt,
      instanceIdHash: "f".repeat(64)
    })),
    { code: "desktop_codex_app_server_stale_receipt" }
  );
  await assert.rejects(
    Promise.resolve().then(() => oldBoot.supervisor.getSnapshot({ ...receipt, hostPath: "/tmp" })),
    { code: "desktop_codex_app_server_invalid_input" }
  );
  assert.equal(oldBoot.clients[0].calls.stop, 0);
  await oldBoot.supervisor.shutdownAll();
  await newBoot.supervisor.shutdownAll();
});

test("hostile DTOs use one own data descriptor capture and fixed invalid-input failures", async () => {
  const canary = `${RAW_CANARY}/hostile-dto/private/path`;
  const current = fixture();

  const accessor = binding();
  Object.defineProperty(accessor, "sessionId", {
    enumerable: true,
    get() {
      throw new Error(canary);
    }
  });
  assert.throws(() => current.supervisor.start(accessor), (error) => {
    assert.equal(error.code, "desktop_codex_app_server_invalid_input");
    assertSafe({ message: error.message, stack: error.stack }, [canary, RAW_CANARY, process.cwd()]);
    return true;
  });

  const throwingOwnKeys = new Proxy(binding(), {
    ownKeys() {
      throw new Error(canary);
    }
  });
  assert.throws(() => current.supervisor.start(throwingOwnKeys), (error) => {
    assert.equal(error.code, "desktop_codex_app_server_invalid_input");
    assertSafe({ message: error.message, stack: error.stack }, [canary, RAW_CANARY, process.cwd()]);
    return true;
  });

  const inherited = Object.assign(Object.create({ token: canary }), binding());
  assert.throws(() => current.supervisor.start(inherited), {
    code: "desktop_codex_app_server_invalid_input"
  });
  const nonEnumerable = binding();
  Object.defineProperty(nonEnumerable, "hidden", { value: canary, enumerable: false });
  assert.throws(() => current.supervisor.start(nonEnumerable), {
    code: "desktop_codex_app_server_invalid_input"
  });
  assert.throws(() => current.supervisor.start({ ...binding(), [Symbol("token")]: canary }), {
    code: "desktop_codex_app_server_invalid_input"
  });

  const descriptorOnly = new Proxy(binding(), {
    get() {
      throw new Error(canary);
    }
  });
  const receipt = await current.supervisor.start(descriptorOnly);
  const receiptProxy = new Proxy(receipt, {
    get() {
      throw new Error(canary);
    }
  });
  assert.equal(current.supervisor.getSnapshot(receiptProxy).state, "ready");
  assertSafe([receipt, current.events], [canary, RAW_CANARY, process.cwd()]);
  await current.supervisor.shutdownAll();
});

test("hostile client DTO traps never leak and are normalized as invalid input", async () => {
  const canary = `${RAW_CANARY}/client-dto/private/path`;
  const challenge = new Proxy({
    type: "chatgpt",
    loginId: RAW_LOGIN_ID,
    authUrl: RAW_URL
  }, {
    ownKeys() {
      throw new Error(canary);
    }
  });
  const current = fixture({ clientOptions: { challenge } });
  const receipt = await current.supervisor.start(binding());
  await assert.rejects(current.supervisor.startBrowserLogin(receipt), (error) => {
    assert.equal(error.code, "desktop_codex_app_server_invalid_input");
    assertSafe({ message: error.message, stack: error.stack }, [canary, RAW_CANARY, process.cwd()]);
    return true;
  });
  assert.equal(current.events.at(-1).state, "failed");
  assert.equal(current.events.at(-1).errorCode, "desktop_codex_app_server_invalid_input");
  assert.deepEqual(current.effects, []);
  assertSafe(current.events, [canary, RAW_LOGIN_ID, RAW_URL, RAW_CANARY, process.cwd()]);
  await current.supervisor.shutdownAll();
});

test("source is current-boot-only and contains no external process or persistence escape hatch", async () => {
  const source = await readFile(
    new URL("./desktop-codex-app-server-supervisor.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /process\.kill/);
  assert.doesNotMatch(source, /\bpid\b/i);
  assert.doesNotMatch(source, /node:fs|writeFile|readFile|appendFile/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|electron-store/);
  assert.match(source, /randomDigest\(BOOT_HASH_DOMAIN/);
  assert.match(source, /randomDigest\(INSTANCE_HASH_DOMAIN/);
});
