import { useState } from "react";
import { Button, Descriptions, Drawer, Segmented, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  drawerWidths,
  readListQueryState,
  usePermissions,
  useRequestClient,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import { ExecutorEventTimeline } from "../components/executor-events";
import { ExecutorRawTerminal } from "../components/executor-terminal";
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

export function ExecutorTasksPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [detail, setDetail] = useState<AiExecutorTask | null>(null);
  const [detailMode, setDetailMode] = useState<"structured" | "terminal">("structured");
  const canCancel = permissions.can("platform.ai_executor_tasks.cancel");

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
      render: (value: string) => value || "-"
    },
    {
      title: "触发原因",
      dataIndex: "triggerReason",
      key: "triggerReason",
      width: 190
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
          scroll={{ x: 980 }}
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
          <Segmented
            value={detailMode}
            onChange={(value) => setDetailMode(value as "structured" | "terminal")}
            options={[
              { label: "结构化事件", value: "structured" },
              { label: "终端投影", value: "terminal" }
            ]}
          />
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
              <Descriptions.Item label="用途">{detail.purpose || "-"}</Descriptions.Item>
              <Descriptions.Item label="触发原因">{detail.triggerReason || "-"}</Descriptions.Item>
              <Descriptions.Item label="Web 空间">{detail.webSpaceId || "-"}</Descriptions.Item>
              <Descriptions.Item label="脚本版本">{detail.scriptVersionId || "-"}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{formatTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="完成时间">{detail.completedAt ? formatTime(detail.completedAt) : "-"}</Descriptions.Item>
            </Descriptions>
            {detailMode === "structured" ? (
              <ExecutorEventTimeline client={client} taskId={detail.id} />
            ) : (
              <ExecutorRawTerminal client={client} taskId={detail.id} height={360} />
            )}
          </Space>
        ) : null}
      </Drawer>
    </>
  );
}

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
