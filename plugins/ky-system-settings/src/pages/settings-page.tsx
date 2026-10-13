import { useEffect, useState } from "react";
import { App as AntdApp, Button, Divider, Form, Skeleton, Space, Switch, Tabs, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, useCurrentWorkspace, useRequestClient, usePermissions } from "@ky/admin-core";
import {
  getOrgSettings,
  getPlatformSettings,
  updateOrgSettings,
  updatePlatformSettings,
  type SettingsMap
} from "../api";

export function SettingsPage() {
  const { message } = AntdApp.useApp();
  const client = useRequestClient();
  const workspace = useCurrentWorkspace();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const isPlatform = workspace?.type === "platform";
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [securitySettings, setSecuritySettings] = useState<Record<string, unknown>>({});
  const [invalidMfaValue, setInvalidMfaValue] = useState(false);
  const [compactTabs, setCompactTabs] = useState(false);

  const canUpdate = permissions.canAny(["platform.settings.update", "agency.settings.update", "enterprise.settings.update"]);

  const { data, isLoading } = useQuery({
    queryKey: ["settings", workspace?.type, workspace?.id],
    queryFn: () => (isPlatform ? getPlatformSettings(client) : getOrgSettings(client))
  });

  useEffect(() => {
    if (!data?.settings) return;
    const rawSecurity = data.settings.security;
    if (rawSecurity === undefined) {
      setSecuritySettings({});
      setMfaEnabled(false);
      setInvalidMfaValue(false);
    } else {
      if (!rawSecurity || typeof rawSecurity !== "object" || Array.isArray(rawSecurity)) {
        setSecuritySettings({});
        setMfaEnabled(false);
        setInvalidMfaValue(true);
        return;
      }
      const nextSecurity = rawSecurity as Record<string, unknown>;
      const value = nextSecurity.mfaEnabled;
      setSecuritySettings({ ...nextSecurity });
      if (value === undefined) {
        setMfaEnabled(false);
        setInvalidMfaValue(false);
      } else if (typeof value === "boolean") {
        setMfaEnabled(value);
        setInvalidMfaValue(false);
      } else {
        setMfaEnabled(false);
        setInvalidMfaValue(true);
      }
    }
  }, [data]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => setCompactTabs(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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
    if (invalidMfaValue) {
      message.error("security.mfaEnabled 必须是布尔值，未保存。");
      return;
    }
    saveMutation.mutate({ security: { ...securitySettings, mfaEnabled } });
  }

  return (
    <ListPageCard title="参数配置" subtitle="管理平台与组织安全参数。">
      {isLoading ? (
        <Skeleton active />
      ) : (
        <div style={{ padding: 16 }}>
          <Tabs
            className="system-settings-tabs"
            tabPosition={compactTabs ? "top" : "left"}
            style={{ width: "100%" }}
            tabBarStyle={compactTabs ? undefined : { minWidth: 168 }}
            items={[
              {
                key: "mfa",
                label: "多因素认证（MFA）",
                children: (
                  <div style={{ width: "100%", maxWidth: 720, padding: "0 16px" }}>
                    <Form layout="vertical">
                      <Form.Item label="状态" extra="启用后，登录及敏感操作可按安全策略要求多因素验证。">
                        <Space wrap>
                          <Switch checked={mfaEnabled} disabled={!canUpdate || invalidMfaValue} onChange={setMfaEnabled} />
                          <Typography.Text>{mfaEnabled ? "已启用" : "已关闭"}</Typography.Text>
                        </Space>
                      </Form.Item>
                    </Form>
                    {invalidMfaValue ? (
                      <Typography.Text type="danger">security.mfaEnabled 配置值不是布尔值，无法保存。</Typography.Text>
                    ) : null}
                    <Divider />
                    <Space style={{ width: "100%", justifyContent: "flex-end" }}>
                      <Button type="primary" loading={saveMutation.isPending} disabled={!canUpdate || invalidMfaValue} onClick={save}>
                        保存
                      </Button>
                    </Space>
                  </div>
                )
              }
            ]}
          />
        </div>
      )}
    </ListPageCard>
  );
}
