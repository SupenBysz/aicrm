import { IPC_CHANNELS } from "../shared/constants.ts";

export type WindowIpcRole = "main" | "terminal" | "offline";

export function legacyWindowChannelRoles(channel: string): readonly WindowIpcRole[] {
  if (channel === IPC_CHANNELS.windowGetState) return ["main", "terminal", "offline"];
  return ["main", "terminal"];
}
