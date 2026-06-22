import { Card, Skeleton, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useQuery } from "@tanstack/react-query";
import { ListPageCard, useRequestClient } from "@ky/admin-core";
import { listDictionaries, type Dictionary, type DictionaryItem } from "../api";

export function DictionariesPage() {
  const client = useRequestClient();
  const { data, isLoading } = useQuery({ queryKey: ["dictionaries"], queryFn: () => listDictionaries(client) });

  const itemColumns: ColumnsType<DictionaryItem> = [
    { title: "标签", dataIndex: "label", key: "label" },
    { title: "值", dataIndex: "value", key: "value" },
    { title: "排序", dataIndex: "sortOrder", key: "sortOrder", width: 80 },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 90,
      render: (status: string) => <Tag color={status === "normal" ? "green" : "default"}>{status}</Tag>
    }
  ];

  return (
    <ListPageCard title="数据字典" subtitle="平台内置字典及其条目（只读）。">
      <div style={{ padding: 16 }}>
        {isLoading ? (
          <Skeleton active />
        ) : (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            {(data ?? []).map((dict: Dictionary) => (
              <Card
                key={dict.id}
                size="small"
                title={
                  <Space>
                    <Typography.Text strong>{dict.name}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {dict.code}
                    </Typography.Text>
                  </Space>
                }
              >
                <Table<DictionaryItem>
                  rowKey={(item) => `${dict.id}:${item.value}`}
                  columns={itemColumns}
                  dataSource={dict.items}
                  pagination={false}
                  size="small"
                />
              </Card>
            ))}
            {(data ?? []).length === 0 ? <Typography.Text type="secondary">暂无字典。</Typography.Text> : null}
          </Space>
        )}
      </div>
    </ListPageCard>
  );
}
