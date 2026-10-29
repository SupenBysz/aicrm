import { createElement, createContext, useCallback, useMemo, useRef, type ReactNode } from "react";
import { App as AntdApp, ConfigProvider } from "antd";
import { UNSAFE_LocationContext, type Location, type NavigationType } from "react-router-dom";
import type { WorkspaceArea, WorkspaceAreaRouteSnapshot } from "./workspace-area-route-cache";

export const BusinessWebPageAreaVisibilityContext = createContext(true);

export function WorkspaceAreaRoutePaneFrame({
  area,
  active,
  children
}: {
  area: WorkspaceArea;
  active: boolean;
  children?: ReactNode;
}) {
  return createElement(
    "div",
    { className: "workspace-area-route-pane", "data-workspace-area": area, hidden: !active, "aria-hidden": !active },
    createElement(BusinessWebPageAreaVisibilityContext.Provider, { value: active }, children)
  );
}

export function WorkspaceAreaRoutePane({
  area,
  active,
  snapshot
}: {
  area: WorkspaceArea;
  active: boolean;
  snapshot: WorkspaceAreaRouteSnapshot<ReactNode> | null;
}) {
  const overlayRootRef = useRef<HTMLDivElement | null>(null);
  const getPopupContainer = useCallback(() => overlayRootRef.current ?? document.body, []);
  const locationContextValue = useMemo(() => snapshot ? {
    location: snapshot.location as Location,
    navigationType: snapshot.navigationType as NavigationType
  } : null, [snapshot?.location, snapshot?.navigationType]);
  return createElement(WorkspaceAreaRoutePaneFrame, { area, active },
    createElement(
      ConfigProvider,
      { getPopupContainer },
      createElement("div", { className: "workspace-area-route-overlay-root", ref: overlayRootRef }),
      createElement(
        AntdApp,
        { component: false },
        snapshot
          ? createElement(
              UNSAFE_LocationContext.Provider,
                { value: locationContextValue! },
              snapshot.node
            )
          : null
      )
    )
  );
}
