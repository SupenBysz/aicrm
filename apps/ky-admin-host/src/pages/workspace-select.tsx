import { UserOutlined } from "@ant-design/icons";
import { App as AntdApp, Button, Card, Empty, Input, Space, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { WorkspaceIdentity } from "@ky/admin-core";
import { loadBootstrap, selectWorkspace, setBootstrap, workspaceWorkbenchPath } from "../app-store";
import { bootstrap, pickRecommendedWorkspace } from "../remote-api";
import {
  filterWorkspaces,
  groupWorkspaces,
  rolesLabel,
  workspaceGroupDescription,
  workspaceTypeColor,
  workspaceTypeLabel
} from "../workspace-ui";

export function WorkspaceSelectPage() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [state, setState] = useState(() => loadBootstrap());
  const [search, setSearch] = useState("");
  const workspaces = state?.workspaces ?? [];

  useEffect(() => {
    if (state) {
      return;
    }
    bootstrap()
      .then((next) => {
        setBootstrap(next);
        setState(next);
        if (next.workspaces.length === 0) {
          navigate("/no-workspace", { replace: true });
          return;
        }
        if (next.workspaces.length === 1) {
          const recommended = pickRecommendedWorkspace(next);
          if (recommended) {
            selectWorkspace(recommended);
            navigate(workspaceWorkbenchPath(recommended), { replace: true });
          }
        }
      })
      .catch((error) => message.error(error instanceof Error ? error.message : "身份加载失败"));
  }, [message, navigate, state]);

  const grouped = useMemo(() => groupWorkspaces(filterWorkspaces(workspaces, search)), [workspaces, search]);
  const matched = grouped.reduce((total, group) => total + group.workspaces.length, 0);

  function enter(workspace: WorkspaceIdentity) {
    selectWorkspace(workspace);
    void message.success(`已进入${workspace.name}`);
    navigate(workspaceWorkbenchPath(workspace));
  }

  return (
    <div className="workspace-selection-shell">
      <div className="workspace-selection-container">
        <header className="workspace-selection-compact-header">
          <div>
            <Typography.Text className="workspace-selection-eyebrow">KyaiCRM Console</Typography.Text>
            <Typography.Title level={2}>选择工作区</Typography.Title>
            <Typography.Paragraph>
              请选择本次进入的平台、机构或企业。进入后，菜单、权限与数据范围会同步切换。
            </Typography.Paragraph>
          </div>

          <div className="workspace-selection-account-inline">
            <Space align="center" size={12}>
              <div className="workspace-selection-avatar">
                <UserOutlined />
              </div>
              <div>
                <Typography.Text strong>{state?.user.displayName}</Typography.Text>
                <br />
                <Typography.Text type="secondary">{state?.user.email ?? ""}</Typography.Text>
              </div>
            </Space>
            <div className="workspace-selection-stats workspace-selection-stats--inline">
              <span>
                <strong>{workspaces.length}</strong>
                <Typography.Text type="secondary">工作区</Typography.Text>
              </span>
            </div>
          </div>
        </header>

        <Card className="workspace-selection-main" styles={{ body: { padding: 0 } }}>
          <div className="workspace-selection-toolbar">
            <div>
              <Typography.Title level={4}>后台身份</Typography.Title>
              <Typography.Text type="secondary">
                共 {workspaces.length} 个工作区，当前匹配 {matched} 个
              </Typography.Text>
            </div>
            <Space wrap className="workspace-selection-actions">
              <Input.Search
                allowClear
                className="workspace-selection-search"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索工作区名称、类型或角色"
                size="large"
                value={search}
              />
            </Space>
          </div>

          <div className="workspace-selection-body">
            {matched === 0 ? (
              <Empty description="没有匹配的工作区。" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Space direction="vertical" size={20} style={{ width: "100%" }}>
                {grouped.map((group) => (
                  <section className="workspace-group-section" key={group.type}>
                    <Typography.Title level={5} className="workspace-group-heading">
                      {workspaceTypeLabel(group.type)}后台
                    </Typography.Title>
                    <Typography.Paragraph type="secondary" className="workspace-group-description">
                      {workspaceGroupDescription(group.type)}
                    </Typography.Paragraph>
                    <div className="workspace-grid">
                      {group.workspaces.map((workspace) => (
                        <Card
                          key={workspace.id}
                          className={`workspace-card workspace-card--selection workspace-card--${workspace.type}`}
                        >
                          <div className="workspace-card-content">
                            <Space size={8} wrap>
                              <Typography.Text strong>{workspace.name}</Typography.Text>
                              <Tag color={workspaceTypeColor(workspace.type)}>
                                {workspaceTypeLabel(workspace.type)}
                              </Tag>
                            </Space>
                            <Typography.Text type="secondary" className="workspace-card-description">
                              角色：{rolesLabel(workspace)}
                            </Typography.Text>
                            <Button type="primary" block onClick={() => enter(workspace)}>
                              进入工作区
                            </Button>
                          </div>
                        </Card>
                      ))}
                    </div>
                  </section>
                ))}
              </Space>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
