import { create } from "zustand";
import type { WorkspaceIdentity } from "../../shared/types";

interface WorkspaceState {
  currentWorkspace: WorkspaceIdentity | null;
  selectWorkspace: (workspace: WorkspaceIdentity | null) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  currentWorkspace: null,
  selectWorkspace: (workspace) => set({ currentWorkspace: workspace })
}));
