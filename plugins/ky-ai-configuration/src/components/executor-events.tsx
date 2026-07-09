import { useEffect, useRef, useState } from "react";
import { Empty, List, Space, Tag, Timeline, Typography } from "antd";
import type { RequestClient } from "@ky/admin-core";
import { listAiExecutorEvents, type AiExecutorEvent } from "../api";

interface ExecutorEventTimelineProps {
  client: RequestClient;
  taskId?: string;
  compact?: boolean;
}

export function ExecutorEventTimeline({ client, compact = false, taskId }: ExecutorEventTimelineProps) {
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
  }, [client, taskId]);

  if (!taskId) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无执行器任务" />;
  }
  if (events.length === 0) {
    return <Typography.Text type="secondary">等待执行器事件...</Typography.Text>;
  }
  if (compact) {
    return (
      <Timeline
        items={events.slice(-8).map((event) => ({
          color: eventColor(event.level),
          children: (
            <Space direction="vertical" size={0}>
              <Typography.Text>{event.message}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatTime(event.createdAt)} · {event.eventType}
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
      dataSource={events}
      renderItem={(event) => (
        <List.Item>
          <Space direction="vertical" size={2} style={{ width: "100%" }}>
            <Space wrap>
              <Tag color={eventColor(event.level)}>{levelLabel(event.level)}</Tag>
              <Typography.Text strong>{event.message}</Typography.Text>
              <Typography.Text type="secondary">{formatTime(event.createdAt)}</Typography.Text>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {event.eventType}
            </Typography.Text>
            <details>
              <summary style={{ cursor: "pointer", color: "var(--ant-color-text-secondary)" }}>查看结构化 payload</summary>
              <div style={{ marginTop: 8 }}>{renderJsonPayload(event.payload)}</div>
            </details>
          </Space>
        </List.Item>
      )}
    />
  );
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
