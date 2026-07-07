import { AppstoreOutlined, BankOutlined, ShopOutlined } from "@ant-design/icons";
import { Button, Empty, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { WorkspaceIdentity, WorkspaceType } from "../../shared/types";
import { AppShell } from "../components/app-shell";
import { useSessionStore } from "../stores/session-store";
import { useWorkspaceStore } from "../stores/workspace-store";

const ICONS: Record<WorkspaceType, ReactNode> = {
  platform: <AppstoreOutlined />,
  agency: <BankOutlined />,
  enterprise: <ShopOutlined />
};

const LABELS: Record<WorkspaceType, string> = {
  platform: "平台",
  agency: "机构",
  enterprise: "企业"
};

const COLORS: Record<WorkspaceType, string> = {
  platform: "purple",
  agency: "blue",
  enterprise: "cyan"
};

function rolesLabel(workspace: WorkspaceIdentity) {
  return workspace.roles.map((role) => role.name).join("、") || "无角色";
}

export function WorkspaceSelectPage() {
  const navigate = useNavigate();
  const workspaces = useSessionStore((state) => state.workspaces);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);

  function enterWorkspace(workspace: WorkspaceIdentity) {
    selectWorkspace(workspace);
    navigate("/dashboard");
  }

  return (
    <AppShell>
      <div className="desktop-page-header">
        <div>
          <Typography.Title level={3}>选择工作区</Typography.Title>
          <Typography.Text type="secondary">桌面客户端会根据所选工作区加载对应权限和上下文。</Typography.Text>
        </div>
      </div>
      {workspaces.length === 0 ? (
        <Empty description="当前账号暂无可进入的后台身份" />
      ) : (
        <div className="workspace-grid">
          {workspaces.map((workspace) => (
            <button className="workspace-card" key={workspace.membershipId} onClick={() => enterWorkspace(workspace)}>
              <div className="workspace-card-icon">{ICONS[workspace.type]}</div>
              <div className="workspace-card-main">
                <Space size={8} wrap>
                  <Typography.Text strong>{workspace.name}</Typography.Text>
                  <Tag color={COLORS[workspace.type]}>{LABELS[workspace.type]}</Tag>
                </Space>
                <Typography.Text type="secondary">{rolesLabel(workspace)}</Typography.Text>
              </div>
              <Button type="primary">进入</Button>
            </button>
          ))}
        </div>
      )}
    </AppShell>
  );
}
