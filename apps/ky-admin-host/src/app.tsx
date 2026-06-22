import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ApartmentOutlined,
  ApiOutlined,
  AppstoreOutlined,
  BankOutlined,
  BellOutlined,
  BookOutlined,
  FileSearchOutlined,
  IdcardOutlined,
  KeyOutlined,
  LoginOutlined,
  LogoutOutlined,
  MenuOutlined,
  NotificationOutlined,
  PartitionOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ShopOutlined,
  StarOutlined,
  SwapOutlined,
  TeamOutlined,
  UsergroupAddOutlined
} from "@ant-design/icons";
import {
  App as AntdApp,
  Breadcrumb,
  Button,
  Card,
  ConfigProvider,
  Drawer,
  Empty,
  Grid,
  Input,
  Layout,
  Menu,
  Result,
  Space,
  Tag,
  Typography
} from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Navigate,
  Outlet,
  Route,
  BrowserRouter,
  Routes,
  useLocation,
  useNavigate,
  useParams
} from "react-router-dom";
import {
  CurrentUserContextProvider,
  PermissionBoundary,
  PermissionContextProvider,
  RequestClientProvider,
  WorkspaceContextProvider,
  usePermissions,
  type PluginRoute,
  type WorkspaceIdentity
} from "@ky/admin-core";
import { ForbiddenPage } from "./pages/forbidden";
import { LoginPage } from "./pages/login";
import { NoWorkspacePage } from "./pages/no-workspace";
import { RegisterPage } from "./pages/register";
import { WorkbenchPage } from "./pages/workbench";
import { WorkspaceSelectPage } from "./pages/workspace-select";
import { clearSession, loadBootstrap, loadSession, selectWorkspace, setBootstrap } from "./app-store";
import { localPlugins } from "./local-plugin-manifest";
import { bootstrap as refreshBootstrap, logout, requestClient } from "./remote-api";
import {
  filterWorkspaces,
  groupWorkspaces,
  rolesLabel,
  workspaceBackendSubtitle,
  workspaceBackendTitle,
  workspaceTypeColor,
  workspaceTypeLabel
} from "./workspace-ui";

const HEADER_HEIGHT = 80;
const SIDEBAR_WIDTH = 210;
const WORKBENCH_KEY = "__workbench__";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } }
});

const pluginRoutes: PluginRoute[] = localPlugins.flatMap((plugin) => plugin.routes ?? []);

const MENU_ICONS: Record<string, ReactNode> = {
  AppstoreOutlined: <AppstoreOutlined />,
  BankOutlined: <BankOutlined />,
  ShopOutlined: <ShopOutlined />,
  IdcardOutlined: <IdcardOutlined />,
  ApartmentOutlined: <ApartmentOutlined />,
  TeamOutlined: <TeamOutlined />,
  UsergroupAddOutlined: <UsergroupAddOutlined />,
  SafetyCertificateOutlined: <SafetyCertificateOutlined />,
  KeyOutlined: <KeyOutlined />,
  PartitionOutlined: <PartitionOutlined />,
  FileSearchOutlined: <FileSearchOutlined />,
  LoginOutlined: <LoginOutlined />,
  BellOutlined: <BellOutlined />,
  NotificationOutlined: <NotificationOutlined />,
  SettingOutlined: <SettingOutlined />,
  BookOutlined: <BookOutlined />,
  ApiOutlined: <ApiOutlined />,
  RobotOutlined: <RobotOutlined />,
  StarOutlined: <StarOutlined />
};

function menuIcon(name?: string): ReactNode {
  return (name && MENU_ICONS[name]) || <AppstoreOutlined />;
}

export function App() {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: "#1677ff", borderRadius: 8 } }}>
      <QueryClientProvider client={queryClient}>
        <RequestClientProvider client={requestClient}>
          <AntdApp>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route
                  path="/workspace/select"
                  element={
                    <RequireSession>
                      <WorkspaceSelectPage />
                    </RequireSession>
                  }
                />
                <Route
                  path="/no-workspace"
                  element={
                    <RequireSession>
                      <NoWorkspacePage />
                    </RequireSession>
                  }
                />
                <Route path="/403" element={<ForbiddenPage />} />
                <Route
                  path="/w/:workspaceType/:workspaceId"
                  element={
                    <RequireSession>
                      <WorkspaceLayout />
                    </RequireSession>
                  }
                >
                  <Route index element={<Navigate to="workbench" replace />} />
                  <Route path="workbench" element={<WorkbenchPage />} />
                  {pluginRoutes.map((route) => (
                    <Route
                      key={route.path}
                      path={route.path.replace(/^\//, "")}
                      element={<GuardedPluginRoute route={route} />}
                    />
                  ))}
                </Route>
                <Route path="*" element={<Navigate to={loadSession() ? "/workspace/select" : "/login"} replace />} />
              </Routes>
            </BrowserRouter>
          </AntdApp>
        </RequestClientProvider>
      </QueryClientProvider>
    </ConfigProvider>
  );
}

function RequireSession({ children }: { children: ReactNode }) {
  if (!loadSession()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function GuardedPluginRoute({ route }: { route: PluginRoute }) {
  const permissions = usePermissions();
  if (route.requiredAnyPermissions?.length && !permissions.canAny(route.requiredAnyPermissions)) {
    return <Result status="403" title="无权访问" subTitle="当前工作区没有该操作权限。" />;
  }
  return (
    <PermissionBoundary
      permissions={permissions.permissions}
      requiredPermissions={route.requiredPermission ? [route.requiredPermission] : undefined}
    >
      {route.element as ReactNode}
    </PermissionBoundary>
  );
}

function menuVisible(
  menu: { requiredPermission?: string; requiredAnyPermissions?: string[] },
  perms: string[]
): boolean {
  if (menu.requiredPermission && !perms.includes(menu.requiredPermission)) {
    return false;
  }
  if (menu.requiredAnyPermissions?.length && !menu.requiredAnyPermissions.some((p) => perms.includes(p))) {
    return false;
  }
  return true;
}

function WorkspaceLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const { message } = AntdApp.useApp();
  const screens = Grid.useBreakpoint();
  const isDesktop = Boolean(screens.md);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherSearch, setSwitcherSearch] = useState("");

  // Use the cached bootstrap for the first paint, then refresh it once on entry
  // so newly granted permissions/menus appear without forcing a re-login.
  const [bootstrapState, setBootstrapState] = useState(() => loadBootstrap());
  useEffect(() => {
    let active = true;
    refreshBootstrap()
      .then((next) => {
        if (!active) return;
        setBootstrap(next);
        setBootstrapState(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const workspaces = bootstrapState?.workspaces ?? [];
  const user = bootstrapState?.user ?? null;
  const currentWorkspace = workspaces.find(
    (workspace) => workspace.id === params.workspaceId && workspace.type === params.workspaceType
  );

  const switcherGroups = useMemo(
    () => groupWorkspaces(filterWorkspaces(workspaces, switcherSearch)),
    [workspaces, switcherSearch]
  );

  if (!currentWorkspace) {
    return <Navigate to="/403" replace />;
  }
  selectWorkspace(currentWorkspace);

  const workbenchPath = `/w/${currentWorkspace.type}/${currentWorkspace.id}/workbench`;
  const workspacePath = (path: string) =>
    `/w/${currentWorkspace.type}/${currentWorkspace.id}${path === "/" ? "/workbench" : path}`;

  // Build the sidebar from plugin-contributed menus, gated by the current
  // workspace's permissions. Each item carries its navigation target.
  // Group the sidebar by plugin (ordered by navOrder), each group a labelled
  // section with per-item icons. menuTargets maps every menu key to its path.
  const menuTargets = new Map<string, string>([[WORKBENCH_KEY, workbenchPath]]);
  const orderedPlugins = [...localPlugins].sort((a, b) => (a.navOrder ?? 100) - (b.navOrder ?? 100));
  const groupItems = orderedPlugins
    .map((plugin) => {
      const visible = (plugin.menus ?? []).filter((menu) => menuVisible(menu, currentWorkspace.permissions));
      visible.forEach((menu) => menuTargets.set(menu.key, workspacePath(menu.path)));
      if (visible.length === 0) {
        return null;
      }
      return {
        key: `grp:${plugin.name}`,
        type: "group" as const,
        label: plugin.navGroup ?? plugin.name,
        children: visible.map((menu) => ({ key: menu.key, icon: menuIcon(menu.icon), label: menu.label }))
      };
    })
    .filter((group): group is NonNullable<typeof group> => group !== null);
  const menuItems = [
    { key: WORKBENCH_KEY, icon: <AppstoreOutlined />, label: "工作台" },
    { type: "divider" as const },
    ...groupItems
  ];
  const activeKey =
    [...menuTargets.entries()].find(([, target]) => target !== workbenchPath && location.pathname.startsWith(target))?.[0] ??
    WORKBENCH_KEY;

  const onMenuClick = (key: string) => {
    setMobileMenuOpen(false);
    const target = menuTargets.get(key);
    if (target) {
      navigate(target);
    }
  };

  const switcherMatchCount = switcherGroups.reduce((total, group) => total + group.workspaces.length, 0);

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // best-effort server logout; local session is cleared regardless
    } finally {
      clearSession();
      void message.success("已退出登录。");
      navigate("/login", { replace: true });
    }
  }

  function enterWorkspace(workspace: WorkspaceIdentity) {
    selectWorkspace(workspace);
    setSwitcherOpen(false);
    setSwitcherSearch("");
    if (workspace.id !== currentWorkspace?.id) {
      void message.success(`已切换到${workspace.name}`);
    }
    navigate(`/w/${workspace.type}/${workspace.id}/workbench`);
  }

  const navMenu = (
    <div className="app-nav-menu-wrap">
      <Menu
        className="app-menu"
        items={menuItems}
        mode="inline"
        onClick={({ key }) => onMenuClick(String(key))}
        selectedKeys={[activeKey]}
        theme="light"
      />
    </div>
  );

  return (
    <CurrentUserContextProvider user={user}>
      <WorkspaceContextProvider workspace={currentWorkspace}>
        <PermissionContextProvider
          value={{
            permissions: currentWorkspace.permissions,
            actionPermissions: currentWorkspace.actionPermissions,
            menuKeys: currentWorkspace.menuKeys
          }}
        >
          <Layout className="app-shell">
            <Layout.Header className="app-header">
              <div className="app-header-leading">
                {!isDesktop ? (
                  <Button icon={<MenuOutlined />} onClick={() => setMobileMenuOpen(true)} type="text" />
                ) : null}
                <div className="brand-block">
                  <Typography.Text className="brand-title">{workspaceBackendTitle(currentWorkspace)}</Typography.Text>
                  <Typography.Text className="brand-subtitle">{workspaceBackendSubtitle(currentWorkspace)}</Typography.Text>
                </div>
              </div>

              <Space>
                <Button icon={<SwapOutlined />} onClick={() => setSwitcherOpen(true)} type="default">
                  <Space className="workspace-switch-label" size={6}>
                    <span>{currentWorkspace.name}</span>
                    <Tag color={workspaceTypeColor(currentWorkspace.type)}>{workspaceTypeLabel(currentWorkspace.type)}</Tag>
                  </Space>
                </Button>
                {user ? <Typography.Text className="header-user">{user.displayName}</Typography.Text> : null}
                <Button icon={<LogoutOutlined />} onClick={handleLogout}>
                  退出
                </Button>
              </Space>
            </Layout.Header>

            <Layout className="app-body" style={{ marginTop: HEADER_HEIGHT }}>
              {isDesktop ? (
                <Layout.Sider className="app-sider" trigger={null} width={SIDEBAR_WIDTH}>
                  <div className="app-sider-scroll">{navMenu}</div>
                </Layout.Sider>
              ) : (
                <Drawer
                  onClose={() => setMobileMenuOpen(false)}
                  open={mobileMenuOpen}
                  placement="left"
                  title="后台菜单"
                  width={SIDEBAR_WIDTH}
                >
                  {navMenu}
                </Drawer>
              )}

              <Layout.Content className="app-content" style={{ marginLeft: isDesktop ? SIDEBAR_WIDTH : 0 }}>
                <Breadcrumb className="workspace-breadcrumb" items={[{ title: currentWorkspace.name }, { title: "工作台" }]} />
                <Outlet />
              </Layout.Content>
            </Layout>

            <Drawer
              onClose={() => {
                setSwitcherOpen(false);
                setSwitcherSearch("");
              }}
              open={switcherOpen}
              title="切换工作区"
              width={isDesktop ? 420 : "94vw"}
            >
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Card size="small">
                  <Space direction="vertical" size={6}>
                    <Typography.Text type="secondary">当前工作区</Typography.Text>
                    <Space wrap>
                      <Typography.Text strong>{currentWorkspace.name}</Typography.Text>
                      <Tag color={workspaceTypeColor(currentWorkspace.type)}>{workspaceTypeLabel(currentWorkspace.type)}</Tag>
                      <Tag color="green">当前</Tag>
                    </Space>
                    <Typography.Text type="secondary">{rolesLabel(currentWorkspace)}</Typography.Text>
                  </Space>
                </Card>

                {workspaces.length > 1 ? (
                  <Input.Search
                    allowClear
                    onChange={(event) => setSwitcherSearch(event.target.value)}
                    placeholder="搜索工作区名称、类型或角色"
                    value={switcherSearch}
                  />
                ) : null}

                {switcherMatchCount === 0 ? (
                  <Empty description="没有匹配的工作区。" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  switcherGroups.map((group) => (
                    <div className="workspace-tree-group" key={group.type}>
                      <Typography.Text className="workspace-group-heading" type="secondary">
                        {workspaceTypeLabel(group.type)}后台
                      </Typography.Text>
                      <Space direction="vertical" size={8} style={{ width: "100%" }}>
                        {group.workspaces.map((workspace) => (
                          <Card key={workspace.id} size="small">
                            <Space style={{ justifyContent: "space-between", width: "100%" }}>
                              <Space direction="vertical" size={0}>
                                <Space size={6}>
                                  <Typography.Text strong>{workspace.name}</Typography.Text>
                                  {workspace.id === currentWorkspace.id ? <Tag color="green">当前</Tag> : null}
                                </Space>
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  {rolesLabel(workspace)}
                                </Typography.Text>
                              </Space>
                              <Button
                                size="small"
                                type={workspace.id === currentWorkspace.id ? "default" : "primary"}
                                onClick={() => enterWorkspace(workspace)}
                              >
                                {workspace.id === currentWorkspace.id ? "停留" : "切换"}
                              </Button>
                            </Space>
                          </Card>
                        ))}
                      </Space>
                    </div>
                  ))
                )}
              </Space>
            </Drawer>
          </Layout>
        </PermissionContextProvider>
      </WorkspaceContextProvider>
    </CurrentUserContextProvider>
  );
}
