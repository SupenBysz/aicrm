import { createContext, useContext, type PropsWithChildren } from "react";
import type { WorkspaceIdentity } from "./index";

const WorkspaceContext = createContext<WorkspaceIdentity | null>(null);

export function WorkspaceContextProvider({
  children,
  workspace
}: PropsWithChildren<{ workspace: WorkspaceIdentity | null }>) {
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}

export function useCurrentWorkspace() {
  return useContext(WorkspaceContext);
}
