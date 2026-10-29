import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("version dialog has a dedicated sandbox preload in both build contracts", async () => {
  const [vite, build] = await Promise.all([
    read("apps/aicrm-desktop/electron.vite.config.ts"),
    read("scripts/desktop-plugins/build-preloads.mjs")
  ]);
  assert.match(vite, /"version-info-dialog":\s*"src\/preload\/version-info-dialog\.ts"/);
  assert.match(build, /'version-info-dialog'/);
});

test("native version dialog exposes only owner-scoped read and close channels", async () => {
  const [main, constants, preload] = await Promise.all([
    read("apps/aicrm-desktop/src/main/version-info-dialog.ts"),
    read("apps/aicrm-desktop/src/shared/constants.ts"),
    read("apps/aicrm-desktop/src/preload/version-info-dialog.ts")
  ]);
  assert.match(main, /scopedIpc\(\["main"\]/);
  assert.match(main, /scopedIpc\(\["version-dialog"\]/);
  assert.match(main, /controller\.ownerOf\(dialog\)/);
  assert.match(constants, /versionDialogOpen:\s*"version-dialog:open"/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("kyVersionDialog"/);
  assert.doesNotMatch(preload, /ipcRenderer\.send\(/);
});
