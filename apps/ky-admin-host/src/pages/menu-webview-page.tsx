import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Result, Space, Spin, Typography } from "antd";
import { useParams } from "react-router-dom";
import { useCurrentWorkspace } from "@ky/admin-core";
import { getDesktopBridge } from "../desktop-client";
import type { MenuWebViewState } from "../../../aicrm-desktop/src/shared/types";

function visibleBounds(element: HTMLElement): { x: number; y: number; width: number; height: number; visible: boolean } {
  const rect = element.getBoundingClientRect();
  let visible = document.visibilityState === "visible";
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || node.hidden || node.inert || node.getAttribute("aria-hidden") === "true") visible = false;
  }
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(window.innerWidth, rect.right);
  let bottom = Math.min(window.innerHeight, rect.bottom);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) {
      const clip = parent.getBoundingClientRect();
      left = Math.max(left, clip.left + parent.clientLeft);
      top = Math.max(top, clip.top + parent.clientTop);
      right = Math.min(right, clip.left + parent.clientLeft + parent.clientWidth);
      bottom = Math.min(bottom, clip.top + parent.clientTop + parent.clientHeight);
    }
  }
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return { x: left, y: top, width, height, visible: visible && width >= 1 && height >= 1 };
}

export function MenuWebViewPage() {
  const { directoryType, menuKey } = useParams();
  const workspace = useCurrentWorkspace();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [instanceId, setInstanceId] = useState("");
  const [openMode, setOpenMode] = useState<"embedded" | "window" | "">("");
  const [state, setState] = useState<MenuWebViewState | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const valid = (directoryType === "management" || directoryType === "workbench")
    && /^[a-z][a-z0-9_.-]{0,127}$/.test(menuKey ?? "")
    && Boolean(workspace?.id && workspace?.type);
  const bridge = getDesktopBridge()?.menuWebView;

  useEffect(() => {
    if (!valid || !bridge || !workspace || !menuKey || !directoryType) {
      if (!bridge) setError("请在桌面客户端中打开此菜单页面。");
      return;
    }
    let disposed = false;
    let currentId = "";
    let openedMode: "embedded" | "window" | "" = "";
    let observer: ResizeObserver | null = null;
    let intersection: IntersectionObserver | null = null;
    let mutations: MutationObserver | null = null;
    let frame = 0;
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const element = viewportRef.current;
        if (!element || !currentId || disposed) return;
        const bounds = visibleBounds(element);
        void bridge.setBounds({ instanceId: currentId, ...bounds });
      });
    };
    const unsubscribe = bridge.onChanged((event) => {
      if (event.instanceId !== currentId || disposed) return;
      setState(event.state);
      if (event.state.status === "failed" && event.state.errorCode) {
        setError(`页面加载或资源执行失败（${event.state.errorCode}）。`);
      }
      if (event.state.status === "closed") { setOpenMode(""); setInstanceId(""); }
    });
    const open = async () => {
      setError("");
      setOpenMode("");
      setInstanceId("");
      setState({ instanceId: "", status: "loading", title: menuKey });
      const result = await bridge.open({
        directoryType,
        menuKey,
        workspaceType: workspace.type,
        workspaceId: workspace.id
      });
      if (disposed) {
        if (result.ok && result.data) void bridge.close({ instanceId: result.data.instanceId });
        return;
      }
      if (!result.ok || !result.data) {
        setState(null);
        setError(result.error?.message || "菜单权限或运行配置无法确认。");
        return;
      }
      currentId = result.data.instanceId;
      openedMode = result.data.openMode;
      setInstanceId(currentId);
      setOpenMode(result.data.openMode);
      setState({ instanceId: currentId, status: "loading", title: result.data.title || menuKey });
      if (result.data.openMode === "embedded") {
        observer = new ResizeObserver(measure);
        intersection = new IntersectionObserver(measure);
        mutations = new MutationObserver(measure);
        if (viewportRef.current) {
          observer.observe(viewportRef.current);
          intersection.observe(viewportRef.current);
          for (let parent = viewportRef.current.parentElement; parent; parent = parent.parentElement) mutations.observe(parent, { attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "inert"] });
        }
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        document.addEventListener("visibilitychange", measure);
        measure();
      }
    };
    void open();
    return () => {
      disposed = true;
      unsubscribe();
      observer?.disconnect();
      intersection?.disconnect();
      mutations?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      document.removeEventListener("visibilitychange", measure);
      if (currentId && openedMode === "embedded") void bridge.setBounds({ instanceId: currentId, x: 0, y: 0, width: 0, height: 0, visible: false });
    };
  }, [valid, bridge, workspace?.type, workspace?.id, directoryType, menuKey, attempt]);

  const navigate = useCallback((command: "back" | "forward" | "reload") => {
    if (!instanceId || !bridge) return;
    void bridge.navigate({ instanceId, command }).then((result) => {
      if (!result.ok) setError(result.error?.message || "页面操作失败。");
    });
  }, [instanceId, bridge]);

  if (!valid) return <Result status="error" title="菜单页面参数无效" />;
  if (!bridge) return <Result status="warning" title="请在桌面客户端打开" subTitle="浏览器版本不能承载受控菜单 WebView。" />;
  const title = state?.title || menuKey;
  return <section className="menu-webview-page" aria-label={title} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "4px 0 10px" }}>
      <Space>
        <Button size="small" disabled={!instanceId} onClick={() => navigate("back")}>后退</Button>
        <Button size="small" disabled={!instanceId} onClick={() => navigate("forward")}>前进</Button>
        <Button size="small" disabled={!instanceId} onClick={() => navigate("reload")}>刷新</Button>
      </Space>
      <Typography.Text type="secondary" ellipsis style={{ maxWidth: "45%" }}>{state?.url || ""}</Typography.Text>
      <Button size="small" disabled={!instanceId} onClick={() => setAttempt((value) => value + 1)}>重新打开</Button>
    </div>
    {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}
    {state?.errorCode === "resource_injection_failed" ? <Alert type="warning" showIcon message="页面已打开，但有绑定资源执行失败；其余资源仍会独立运行。" style={{ marginBottom: 8 }} /> : null}
    {openMode === "window" ? <div className="menu-webview-window-state"><Result status="success" title="已在独立窗口打开" subTitle={title} extra={<Button onClick={() => instanceId && bridge.close({ instanceId })}>关闭独立窗口</Button>} /></div> : null}
    {!openMode && !error ? <div className="menu-webview-placeholder"><Spin tip="正在验证菜单权限并准备页面…" /></div> : null}
    {openMode === "embedded" ? <div ref={viewportRef} className="menu-webview-viewport" aria-label={`${title}网页内容`} style={{ flex: 1, minHeight: 180, position: "relative", overflow: "hidden" }} /> : null}
    {state?.status === "failed" && !error ? <Result status="error" title="页面暂不可用" extra={<Button onClick={() => setAttempt((value) => value + 1)}>重试</Button>} /> : null}
  </section>;
}
