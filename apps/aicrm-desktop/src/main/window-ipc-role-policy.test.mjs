import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { IPC_CHANNELS } from "../shared/constants.ts";
import { legacyWindowChannelRoles } from "./window-ipc-role-policy.ts";

test("离线发送方仅能读取窗口状态，不能操作窗口", () => {
  assert.deepEqual(legacyWindowChannelRoles(IPC_CHANNELS.windowGetState), ["main", "terminal", "offline"]);
  for (const channel of [IPC_CHANNELS.windowMinimize, IPC_CHANNELS.windowToggleMaximize, IPC_CHANNELS.windowClose]) {
    assert.deepEqual(legacyWindowChannelRoles(channel), ["main", "terminal"]);
  }
});

test("guardedIpc 仅将精确的窗口状态读取通道扩展到 offline 角色", async () => {
  const source = await readFile(new URL("./guarded-ipc.ts", import.meta.url), "utf8");
  const policy = await readFile(new URL("./window-ipc-role-policy.ts", import.meta.url), "utf8");
  assert.match(source, /windowChannels\.has\(channel\)\s*\?\s*legacyWindowChannelRoles\(channel\)/);
  assert.match(policy, /if \(channel === IPC_CHANNELS\.windowGetState\) return \["main", "terminal", "offline"\]/);
  assert.doesNotMatch(source, /\["main", "terminal", "controlled", "offline"\]/);
});
