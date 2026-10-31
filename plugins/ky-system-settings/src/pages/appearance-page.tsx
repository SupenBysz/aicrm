import { useEffect, useRef, useState, type CSSProperties } from "react";
import { App, Button, Empty, Segmented, Space, Tooltip, Typography } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { AppearanceControls, DEFAULT_APPEARANCE, ListPageCard, themeVariables, useAppearance, useCurrentUser, validAppearance, usePermissions, useRequestClient, type AppearanceValue } from "@ky/admin-core";
import "./appearance-page.css";
/** Draft selection changes only the preview; platform settings change on save. */
export function AppearancePage() {
    const appearance = useAppearance(), client = useRequestClient(), permission = usePermissions();
    const { message, modal } = App.useApp(), user = useCurrentUser();
    const key = "ky.appearance.platform-draft.v1:" + (user?.id ?? "anonymous");
    const [initial] = useState(() => { try {
        const v = JSON.parse(sessionStorage.getItem(key) ?? "null");
        return validAppearance(v) ? v : null;
    }
    catch {
        return null;
    } });
    const [previewing, setPreviewing] = useState(false);
    const [draft, setDraft] = useState<AppearanceValue>(initial ?? appearance.platform), [edited, setEdited] = useState(!!initial), [saving, setSaving] = useState(false), [previewDark, setPreviewDark] = useState(false);
    useEffect(() => { appearance.previewPlatform?.(previewing ? draft : null); return () => appearance.previewPlatform?.(null); }, [draft, previewing, appearance.previewPlatform]);
    useEffect(() => { setPreviewDark(draft.mode === "dark" || (draft.mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches)); }, [appearance.dark, draft.mode]);
    const inFlight = useRef(false);
    const canUpdate = permission.can("platform.appearance.update");
    useEffect(() => { if (!edited)
        setDraft(appearance.platform); }, [appearance.platform, edited]);
    useEffect(() => {
        try {
            if (edited)
                sessionStorage.setItem(key, JSON.stringify(draft));
            else
                sessionStorage.removeItem(key);
        }
        catch { /* Preserve the in-memory draft. */ }
        const guard = (e: BeforeUnloadEvent) => { if (edited) {
            e.preventDefault();
            e.returnValue = "";
        } };
        window.addEventListener("beforeunload", guard);
        return () => window.removeEventListener("beforeunload", guard);
    }, [key, draft, edited]);
    async function save() {
        if (!canUpdate || !edited || inFlight.current)
            return;
        inFlight.current = true;
        setSaving(true);
        try {
            const v = await client.request<AppearanceValue>("/api/v1/platform/appearance", { method: "PUT", body: draft });
            await appearance.reloadPlatform(v);
            setDraft(v);
            setEdited(false);
            setPreviewing(false);
            void message.success("外观设置已保存。");
        }
        catch (error) {
            const conflict = !!error && typeof error === "object" && "code" in error && error.code === "appearance_conflict";
            if (conflict)
                modal.confirm({ title: "外观设置已更新", content: "其他管理员已保存新的设置。是否读取最新设置？当前修改将被替换。", okText: "读取最新设置", cancelText: "保留修改", onOk: reload });
            else
                void message.error("暂时无法保存，修改内容已保留。");
        }
        finally {
            inFlight.current = false;
            setSaving(false);
        }
    }
    async function reload() {
        if (inFlight.current)
            return;
        inFlight.current = true;
        setSaving(true);
        try {
            const latest = await client.request<AppearanceValue>("/api/v1/platform/appearance");
            await appearance.reloadPlatform(latest);
            setDraft(latest);
            setEdited(false);
            setPreviewing(false);
        }
        catch {
            void message.error("暂时无法读取，修改内容已保留。");
        }
        finally {
            inFlight.current = false;
            setSaving(false);
        }
    }
    const change = (themeId: AppearanceValue['themeId'], mode: AppearanceValue['mode']) => { setPreviewing(true); setDraft({ ...draft, themeId, mode }); setEdited(themeId !== appearance.platform.themeId || mode !== appearance.platform.mode); };
    if (!permission.can("platform.appearance.view"))
        return <Empty description="暂无外观设置查看权限"/>;
    if (!appearance.enabled)
        return <Empty description="暂不可配置外观"/>;
    return <div className="platform-appearance-page"><ListPageCard title="外观主题" subtitle="设置平台默认配色与明暗模式" extra={<Space wrap>
  <Tooltip title="适用于未登录页面及跟随平台设置的用户，个人偏好保持独立。"><Button type="text" aria-label="外观设置适用范围" icon={<QuestionCircleOutlined />}/></Tooltip>
  {canUpdate && <><Button disabled={saving} onClick={() => modal.confirm({ title: "恢复默认外观？", content: "预览将恢复为经典金并跟随系统，保存后生效。", okText: "恢复默认", cancelText: "取消", onOk: () => change(DEFAULT_APPEARANCE.themeId, DEFAULT_APPEARANCE.mode) })}>恢复默认</Button><Button type="primary" loading={saving} disabled={!edited} onClick={() => void save()}>保存设置</Button></>}
 </Space>}>
 <div className="platform-appearance">
  <AppearanceControls label="平台默认" disabled={!canUpdate || saving} themeId={draft.themeId || "classic-gold"} mode={draft.mode || "system"} onChange={change}/>
  <section className="platform-appearance-preview">
   <div className="platform-appearance-preview-title"><Typography.Text strong>界面预览</Typography.Text><Segmented aria-label="预览明暗" value={previewDark ? "dark" : "light"} options={[{ label: "亮色", value: "light" }, { label: "暗色", value: "dark" }]} onChange={v => setPreviewDark(v === "dark")}/></div>
   <div className="appearance-window" style={{ ...themeVariables(draft.themeId, previewDark), color: "var(--admin-text)", colorScheme: previewDark ? "dark" : "light" } as CSSProperties} role="img" aria-label={`${previewDark ? "暗色" : "亮色"}界面效果`}>
    <div className="appearance-window-header"><span style={{ color: "var(--admin-accent)", fontWeight: 600 }}>管理中心</span></div>
    <div className="appearance-window-content"><div className="appearance-window-nav"><span>系统设置</span><span>通知中心</span><span>身份管理</span></div><div className="appearance-window-body">
     <div className="appearance-window-toolbar"><strong>通知设置</strong><span style={{ background: "var(--admin-accent)", color: "var(--admin-on-primary)", padding: "7px 14px", borderRadius: 6 }}>保存设置</span></div>
     <span className="appearance-window-field">系统通知</span>
     <div className="appearance-window-row"><span>消息通知</span><span style={{ color: "var(--admin-accent)" }}>已开启</span></div><div className="appearance-window-row"><span>账号安全</span><span>已开启</span></div>
    </div></div>
   </div>
  </section>
 </div>
 </ListPageCard></div>;
}
