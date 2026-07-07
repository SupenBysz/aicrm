import { Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  readListQueryState,
  useRequestClient,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import { listLoginLogs, type LoginLog } from "../api";

export function LoginLogsPage() {
  const client = useRequestClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);

  const { data, isFetching } = useQuery({
    queryKey: ["login-logs", queryState.page, queryState.pageSize],
    queryFn: () => listLoginLogs(client, { page: queryState.page, pageSize: queryState.pageSize })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }

  const columns: ColumnsType<LoginLog> = [
    { title: "登录账号", dataIndex: "loginAccount", key: "loginAccount", width: 200 },
    {
      title: "结果",
      dataIndex: "result",
      key: "result",
      width: 100,
      render: (value: string) => <Tag color={value === "success" ? "green" : "red"}>{value}</Tag>
    },
    {
      title: "失败原因",
      dataIndex: "failReason",
      key: "failReason",
      render: (value: string) => value || <Typography.Text type="secondary">—</Typography.Text>
    },
    { title: "IP 地址", dataIndex: "ipAddress", key: "ipAddress", width: 160 },
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => new Date(value).toLocaleString("zh-CN")
    }
  ];

  return (
    <ListPageCard title="登录日志" subtitle="平台账号登录与认证记录（仅平台后台可见）。">
      <Table<LoginLog>
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
