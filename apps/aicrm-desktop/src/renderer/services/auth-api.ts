import type { BootstrapState, DesktopConfig, DesktopSession, LoginInput, LoginResult } from "../../shared/types";
import { request } from "./request-client";

export function login(config: DesktopConfig, input: LoginInput): Promise<LoginResult> {
  return request<LoginResult>(config, null, "/api/v1/auth/login", { method: "POST", body: input });
}

export function bootstrap(config: DesktopConfig, session: DesktopSession): Promise<BootstrapState> {
  return request<BootstrapState>(config, session, "/api/v1/auth/bootstrap");
}
