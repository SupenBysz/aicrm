import {syncDesktopSession} from "../desktop-session-sync";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const pageRef=useRef<HTMLElement>(null);
  const activationRef=useRef("");
  const boundsSequence=useRef(0);
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
    if (!valid || !bridge || bridge.protocolVersion!==2 || !workspace || !menuKey || !directoryType) {
      if (!bridge) setError("请在桌面客户端中打开此菜单页面。");
      return;
    }
    let disposed = false;
    let currentId = "";
    let openedMode: "embedded" | "window" | "" = "";
    const earlyStates = new Map<string, MenuWebViewState>();
    const applyState = (next: MenuWebViewState) => {
      setState(previous => previous?.instanceId === next.instanceId && (previous.sequence ?? -1) > (next.sequence ?? -1) ? previous : next);
      if (next.status === "failed" && next.errorCode) setError(`页面加载或资源执行失败（${next.errorCode}）。`);
      if (next.status === "closed") { setOpenMode(""); setInstanceId(""); }
    };
    const unsubscribe = bridge.onChanged((event) => {
      if (disposed) return;
      if (!currentId) {
        if (earlyStates.size >= 32 && !earlyStates.has(event.instanceId)) earlyStates.delete(earlyStates.keys().next().value!);
        const previous=earlyStates.get(event.instanceId);
        if(!previous || (event.state.sequence??-1)>=(previous.sequence??-1))earlyStates.set(event.instanceId, event.state);
        return;
      }
      if (event.instanceId === currentId) applyState(event.state);
    });
    const open = async () => {
      setError("");
      setOpenMode("");
      setInstanceId("");
      setState({ instanceId: "", status: "loading", title: menuKey });
      await syncDesktopSession();
      if(disposed)return;
      const result = await bridge.open({
        directoryType,
        menuKey,
        workspaceType: workspace.type,
        workspaceId: workspace.id
      });
      if (disposed) {
        if (result.ok && result.data) void bridge.close({ instanceId: result.data.instanceId, activationId:result.data.activationId });
        return;
      }
      if (!result.ok || !result.data) {
        setState(null);
        setError(result.error?.message || "菜单权限或运行配置无法确认。");
        return;
      }
      if (result.data.protocolVersion !== 2 || !result.data.stateSnapshot) {
        setState(null); setError("当前客户端不支持菜单状态协议，请升级客户端后重试。"); return;
      }
      currentId = result.data.instanceId;
      activationRef.current=result.data.activationId; boundsSequence.current=0;
      openedMode = result.data.openMode;
      setInstanceId(currentId);
      setOpenMode(result.data.openMode);
      applyState(result.data.stateSnapshot);
      const early = earlyStates.get(currentId);
      if (early && (early.sequence ?? -1) > (result.data.stateSnapshot.sequence ?? -1)) applyState(early);
      earlyStates.clear();
    };
    void open().catch(error => { if (!disposed) { setState(null); setError(error instanceof Error ? error.message : "页面初始化失败，请重试。"); } });
    return () => {
      disposed = true;
      unsubscribe();
      if (currentId && openedMode === "embedded") void bridge.setBounds({ instanceId: currentId, activationId:activationRef.current,boundsSequence:++boundsSequence.current,x: 0, y: 0, width: 0, height: 0, visible: false });
    };
  }, [valid, bridge, workspace?.type, workspace?.id, directoryType, menuKey, attempt]);

  // Bind only after React has committed the embedded viewport. Opening the native
  // page and binding DOM geometry have independent lifecycles.
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!bridge || !instanceId || openMode !== "embedded" || !element) return;
    let frame = 0;
    let disposed = false;
    let lastVisible:boolean|undefined;
    let reopening=false;
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (disposed) return;
        const bounds=visibleBounds(element);
        const restoring=bounds.visible && lastVisible===false;
        lastVisible=bounds.visible;
        if(restoring && !reopening && workspace && menuKey && (directoryType==="management"||directoryType==="workbench")) {
          reopening=true;
          void bridge.open({directoryType,menuKey,workspaceType:workspace.type,workspaceId:workspace.id}).then(result=>{
            if(disposed)return;
            if(!result.ok || !result.data){setError(result.error?.message || "重新验证页面授权失败，请重试。");return;}
            activationRef.current=result.data.activationId;boundsSequence.current=0;
            setState(result.data.stateSnapshot);measure();
          }).catch(()=>setError("重新验证页面授权失败，请重试。")).finally(()=>{reopening=false;});
          return;
        }
        void bridge.setBounds({ instanceId,activationId:activationRef.current,boundsSequence:++boundsSequence.current,...bounds }).catch(() => {});
      });
    };
    const observer = new ResizeObserver(measure);
    const intersection = new IntersectionObserver(measure);
    const mutations = new MutationObserver(measure);
    observer.observe(element); intersection.observe(element);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) mutations.observe(parent, {attributes:true,attributeFilter:["class","style","hidden","aria-hidden","inert"]});
    window.addEventListener("resize",measure); window.addEventListener("scroll",measure,true); document.addEventListener("visibilitychange",measure);
    measure();
    return () => {
      disposed = true; observer.disconnect(); intersection.disconnect(); mutations.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize",measure); window.removeEventListener("scroll",measure,true); document.removeEventListener("visibilitychange",measure);
    };
  }, [bridge, instanceId, openMode]);

  useEffect(()=>{const refresh=()=>{if(pageRef.current&&visibleBounds(pageRef.current).visible)setAttempt(value=>value+1);};window.addEventListener("ky-native-unlocked",refresh);return()=>window.removeEventListener("ky-native-unlocked",refresh);},[]);

  const navigate = useCallback((command: "back" | "forward" | "reload") => {
    if (!instanceId || !bridge) return;
    void bridge.navigate({ instanceId,activationId:activationRef.current, command }).then((result) => {
      if (!result.ok) setError(result.error?.message || "页面操作失败。");
    });
  }, [instanceId, bridge]);

  if (!valid) return <Result status="error" title="菜单页面参数无效" />;
  if (!bridge) return <Result status="warning" title="请在桌面客户端打开" subTitle="浏览器版本不能承载受控菜单 WebView。" />;
  if(bridge.protocolVersion!==2)return <Result status="warning" title="请升级桌面客户端" subTitle="当前客户端不支持菜单状态协议，尚未打开网页。"/>;
  const title = state?.title || menuKey;
  return <section ref={pageRef} className="menu-webview-page" aria-label={title} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
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
    {openMode === "window" ? <div className="menu-webview-window-state"><Result status="success" title="已在独立窗口打开" subTitle={title} extra={<Button onClick={() => instanceId && bridge.close({ instanceId,activationId:activationRef.current })}>关闭独立窗口</Button>} /></div> : null}
    {!openMode && !error ? <div className="menu-webview-placeholder"><Space orientation="vertical" align="center"><Spin/><Typography.Text type="secondary">正在验证菜单权限并准备页面…</Typography.Text></Space></div> : null}
    {openMode === "embedded" ? <div ref={viewportRef} className="menu-webview-viewport" aria-label={`${title}网页内容`} style={{ flex: 1, minHeight: 180, position: "relative", overflow: "hidden", background: "var(--admin-content-bg, #f5f5f5)" }}>{state?.status === "loading" ? <div className="menu-webview-placeholder"><Space orientation="vertical" align="center"><Spin/><Typography.Text type="secondary">正在初始化网页内容…</Typography.Text></Space></div> : null}</div> : null}
    {state?.status === "failed" && !error ? <Result status="error" title="页面暂不可用" extra={<Button onClick={() => setAttempt((value) => value + 1)}>重试</Button>} /> : null}
  </section>;
}
