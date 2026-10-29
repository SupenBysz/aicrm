import { useEffect, useState } from "react";
import { getDesktopBridge } from "./desktop-client";
import { Button } from "antd";

/** 通过既有 preload 查询应用版本，不读取浏览器或 Electron 引擎版本。 */
export function ClientVersion() {
  const [label, setLabel] = useState("读取中…");

  useEffect(() => {
    let active = true;
    async function loadVersion() {
      try {
        const version = await getDesktopBridge()?.app?.getVersion?.();
        const normalizedVersion = version?.trim().replace(/^v+/i, "").trim();
        if (active) setLabel(normalizedVersion ? `v${normalizedVersion}` : "暂不可用");
      } catch {
        if (active) setLabel("暂不可用");
      }
    }
    void loadVersion();
    return () => { active = false; };
  }, []);

  return <Button type="text" size="small" className="client-version" title={`客户端版本：${label}`} onClick={(event) => { const rect=event.currentTarget.getBoundingClientRect(); void getDesktopBridge()?.app?.openVersionDialog?.({x:rect.x,y:rect.y,width:rect.width,height:rect.height}).catch(() => {}); }}>{label}</Button>;
}
