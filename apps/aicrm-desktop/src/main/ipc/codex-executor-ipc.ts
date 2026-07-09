import { app, ipcMain } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { IPC_CHANNELS } from "../../shared/constants";
import type { CodexExecutorAuthInput, CodexExecutorAuthResult, DesktopCommandResult } from "../../shared/types";

const CODEX_AUTH_PROBE_TOKEN = "AICRM_CODEX_AUTH_OK";
const CODEX_AUTH_PROBE_PROMPT = `只输出 ${CODEX_AUTH_PROBE_TOKEN}，不要输出其他内容。`;

export function registerCodexExecutorIpc() {
  ipcMain.handle(IPC_CHANNELS.codexExecutorAuthorize, async (_event, input: CodexExecutorAuthInput) => {
    return startCodexLogin(input);
  });
  ipcMain.handle(IPC_CHANNELS.codexExecutorGetAuthStatus, async (_event, input: CodexExecutorAuthInput) => {
    return getCodexAuthStatus(input);
  });
}

async function startCodexLogin(input: CodexExecutorAuthInput): Promise<DesktopCommandResult<CodexExecutorAuthResult>> {
  const current = await detectCodexAuthorization(input);
  if (current.authStatus === "authorized") {
    return {
      ok: true,
      data: {
        ...current,
        message: "已检测到本机 Codex 可用授权，无需重新登录。"
      }
    };
  }

  const codexHome = executorCodexHome(input);
  mkdirSync(codexHome, { recursive: true });
  try {
    const child = spawn("codex", ["login"], {
      detached: true,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: "ignore"
    });
    child.unref();
    return {
      ok: true,
      data: {
        executorId: input.executorId,
        authStatus: "authorizing",
        codexHome,
        authAccountLabel: "",
        codexVersion: await codexVersion(),
        capabilities: {
          codexHome,
          authProbe: "login_started",
          checkedAt: new Date().toISOString()
        },
        command: `CODEX_HOME='${codexHome}' codex login`,
        message: "已拉起 Codex 浏览器授权流程，请在打开的浏览器中完成登录。"
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "codex_login_failed",
        message: error instanceof Error ? error.message : "Codex 登录流程启动失败"
      }
    };
  }
}

async function getCodexAuthStatus(input: CodexExecutorAuthInput): Promise<DesktopCommandResult<CodexExecutorAuthResult>> {
  const detected = await detectCodexAuthorization(input);
  return {
    ok: true,
    data: detected
  };
}

function executorCodexHome(input: CodexExecutorAuthInput): string {
  if (isConcreteCodexHome(input.codexHome)) {
    return input.codexHome;
  }
  return join(app.getPath("userData"), "codex-executors", safePart(input.executorId));
}

type CodexAuthProbe = {
  codexHome: string;
  source: "configured" | "executor" | "env" | "default";
  authorized: boolean;
  authStatus: "not_authorized" | "authorized" | "error";
  accountLabel: string;
  statusText: string;
  exitStatus: number | null;
};

async function detectCodexAuthorization(input: CodexExecutorAuthInput): Promise<CodexExecutorAuthResult> {
  const candidates = codexHomeCandidates(input);
  const probes: CodexAuthProbe[] = [];
  for (const candidate of candidates) {
    const probe = await probeCodexHome(candidate.codexHome, candidate.source);
    probes.push(probe);
    if (probe.authorized) break;
  }
  const authorized = probes.find((probe) => probe.authorized);
  const failed = probes.find((probe) => probe.authStatus === "error");
  const selected = authorized ?? failed ?? probes[0];
  const authStatus = authorized ? "authorized" : failed ? "error" : "not_authorized";
  const version = await codexVersion();

  return {
    executorId: input.executorId,
    authStatus,
    codexHome: selected.codexHome,
    authAccountLabel: authorized?.accountLabel ?? "",
    codexVersion: version,
    capabilities: {
      codexHome: selected.codexHome,
      authProbe: authStatus,
      authProof: "codex_exec",
      authSource: selected.source,
      checkedAt: new Date().toISOString(),
      probes: probes.map((probe) => ({
        codexHome: probe.codexHome,
        source: probe.source,
        authStatus: probe.authStatus,
        exitStatus: probe.exitStatus,
        statusText: truncateText(probe.statusText, 500)
      }))
    },
    command: `CODEX_HOME=${shellQuote(selected.codexHome)} codex exec --json --ephemeral --ignore-rules --skip-git-repo-check -C ${shellQuote(codexProbeWorkspace())} -`,
    message: authorized
      ? `已通过 Codex 真实执行探针：${authorized.accountLabel || "可正常使用"}。`
      : authStatus === "error"
        ? "Codex 真实执行探针失败，请检查网络、模型、配置或额度。"
        : "Codex 真实执行探针未通过，请完成 Codex 登录授权。"
  };
}

function codexHomeCandidates(input: CodexExecutorAuthInput): Array<{ codexHome: string; source: CodexAuthProbe["source"] }> {
  const result: Array<{ codexHome: string; source: CodexAuthProbe["source"] }> = [];
  const add = (codexHome: string | undefined, source: CodexAuthProbe["source"]) => {
    const normalized = codexHome?.trim();
    if (!normalized) return;
    if (result.some((item) => item.codexHome === normalized)) return;
    result.push({ codexHome: normalized, source });
  };

  if (isConcreteCodexHome(input.codexHome)) {
    add(input.codexHome, "configured");
  }
  add(join(app.getPath("userData"), "codex-executors", safePart(input.executorId)), "executor");
  add(process.env.CODEX_HOME, "env");
  add(join(homedir(), ".codex"), "default");
  return result;
}

async function probeCodexHome(codexHome: string, source: CodexAuthProbe["source"]): Promise<CodexAuthProbe> {
  const status = await runCodex(
    ["exec", "--json", "--ephemeral", "--ignore-rules", "--skip-git-repo-check", "-C", codexProbeWorkspace(), "-"],
    codexHome,
    CODEX_AUTH_PROBE_PROMPT,
    30000
  );
  const statusText = [status.stdout, status.stderr].filter(Boolean).join("\n").trim();
  const authorized = status.status === 0 && statusText.includes(CODEX_AUTH_PROBE_TOKEN);
  const authStatus = authorized ? "authorized" : isAuthorizationFailure(statusText) ? "not_authorized" : "error";
  return {
    codexHome,
    source,
    authorized,
    authStatus,
    accountLabel: authorized ? await readCodexAccountLabel(codexHome) : "",
    statusText,
    exitStatus: status.status
  };
}

async function codexVersion(): Promise<string> {
  const result = await runCodex(["--version"]);
  return [result.stdout, result.stderr].filter(Boolean).join(" ").trim();
}

function runCodex(
  args: string[],
  codexHome?: string,
  input?: string,
  timeout = 5000
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn("codex", args, {
      env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const finish = (status: number | null, extraError = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        stdout: stdout.trim(),
        stderr: [stderr.trim(), extraError.trim()].filter(Boolean).join("\n")
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000);
    }, timeout);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(timedOut ? null : code, timedOut ? "Codex 探针执行超时" : ""));

    if (input) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

async function readCodexAccountLabel(codexHome: string): Promise<string> {
  const status = await runCodex(["login", "status"], codexHome);
  return parseCodexAccountLabel([status.stdout, status.stderr].filter(Boolean).join("\n"));
}

function parseCodexAccountLabel(statusText: string): string {
  const text = statusText.trim();
  const match = text.match(/logged in using\s+(.+)$/i);
  if (match?.[1]) return match[1].trim();
  return text.split(/\r?\n/)[0] ?? "";
}

function isAuthorizationFailure(value: string): boolean {
  return /not logged in|login required|unauthorized|authentication|auth|未登录|未授权|认证|登录/i.test(value);
}

function codexProbeWorkspace(): string {
  const workspace = join(tmpdir(), "aicrm-codex-auth-probe");
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function truncateText(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function isConcreteCodexHome(value: string | undefined): value is string {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return !trimmed.includes("AiCRM Desktop 用户数据目录");
}

function safePart(value: string): string {
  return String(value || "default").replace(/[^a-zA-Z0-9_.:-]/g, "_");
}
