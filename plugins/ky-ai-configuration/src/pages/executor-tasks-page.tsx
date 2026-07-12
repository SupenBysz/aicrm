import { useEffect, useRef, useState } from "react";
import { CodeOutlined } from "@ant-design/icons";
import { Button, Descriptions, Drawer, Segmented, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  drawerWidths,
  getAiCrmDesktopDebugMode,
  isAiCrmDesktopClientRuntime,
  openAiExecutorTerminalWindow,
  readListQueryState,
  useCurrentUser,
  useCurrentWorkspace,
  usePermissions,
  useRequestClient,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import { ExecutorEventTimeline } from "../components/executor-events";
import { cancelAiExecutorTask, listAiExecutorTasks, type AiExecutorTask } from "../api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: "等待执行", color: "default" },
  waiting_executor: { label: "等待执行器", color: "gold" },
  running: { label: "执行中", color: "blue" },
  waiting_user_scan: { label: "等待扫码", color: "orange" },
  completed: { label: "已完成", color: "green" },
  failed: { label: "失败", color: "red" },
  cancelled: { label: "已取消", color: "default" },
  timeout: { label: "超时", color: "red" }
};
const EXECUTOR_TERMINAL_POPUP_WIDTH = 1180;
const EXECUTOR_TERMINAL_POPUP_HEIGHT = 760;
const EXECUTOR_TERMINAL_POPUP_FEATURES = [
  "popup=yes",
  `width=${EXECUTOR_TERMINAL_POPUP_WIDTH}`,
  `height=${EXECUTOR_TERMINAL_POPUP_HEIGHT}`,
  "resizable=yes",
  "scrollbars=no",
  "toolbar=no",
  "location=no",
  "menubar=no",
  "status=no"
].join(",");

export function ExecutorTasksPage() {
  const client = useRequestClient();
  const workspace = useCurrentWorkspace();
  const currentUser = useCurrentUser();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [detail, setDetail] = useState<AiExecutorTask | null>(null);
  const [openingTerminalTaskId, setOpeningTerminalTaskId] = useState("");
  const terminalWindowRefs = useRef(new Map<string, WindowProxy>());
  const canCancel = permissions.can("platform.ai_executor_tasks.cancel");
  const clientDebugMode = useClientDebugMode();
  const canUseDebugTools = clientDebugMode || isSuperAdminUser(currentUser, workspace);

  const query = useQuery({
    queryKey: ["ai-executor-tasks", queryState.page, queryState.pageSize, queryState.status],
    queryFn: () => listAiExecutorTasks(client, { page: queryState.page, pageSize: queryState.pageSize, status: queryState.status })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelAiExecutorTask(client, id),
    onSuccess: () => {
      void message.success("任务已取消。");
      void queryClient.invalidateQueries({ queryKey: ["ai-executor-tasks"] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  async function openTerminalWindow(task: AiExecutorTask | null) {
    if (!task?.id) {
      void message.warning("暂无执行器任务");
      return;
    }
    if (!workspace) {
      void message.warning("当前工作区上下文不可用");
      return;
    }
    if (openingTerminalTaskId === task.id) return;
    const existingWindow = terminalWindowRefs.current.get(task.id);
    if (existingWindow && !existingWindow.closed) {
      existingWindow.focus();
      return;
    }

    setOpeningTerminalTaskId(task.id);
    const terminalUrl = new URL(
      `/w/${workspace.type}/${workspace.id}/workbench/matrix-accounts/executor-terminal/${task.id}`,
      window.location.origin
    );
    terminalUrl.searchParams.set("terminalWindow", "1");
    terminalUrl.searchParams.set("redactTerminal", "1");
    if (clientDebugMode) terminalUrl.searchParams.set("debug", "1");

    try {
      if (!isAiCrmDesktopClientRuntime()) {
        const opened = window.open(terminalUrl.toString(), `aicrm-executor-terminal-${task.id}`, EXECUTOR_TERMINAL_POPUP_FEATURES);
        if (opened) {
          terminalWindowRefs.current.set(task.id, opened);
          opened.focus();
        } else {
          void message.warning("浏览器已拦截终端窗口，请允许弹窗后重试");
        }
        return;
      }

      const result = await openAiExecutorTerminalWindow({
        taskId: task.id,
        url: terminalUrl.toString(),
        title: `${task.executorId || task.executorType || "执行器"}终端`
      });
      if (!result.ok) {
        void message.error(result.error?.message || "打开终端失败");
      }
    } finally {
      setOpeningTerminalTaskId((current) => (current === task.id ? "" : current));
    }
  }

  const columns: ColumnsType<AiExecutorTask> = [
    {
      title: "任务",
      key: "task",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.id}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.executorId || record.executorType} / {record.taskType}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: "用途",
      dataIndex: "purpose",
      key: "purpose",
      width: 150,
      render: (value: string) => executorTaskPurposeLabel(value)
    },
    {
      title: "触发原因",
      dataIndex: "triggerReason",
      key: "triggerReason",
      width: 240,
      render: (value: string) => executorTaskTriggerReasonLabel(value)
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (status: string) => {
        const meta = STATUS_META[status] ?? { label: status, color: "default" };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      }
    },
    {
      title: "Token 用量",
      dataIndex: "tokenUsage",
      key: "tokenUsage",
      width: 150,
      render: (_, record) => renderExecutorTaskTokenUsage(record.tokenUsage)
    },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: formatTime
    },
    {
      title: "操作",
      key: "actions",
      className: "table-action-column",
      width: 180,
      render: (_, record) => (
        <Space className="table-action-grid" size={4} wrap>
          <Button size="small" type="link" onClick={() => setDetail(record)}>
            详情
          </Button>
          <Tooltip title="打开终端">
            <Button
              aria-label="打开终端"
              icon={<CodeOutlined />}
              loading={openingTerminalTaskId === record.id}
              size="small"
              type="link"
              onClick={() => openTerminalWindow(record)}
            />
          </Tooltip>
          {canCancel && ["pending", "running", "waiting_user_scan"].includes(record.status) ? (
            <Button size="small" type="link" danger loading={cancelMutation.isPending} onClick={() => cancelMutation.mutate(record.id)}>
              取消
            </Button>
          ) : null}
        </Space>
      )
    }
  ];

  return (
    <>
      <ListPageCard
        title="AI 执行器任务"
        subtitle="查看 Codex 修复任务、结构化事件和终端投影输出。"
        toolbar={
          <Segmented
            value={queryState.status ?? ""}
            onChange={(value) => applyState({ status: String(value), page: 1 })}
            options={[
              { label: "全部", value: "" },
              { label: "执行中", value: "running" },
              { label: "等待执行器", value: "waiting_executor" },
              { label: "等待扫码", value: "waiting_user_scan" },
              { label: "完成", value: "completed" },
              { label: "失败", value: "failed" }
            ]}
          />
        }
      >
        <Table<AiExecutorTask>
          columns={columns}
          dataSource={query.data?.items ?? []}
          loading={query.isFetching}
          rowKey="id"
          scroll={{ x: 1130 }}
          pagination={{
            current: queryState.page,
            pageSize: queryState.pageSize,
            total: query.data?.pagination.total ?? 0,
            onChange: (page, pageSize) => applyState({ page, pageSize })
          }}
        />
      </ListPageCard>

      <Drawer
        width={drawerWidths.complexDetail}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title="执行器任务详情"
        extra={
          <Tooltip title="打开终端">
            <Button
              aria-label="打开终端"
              icon={<CodeOutlined />}
              loading={openingTerminalTaskId === detail?.id}
              type="primary"
              onClick={() => openTerminalWindow(detail)}
            />
          </Tooltip>
        }
      >
        {detail ? (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="任务 ID">{detail.id}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={STATUS_META[detail.status]?.color}>{STATUS_META[detail.status]?.label ?? detail.status}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="执行器">{detail.executorId || "-"}</Descriptions.Item>
              <Descriptions.Item label="用途">{executorTaskPurposeLabel(detail.purpose)}</Descriptions.Item>
              <Descriptions.Item label="触发原因">{executorTaskTriggerReasonLabel(detail.triggerReason)}</Descriptions.Item>
              <Descriptions.Item label="Token 用量">{formatExecutorTaskTokenUsage(detail.tokenUsage)}</Descriptions.Item>
              <Descriptions.Item label="Web 空间">{detail.webSpaceId || "-"}</Descriptions.Item>
              <Descriptions.Item label="脚本版本">{detail.scriptVersionId || "-"}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{formatTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="完成时间">{detail.completedAt ? formatTime(detail.completedAt) : "-"}</Descriptions.Item>
            </Descriptions>
            <ExecutorEventTimeline
              client={client}
              showDebugEvents={canUseDebugTools}
              taskId={detail.id}
            />
          </Space>
        ) : null}
      </Drawer>
    </>
  );
}

function useClientDebugMode() {
  const [desktopDebugMode, setDesktopDebugMode] = useState(false);

  useEffect(() => {
    let active = true;
    void getAiCrmDesktopDebugMode()
      .then((debugMode) => {
        if (active) setDesktopDebugMode(debugMode);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return readLocalDebugFlag() || desktopDebugMode;
}

function readLocalDebugFlag() {
  if (typeof window === "undefined") return false;
  return (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    new URLSearchParams(window.location.search).get("debug") === "1" ||
    window.localStorage.getItem("aicrm.debug") === "1"
  );
}

function isSuperAdminUser(
  currentUser: { username?: string | null } | null,
  workspace: { roles?: Array<{ code?: string | null }> } | null
) {
  return (
    currentUser?.username?.toLowerCase() === "super.admin" ||
    workspace?.roles?.some((role) => role.code === "platform_owner") === true
  );
}

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function renderExecutorTaskTokenUsage(usage: AiExecutorTask["tokenUsage"]) {
  const total = executorTaskTokenTotal(usage);
  if (total <= 0) return <Typography.Text type="secondary">-</Typography.Text>;
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const reasoning = usage?.reasoningOutputTokens ?? 0;
  const cached = usage?.cachedInputTokens ?? 0;
  const details = [
    input > 0 ? `入 ${formatTokenCount(input)}` : "",
    output > 0 ? `出 ${formatTokenCount(output)}` : "",
    reasoning > 0 ? `推理 ${formatTokenCount(reasoning)}` : "",
    cached > 0 ? `缓存 ${formatTokenCount(cached)}` : ""
  ].filter(Boolean);
  return (
    <Space direction="vertical" size={0}>
      <Typography.Text strong>{formatTokenCount(total)}</Typography.Text>
      {details.length > 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {details.join(" / ")}
        </Typography.Text>
      ) : null}
    </Space>
  );
}

function formatExecutorTaskTokenUsage(usage: AiExecutorTask["tokenUsage"]) {
  const total = executorTaskTokenTotal(usage);
  if (total <= 0) return "-";
  return `${formatTokenCount(total)} Token`;
}

function executorTaskTokenTotal(usage: AiExecutorTask["tokenUsage"]) {
  if (!usage) return 0;
  if (usage.totalTokens > 0) return usage.totalTokens;
  return Math.max(0, usage.inputTokens + usage.outputTokens + usage.reasoningOutputTokens);
}

function formatTokenCount(value: number) {
  return Math.max(0, Math.round(value)).toLocaleString("zh-CN");
}

function executorTaskPurposeLabel(value: string | null | undefined) {
  if (!value) return "-";
  const labels: Record<string, string> = {
    account_detect: "账号识别",
    qr_login_prepare: "获取二维码",
    qr_login_refresh: "刷新二维码",
    session_check: "登录检测"
  };
  return labels[value] ?? value;
}

function executorTaskTriggerReasonLabel(value: string | null | undefined) {
  if (!value) return "-";
  const labels: Record<string, string> = {
    account_identity_not_found: "未识别到稳定账号身份，正在重新分析账号页面",
    consecutive_failures: "脚本连续失败，正在使用 AI 重新优化脚本",
    detect_script_failed: "账号识别脚本执行失败，正在重新适配识别逻辑",
    detect_script_missing: "暂无账号识别脚本，正在自动生成识别脚本",
    login_completed_detect_missing: "已完成扫码登录，正在构建账号识别脚本",
    manual_retry: "正在按本次操作重新适配脚本",
    no_active_script: "当前平台暂无可用脚本，正在自动构建适配脚本",
    no_active_version: "当前脚本缺少可执行版本，正在自动生成新版本",
    page_fingerprint_changed: "检测到登录页结构变化，正在重新适配脚本",
    qr_not_found: "未识别到二维码区域，正在重新分析页面",
    refresh_script_failed: "刷新二维码脚本执行失败，正在重新适配刷新逻辑",
    refresh_script_missing: "暂无刷新二维码脚本，正在自动生成刷新脚本",
    script_disabled: "已配置脚本不可用，正在重新适配",
    script_run_failed: "已缓存脚本执行失败，正在重新构建适配脚本"
  };
  return labels[value] ?? value;
}
