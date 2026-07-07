import { useState } from "react";
import { Button, Descriptions, Drawer, Input, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  drawerWidths,
  readListQueryState,
  useRequestClient,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import { listAuditLogs, type AuditLog } from "../api";

export function AuditLogsPage() {
  const client = useRequestClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [actionInput, setActionInput] = useState("");
  const [resourceInput, setResourceInput] = useState("");
  const [detail, setDetail] = useState<AuditLog | null>(null);

  const { data, isFetching } = useQuery({
    queryKey: ["audit-logs", queryState.page, queryState.pageSize, actionInput, resourceInput],
    queryFn: () =>
      listAuditLogs(client, {
        page: queryState.page,
        pageSize: queryState.pageSize,
        action: actionInput || undefined,
        resourceType: resourceInput || undefined
      })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }

  const columns: ColumnsType<AuditLog> = [
    { title: "动作", dataIndex: "action", key: "action", width: 200 },
    {
      title: "资源",
      key: "resource",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{record.resourceType}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.resourceId}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: "操作者",
      key: "actor",
      width: 180,
      render: (_, record) =>
        record.actorName || record.actorUserId || <Typography.Text type="secondary">系统</Typography.Text>
    },
    {
      title: "结果",
      dataIndex: "result",
      key: "result",
      width: 90,
      render: (value: string) => <Tag color={value === "success" ? "green" : "red"}>{value}</Tag>
    },
    { title: "来源", dataIndex: "source", key: "source", width: 160 },
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => new Date(value).toLocaleString("zh-CN")
    },
    {
      title: "操作",
      key: "actions",
      className: "table-action-column",
      width: 180,
      render: (_, record) => (
        <Button size="small" type="link" onClick={() => setDetail(record)}>
          详情
        </Button>
      )
    }
  ];

  return (
    <>
      <ListPageCard
        title="审计日志"
        subtitle="记录当前工作区的关键写操作。"
        toolbar={
          <Space wrap>
          <Input.Search
            allowClear
            placeholder="动作（如 role.created）"
            style={{ width: 240 }}
            value={actionInput}
            onChange={(event) => setActionInput(event.target.value)}
            onSearch={() => applyState({ page: 1 })}
          />
          <Input.Search
            allowClear
            placeholder="资源类型（如 role）"
            style={{ width: 200 }}
            value={resourceInput}
            onChange={(event) => setResourceInput(event.target.value)}
            onSearch={() => applyState({ page: 1 })}
          />
        </Space>
        }
      >
        <Table<AuditLog>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          pagination={{
            current: data?.pagination.page ?? queryState.page,
            pageSize: data?.pagination.pageSize ?? queryState.pageSize,
            total: data?.pagination.total ?? 0,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条`,
            onChange: (page, pageSize) => applyState({ page, pageSize })
          }}
        />
      </ListPageCard>

      <Drawer title="审计详情" width={drawerWidths.simpleDetail} open={Boolean(detail)} onClose={() => setDetail(null)}>
        {detail ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="动作">{detail.action}</Descriptions.Item>
            <Descriptions.Item label="资源类型">{detail.resourceType}</Descriptions.Item>
            <Descriptions.Item label="资源 ID">{detail.resourceId}</Descriptions.Item>
            <Descriptions.Item label="结果">{detail.result}</Descriptions.Item>
            <Descriptions.Item label="操作者">{detail.actorName || detail.actorUserId || "系统"}</Descriptions.Item>
            <Descriptions.Item label="操作者成员">{detail.actorMembershipId || "—"}</Descriptions.Item>
            <Descriptions.Item label="工作区">
              {detail.workspaceType} / {detail.workspaceId}
            </Descriptions.Item>
            <Descriptions.Item label="来源">{detail.source}</Descriptions.Item>
            <Descriptions.Item label="Request ID">{detail.requestId}</Descriptions.Item>
            <Descriptions.Item label="备注">{detail.remark || "—"}</Descriptions.Item>
            <Descriptions.Item label="时间">{new Date(detail.createdAt).toLocaleString("zh-CN")}</Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>
    </>
  );
}
