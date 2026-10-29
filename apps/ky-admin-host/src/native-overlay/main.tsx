import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme } from "antd";
import { AppearanceContext, applyAppearance, appearanceAntdTheme, type AppearanceContextValue } from "@ky/admin-core";
import { NativePanels } from "./panels";
import { PersonalPreferencesDrawer } from "../personal-preferences-drawer";
import type { HostOverlayAction, HostOverlayProjection, HostOverlayPresentation, HostOverlayKind } from "../../../aicrm-desktop/src/shared/host-overlay";
import "antd/dist/reset.css";
const port = (window as unknown as {
    kyHostOverlay: {
        get(): Promise<HostOverlayPresentation>;
        dispatch(action: HostOverlayAction): Promise<boolean>;
        onProjection(listener: (value: HostOverlayPresentation) => void): () => void;
    };
}).kyHostOverlay;
function Presenter() {
    const [projection, setProjection] = useState<HostOverlayProjection | null>(null);
    const [kind, setKind] = useState<HostOverlayKind>("preferences");
    const sequence = useRef(0);
    const [error, setError] = useState("");
    useEffect(() => { let alive = true; const apply = (value: HostOverlayPresentation) => { if (alive && value.sequence >= sequence.current) {
        sequence.current = value.sequence;
        setKind(value.kind);
        setProjection(value.projection);
    } }; const unsubscribe = port.onProjection(apply); void port.get().then(apply).catch(() => setError("个人偏好暂不可用，请关闭后重试")); return () => { alive = false; unsubscribe(); }; }, []);
    useEffect(() => { if (projection) {
        applyAppearance(projection.themeId, projection.dark ? "dark" : "light");
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";
    } }, [projection?.themeId, projection?.dark]);
    if (!projection)
        return <div role="status">{error || "正在初始化个人偏好…"}</div>;
    const dispatch = (action: HostOverlayAction) => { void port.dispatch(action); };
    const value = { ...projection, choose: (themeId, mode) => dispatch({ type: "choose", themeId, mode }), followPlatform: () => dispatch({ type: "followPlatform" }), retry: () => dispatch({ type: "retry" }), refresh: async () => { await port.dispatch({ type: "refresh" }); }, reloadPlatform: async () => { } } as AppearanceContextValue;
    return <ConfigProvider theme={appearanceAntdTheme(projection.themeId, projection.dark)}><App><AppearanceContext.Provider value={value}>{kind === "preferences" ? <PersonalPreferencesDrawer open onClose={() => dispatch({ type: "close" })}/> : <NativePanels key={kind} kind={kind} projection={projection} dispatch={dispatch}/>}</AppearanceContext.Provider></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Presenter />);
