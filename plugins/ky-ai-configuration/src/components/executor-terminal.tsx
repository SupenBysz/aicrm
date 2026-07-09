import { useEffect, useRef, useState } from "react";
import { Button, Space, Typography } from "antd";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { RequestClient } from "@ky/admin-core";
import { listAiExecutorRawLogs, type AiExecutorRawLog } from "../api";

interface ExecutorRawTerminalProps {
  client: RequestClient;
  taskId?: string;
  height?: number;
}

export function ExecutorRawTerminal({ client, height = 280, taskId }: ExecutorRawTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastSequenceRef = useRef(0);
  const autoScrollRef = useRef(true);
  const pendingLogsRef = useRef<AiExecutorRawLog[]>([]);
  const queuedSequenceRef = useRef(0);
  const flushTimerRef = useRef<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    autoScrollRef.current = autoScroll;
    if (autoScroll) {
      window.requestAnimationFrame(() => terminalRef.current?.scrollToBottom());
    }
  }, [autoScroll]);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: "Menlo, Consolas, monospace",
      fontSize: 12,
      scrollback: 2000,
      theme: {
        background: "#111827",
        foreground: "#d1d5db",
        cursor: "#d1d5db"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;
    const scrollDisposable = terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      const isAtBottom = buffer.viewportY >= buffer.baseY;
      if (!isAtBottom && autoScrollRef.current) {
        autoScrollRef.current = false;
        setAutoScroll(false);
      }
    });
    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(containerRef.current);
    return () => {
      resizeObserver.disconnect();
      scrollDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      lastSequenceRef.current = 0;
      queuedSequenceRef.current = 0;
      pendingLogsRef.current = [];
      if (flushTimerRef.current != null) {
        window.cancelAnimationFrame(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!taskId) {
      terminalRef.current?.clear();
      lastSequenceRef.current = 0;
      return undefined;
    }
    let cancelled = false;
    terminalRef.current?.clear();
    lastSequenceRef.current = 0;
    queuedSequenceRef.current = 0;
    pendingLogsRef.current = [];
    if (flushTimerRef.current != null) {
      window.cancelAnimationFrame(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    const flushLogs = () => {
      flushTimerRef.current = null;
      if (cancelled) {
        pendingLogsRef.current = [];
        return;
      }
      const logs = pendingLogsRef.current.splice(0);
      if (logs.length === 0) return;
      logs.forEach((log) => {
        if (log.sequence <= lastSequenceRef.current) return;
        lastSequenceRef.current = log.sequence;
        terminalRef.current?.writeln(formatTerminalLine(log));
      });
      if (autoScrollRef.current) terminalRef.current?.scrollToBottom();
    };

    const enqueueLog = (log: AiExecutorRawLog) => {
      const seenSequence = Math.max(lastSequenceRef.current, queuedSequenceRef.current);
      if (log.sequence <= seenSequence) return;
      queuedSequenceRef.current = log.sequence;
      pendingLogsRef.current.push(log);
      if (flushTimerRef.current == null) {
        flushTimerRef.current = window.requestAnimationFrame(flushLogs);
      }
    };

    void (async () => {
      const initial = await listAiExecutorRawLogs(client, taskId, 0).catch(() => []);
      if (cancelled) return;
      initial.forEach(enqueueLog);
      if (!client.stream) return;
      while (!cancelled) {
        const response = await client.stream(`/api/v1/ai-executor-tasks/${taskId}/terminal-stream?after=${lastSequenceRef.current}`).catch(() => null);
        if (!response?.body || cancelled) return;
        await readSse(response, (event) => {
          if (event.event !== "terminal.line") return;
          enqueueLog(event.data as AiExecutorRawLog);
        });
        if (!cancelled) await wait(100);
      }
    })();

    return () => {
      cancelled = true;
      pendingLogsRef.current = [];
      if (flushTimerRef.current != null) {
        window.cancelAnimationFrame(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [client, taskId]);

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <Space style={{ justifyContent: "space-between", width: "100%" }}>
        <Typography.Text strong>终端投影</Typography.Text>
        <Space size={6}>
          <Button size="small" onClick={() => terminalRef.current?.clear()}>
            清屏
          </Button>
          <Button size="small" type={autoScroll ? "primary" : "default"} onClick={() => setAutoScroll((value) => !value)}>
            跟随底部
          </Button>
        </Space>
      </Space>
      <div
        ref={containerRef}
        style={{
          background: "#111827",
          borderRadius: 6,
          height,
          overflow: "hidden",
          padding: 8,
          width: "100%"
        }}
      />
    </Space>
  );
}

interface SseEvent {
  event: string;
  data: unknown;
}

async function readSse(response: Response, onEvent: (event: SseEvent) => void) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = parseSseChunk(chunk);
      if (event) onEvent(event);
      index = buffer.indexOf("\n\n");
    }
  }
}

function parseSseChunk(chunk: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return { event, data: dataLines.join("\n") };
  }
}

function formatTerminalLine(log: AiExecutorRawLog) {
  const time = new Date(log.createdAt).toLocaleTimeString("zh-CN", { hour12: false });
  return `[${time}] [${log.source}/${log.direction}] ${formatTerminalText(log)}`;
}

function formatTerminalText(log: AiExecutorRawLog) {
  const raw = log.rawJson as Record<string, unknown> | null | undefined;
  const eventType = stringValue(raw?.type);
  const item = raw?.item as Record<string, unknown> | undefined;
  const itemType = stringValue(item?.type);

  if (eventType === "item.started") {
    if (itemType === "command_execution") return `$ ${normalizeCodexCommand(stringValue(item?.command) || "执行命令")}`;
    if (itemType === "agent_message") return "Codex 正在生成回复...";
    return `开始 ${itemType || "任务步骤"}`;
  }

  if (eventType === "item.completed") {
    if (itemType === "agent_message") return stringValue(item?.text) || "Codex 已输出回复";
    if (itemType === "command_execution") {
      const command = normalizeCodexCommand(stringValue(item?.command) || "执行命令");
      const exitCode = numberValue(item?.exit_code);
      const output = stringValue(item?.aggregated_output).trim();
      return output
        ? `$ ${command}\n# exit ${exitCode ?? "-"}\n${truncateTerminalOutput(output)}`
        : `$ ${command}\n# exit ${exitCode ?? "-"}`;
    }
    return `完成 ${itemType || "任务步骤"}`;
  }

  if (eventType === "turn.completed") {
    const usage = raw?.usage as Record<string, unknown> | undefined;
    const inputTokens = numberValue(usage?.input_tokens);
    const cachedTokens = numberValue(usage?.cached_input_tokens);
    const outputTokens = numberValue(usage?.output_tokens);
    const reasoningTokens = numberValue(usage?.reasoning_output_tokens);
    return [
      "Codex 回合完成",
      inputTokens == null ? "" : `input=${inputTokens}`,
      cachedTokens == null ? "" : `cached=${cachedTokens}`,
      outputTokens == null ? "" : `output=${outputTokens}`,
      reasoningTokens == null ? "" : `reasoning=${reasoningTokens}`
    ]
      .filter(Boolean)
      .join(" · ");
  }

  if (log.terminalLine && !looksLikeJson(log.terminalLine)) return log.terminalLine;
  if (log.rawText && !looksLikeJson(log.rawText)) return log.rawText;
  return eventType || JSON.stringify(log.rawJson ?? {});
}

function normalizeCodexCommand(command: string) {
  const value = command.trim();
  const match = value.match(/^\/bin\/bash -lc "([\s\S]*)"$/);
  if (match?.[1]) return match[1].replace(/\\"/g, "\"");
  const singleQuoteMatch = value.match(/^\/bin\/bash -lc '([\s\S]*)'$/);
  if (singleQuoteMatch?.[1]) return singleQuoteMatch[1];
  return value;
}

function truncateTerminalOutput(value: string, maxLength = 4000) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n... 已截断 ${value.length - maxLength} 字符`;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function looksLikeJson(value: string) {
  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0])) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
