import { ApiOutlined, SafetyCertificateOutlined, TeamOutlined, UserOutlined } from "@ant-design/icons";
import { Button, Card, Col, Descriptions, Empty, Row, Statistic, Tag, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { useSessionStore } from "../stores/session-store";
import { useWorkspaceStore } from "../stores/workspace-store";

export function DashboardPage() {
  const navigate = useNavigate();
  const user = useSessionStore((state) => state.user);
  const config = useSessionStore((state) => state.config);
  const workspace = useWorkspaceStore((state) => state.currentWorkspace);

  if (!workspace) {
    return (
      <AppShell>
        <Empty
          description="尚未选择工作区"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ marginTop: 120 }}
        >
          <Button type="primary" onClick={() => navigate("/workspaces")}>
            选择工作区
          </Button>
        </Empty>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="desktop-page-header">
        <div>
          <Typography.Title level={3}>{workspace.name} 概览</Typography.Title>
          <Typography.Text type="secondary">当前桌面客户端已连接到 AiCRM 后台服务。</Typography.Text>
        </div>
        <Button onClick={() => navigate("/workspaces")}>切换工作区</Button>
      </div>

      <Row gutter={[16, 16]}>
        <Col span={6}>
          <Card>
            <Statistic prefix={<TeamOutlined />} title="可见菜单" value={workspace.menuKeys.length} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic prefix={<SafetyCertificateOutlined />} title="页面权限" value={workspace.permissions.length} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic prefix={<ApiOutlined />} title="操作权限" value={workspace.actionPermissions.length} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic prefix={<UserOutlined />} title="授予角色" value={workspace.roles.length} />
          </Card>
        </Col>
      </Row>

      <Card className="desktop-detail-card" title="当前上下文">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="当前用户">{user?.username || user?.displayName || "—"}</Descriptions.Item>
          <Descriptions.Item label="显示名称">{user?.displayName || "—"}</Descriptions.Item>
          <Descriptions.Item label="工作区类型">
            <Tag>{workspace.type}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="工作区 ID">{workspace.id}</Descriptions.Item>
          <Descriptions.Item label="成员身份 ID">{workspace.membershipId}</Descriptions.Item>
          <Descriptions.Item label="API 地址">{config?.apiBaseUrl || "—"}</Descriptions.Item>
        </Descriptions>
      </Card>
    </AppShell>
  );
}
