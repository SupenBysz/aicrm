import { AppstoreOutlined, ArrowRightOutlined, BankOutlined, ShopOutlined, UserOutlined } from "@ant-design/icons";
import { App as AntdApp, Empty, Input, Tag, Typography } from "antd";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { WorkspaceIdentity, WorkspaceType } from "@ky/admin-core";
import {
  loadBootstrap,
  selectWorkspace,
  setBootstrap,
  workspaceWorkbenchPath,
  type BootstrapState
} from "../app-store";
import { usePlatformProfile } from "../platform-profile";
import { bootstrap, pickRecommendedWorkspace } from "../remote-api";
import {
  filterWorkspaces,
  groupWorkspaces,
  rolesLabel,
  workspaceGroupDescription,
  workspaceTypeColor,
  workspaceTypeLabel
} from "../workspace-ui";

const WORKSPACE_TYPE_ICONS: Record<WorkspaceType, ReactNode> = {
  agency: <BankOutlined />,
  enterprise: <ShopOutlined />,
  platform: <AppstoreOutlined />
};

export function WorkspaceSelectPage() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const { logoTextLong } = usePlatformProfile();
  const [state, setState] = useState(() => loadBootstrap());
  const [search, setSearch] = useState("");
  const workspaces = state?.workspaces ?? [];

  useEffect(() => {
    let active = true;
    const leaveSelectionWhenNotNeeded = (next: BootstrapState) => {
      if (!active) return;
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
    };

    if (state) {
      leaveSelectionWhenNotNeeded(state);
      return () => {
        active = false;
      };
    }

    bootstrap()
      .then((next) => {
        if (!active) return;
        setBootstrap(next);
        setState(next);
        leaveSelectionWhenNotNeeded(next);
      })
      .catch((error) => {
        if (active) {
          message.error(error instanceof Error ? error.message : "身份加载失败");
        }
      });

    return () => {
      active = false;
    };
  }, [message, navigate, state]);

  const filteredWorkspaces = useMemo(() => filterWorkspaces(workspaces, search), [search, workspaces]);
  const grouped = useMemo(() => groupWorkspaces(filteredWorkspaces), [filteredWorkspaces]);
  const matched = grouped.reduce((total, group) => total + group.workspaces.length, 0);
  const userContact = state?.user.email || state?.user.phone || "已登录账号";

  function enter(workspace: WorkspaceIdentity) {
    selectWorkspace(workspace);
    void message.success(`已进入${workspace.name}`);
    navigate(workspaceWorkbenchPath(workspace));
  }

  if (!state || workspaces.length <= 1) {
    return null;
  }

  return (
    <div className="workspace-selection-shell">
      <div className="workspace-selection-container">
        <header className="workspace-selection-header">
          <div>
            <Typography.Text className="workspace-selection-eyebrow">{logoTextLong} Console</Typography.Text>
            <Typography.Title level={2}>选择工作区</Typography.Title>
            <Typography.Paragraph>进入不同后台时，菜单、权限与数据范围会按当前身份切换。</Typography.Paragraph>
          </div>
          <div className="workspace-selection-user-chip">
            <div className="workspace-selection-avatar">
              <UserOutlined />
            </div>
            <div className="workspace-selection-user">
              <Typography.Text strong>{state?.user.displayName}</Typography.Text>
              <Typography.Text type="secondary">{userContact}</Typography.Text>
            </div>
          </div>
        </header>

        <main className="workspace-selection-panel">
          <div className="workspace-selection-toolbar">
            <div>
              <Typography.Title level={4}>后台身份</Typography.Title>
              <Typography.Text type="secondary">
                共 {workspaces.length} 个工作区，当前匹配 {matched} 个
              </Typography.Text>
            </div>
            <Input.Search
              allowClear
              className="workspace-selection-search"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索工作区、后台类型或角色"
              size="large"
              value={search}
            />
          </div>

          <div className="workspace-selection-body">
            {matched === 0 ? (
              <div className="workspace-selection-empty">
                <Empty description="没有匹配的工作区。" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              </div>
            ) : (
              <div className="workspace-tree-list workspace-tree-list--selection">
                {grouped.map((group) => (
                  <section className="workspace-tree-group" key={group.type}>
                    <div className={`workspace-tree-group-row workspace-tree-group-row--${group.type}`}>
                      <span className={`workspace-selection-type-icon workspace-selection-type-icon--${group.type}`}>
                        {WORKSPACE_TYPE_ICONS[group.type]}
                      </span>
                      <div className="workspace-tree-group-main">
                        <div>
                          <Typography.Title level={5}>{workspaceTypeLabel(group.type)}后台</Typography.Title>
                          <Typography.Text type="secondary">{workspaceGroupDescription(group.type)}</Typography.Text>
                        </div>
                        <Tag color={workspaceTypeColor(group.type)}>{group.workspaces.length} 个</Tag>
                      </div>
                    </div>

                    <div className="workspace-tree-children">
                      {group.workspaces.map((workspace) => (
                        <button
                          aria-label={`进入${workspace.name}`}
                          className="workspace-tree-row"
                          key={workspace.id}
                          onClick={() => enter(workspace)}
                          type="button"
                        >
                          <span className="workspace-tree-branch" />
                          <span className="workspace-tree-row-main">
                            <span className="workspace-tree-row-title">
                              <Typography.Text strong>{workspace.name}</Typography.Text>
                              <Tag color={workspaceTypeColor(workspace.type)}>
                                {workspaceTypeLabel(workspace.type)}
                              </Tag>
                            </span>
                            <Typography.Text type="secondary" className="workspace-tree-row-meta">
                              角色：{rolesLabel(workspace)}
                            </Typography.Text>
                          </span>
                          <span className="workspace-tree-row-action">
                            进入
                            <ArrowRightOutlined />
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
