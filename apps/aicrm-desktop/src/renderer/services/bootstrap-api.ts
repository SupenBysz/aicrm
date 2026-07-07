import type { BootstrapState, DesktopConfig, DesktopSession } from "../../shared/types";
import { bootstrap } from "./auth-api";

export function loadBootstrap(config: DesktopConfig, session: DesktopSession): Promise<BootstrapState> {
  return bootstrap(config, session);
}
