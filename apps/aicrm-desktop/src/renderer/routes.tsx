import { Navigate, Route, Routes } from "react-router-dom";
import type { ReactElement } from "react";
import { DashboardPage } from "./pages/dashboard-page";
import { LoginPage } from "./pages/login-page";
import { SettingsPage } from "./pages/settings-page";
import { WorkspaceSelectPage } from "./pages/workspace-select-page";
import { useSessionStore } from "./stores/session-store";

function RequireSession({ children }: { children: ReactElement }) {
  const session = useSessionStore((state) => state.session);
  if (!session) return <Navigate to="/login" replace />;
  return children;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/workspaces"
        element={
          <RequireSession>
            <WorkspaceSelectPage />
          </RequireSession>
        }
      />
      <Route
        path="/dashboard"
        element={
          <RequireSession>
            <DashboardPage />
          </RequireSession>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireSession>
            <SettingsPage />
          </RequireSession>
        }
      />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
