import { LogoutOutlined, ReloadOutlined, SettingOutlined, TeamOutlined } from "@ant-design/icons";
import { App as AntdApp, Button, Layout, Menu, Space } from "antd";
import type { PropsWithChildren } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { TitleBar } from "./title-bar";
import { useSessionStore } from "../stores/session-store";
import { useWorkspaceStore } from "../stores/workspace-store";

export function AppShell({ children }: PropsWithChildren) {
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntdApp.useApp();
  const signOut = useSessionStore((state) => state.signOut);
  const refreshBootstrap = useSessionStore((state) => state.refreshBootstrap);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);

  async function handleRefresh() {
    try {
      await refreshBootstrap();
      void message.success("工作区信息已刷新。");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "刷新失败");
    }
  }

  async function handleLogout() {
    await signOut();
    selectWorkspace(null);
    navigate("/login", { replace: true });
  }

  return (
    <Layout className="desktop-shell">
      <TitleBar />
      <Layout>
        <Layout.Sider className="desktop-sider" width={220}>
          <Menu
            mode="inline"
            selectedKeys={[location.pathname]}
            onClick={({ key }) => navigate(String(key))}
            items={[
              { key: "/workspaces", icon: <TeamOutlined />, label: "工作区" },
              { key: "/dashboard", icon: <ReloadOutlined />, label: "概览" },
              { key: "/settings", icon: <SettingOutlined />, label: "设置" }
            ]}
          />
          <div className="desktop-sider-footer">
            <Space orientation="vertical" size={8} style={{ width: "100%" }}>
              <Button block icon={<ReloadOutlined />} onClick={handleRefresh}>
                刷新身份
              </Button>
              <Button block icon={<LogoutOutlined />} onClick={handleLogout}>
                退出登录
              </Button>
            </Space>
          </div>
        </Layout.Sider>
        <Layout.Content className="desktop-content">{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}
