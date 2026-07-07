import { create } from "zustand";
import type { BootstrapState, CurrentUser, DesktopConfig, DesktopSession, LoginInput, WorkspaceIdentity } from "../../shared/types";
import { bootstrap, login } from "../services/auth-api";
import { getDesktopBridge } from "../services/desktop-bridge";

type BootStatus = "booting" | "ready";

interface SessionState {
  status: BootStatus;
  config: DesktopConfig | null;
  session: DesktopSession | null;
  user: CurrentUser | null;
  workspaces: WorkspaceIdentity[];
  error: string | null;
  boot: () => Promise<void>;
  signIn: (input: LoginInput) => Promise<BootstrapState>;
  signOut: () => Promise<void>;
  refreshBootstrap: () => Promise<BootstrapState | null>;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  status: "booting",
  config: null,
  session: null,
  user: null,
  workspaces: [],
  error: null,
  async boot() {
    try {
      const bridge = getDesktopBridge();
      const config = await bridge.app.getConfig();
      const session = await bridge.session.load();
      set({ config, session, status: "ready", error: null });
      if (session) {
        await get().refreshBootstrap();
      }
    } catch (error) {
      set({
        status: "ready",
        error: error instanceof Error ? error.message : "客户端初始化失败"
      });
    }
  },
  async signIn(input) {
    const bridge = getDesktopBridge();
    const config = get().config ?? (await bridge.app.getConfig());
    const result = await login(config, input);
    const session = { token: result.token, expiresAt: result.expiresAt };
    await bridge.session.save(session);
    const state = await bootstrap(config, session);
    set({ config, session, user: state.user, workspaces: state.workspaces, error: null });
    return state;
  },
  async signOut() {
    await getDesktopBridge().session.clear();
    set({ session: null, user: null, workspaces: [], error: null });
  },
  async refreshBootstrap() {
    const { config, session } = get();
    if (!config || !session) return null;
    const state = await bootstrap(config, session);
    set({ user: state.user, workspaces: state.workspaces, error: null });
    return state;
  }
}));
