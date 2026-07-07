import { Navigate, useParams } from "react-router-dom";
import { loadBootstrap, selectWorkspace } from "../app-store";
import { pickWorkspace } from "../remote-api";

export function WorkbenchPage() {
  const params = useParams();
  const bootstrap = loadBootstrap();
  const workspace = pickWorkspace(bootstrap?.workspaces ?? [], params.workspaceType, params.workspaceId);

  if (!workspace) {
    return <Navigate to="/workspace/select" replace />;
  }
  selectWorkspace(workspace);

  return <div className="content-stack" data-workbench-section={params.section ?? "overview"} />;
}
