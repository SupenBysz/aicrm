import { BrowserWindow } from "electron";
import { join } from "node:path";
import { DESKTOP_APPLICATION_VERSION, IPC_CHANNELS } from "../shared/constants";
import { registerSender, scopedIpc } from "./guarded-ipc";
import { createVersionDialogController, type VersionDialogTheme } from "./version-info-dialog-controller";
import { storedNativeTheme } from "./window-appearance";

const markup = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color-scheme:light;--surface:rgba(255,252,247,.98);--text:#34281a;--muted:#66563f;--stroke:rgba(90,70,40,.2)}:root[data-theme=dark]{color-scheme:dark;--surface:rgba(17,19,23,.97);--text:#f2f3f5;--muted:#b9bdc5;--stroke:rgba(255,255,255,.16)}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:var(--text);font:13px/1.5 system-ui,sans-serif}.veil{position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.16)}main{width:min(360px,calc(100vw - 32px));padding:16px;border:1px solid var(--stroke);border-radius:12px;background:var(--surface);box-shadow:0 16px 44px #0003}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:14px}button{border:0;background:transparent;color:var(--muted);font-size:22px;cursor:pointer}dl{margin:0}dl div{display:flex;justify-content:space-between;gap:12px;padding:5px 0}dt{color:var(--muted)}dd{margin:0;text-align:right}#error{display:none;color:var(--muted)}
</style></head><body><div class="veil" data-veil><main role="dialog" aria-modal="true" aria-label="客户端版本信息"><header><strong>客户端版本信息</strong><button data-close aria-label="关闭">×</button></header><dl><div><dt>客户端版本</dt><dd id="client">—</dd></div><div><dt>插件版本</dt><dd id="plugin">—</dd></div><div><dt>运行阶段</dt><dd id="phase">—</dd></div></dl><p id="error" role="status"></p></main></div></body></html>`;
const dialogURL = `data:text/html;charset=utf-8,${encodeURIComponent(markup)}`;
const ownerByDialog = new WeakMap<BrowserWindow, BrowserWindow>();
let currentTheme: VersionDialogTheme = "light";

function position(parent: BrowserWindow, dialog: BrowserWindow): void {
  if (!parent.isDestroyed() && !dialog.isDestroyed()) {
    const bounds = parent.getContentBounds();
    dialog.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }
}

const controller = createVersionDialogController<BrowserWindow, BrowserWindow>({
  parentAlive: (parent) => !parent.isDestroyed(),
  dialogAlive: (dialog) => !dialog.isDestroyed(),
  create: (parent) => {
    const bounds = parent.getContentBounds();
    const dialog = new BrowserWindow({ parent, modal: false, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, resizable: false,
      minimizable: false, maximizable: false, autoHideMenuBar: true, show: false,
      webPreferences: { preload: join(__dirname, "../preload/version-info-dialog.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false }
    });
    ownerByDialog.set(dialog, parent);
    const unregister = registerSender(dialog.webContents, "version-dialog", (url) => url === dialogURL);
    dialog.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    dialog.webContents.on("will-navigate", (event, url) => { if (url !== dialogURL) event.preventDefault(); });
    dialog.webContents.on("will-redirect", (event, url) => { if (url !== dialogURL) event.preventDefault(); });
    dialog.once("closed", unregister);
    dialog.once("ready-to-show", () => { if (!parent.isDestroyed() && !dialog.isDestroyed()) { position(parent, dialog); dialog.show(); dialog.focus(); } });
    void dialog.loadURL(dialogURL).catch(() => { if (!dialog.isDestroyed()) dialog.close(); });
    return dialog;
  },
  focus: (dialog) => { if (dialog.isVisible()) dialog.focus(); },
  close: (dialog) => dialog.close(),
  setTheme: (dialog, theme) => { if (!dialog.isDestroyed() && !dialog.webContents.isDestroyed()) dialog.webContents.send(IPC_CHANNELS.versionDialogThemeChanged, theme); },
  onDialogClosed: (dialog, listener) => { dialog.once("closed", listener); return () => dialog.removeListener("closed", listener); },
  onParentClosed: (parent, listener) => {
    const reposition = () => { const dialog = dialogs.get(parent); if (dialog) position(parent, dialog); };
    parent.once("closed", listener); parent.on("move", reposition); parent.on("resize", reposition);
    return () => { parent.removeListener("closed", listener); parent.removeListener("move", reposition); parent.removeListener("resize", reposition); };
  }
});
// Keep the owner lookup in one weak index for sender authorization. Controller owns lifecycle.
const dialogs = new WeakMap<BrowserWindow, BrowserWindow>();
const originalCreate = controller.open;
const openDialog = (parent: BrowserWindow) => {
  const dialog = originalCreate(parent);
  if (dialog) { dialogs.set(parent, dialog); position(parent, dialog); }
  return dialog;
};

const mainIpc = scopedIpc(["main"], (args) => args.length === 0);
mainIpc.handle(IPC_CHANNELS.versionDialogOpen, (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed() || owner.webContents !== event.sender) return false;
  return openDialog(owner) !== null;
});
const dialogIpc = scopedIpc(["version-dialog"], (args) => args.length === 0);
dialogIpc.handle(IPC_CHANNELS.versionDialogGetInfo, async (event) => {
  const dialog = BrowserWindow.fromWebContents(event.sender);
  if (!dialog || controller.ownerOf(dialog) === null || ownerByDialog.get(dialog) !== controller.ownerOf(dialog)) throw new Error("permission_denied");
  const { getPluginHost } = await import("./desktop-plugin-host/host");
  const snapshot = getPluginHost()?.snapshot();
  return { clientVersion: `v${DESKTOP_APPLICATION_VERSION}`, pluginVersion: snapshot?.pluginVersion ?? "—", runtimePhase: snapshot?.phase ?? "—", theme: currentTheme };
});
dialogIpc.handle(IPC_CHANNELS.versionDialogClose, (event) => {
  const dialog = BrowserWindow.fromWebContents(event.sender);
  return dialog ? controller.closeDialog(dialog) : false;
});

export function registerVersionDialogIpc(): void { currentTheme = storedNativeTheme(); }
export function setVersionDialogTheme(value: unknown): boolean {
  if (value !== "light" && value !== "dark") return false;
  currentTheme = value;
  controller.setTheme(value);
  return true;
}
