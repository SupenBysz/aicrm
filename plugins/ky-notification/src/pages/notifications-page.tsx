import { Button, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  readListQueryState,
  useRequestClient,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationUnreadCount,
  type Notification
} from "../api";

const READ_OPTIONS = [
  { value: "false", label: "未读" },
  { value: "true", label: "已读" }
];

export function NotificationsPage() {
  const client = useRequestClient();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const readFilter = searchParams.get("read") ?? undefined;

  const { data, isFetching } = useQuery({
    queryKey: ["notifications", queryState.page, queryState.pageSize, readFilter],
    queryFn: () => listNotifications(client, { page: queryState.page, pageSize: queryState.pageSize, read: readFilter })
  });
  const unreadQuery = useQuery({ queryKey: ["notifications", "unread"], queryFn: () => notificationUnreadCount(client) });
  const unread = unreadQuery.data?.count ?? unreadQuery.data?.unreadCount ?? 0;

  function applyState(next: Partial<ListQueryState> & { read?: string }) {
    const params = new URLSearchParams(writeListQueryState({ ...queryState, ...next }));
    if (next.read !== undefined) {
      if (next.read) params.set("read", next.read);
      else params.delete("read");
    } else if (readFilter) {
      params.set("read", readFilter);
    }
    setSearchParams(params);
  }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["notifications"] });

  const readMutation = useMutation({
    mutationFn: (id: string) => markNotificationRead(client, id),
    onSuccess: invalidate,
    onError: (error: Error) => message.error(error.message)
  });
  const readAllMutation = useMutation({
    mutationFn: () => markAllNotificationsRead(client),
    onSuccess: () => {
      void message.success("已全部标记为已读。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const columns: ColumnsType<Notification> = [
    {
      title: "通知",
      key: "title",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            {!record.read ? <Tag color="blue">未读</Tag> : null}
            <Typography.Text strong={!record.read}>{record.title}</Typography.Text>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.content}
          </Typography.Text>
        </Space>
      )
    },
    { title: "类型", dataIndex: "notificationType", key: "notificationType", width: 120 },
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
      width: 100,
      render: (_, record) =>
        record.read ? null : (
          <Button size="small" type="link" onClick={() => readMutation.mutate(record.id)}>
            标记已读
          </Button>
        )
    }
  ];

  return (
    <ListPageCard
      title="通知"
      subtitle={`未读 ${unread} 条`}
      extra={
        <Button onClick={() => readAllMutation.mutate()} loading={readAllMutation.isPending}>
          全部已读
        </Button>
      }
    >
      <Space style={{ padding: 16 }} wrap>
        <Select
          allowClear
          placeholder="阅读状态"
          style={{ width: 140 }}
          options={READ_OPTIONS}
          value={readFilter}
          onChange={(value) => applyState({ read: value || "", page: 1 })}
        />
      </Space>
      <Table<Notification>
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
  );
}
