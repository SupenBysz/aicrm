import type { ReactNode } from "react";
import { DesktopPluginSlot } from "./desktop-plugin-slot";
import { isDesktopClientMode } from "./desktop-client";

/** 所有客户端页面共用底栏；浏览器不增加布局或原生查询。 */
export function DesktopClientFrame({ children }: { children: ReactNode }) {
  if (!isDesktopClientMode()) return <>{children}</>;

  return (
    <div className="desktop-client-frame">
      {children}
      <footer className="desktop-status-bar" aria-label="客户端状态栏" role="status">
        <DesktopPluginSlot />
      </footer>
    </div>
  );
}
