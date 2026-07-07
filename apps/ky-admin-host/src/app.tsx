import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ApartmentOutlined,
  ApiOutlined,
  AppstoreOutlined,
  BankOutlined,
  BellOutlined,
  BookOutlined,
  ClearOutlined,
  FileSearchOutlined,
  IdcardOutlined,
  KeyOutlined,
  LoginOutlined,
  LogoutOutlined,
  MailOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  NotificationOutlined,
  PartitionOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ShopOutlined,
  StarOutlined,
  SwapOutlined,
  TeamOutlined,
  UserOutlined,
  UsergroupAddOutlined
} from "@ant-design/icons";
import {
  IconActivity,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconBell,
  IconBug,
  IconLock,
  IconMoon,
  IconPinned,
  IconPinnedOff,
  IconSunHigh
} from "@tabler/icons-react";
import {
  App as AntdApp,
  Badge,
  Breadcrumb,
  Button,
  Card,
  ConfigProvider,
  Dropdown,
  Drawer,
  Empty,
  Form,
  Grid,
  Input,
  Layout,
  Menu,
  Result,
  Segmented,
  Space,
  Tag,
  theme as antdTheme,
  Tooltip,
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
import { clearSession, loadBootstrap, loadSession, saveSession, selectWorkspace, setBootstrap } from "./app-store";
import { localPlugins } from "./local-plugin-manifest";
import { bootstrap as refreshBootstrap, changeLoginPassword, login, logout, requestClient } from "./remote-api";
import {
  filterWorkspaces,
  groupWorkspaces,
  rolesLabel,
  workspaceBackendTitle,
  workspaceTypeColor,
  workspaceTypeLabel
} from "./workspace-ui";
import { PlatformProfileProvider, usePlatformProfile } from "./platform-profile";
import {
  getDesktopBridge,
  isDesktopClientMode,
  type DesktopNetworkLogSnapshot,
  type DesktopWindowState
} from "./desktop-client";
import { useTableHorizontalScrollbars } from "./table-horizontal-scrollbar";

const HEADER_HEIGHT = 76;
const SIDEBAR_WIDTH = 177;
const SIDEBAR_COLLAPSED_WIDTH = 80;
const SIDEBAR_COLLAPSED_KEY = "ky.admin.sidebarCollapsed.v1";
const WORKBENCH_KEY = "workbench.overview";
const WORKBENCH_LABEL = "工作台";
const MANAGEMENT_CENTER_LABEL = "管理中心";

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
  MailOutlined: <MailOutlined />,
  SettingOutlined: <SettingOutlined />,
  BookOutlined: <BookOutlined />,
  ApiOutlined: <ApiOutlined />,
  RobotOutlined: <RobotOutlined />,
  StarOutlined: <StarOutlined />
};

const MENU_GROUP_ICONS: Record<string, ReactNode> = {
  组织管理: <ApartmentOutlined />,
  身份管理: <TeamOutlined />,
  权限中心: <SafetyCertificateOutlined />,
  通知中心: <BellOutlined />,
  "AI 配置": <RobotOutlined />,
  系统设置: <SettingOutlined />,
  审计中心: <FileSearchOutlined />
};

type HeaderNavMode = "workbench" | "manage";

interface NavMeta {
  key: string;
  icon: ReactNode;
  label: string;
  target: string;
  groupLabel?: string;
}

function menuIcon(name?: string): ReactNode {
  return (name && MENU_ICONS[name]) || <AppstoreOutlined />;
}

function menuGroupIcon(label: string, fallback?: ReactNode): ReactNode {
  return MENU_GROUP_ICONS[label] ?? fallback ?? <AppstoreOutlined />;
}

type AdminColorScheme = "light" | "dark";

const ADMIN_COLOR_SCHEME_KEY = "ky.admin.colorScheme.v1";
const ADMIN_COLOR_SCHEME_CHANGED_EVENT = "ky:admin-color-scheme-changed";
const ADMIN_LOCKED_KEY = "ky.admin.locked.v1";

function systemColorScheme(): AdminColorScheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedColorScheme(): AdminColorScheme | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(ADMIN_COLOR_SCHEME_KEY);
  return value === "dark" || value === "light" ? value : null;
}

function resolveColorScheme(): AdminColorScheme {
  return storedColorScheme() ?? systemColorScheme();
}

function setAdminColorScheme(scheme: AdminColorScheme): void {
  window.localStorage.setItem(ADMIN_COLOR_SCHEME_KEY, scheme);
  window.dispatchEvent(new Event(ADMIN_COLOR_SCHEME_CHANGED_EVENT));
}

function isAdminLocked(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(ADMIN_LOCKED_KEY) === "1";
}

function setAdminLocked(locked: boolean): void {
  if (locked) {
    window.localStorage.setItem(ADMIN_LOCKED_KEY, "1");
  } else {
    window.localStorage.removeItem(ADMIN_LOCKED_KEY);
  }
}

function usePreferredColorScheme() {
  const [scheme, setScheme] = useState<"light" | "dark">(() => {
    return resolveColorScheme();
  });

  useEffect(() => {
    document.documentElement.dataset.adminTheme = scheme;
    document.documentElement.style.colorScheme = scheme;
  }, [scheme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setScheme(resolveColorScheme());
    handleChange();
    media.addEventListener("change", handleChange);
    window.addEventListener(ADMIN_COLOR_SCHEME_CHANGED_EVENT, handleChange);
    return () => {
      media.removeEventListener("change", handleChange);
      window.removeEventListener(ADMIN_COLOR_SCHEME_CHANGED_EVENT, handleChange);
    };
  }, []);

  return scheme;
}

export function App() {
  const colorScheme = usePreferredColorScheme();
  const isDark = colorScheme === "dark";

  return (
    <ConfigProvider
      theme={{
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: isDark ? "#ffd47d" : "#d49a3d",
          colorLink: isDark ? "#ffd47d" : "#d49a3d",
          colorBgLayout: isDark ? "#050505" : "#f7efe4",
          colorBgContainer: isDark ? "#111111" : "#fffaf3",
          colorBorder: isDark ? "rgba(255, 212, 125, 0.16)" : "rgba(221, 182, 113, 0.24)",
          colorSplit: isDark ? "rgba(255, 212, 125, 0.12)" : "rgba(210, 168, 95, 0.18)",
          colorText: isDark ? "#ffffff" : "#34281a",
          colorTextSecondary: isDark ? "rgba(255, 255, 255, 0.66)" : "rgba(79, 59, 36, 0.72)",
          borderRadius: 10
        }
      }}
    >
      <QueryClientProvider client={queryClient}>
        <RequestClientProvider client={requestClient}>
          <AntdApp>
            <PlatformProfileProvider>
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
                  <Route path="workbench/:section" element={<WorkbenchPage />} />
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
            </PlatformProfileProvider>
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

function pathActive(pathname: string, target: string): boolean {
  return pathname === target || pathname.startsWith(`${target}/`);
}

function formatNetworkLogUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function formatNetworkLogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function networkLogStatusColor(statusCode?: number, status?: string): string {
  if (status === "failed") return "red";
  if (!statusCode) return "default";
  if (statusCode >= 500) return "red";
  if (statusCode >= 400) return "orange";
  if (statusCode >= 300) return "blue";
  return "green";
}

interface ChangePasswordFormValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

function WorkspaceLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const platformProfile = usePlatformProfile();
  const { message } = AntdApp.useApp();
  const screens = Grid.useBreakpoint();
  const isDesktop = Boolean(screens.md);
  const colorScheme = usePreferredColorScheme();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherSearch, setSwitcherSearch] = useState("");
  const isDesktopClient = isDesktopClientMode();
  const desktopBridge = getDesktopBridge();
  const [windowState, setWindowState] = useState<DesktopWindowState | null>(null);
  const [networkLogOpen, setNetworkLogOpen] = useState(false);
  const [networkLogSnapshot, setNetworkLogSnapshot] = useState<DesktopNetworkLogSnapshot | null>(null);
  const [networkLogLoading, setNetworkLogLoading] = useState(false);
  const [locked, setLocked] = useState(() => isAdminLocked());
  const [webFullscreen, setWebFullscreen] = useState(() => {
    if (typeof document === "undefined") return false;
    return Boolean(document.fullscreenElement);
  });
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [passwordDrawerOpen, setPasswordDrawerOpen] = useState(false);
  const [passwordChanging, setPasswordChanging] = useState(false);
  const [passwordForm] = Form.useForm<ChangePasswordFormValues>();
  const navScrollRef = useRef<HTMLDivElement | null>(null);
  const [navPanelActive, setNavPanelActive] = useState(false);
  const [navScrollbar, setNavScrollbar] = useState({ hasOverflow: false, thumbHeight: 0, thumbTop: 0 });
  useTableHorizontalScrollbars();
  const updateNavScrollbar = useCallback(() => {
    const element = navScrollRef.current;
    if (!element) {
      setNavScrollbar((current) =>
        current.hasOverflow || current.thumbHeight || current.thumbTop
          ? { hasOverflow: false, thumbHeight: 0, thumbTop: 0 }
          : current
      );
      return;
    }

    const { clientHeight, scrollHeight, scrollTop } = element;
    const hasOverflow = scrollHeight > clientHeight + 1;
    const thumbHeight = hasOverflow ? Math.max(28, Math.round((clientHeight / scrollHeight) * clientHeight)) : 0;
    const maxScrollTop = Math.max(1, scrollHeight - clientHeight);
    const maxThumbTop = Math.max(0, clientHeight - thumbHeight);
    const thumbTop = hasOverflow ? Math.round((scrollTop / maxScrollTop) * maxThumbTop) : 0;
    const next = { hasOverflow, thumbHeight, thumbTop };

    setNavScrollbar((current) =>
      current.hasOverflow === next.hasOverflow &&
      current.thumbHeight === next.thumbHeight &&
      current.thumbTop === next.thumbTop
        ? current
        : next
    );
  }, []);

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
  const currentUserName = user?.username || user?.displayName || "当前用户";
  const currentUserDisplayName = user?.displayName || currentUserName;
  const canSwitchWorkspace = workspaces.length > 1;
  const effectiveSidebarCollapsed = isDesktop && sidebarCollapsed;
  const sidebarWidth = effectiveSidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH;
  const shellStyle = { "--admin-sidebar-width": `${sidebarWidth}px` } as CSSProperties;
  const currentWorkspace = workspaces.find(
    (workspace) => workspace.id === params.workspaceId && workspace.type === params.workspaceType
  );
  const canViewNotifications = Boolean(
    currentWorkspace?.permissions.some((permission) =>
      ["platform.notifications.view", "agency.notifications.view", "enterprise.notifications.view"].includes(permission)
    )
  );

  useEffect(() => {
    if (!isDesktopClient || !desktopBridge?.window) return;
    let active = true;
    void desktopBridge.window.getState?.().then((state) => {
      if (active) setWindowState(state);
    });
    const dispose = desktopBridge.window.onStateChanged?.((state) => {
      setWindowState(state);
    });
    return () => {
      active = false;
      dispose?.();
    };
  }, [desktopBridge, isDesktopClient]);

  useEffect(() => {
    const handleFullscreenChange = () => setWebFullscreen(Boolean(document.fullscreenElement));
    handleFullscreenChange();
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!currentWorkspace || !canViewNotifications) {
      setUnreadCount(0);
      return;
    }
    let active = true;
    const loadUnread = () => {
      requestClient
        .request<{ count?: number; unreadCount?: number }>("/api/v1/notifications/unread-count")
        .then((result) => {
          if (!active) return;
          setUnreadCount(result.unreadCount ?? result.count ?? 0);
        })
        .catch(() => {
          if (active) setUnreadCount(0);
        });
    };
    loadUnread();
    const timer = window.setInterval(loadUnread, 60000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [canViewNotifications, currentWorkspace?.id, currentWorkspace?.type]);

  const switcherGroups = useMemo(
    () => groupWorkspaces(filterWorkspaces(workspaces, switcherSearch)),
    [workspaces, switcherSearch]
  );

  useEffect(() => {
    updateNavScrollbar();
    const element = navScrollRef.current;
    if (!element) return;

    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateNavScrollbar) : null;
    resizeObserver?.observe(element);
    if (element.firstElementChild) {
      resizeObserver?.observe(element.firstElementChild);
    }
    window.addEventListener("resize", updateNavScrollbar);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateNavScrollbar);
    };
  }, [currentWorkspace?.id, currentWorkspace?.type, effectiveSidebarCollapsed, location.pathname, updateNavScrollbar]);

  if (!currentWorkspace) {
    return <Navigate to="/403" replace />;
  }
  selectWorkspace(currentWorkspace);

  const workbenchPath = `/w/${currentWorkspace.type}/${currentWorkspace.id}/workbench`;
  const workbenchPathFor = (section?: string) => `${workbenchPath}${section ? `/${section}` : ""}`;
  const workspacePath = (path: string) =>
    `/w/${currentWorkspace.type}/${currentWorkspace.id}${path === "/" ? "/workbench" : path}`;
  const currentNavMode: HeaderNavMode = pathActive(location.pathname, workbenchPath) ? "workbench" : "manage";
  const workbenchNavMetas: NavMeta[] = [
    { key: WORKBENCH_KEY, icon: <AppstoreOutlined />, label: "概览", target: workbenchPathFor() },
    { key: "workbench.todos", icon: <BookOutlined />, label: "待办事项", target: workbenchPathFor("todos") },
    { key: "workbench.messages", icon: <BellOutlined />, label: "我的消息", target: workbenchPathFor("messages") },
    { key: "workbench.shortcuts", icon: <StarOutlined />, label: "快捷入口", target: workbenchPathFor("shortcuts") }
  ];

  // Build the sidebar from plugin-contributed menus, gated by the current
  // workspace's permissions. Each item carries its navigation target.
  // Group the sidebar by plugin (ordered by navOrder). Each plugin group is a
  // collapsible first-level submenu; menuTargets maps leaf menu keys to routes.
  const orderedPlugins = [...localPlugins].sort((a, b) => (a.navOrder ?? 100) - (b.navOrder ?? 100));
  const navGroups = orderedPlugins
    .map((plugin) => {
      const visible = (plugin.menus ?? []).filter((menu) => menuVisible(menu, currentWorkspace.permissions));
      if (visible.length === 0) {
        return null;
      }
      const items: NavMeta[] = visible.map((menu) => ({
        key: menu.key,
        icon: menuIcon(menu.icon),
        label: menu.label,
        target: workspacePath(menu.path),
        groupLabel: plugin.navGroup ?? plugin.name
      }));
      return {
        key: `grp:${plugin.name}`,
        label: plugin.navGroup ?? plugin.name,
        icon: menuGroupIcon(plugin.navGroup ?? plugin.name, items[0]?.icon),
        items
      };
    })
    .filter((group): group is NonNullable<typeof group> => group !== null);
  const navMetas = navGroups.flatMap((group) => group.items);
  const menuTargets = new Map<string, string>(
    (currentNavMode === "workbench" ? workbenchNavMetas : navMetas).map((item) => [item.key, item.target])
  );
  const activeWorkbenchMenu = [...workbenchNavMetas]
    .sort((a, b) => b.target.length - a.target.length)
    .find((item) => pathActive(location.pathname, item.target));
  const activeMenu = [...navMetas]
    .sort((a, b) => b.target.length - a.target.length)
    .find((item) => pathActive(location.pathname, item.target));
  const menuItems =
    currentNavMode === "workbench"
      ? workbenchNavMetas.map((item) => ({ key: item.key, icon: item.icon, label: item.label }))
      : navGroups.map((group) => ({
          key: group.key,
          icon: group.icon,
          label: group.label,
          children: group.items.map((item) => ({ key: item.key, icon: item.icon, label: item.label }))
        }));
  const activeKey = currentNavMode === "workbench" ? activeWorkbenchMenu?.key ?? WORKBENCH_KEY : activeMenu?.key;
  const breadcrumbItems =
    currentNavMode === "workbench"
      ? [{ title: currentWorkspace.name }, { title: WORKBENCH_LABEL }, { title: activeWorkbenchMenu?.label ?? "概览" }]
      : activeMenu
        ? [{ title: currentWorkspace.name }, { title: activeMenu.groupLabel }, { title: activeMenu.label }]
        : [{ title: currentWorkspace.name }, { title: MANAGEMENT_CENTER_LABEL }];

  const onMenuClick = (key: string) => {
    setMobileMenuOpen(false);
    const target = menuTargets.get(key);
    if (target) {
      navigate(target);
    }
  };
  const handleHeaderNavModeChange = (nextMode: HeaderNavMode) => {
    setMobileMenuOpen(false);
    if (nextMode === currentNavMode) return;
    if (nextMode === "workbench") {
      navigate(workbenchPath);
      return;
    }
    const manageDefaultTarget = navMetas[0]?.target;
    if (manageDefaultTarget) {
      navigate(manageDefaultTarget);
      return;
    }
    void message.warning("当前工作区暂无可访问的管理菜单。");
  };
  const handleNavPanelEnter = () => {
    setNavPanelActive(true);
    window.requestAnimationFrame(updateNavScrollbar);
  };
  const handleNavPanelLeave = () => {
    setNavPanelActive(false);
  };
  const handleNavScroll = () => {
    updateNavScrollbar();
  };

  const switcherMatchCount = switcherGroups.reduce((total, group) => total + group.workspaces.length, 0);

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // best-effort server logout; local session is cleared regardless
    } finally {
      setAdminLocked(false);
      clearSession();
      void message.success("已退出登录。");
      navigate("/login", { replace: true });
    }
  }

  function handleOpenChangePassword() {
    passwordForm.resetFields();
    setPasswordDrawerOpen(true);
  }

  function handleToggleSidebarCollapsed() {
    setSidebarCollapsed((value) => {
      const next = !value;
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }

  async function handleChangePassword(values: ChangePasswordFormValues) {
    setPasswordChanging(true);
    try {
      await changeLoginPassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword
      });
      passwordForm.resetFields();
      setPasswordDrawerOpen(false);
      void message.success("登录密码已修改。");
    } catch {
      void message.error("修改登录密码失败，请确认当前密码是否正确。");
    } finally {
      setPasswordChanging(false);
    }
  }

  async function refreshNetworkLogs() {
    if (!desktopBridge?.network?.getSnapshot) {
      void message.warning("网络日志仅在客户端模式可用。");
      return;
    }
    setNetworkLogLoading(true);
    try {
      setNetworkLogSnapshot(await desktopBridge.network.getSnapshot());
    } catch {
      void message.error("读取网络日志失败。");
    } finally {
      setNetworkLogLoading(false);
    }
  }

  async function handleOpenNetworkLogs() {
    setNetworkLogOpen(true);
    await refreshNetworkLogs();
  }

  async function handleClearNetworkLogs() {
    if (!desktopBridge?.network?.clear) return;
    setNetworkLogLoading(true);
    try {
      setNetworkLogSnapshot(await desktopBridge.network.clear());
      void message.success("网络日志已清空。");
    } catch {
      void message.error("清空网络日志失败。");
    } finally {
      setNetworkLogLoading(false);
    }
  }

  async function handleToggleAlwaysOnTop() {
    if (!desktopBridge?.window?.setAlwaysOnTop) {
      void message.warning("窗口置顶仅在客户端模式可用。");
      return;
    }
    try {
      setWindowState(await desktopBridge.window.setAlwaysOnTop(!windowState?.isAlwaysOnTop));
    } catch {
      void message.error("切换窗口置顶失败。");
    }
  }

  async function handleToggleFullscreen() {
    if (isDesktopClient) {
      if (windowState?.platform !== "darwin" || !desktopBridge?.window?.setFullScreen) {
        void message.warning("全屏仅在 Mac 客户端可用。");
        return;
      }
      try {
        setWindowState(await desktopBridge.window.setFullScreen(!windowState?.isFullScreen));
      } catch {
        void message.error("切换全屏失败。");
      }
      return;
    }

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      void message.error("浏览器全屏切换失败。");
    }
  }

  async function handleOpenDevTools() {
    if (!desktopBridge?.window?.openDevTools) {
      void message.warning("调试入口仅在客户端模式可用。");
      return;
    }
    const result = await desktopBridge.window.openDevTools();
    if (result.opened) return;
    if (result.reason === "production") {
      void message.warning("生产模式下禁止打开调试工具。");
      return;
    }
    void message.error("调试工具暂不可用。");
  }

  function handleOpenNotifications() {
    if (!canViewNotifications) {
      void message.warning("当前工作区没有通知查看权限。");
      return;
    }
    navigate(workspacePath("/notifications"));
  }

  function handleLockScreen() {
    setUnlockPassword("");
    setUnlockError("");
    setAdminLocked(true);
    setLocked(true);
  }

  async function handleUnlock() {
    const account = user?.username || user?.email || user?.displayName;
    if (!account) {
      setUnlockError("当前用户缺少可用于解锁的账号。");
      void message.error("当前用户缺少可用于解锁的账号。");
      return;
    }
    if (!unlockPassword.trim()) {
      setUnlockError("请输入当前账号密码。");
      void message.warning("请输入当前账号密码。");
      return;
    }
    setUnlocking(true);
    setUnlockError("");
    try {
      const nextSession = await login({ account, password: unlockPassword }, { skipAuthRedirect: true });
      saveSession(nextSession);
      setUnlockPassword("");
      setUnlockError("");
      setAdminLocked(false);
      setLocked(false);
      void message.success("已解锁。");
    } catch {
      setUnlockError("密码错误，请重新输入。");
      void message.error("密码错误，请重新输入。");
    } finally {
      setUnlocking(false);
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
        className={`app-menu${effectiveSidebarCollapsed ? " app-menu--collapsed" : ""}`}
        defaultOpenKeys={[]}
        inlineCollapsed={effectiveSidebarCollapsed}
        items={menuItems}
        mode="inline"
        onClick={({ key }) => onMenuClick(String(key))}
        selectedKeys={activeKey ? [activeKey] : []}
        theme={colorScheme === "dark" ? "dark" : "light"}
      />
    </div>
  );
  const isMacDesktopClient = isDesktopClient && windowState?.platform === "darwin";
  const showFullscreenAction = !isDesktopClient || isMacDesktopClient;
  const fullscreenActive = isDesktopClient ? Boolean(windowState?.isFullScreen) : webFullscreen;

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
          <Layout
            className={`app-shell${effectiveSidebarCollapsed ? " app-shell--sidebar-collapsed" : ""}`}
            style={shellStyle}
          >
            <Layout.Header className="app-header">
              <div className="app-header-leading">
                {!isDesktop ? (
                  <Button icon={<MenuOutlined />} onClick={() => setMobileMenuOpen(true)} type="text" />
                ) : null}
                <div className="brand-block">
                  <Typography.Text className="brand-title">
                    {workspaceBackendTitle(currentWorkspace, platformProfile, effectiveSidebarCollapsed ? "short" : "full")}
                  </Typography.Text>
                </div>
              </div>

              <div className="app-header-mode-switch">
                <Segmented<HeaderNavMode>
                  aria-label="后台大类"
                  className="app-mode-segmented"
                  onChange={handleHeaderNavModeChange}
                  options={[
                    { label: WORKBENCH_LABEL, value: "workbench" },
                    { label: MANAGEMENT_CENTER_LABEL, value: "manage" }
                  ]}
                  value={currentNavMode}
                />
              </div>

              <Space className="app-header-actions desktop-quick-actions" size={6}>
                {canSwitchWorkspace ? (
                  <Button icon={<SwapOutlined />} onClick={() => setSwitcherOpen(true)} type="default">
                    <Space className="workspace-switch-label" size={6}>
                      <span>{currentWorkspace.name}</span>
                      <Tag color={workspaceTypeColor(currentWorkspace.type)}>
                        {workspaceTypeLabel(currentWorkspace.type)}
                      </Tag>
                    </Space>
                  </Button>
                ) : null}
                {isDesktopClient ? (
                  <>
                    <Tooltip title="调试入口">
                      <Button
                        aria-label="调试入口"
                        className="desktop-quick-action desktop-quick-action--debug"
                        icon={<IconBug size={24} stroke={1.45} />}
                        onClick={() => void handleOpenDevTools()}
                        type="text"
                      />
                    </Tooltip>
                    <Tooltip title="网络日志">
                      <Button
                        aria-label="网络日志"
                        className="desktop-quick-action desktop-quick-action--network"
                        icon={<IconActivity size={24} stroke={1.45} />}
                        onClick={() => void handleOpenNetworkLogs()}
                        type="text"
                      />
                    </Tooltip>
                    <Tooltip title={windowState?.isAlwaysOnTop ? "取消置顶" : "置顶窗口"}>
                      <Button
                        aria-label={windowState?.isAlwaysOnTop ? "取消置顶" : "置顶窗口"}
                        className={`desktop-quick-action desktop-quick-action--pin${
                          windowState?.isAlwaysOnTop ? " is-active" : ""
                        }`}
                        icon={
                          windowState?.isAlwaysOnTop ? (
                            <IconPinnedOff size={25} stroke={1.35} />
                          ) : (
                            <IconPinned size={25} stroke={1.35} />
                          )
                        }
                        onClick={() => void handleToggleAlwaysOnTop()}
                        type="text"
                      />
                    </Tooltip>
                  </>
                ) : null}
                <Tooltip title="公告">
                  <Badge count={unreadCount} overflowCount={99} size="small">
                    <Button
                      aria-label="公告"
                      className="desktop-quick-action desktop-quick-action--notification"
                      icon={<IconBell size={26} stroke={1.35} />}
                      onClick={handleOpenNotifications}
                      type="text"
                    />
                  </Badge>
                </Tooltip>
                <Tooltip title={colorScheme === "dark" ? "切换亮色" : "切换暗色"}>
                  <Button
                    aria-label={colorScheme === "dark" ? "切换亮色" : "切换暗色"}
                    className="desktop-quick-action desktop-quick-action--theme"
                    icon={
                      colorScheme === "dark" ? (
                        <IconSunHigh size={26} stroke={1.35} />
                      ) : (
                        <IconMoon size={26} stroke={1.35} />
                      )
                    }
                    onClick={() => setAdminColorScheme(colorScheme === "dark" ? "light" : "dark")}
                    type="text"
                  />
                </Tooltip>
                {showFullscreenAction ? (
                  <Tooltip title={fullscreenActive ? "退出全屏" : isDesktopClient ? "全屏显示" : "浏览器全屏"}>
                    <Button
                      aria-label={fullscreenActive ? "退出全屏" : "全屏"}
                      className={`desktop-quick-action desktop-quick-action--fullscreen${
                        fullscreenActive ? " is-active" : ""
                      }`}
                      icon={
                        fullscreenActive ? (
                          <IconArrowsMinimize size={25} stroke={1.35} />
                        ) : (
                          <IconArrowsMaximize size={25} stroke={1.35} />
                        )
                      }
                      onClick={() => void handleToggleFullscreen()}
                      type="text"
                    />
                  </Tooltip>
                ) : null}
                <Tooltip title="锁屏">
                  <Button
                    aria-label="锁屏"
                    className="desktop-quick-action desktop-quick-action--lock"
                    icon={<IconLock size={25} stroke={1.35} />}
                    onClick={handleLockScreen}
                    type="text"
                  />
                </Tooltip>
                {user ? (
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: "current-user",
                          disabled: true,
                          label: (
                            <span className="desktop-user-menu-name">
                              <strong>{currentUserName}</strong>
                              <span>{currentUserDisplayName}</span>
                            </span>
                          )
                        },
                        { type: "divider" },
                        ...(canSwitchWorkspace
                          ? [
                              {
                                key: "switch-workspace",
                                icon: <SwapOutlined />,
                                label: "切换工作区",
                                onClick: () => setSwitcherOpen(true)
                              }
                            ]
                          : []),
                        {
                          key: "change-password",
                          icon: <KeyOutlined />,
                          label: "修改登录密码",
                          onClick: handleOpenChangePassword
                        },
                        {
                          key: "logout",
                          icon: <LogoutOutlined />,
                          label: "退出登录",
                          onClick: handleLogout
                        }
                      ]
                    }}
                    trigger={["click"]}
                  >
                    <Button
                      aria-label={`用户：${currentUserName}，${currentUserDisplayName}`}
                      className="desktop-user-action"
                      type="text"
                    >
                      <span className="desktop-user-action-icon">
                        <UserOutlined />
                      </span>
                      <span className="desktop-user-action-copy">
                        <span className="desktop-user-action-name">{currentUserName}</span>
                        <span className="desktop-user-action-display">{currentUserDisplayName}</span>
                      </span>
                    </Button>
                  </Dropdown>
                ) : null}
              </Space>
            </Layout.Header>

            <Layout className="app-body" style={{ marginTop: HEADER_HEIGHT }}>
              {isDesktop ? (
                <Layout.Sider
                  className="app-sider"
                  collapsed={effectiveSidebarCollapsed}
                  collapsedWidth={SIDEBAR_COLLAPSED_WIDTH}
                  onMouseEnter={handleNavPanelEnter}
                  onMouseLeave={handleNavPanelLeave}
                  trigger={null}
                  width={SIDEBAR_WIDTH}
                >
                  <div className="app-sider-scroll" onScroll={handleNavScroll} ref={navScrollRef}>
                    {navMenu}
                  </div>
                  <div
                    aria-hidden="true"
                    className={`app-sider-scrollbar${
                      navPanelActive && navScrollbar.hasOverflow ? " is-visible" : ""
                    }`}
                  >
                    <div
                      className="app-sider-scrollbar-thumb"
                      style={{
                        height: navScrollbar.hasOverflow ? navScrollbar.thumbHeight : 0,
                        transform: `translateY(${navScrollbar.thumbTop}px)`
                      }}
                    />
                  </div>
                </Layout.Sider>
              ) : (
                <Drawer
                  onClose={() => setMobileMenuOpen(false)}
                  open={mobileMenuOpen}
                  placement="left"
                  title={currentNavMode === "workbench" ? "工作台菜单" : "管理中心菜单"}
                  width={SIDEBAR_WIDTH}
                >
                  {navMenu}
                </Drawer>
              )}

              <Layout.Content className="app-content" style={{ marginLeft: isDesktop ? sidebarWidth : 0 }}>
                <div className="workspace-breadcrumb">
                  {isDesktop ? (
                    <Tooltip title={effectiveSidebarCollapsed ? "展开导航" : "收起导航"} placement="bottom">
                      <button
                        aria-label={effectiveSidebarCollapsed ? "展开导航" : "收起导航"}
                        className="workspace-breadcrumb-toggle"
                        onClick={handleToggleSidebarCollapsed}
                        type="button"
                      >
                        {effectiveSidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                      </button>
                    </Tooltip>
                  ) : null}
                  <Breadcrumb className="workspace-breadcrumb-trail" items={breadcrumbItems} />
                </div>
                <Outlet />
              </Layout.Content>
            </Layout>

            {canSwitchWorkspace ? (
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
                        <Tag color={workspaceTypeColor(currentWorkspace.type)}>
                          {workspaceTypeLabel(currentWorkspace.type)}
                        </Tag>
                        <Tag color="green">当前</Tag>
                      </Space>
                      <Typography.Text type="secondary">{rolesLabel(currentWorkspace)}</Typography.Text>
                    </Space>
                  </Card>

                  <Input.Search
                    allowClear
                    onChange={(event) => setSwitcherSearch(event.target.value)}
                    placeholder="搜索工作区名称、类型或角色"
                    value={switcherSearch}
                  />

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
            ) : null}

            <Drawer
              destroyOnClose
              onClose={() => {
                setPasswordDrawerOpen(false);
                passwordForm.resetFields();
              }}
              open={passwordDrawerOpen}
              title="修改登录密码"
              width={isDesktop ? 420 : "94vw"}
              extra={
                <Space>
                  <Button
                    onClick={() => {
                      setPasswordDrawerOpen(false);
                      passwordForm.resetFields();
                    }}
                  >
                    取消
                  </Button>
                  <Button loading={passwordChanging} onClick={() => passwordForm.submit()} type="primary">
                    保存
                  </Button>
                </Space>
              }
            >
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Card size="small">
                  <Space direction="vertical" size={4}>
                    <Typography.Text strong>{currentUserName}</Typography.Text>
                    <Typography.Text type="secondary">修改后请使用新密码登录。当前会话不会立即退出。</Typography.Text>
                  </Space>
                </Card>
                <Form<ChangePasswordFormValues>
                  form={passwordForm}
                  layout="vertical"
                  onFinish={(values) => void handleChangePassword(values)}
                >
                  <Form.Item
                    label="当前密码"
                    name="currentPassword"
                    rules={[{ required: true, message: "请输入当前密码" }]}
                  >
                    <Input.Password autoComplete="current-password" placeholder="当前登录密码" />
                  </Form.Item>
                  <Form.Item
                    label="新密码"
                    name="newPassword"
                    rules={[
                      { required: true, message: "请输入新密码" },
                      { min: 6, message: "新密码至少 6 位" }
                    ]}
                  >
                    <Input.Password autoComplete="new-password" placeholder="至少 6 位" />
                  </Form.Item>
                  <Form.Item
                    dependencies={["newPassword"]}
                    label="确认新密码"
                    name="confirmPassword"
                    rules={[
                      { required: true, message: "请再次输入新密码" },
                      ({ getFieldValue }) => ({
                        validator(_, value) {
                          if (!value || getFieldValue("newPassword") === value) {
                            return Promise.resolve();
                          }
                          return Promise.reject(new Error("两次输入的新密码不一致"));
                        }
                      })
                    ]}
                  >
                    <Input.Password autoComplete="new-password" placeholder="再次输入新密码" />
                  </Form.Item>
                </Form>
              </Space>
            </Drawer>

            <Drawer
              className="desktop-network-log-drawer"
              onClose={() => setNetworkLogOpen(false)}
              open={networkLogOpen}
              title="网络日志"
              width={isDesktop ? 620 : "94vw"}
              extra={
                <Space>
                  <Button loading={networkLogLoading} onClick={() => void refreshNetworkLogs()} size="small">
                    刷新
                  </Button>
                  <Button
                    danger
                    icon={<ClearOutlined />}
                    loading={networkLogLoading}
                    onClick={() => void handleClearNetworkLogs()}
                    size="small"
                  >
                    清空
                  </Button>
                </Space>
              }
            >
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Typography.Text type="secondary">
                  最近 {networkLogSnapshot?.entries.length ?? 0} 条请求，最多保留 {networkLogSnapshot?.maxEntries ?? 300} 条。
                </Typography.Text>
                {networkLogSnapshot?.entries.length ? (
                  networkLogSnapshot.entries.map((entry) => (
                    <Card className="desktop-network-log-item" key={entry.id} size="small">
                      <Space direction="vertical" size={6} style={{ width: "100%" }}>
                        <Space wrap size={6}>
                          <Tag color="blue">{entry.method}</Tag>
                          <Tag color={networkLogStatusColor(entry.statusCode, entry.status)}>
                            {entry.status === "failed" ? entry.error ?? "FAILED" : entry.statusCode ?? "-"}
                          </Tag>
                          <Tag>{entry.resourceType}</Tag>
                          <Typography.Text type="secondary">{formatNetworkLogTime(entry.completedAt)}</Typography.Text>
                          {typeof entry.durationMs === "number" ? (
                            <Typography.Text type="secondary">{entry.durationMs}ms</Typography.Text>
                          ) : null}
                        </Space>
                        <Typography.Text className="desktop-network-log-url" copyable>
                          {formatNetworkLogUrl(entry.url)}
                        </Typography.Text>
                      </Space>
                    </Card>
                  ))
                ) : (
                  <Empty description="暂无网络日志。" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )}
              </Space>
            </Drawer>

            {locked ? (
              <div className="desktop-lock-overlay" role="dialog" aria-modal="true" aria-label="后台已锁屏">
                <Card className="desktop-lock-card">
                  <Space direction="vertical" size={16} style={{ width: "100%" }}>
                    <Space direction="vertical" size={4}>
                      <Typography.Title level={3}>已锁屏</Typography.Title>
                      <Typography.Text type="secondary">输入当前账号密码后继续使用。</Typography.Text>
                    </Space>
                    <Typography.Text className="desktop-lock-user">
                      <UserOutlined />
                      <span>{currentUserName}</span>
                    </Typography.Text>
                    <Input.Password
                      autoFocus
                      status={unlockError ? "error" : undefined}
                      onChange={(event) => {
                        setUnlockPassword(event.target.value);
                        if (unlockError) setUnlockError("");
                      }}
                      onPressEnter={() => void handleUnlock()}
                      placeholder="当前账号密码"
                      value={unlockPassword}
                    />
                    {unlockError ? (
                      <Typography.Text className="desktop-lock-error" role="alert" type="danger">
                        {unlockError}
                      </Typography.Text>
                    ) : null}
                    <Button block loading={unlocking} onClick={() => void handleUnlock()} type="primary">
                      解锁
                    </Button>
                  </Space>
                </Card>
              </div>
            ) : null}
          </Layout>
        </PermissionContextProvider>
      </WorkspaceContextProvider>
    </CurrentUserContextProvider>
  );
}
