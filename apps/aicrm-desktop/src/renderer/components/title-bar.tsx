import { CloudServerOutlined, DesktopOutlined } from "@ant-design/icons";
import { Space, Tag, Typography } from "antd";
import { useSessionStore } from "../stores/session-store";

export function TitleBar() {
  const config = useSessionStore((state) => state.config);
  const user = useSessionStore((state) => state.user);
  const name = user?.username || user?.displayName || "未登录";

  return (
    <div className="desktop-title-bar">
      <Space size={10}>
        <div className="desktop-title-icon">
          <DesktopOutlined />
        </div>
        <div>
          <Typography.Text className="desktop-title">AiCRM Desktop</Typography.Text>
          <Typography.Text className="desktop-subtitle">桌面客户端</Typography.Text>
        </div>
      </Space>
      <Space size={8}>
        <Tag icon={<CloudServerOutlined />} color="blue">
          {config?.apiBaseUrl ?? "未连接"}
        </Tag>
        <Typography.Text className="desktop-user">{name}</Typography.Text>
      </Space>
    </div>
  );
}
