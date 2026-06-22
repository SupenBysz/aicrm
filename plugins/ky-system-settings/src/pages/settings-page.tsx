import { useEffect, useState } from "react";
import { Button, Input, Skeleton, Space, Typography, message } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DetailPagePanel, useCurrentWorkspace, useRequestClient, usePermissions } from "@ky/admin-core";
import {
  getOrgSettings,
  getPlatformSettings,
  updateOrgSettings,
  updatePlatformSettings,
  type SettingsMap
} from "../api";

interface Entry {
  key: string;
  value: string;
}

export function SettingsPage() {
  const client = useRequestClient();
  const workspace = useCurrentWorkspace();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const isPlatform = workspace?.type === "platform";
  const [entries, setEntries] = useState<Entry[]>([]);

  const canUpdate = permissions.canAny(["platform.settings.update", "agency.settings.update", "enterprise.settings.update"]);

  const { data, isLoading } = useQuery({
    queryKey: ["settings", workspace?.type, workspace?.id],
    queryFn: () => (isPlatform ? getPlatformSettings(client) : getOrgSettings(client))
  });

  useEffect(() => {
    if (data?.settings) {
      setEntries(Object.entries(data.settings).map(([key, value]) => ({ key, value: String(value) })));
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (settings: SettingsMap) =>
      isPlatform ? updatePlatformSettings(client, settings) : updateOrgSettings(client, settings),
    onSuccess: () => {
      void message.success("设置已保存。");
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  function save() {
    const map: SettingsMap = {};
    for (const entry of entries) {
      const key = entry.key.trim();
      if (key) map[key] = entry.value;
    }
    saveMutation.mutate(map);
  }

  return (
    <DetailPagePanel
      title={isPlatform ? "平台系统设置" : "组织设置"}
      extra={
        canUpdate ? (
          <Button type="primary" loading={saveMutation.isPending} onClick={save}>
            保存
          </Button>
        ) : null
      }
    >
      {isLoading ? (
        <Skeleton active />
      ) : (
        <Space direction="vertical" size={12} style={{ width: "100%", maxWidth: 720 }}>
          <Typography.Text type="secondary">键值对形式的配置项，保存即覆盖。</Typography.Text>
          {entries.map((entry, index) => (
            <Space key={index} align="start" style={{ width: "100%" }}>
              <Input
                placeholder="配置键"
                style={{ width: 220 }}
                value={entry.key}
                disabled={!canUpdate}
                onChange={(event) =>
                  setEntries((list) => list.map((e, i) => (i === index ? { ...e, key: event.target.value } : e)))
                }
              />
              <Input
                placeholder="配置值"
                style={{ width: 360 }}
                value={entry.value}
                disabled={!canUpdate}
                onChange={(event) =>
                  setEntries((list) => list.map((e, i) => (i === index ? { ...e, value: event.target.value } : e)))
                }
              />
              {canUpdate ? (
                <Button
                  type="text"
                  icon={<DeleteOutlined />}
                  onClick={() => setEntries((list) => list.filter((_, i) => i !== index))}
                />
              ) : null}
            </Space>
          ))}
          {canUpdate ? (
            <Button icon={<PlusOutlined />} onClick={() => setEntries((list) => [...list, { key: "", value: "" }])}>
              新增配置项
            </Button>
          ) : null}
        </Space>
      )}
    </DetailPagePanel>
  );
}
