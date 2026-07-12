import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Card, Descriptions, Space, Tag, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getCodexAuthorizationCapabilities,
  isAiExecutorDesktopRuntime,
  usePermissions,
  useRequestClient
} from "@ky/admin-core";
import {
  AI_EXECUTOR_DESKTOP_HANDOFF_READY,
  cancelAiExecutorAuthorizationSession,
  createAiExecutorAuthorizationSession,
  getAiExecutorAuthorizationUserAction,
  getCurrentAiExecutorAuthorizationSession,
  reopenAiExecutorAuthorizationSession,
  watchAiExecutorAuthorizationSession,
  type AiExecutorAuthorizationIntent,
  type AiExecutorAuthorizationSession,
  type AiExecutorAuthorizationUserAction,
  type AiExecutorConfig
} from "../api";
import { AI_EXECUTOR_PERMISSIONS } from "../permissions";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired", "interrupted", "superseded"]);

const STATUS_META: Record<string, { label: string; color: string }> = {
  starting: { label: "正在启动", color: "processing" },
  waiting_user: { label: "等待用户授权", color: "gold" },
  verifying: { label: "正在验证账号", color: "processing" },
  succeeded: { label: "授权成功", color: "green" },
  failed: { label: "授权失败", color: "red" },
  cancelled: { label: "已取消", color: "default" },
  expired: { label: "已过期", color: "orange" },
  interrupted: { label: "服务重启，已中断", color: "orange" },
  superseded: { label: "已被新会话替代", color: "default" }
};

export function ExecutorAuthorizationPanel({ executor, onExecutorChanged }: { executor: AiExecutorConfig; onExecutorChanged: () => void }) {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [session, setSession] = useState<AiExecutorAuthorizationSession | null>(null);
  const [userAction, setUserAction] = useState<AiExecutorAuthorizationUserAction | null>(null);
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "connected" | "closed" | "error">("idle");
  const [desktopBridgeReady, setDesktopBridgeReady] = useState(false);

  const canAuthorize = permissions.can(AI_EXECUTOR_PERMISSIONS.authorize);
  const canChangeAccount = canAuthorize && permissions.can(AI_EXECUTOR_PERMISSIONS.changeAccount);
  const canForceCancel = permissions.can(AI_EXECUTOR_PERMISSIONS.forceRevoke);
  const isDesktop = executor.runtimeType === "desktop";

  const currentQuery = useQuery({
    queryKey: ["ai-executor-authorization-current", executor.id],
    queryFn: () => getCurrentAiExecutorAuthorizationSession(client, executor.id),
    retry: false,
    refetchInterval: session && !TERMINAL_STATUSES.has(session.status) ? 5000 : false
  });

  useEffect(() => {
    setSession(currentQuery.data ?? null);
  }, [currentQuery.data, executor.id]);

  useEffect(() => {
    let active = true;
    if (!isDesktop || !isAiExecutorDesktopRuntime()) {
      setDesktopBridgeReady(false);
      return () => {
        active = false;
      };
    }
    void getCodexAuthorizationCapabilities()
      .then((capabilities) => {
        if (active) setDesktopBridgeReady(capabilities?.bridgeVersion === 2);
      })
      .catch(() => {
        if (active) setDesktopBridgeReady(false);
      });
    return () => {
      active = false;
    };
  }, [isDesktop]);

  useEffect(() => {
    if (!session?.id || TERMINAL_STATUSES.has(session.status)) return undefined;
    setStreamState("connecting");
    const subscription = watchAiExecutorAuthorizationSession(client, session.id, {
      after: session.sequence,
      onOpen: () => setStreamState("connected"),
      onSession: (next) => {
        setSession((current) => (!current || next.sequence >= current.sequence ? next : current));
        queryClient.setQueryData(["ai-executor-authorization-current", executor.id], next);
        if (TERMINAL_STATUSES.has(next.status)) {
          onExecutorChanged();
          void queryClient.invalidateQueries({ queryKey: ["ai-executors"] });
        }
      },
      onClosed: () => setStreamState("closed"),
      onError: () => setStreamState("error")
    });
    return () => subscription.close();
  }, [client, executor.id, queryClient, session?.id]);

  useEffect(() => {
    let active = true;
    setUserAction(null);
    if (!session || session.runtimeType !== "server" || session.status !== "waiting_user" || !session.userActionRequired) {
      return () => {
        active = false;
      };
    }
    void getAiExecutorAuthorizationUserAction(client, session.id)
      .then((action) => {
        if (active) setUserAction(action);
      })
      .catch((error: Error) => {
        if (active) void message.warning(error.message);
      });
    return () => {
      active = false;
      setUserAction(null);
    };
  }, [client, message, session?.id, session?.status, session?.userActionRequired]);

  const startMutation = useMutation({
    mutationFn: (intent: AiExecutorAuthorizationIntent) => createAiExecutorAuthorizationSession(client, executor.id, intent),
    onSuccess: (next) => {
      setSession(next);
      setStreamState("connecting");
      queryClient.setQueryData(["ai-executor-authorization-current", executor.id], next);
    },
    onError: (error: Error) => message.error(error.message)
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelAiExecutorAuthorizationSession(client, session!),
    onSuccess: (next) => {
      setSession(next);
      setUserAction(null);
      void message.success("授权会话已取消");
      onExecutorChanged();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const reopenMutation = useMutation({
    mutationFn: () => reopenAiExecutorAuthorizationSession(client, session!),
    onSuccess: (action) => setUserAction(action),
    onError: (error: Error) => message.error(error.message)
  });

  const runtimeBlocked = isDesktop && (!desktopBridgeReady || !AI_EXECUTOR_DESKTOP_HANDOFF_READY);
  const canStart = canAuthorize && !runtimeBlocked && (!session || TERMINAL_STATUSES.has(session.status));
  const statusMeta = session ? STATUS_META[session.status] ?? { label: session.status, color: "default" } : null;
  const deadlineText = useDeadline(userAction?.sessionDeadlineAt ?? session?.sessionDeadlineAt);
  const safeVerificationUrl = useMemo(
    () => (userAction ? officialVerificationUrl(userAction.verificationUrl) : null),
    [userAction]
  );

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      {runtimeBlocked ? (
        <Alert
          showIcon
          type="warning"
          message={desktopBridgeReady ? "Desktop 设备 handoff 尚未接通" : "需要 AiCRM Desktop Bridge v2"}
          description="客户端执行器只能在完成设备身份、绑定、desktop-handoff 与一次性 Ticket 后调用 bridge.start；当前页面不会仅凭 capability 创建会话，也不会回退旧 IPC。"
        />
      ) : null}
      {currentQuery.isError ? (
        <Alert showIcon type="error" message="授权控制面不可用" description={(currentQuery.error as Error).message} />
      ) : null}

      <Space wrap>
        <Button
          type="primary"
          disabled={!canStart}
          loading={startMutation.isPending}
          onClick={() => startMutation.mutate("authorize")}
        >
          开始授权
        </Button>
        {executor.credentialStatus === "authorized" ? (
          <Button
            disabled={!canStart || !canChangeAccount}
            loading={startMutation.isPending}
            onClick={() => startMutation.mutate("change_account")}
          >
            更换授权账号
          </Button>
        ) : null}
        {session && !TERMINAL_STATUSES.has(session.status) ? (
          <Button
            danger
            disabled={!canAuthorize && !canForceCancel}
            loading={cancelMutation.isPending}
            onClick={() => cancelMutation.mutate()}
          >
            取消授权
          </Button>
        ) : null}
      </Space>

      {session ? (
        <Card size="small" title={<Space><span>授权会话</span><Tag color={statusMeta?.color}>{statusMeta?.label}</Tag></Space>}>
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="会话 ID">{session.id}</Descriptions.Item>
            <Descriptions.Item label="授权意图">{session.intent === "change_account" ? "更换账号" : "首次/重新授权"}</Descriptions.Item>
            <Descriptions.Item label="运行方式">{session.runtimeType === "server" ? "服务端设备码" : "客户端系统浏览器"}</Descriptions.Item>
            <Descriptions.Item label="事件序列">#{session.sequence} · revision {session.revision}</Descriptions.Item>
            <Descriptions.Item label="实时连接">{streamStateLabel(streamState)}</Descriptions.Item>
            <Descriptions.Item label="失败原因">{session.failure?.code || "-"}</Descriptions.Item>
          </Descriptions>
          {Object.keys(session.accountSummary ?? {}).length > 0 ? (
            <Alert type="success" showIcon message="账号已确认" description={safeAccountSummary(session.accountSummary)} />
          ) : null}
        </Card>
      ) : (
        <Alert type="info" showIcon message="暂无授权会话" description="创建会话后，页面通过可回放事件流观察正式状态。关闭页面不会取消授权。" />
      )}

      {userAction ? (
        <Card size="small" title="Codex 关联授权">
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Typography.Text type="secondary">在官方页面输入以下关联验证码。AiCRM 会自动监听授权结果。</Typography.Text>
            <Typography.Title level={2} copyable={{ text: userAction.userCode }} style={{ margin: 0, letterSpacing: 4 }}>
              {userAction.userCode}
            </Typography.Title>
            <Typography.Text>监管剩余时间：{deadlineText}</Typography.Text>
            {!safeVerificationUrl ? (
              <Alert type="error" showIcon message="授权地址未通过官方域名校验，已拒绝打开" />
            ) : (
              <Space wrap>
                <Button type="primary" onClick={() => openOfficialUrl(safeVerificationUrl)}>打开官方授权页面</Button>
                <Button loading={reopenMutation.isPending} onClick={() => reopenMutation.mutate()}>重新显示授权信息</Button>
              </Space>
            )}
          </Space>
        </Card>
      ) : null}
    </Space>
  );
}

function useDeadline(value?: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!value) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [value]);
  if (!value) return "-";
  const remaining = Math.max(0, Math.floor((new Date(value).getTime() - now) / 1000));
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
}

function officialVerificationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    if (!["auth.openai.com", "platform.openai.com", "chatgpt.com"].includes(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function openOfficialUrl(url: string) {
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
}

function streamStateLabel(value: string) {
  return { idle: "待连接", connecting: "连接中", connected: "已连接", closed: "已完成", error: "连接异常，正在恢复" }[value] ?? value;
}

function safeAccountSummary(summary: Record<string, unknown>) {
  const allowed = ["displayName", "emailMasked", "plan", "accountType"];
  const entries = allowed.flatMap((key) => (typeof summary[key] === "string" ? [`${key}: ${summary[key]}`] : []));
  return entries.join(" · ") || "已生成脱敏账号指纹";
}
