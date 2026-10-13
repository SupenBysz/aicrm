import { useEffect, useState } from "react";
import { Skeleton, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useQuery } from "@tanstack/react-query";
import { ListPageCard, useRequestClient } from "@ky/admin-core";
import { listDictionaries, type Dictionary, type DictionaryItem } from "../api";

export function DictionariesPage() {
  const client = useRequestClient();
  const { data, isLoading } = useQuery({ queryKey: ["dictionaries"], queryFn: () => listDictionaries(client) });
  const [activeKey, setActiveKey] = useState("");
  const [compactTabs, setCompactTabs] = useState(false);

  useEffect(() => {
    const dictionaries = data ?? [];
    if (dictionaries.some((dictionary) => dictionary.id === activeKey)) return;
    setActiveKey(dictionaries[0]?.id ?? "");
  }, [activeKey, data]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => setCompactTabs(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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
        ) : (data ?? []).length === 0 ? (
          <Typography.Text type="secondary">暂无字典。</Typography.Text>
        ) : (
          <Tabs
            className="system-settings-tabs"
            activeKey={activeKey}
            onChange={setActiveKey}
            tabPosition={compactTabs ? "top" : "left"}
            style={{ width: "100%" }}
            tabBarStyle={compactTabs ? undefined : { minWidth: 168 }}
            items={(data ?? []).map((dict: Dictionary) => ({
              key: dict.id,
              label: (
                <span className="system-settings-dictionary-tab-label">
                  <Typography.Text>{dict.name || dict.code}</Typography.Text>
                  <Typography.Text type="secondary" className="system-settings-dictionary-tab-code">
                    {dict.code}
                  </Typography.Text>
                </span>
              ),
              children: (
                <div style={{ width: "100%", padding: "0 16px" }}>
                  <Table<DictionaryItem>
                    rowKey={(item) => `${dict.id}:${item.value}`}
                    columns={itemColumns}
                    dataSource={dict.items}
                    pagination={false}
                    size="small"
                  />
                </div>
              )
            }))}
          />
        )}
      </div>
    </ListPageCard>
  );
}
