import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, List, Space, Tag, Timeline, Typography } from "antd";
import type { RequestClient } from "@ky/admin-core";
import { listAiExecutorEvents, type AiExecutorEvent } from "../api";

interface ExecutorEventTimelineProps {
  client: RequestClient;
  taskId?: string;
  compact?: boolean;
  showDebugEvents?: boolean;
  showPayload?: boolean;
}

export function ExecutorEventTimeline({
  client,
  compact = false,
  showDebugEvents = false,
  showPayload = true,
  taskId
}: ExecutorEventTimelineProps) {
  const [events, setEvents] = useState<AiExecutorEvent[]>([]);
  const lastSequenceRef = useRef(0);

  useEffect(() => {
    if (!taskId) {
      setEvents([]);
      lastSequenceRef.current = 0;
      return undefined;
    }
    let cancelled = false;
    setEvents([]);
    lastSequenceRef.current = 0;
    const append = (event: AiExecutorEvent) => {
      if (event.sequence <= lastSequenceRef.current) return;
      lastSequenceRef.current = event.sequence;
      if (isHiddenExecutorEvent(event, showDebugEvents)) return;
      setEvents((current) => [...current, event].slice(-200));
    };

    void (async () => {
      const initial = await listAiExecutorEvents(client, taskId, 0).catch(() => []);
      if (cancelled) return;
      initial.forEach(append);
      if (!client.stream) return;
      while (!cancelled) {
        const response = await client.stream(`/api/v1/ai-executor-tasks/${taskId}/events-stream?after=${lastSequenceRef.current}`).catch(() => null);
        if (!response?.body || cancelled) return;
        await readSse(response, (event) => {
          if (event.event === "stream.closed") return;
          append(event.data as AiExecutorEvent);
        });
        if (!cancelled) await wait(250);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, showDebugEvents, taskId]);

  const eventGroups = useMemo(() => groupConsecutiveExecutorEvents(events), [events]);

  if (!taskId) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无执行器任务" />;
  }
  if (eventGroups.length === 0) {
    return <Typography.Text type="secondary">等待执行器事件...</Typography.Text>;
  }
  if (compact) {
    return (
      <Timeline
        items={eventGroups.slice(-8).map((group) => ({
          color: eventColor(group.event.level),
          children: (
            <Space direction="vertical" size={0}>
              <Space size={6} wrap>
                <Typography.Text>{group.event.message}</Typography.Text>
                {group.count > 1 ? <Tag color="blue">x{group.count}</Tag> : null}
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatTime(group.event.createdAt)} · {group.event.eventType}
              </Typography.Text>
            </Space>
          )
        }))}
      />
    );
  }
  return (
    <List
      size="small"
      dataSource={eventGroups}
      renderItem={(group) => (
        <List.Item>
          <Space direction="vertical" size={2} style={{ width: "100%" }}>
            <Space wrap>
              <Tag color={eventColor(group.event.level)}>{levelLabel(group.event.level)}</Tag>
              <Typography.Text strong>{group.event.message}</Typography.Text>
              {group.count > 1 ? <Tag color="blue">x{group.count}</Tag> : null}
              <Typography.Text type="secondary">{formatTime(group.event.createdAt)}</Typography.Text>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {group.event.eventType} · {formatExecutorEventGroupSequence(group)}
            </Typography.Text>
            {showPayload ? (
              <details>
                <summary style={{ cursor: "pointer", color: "var(--ant-color-text-secondary)" }}>结构化上下文与环境信息</summary>
                <div style={{ marginTop: 8 }}>{renderJsonPayload(redactStructuredPayload(group.event.payload))}</div>
              </details>
            ) : null}
          </Space>
        </List.Item>
      )}
    />
  );
}

function isHiddenExecutorEvent(event: AiExecutorEvent, showDebugEvents: boolean) {
  return event.eventType === "terminal.resized" || (!showDebugEvents && event.level === "debug");
}

interface ExecutorEventGroup {
  count: number;
  event: AiExecutorEvent;
  firstSequence: number;
  id: string;
  lastSequence: number;
  repeatKey: string;
}

function groupConsecutiveExecutorEvents(events: AiExecutorEvent[]): ExecutorEventGroup[] {
  const groups: ExecutorEventGroup[] = [];
  events.forEach((event) => {
    const repeatKey = executorEventRepeatKey(event);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup?.repeatKey === repeatKey) {
      lastGroup.count += 1;
      lastGroup.event = event;
      lastGroup.lastSequence = event.sequence;
      return;
    }
    groups.push({
      count: 1,
      event,
      firstSequence: event.sequence,
      id: event.id,
      lastSequence: event.sequence,
      repeatKey
    });
  });
  return groups;
}

function executorEventRepeatKey(event: AiExecutorEvent) {
  return [
    event.level,
    event.eventType,
    event.message,
    stringifyJson(redactStructuredPayload(event.payload))
  ].join("\u001f");
}

function formatExecutorEventGroupSequence(group: ExecutorEventGroup) {
  return group.firstSequence === group.lastSequence
    ? `#${group.lastSequence}`
    : `#${group.firstSequence}-#${group.lastSequence}`;
}

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? "");
  }
}

const structuredPayloadSensitiveKeyPattern =
  /^(authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|secret|password|passwd|captcha|otp|mfa|localStorage|sessionStorage|indexedDB|storage|rawScreenshot|screenshot|imageData|base64|rawPrompt|prompt|rawDom|domHtml|html)$/i;

const structuredPayloadSensitiveValuePatterns: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[已脱敏]"],
  [/(sk-[A-Za-z0-9_-]{8,})/g, "[已脱敏]"],
  [
    /((?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|secret|password|passwd|storage|localStorage|sessionStorage|验证码|captcha)(?:["'\s:=]+))([^,\s"'`;}\]]{3,})/gi,
    "$1[已脱敏]"
  ],
  [/((?:token|secret|password|cookie)["']?\s*:\s*["'])([^"']{3,})(["'])/gi, "$1[已脱敏]$3"]
];

function redactStructuredPayload(value: unknown, key = ""): unknown {
  if (value == null) return value;
  if (structuredPayloadSensitiveKeyPattern.test(key)) return "[已脱敏]";
  if (typeof value === "string") {
    return structuredPayloadSensitiveValuePatterns.reduce(
      (current, [pattern, replacement]) => current.replace(pattern, replacement),
      value
    );
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactStructuredPayload(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactStructuredPayload(entryValue, entryKey)
      ])
    );
  }
  return value;
}

function renderJsonPayload(value: unknown) {
  return (
    <pre
      style={{
        maxHeight: 260,
        margin: 0,
        padding: 12,
        overflow: "auto",
        border: "1px solid rgba(127, 127, 127, 0.18)",
        borderRadius: 8,
        background: "rgba(127, 127, 127, 0.08)",
        fontSize: 12,
        lineHeight: 1.55,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word"
      }}
    >
      {JSON.stringify(value ?? {}, null, 2)}
    </pre>
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

function eventColor(level: string) {
  if (level === "success") return "green";
  if (level === "warning") return "orange";
  if (level === "error") return "red";
  if (level === "debug") return "default";
  return "blue";
}

function levelLabel(level: string) {
  const labels: Record<string, string> = {
    debug: "调试",
    info: "信息",
    success: "成功",
    warning: "注意",
    error: "失败"
  };
  return labels[level] ?? level;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
