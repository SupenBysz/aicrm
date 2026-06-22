import { Card, Col, Row, Statistic, Tag, Typography } from "antd";
import { Navigate, useParams } from "react-router-dom";
import { loadBootstrap, selectWorkspace } from "../app-store";
import { pickWorkspace } from "../remote-api";
import { rolesLabel, workspaceTypeColor, workspaceTypeLabel } from "../workspace-ui";

export function WorkbenchPage() {
  const params = useParams();
  const bootstrap = loadBootstrap();
  const workspace = pickWorkspace(bootstrap?.workspaces ?? [], params.workspaceType, params.workspaceId);

  if (!workspace) {
    return <Navigate to="/workspace/select" replace />;
  }
  selectWorkspace(workspace);

  return (
    <div className="content-stack">
      <div className="page-intro">
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          {workspace.name} 工作台
        </Typography.Title>
        <Typography.Text type="secondary">
          欢迎回来，当前以
          <Tag color={workspaceTypeColor(workspace.type)} style={{ marginInline: 6 }}>
            {workspaceTypeLabel(workspace.type)}
          </Tag>
          身份进入。角色：{rolesLabel(workspace)}
        </Typography.Text>
      </div>

      <Row gutter={[16, 16]} className="summary-grid">
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic title="可见菜单" value={workspace.menuKeys.length} />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic title="页面权限" value={workspace.permissions.length} />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic title="操作权限" value={workspace.actionPermissions.length} />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic title="授予角色" value={workspace.roles.length} />
          </Card>
        </Col>
      </Row>

      <Card title="工作区信息">
        <Typography.Paragraph style={{ marginBottom: 4 }}>
          工作区类型：{workspaceTypeLabel(workspace.type)}（{workspace.type}）
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 4 }}>工作区 ID：{workspace.id}</Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 0 }}>成员身份 ID：{workspace.membershipId}</Typography.Paragraph>
      </Card>
    </div>
  );
}
