import { App as AntdApp, ConfigProvider, Spin, Typography } from "antd";
import { useEffect } from "react";
import { HashRouter } from "react-router-dom";
import { AppRoutes } from "./routes";
import { useSessionStore } from "./stores/session-store";

export function App() {
  const status = useSessionStore((state) => state.status);
  const error = useSessionStore((state) => state.error);
  const boot = useSessionStore((state) => state.boot);

  useEffect(() => {
    void boot();
  }, [boot]);

  if (status === "booting") {
    return (
      <div className="desktop-boot">
        <Spin />
        <Typography.Text type="secondary">正在启动 AiCRM Desktop...</Typography.Text>
      </div>
    );
  }

  return (
    <ConfigProvider theme={{ token: { colorPrimary: "#1677ff", borderRadius: 8 } }}>
      <AntdApp>
        {error ? <div className="desktop-error">{error}</div> : null}
        <HashRouter>
          <AppRoutes />
        </HashRouter>
      </AntdApp>
    </ConfigProvider>
  );
}
