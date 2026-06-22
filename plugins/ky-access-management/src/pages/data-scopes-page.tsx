import { Card, Skeleton, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useQuery } from "@tanstack/react-query";
import { DetailPagePanel, useRequestClient } from "@ky/admin-core";
import { listDataScopes, type DataScope, type DataScopeDefinition } from "../api";

export function DataScopesPage() {
  const client = useRequestClient();
  const { data, isLoading } = useQuery({ queryKey: ["data-scopes"], queryFn: () => listDataScopes(client) });

  const defColumns: ColumnsType<DataScopeDefinition> = [
    { title: "范围类型", dataIndex: "scopeType", key: "scopeType", width: 220 },
    { title: "说明", dataIndex: "label", key: "label" }
  ];

  return (
    <DetailPagePanel title="数据范围">
      {isLoading ? (
        <Skeleton active />
      ) : (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div>
            <Typography.Title level={5}>当前身份数据范围</Typography.Title>
            {data && data.current.length > 0 ? (
              <Space size={8} wrap>
                {data.current.map((scope: DataScope, index) => (
                  <Tag key={index} color="blue">
                    {scope.scopeType}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">未设置（默认按角色范围）</Typography.Text>
            )}
          </div>
          <Card size="small" title="可用数据范围类型">
            <Table<DataScopeDefinition>
              rowKey="scopeType"
              columns={defColumns}
              dataSource={data?.definitions ?? []}
              pagination={false}
              size="small"
            />
          </Card>
        </Space>
      )}
    </DetailPagePanel>
  );
}
