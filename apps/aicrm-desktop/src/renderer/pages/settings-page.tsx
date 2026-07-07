import { Card, Descriptions, Typography } from "antd";
import { AppShell } from "../components/app-shell";
import { useSessionStore } from "../stores/session-store";

export function SettingsPage() {
  const config = useSessionStore((state) => state.config);

  return (
    <AppShell>
      <div className="desktop-page-header">
        <div>
          <Typography.Title level={3}>客户端设置</Typography.Title>
          <Typography.Text type="secondary">第一版只展示运行配置，后续可接入安全存储、自动更新和本地运行时设置。</Typography.Text>
        </div>
      </div>
      <Card title="连接配置">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="Web URL">{config?.webUrl ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="API Base URL">{config?.apiBaseUrl ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="配置来源">
            Web 入口读取 AICRM_WEB_URL，未配置时默认 https://kyaicrm.entai.im。API
            读取 AICRM_API_BASE_URL / KY_CONSOLE_URL，未配置时默认 http://127.0.0.1:16178。
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </AppShell>
  );
}
