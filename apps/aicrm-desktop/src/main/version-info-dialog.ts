import { BrowserWindow } from "electron";
import { join } from "node:path";
import { DESKTOP_APPLICATION_VERSION, IPC_CHANNELS } from "../shared/constants";
import { registerSender, scopedIpc } from "./guarded-ipc";
import { createVersionDialogController, type VersionDialogTheme } from "./version-info-dialog-controller";
import { storedNativeTheme, storedNativeThemeId } from "./window-appearance";

const markup = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color-scheme:light;--surface:rgba(255,252,247,.98);--text:#34281a;--muted:#66563f;--stroke:rgba(90,70,40,.2)}:root[data-theme=dark]{color-scheme:dark;--surface:rgba(17,19,23,.97);--text:#f2f3f5;--muted:#b9bdc5;--stroke:rgba(255,255,255,.16)}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:var(--text);font:13px/1.5 system-ui,sans-serif}.veil{position:fixed;inset:0;display:flex;align-items:stretch;padding:8px;background:transparent}main{width:100%;padding:16px;border:1px solid var(--stroke);border-radius:12px;background:var(--surface);box-shadow:0 16px 44px #0003}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:14px}button{outline:none;box-shadow:none;border:0;background:transparent;color:var(--muted);font-size:22px;cursor:pointer}dl{margin:0}dl div{display:flex;justify-content:space-between;gap:12px;padding:5px 0}dt{color:var(--muted)}dd{margin:0;text-align:right}#error{display:none;color:var(--muted)}
:root[data-palette=business-blue]{--surface:#fbfdff;--text:#1f3048;--muted:#68788e;--stroke:#d8e3f0}:root[data-palette=business-blue][data-theme=dark]{--surface:#101e30;--text:#edf4ff;--muted:#a6b7cc;--stroke:#30445e}:root[data-palette=jade-green]{--surface:#fbfffc;--text:#1c4030;--muted:#557460;--stroke:#d2e5d9}:root[data-palette=jade-green][data-theme=dark]{--surface:#10231a;--text:#edf8f1;--muted:#a2bdae;--stroke:#304e3c}:root[data-palette=graphite-cyan]{--surface:#ffffff;--text:#202428;--muted:#667078;--stroke:#dce2e5}:root[data-palette=graphite-cyan][data-theme=dark]{--surface:#303030;--text:#f3f3f3;--muted:#ababab;--stroke:#3a3a3a}:root[data-palette=violet-dusk]{--surface:#fcfbfe;--text:#29243a;--muted:#706a80;--stroke:#ddd7eb}:root[data-palette=violet-dusk][data-theme=dark]{--surface:#282432;--text:#f4f0ff;--muted:#bcb5cd;--stroke:#40394f}:root[data-palette=terracotta]{--surface:#fffaf7;--text:#34251f;--muted:#79645d;--stroke:#ead8d1}:root[data-palette=terracotta][data-theme=dark]{--surface:#2d1f1b;--text:#fff1eb;--muted:#c8aaa0;--stroke:#50372f}:root[data-palette=sky-mist]{--surface:#fbfdff;--text:#243546;--muted:#617487;--stroke:#d6e2eb}:root[data-palette=sky-mist][data-theme=dark]{--surface:#222e39;--text:#f0f6fb;--muted:#aebdca;--stroke:#364754}:root[data-palette=pine-forest]{--surface:#fbfdfb;--text:#28392d;--muted:#657769;--stroke:#d8e3d9}:root[data-palette=pine-forest][data-theme=dark]{--surface:#222f26;--text:#f0f7f0;--muted:#b1c2b4;--stroke:#394a3d}:root[data-palette=camellia-red]{--surface:#fdf9fa;--text:#39272b;--muted:#7b6569;--stroke:#e8d7da}:root[data-palette=camellia-red][data-theme=dark]{--surface:#2e2025;--text:#fff0f1;--muted:#c8aeb2;--stroke:#4b363d}:root[data-palette=slate-fog]{--surface:#fbfcfd;--text:#263341;--muted:#66788a;--stroke:#d7e1e9}:root[data-palette=slate-fog][data-theme=dark]{--surface:#252f3a;--text:#f0f4f8;--muted:#b2bfcb;--stroke:#3a4a58}button:focus-visible{color:var(--text);text-decoration:underline}</style></head><body><div class="veil" data-veil><main role="dialog" aria-modal="true" aria-label="客户端版本信息"><header><strong>客户端版本信息</strong><button data-close aria-label="关闭">×</button></header><dl><div><dt>客户端版本</dt><dd id="client">—</dd></div><div><dt>插件版本</dt><dd id="plugin">—</dd></div><div><dt>运行阶段</dt><dd id="phase">—</dd></div></dl><p id="error" role="status"></p></main></div></body></html>`;
const dialogURL = `data:text/html;charset=utf-8,${encodeURIComponent(markup)}`;
const ownerByDialog = new WeakMap<BrowserWindow, BrowserWindow>();
let currentTheme: VersionDialogTheme = "light";
const anchors=new WeakMap<BrowserWindow,{x:number;y:number;width:number;height:number}>();

function position(parent: BrowserWindow, dialog: BrowserWindow): void {
  if (!parent.isDestroyed() && !dialog.isDestroyed()) {
    const bounds = parent.getContentBounds();
    const zoom = parent.webContents.getZoomFactor();
    const anchor=anchors.get(parent);
    const width=Math.min(Math.round(396*zoom),bounds.width); const height=Math.min(Math.round(180*zoom),bounds.height);
    dialog.webContents.setZoomFactor(zoom);
    const right=anchor ? (anchor.x+anchor.width)*zoom : bounds.width-8;
    const top=anchor ? anchor.y*zoom : bounds.height-28;
    const x=bounds.x+Math.max(0,Math.min(bounds.width-width,right-width+8));
    const y=bounds.y+Math.max(0,Math.min(bounds.height-height,top-height-4));
    dialog.setBounds({ x,y,width,height });
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
    dialog.on("blur",()=>{if(!dialog.isDestroyed())controller.closeDialog(dialog);});
    dialog.once("ready-to-show", () => { if (!parent.isDestroyed() && !dialog.isDestroyed()) { position(parent, dialog); dialog.show(); dialog.focus(); } });
    void dialog.loadURL(dialogURL).catch(() => { if (!dialog.isDestroyed()) dialog.close(); });
    return dialog;
  },
  focus: (dialog) => { if (dialog.isVisible()) dialog.focus(); },
  close: (dialog) => dialog.close(),
  setTheme: (dialog, theme) => { if (!dialog.isDestroyed() && !dialog.webContents.isDestroyed()) dialog.webContents.send(IPC_CHANNELS.versionDialogThemeChanged, {theme,themeId:storedNativeThemeId()}); },
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

const mainIpc = scopedIpc(["main"], (args) => args.length <= 1 && (args[0]===undefined || Boolean(args[0] && [args[0].x,args[0].y,args[0].width,args[0].height].every((n:unknown)=>typeof n==="number" && Number.isFinite(n) && n>=0 && n<=10000))));
mainIpc.handle(IPC_CHANNELS.versionDialogOpen, (event,anchor?:{x:number;y:number;width:number;height:number}) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed() || owner.webContents !== event.sender) return false;
  if(anchor)anchors.set(owner,anchor);
  return openDialog(owner) !== null;
});
const dialogIpc = scopedIpc(["version-dialog"], (args) => args.length === 0);
dialogIpc.handle(IPC_CHANNELS.versionDialogGetInfo, async (event) => {
  const dialog = BrowserWindow.fromWebContents(event.sender);
  if (!dialog || controller.ownerOf(dialog) === null || ownerByDialog.get(dialog) !== controller.ownerOf(dialog)) throw new Error("permission_denied");
  const { getPluginHost } = await import("./desktop-plugin-host/host");
  const snapshot = getPluginHost()?.snapshot();
  return { clientVersion: `v${DESKTOP_APPLICATION_VERSION}`, pluginVersion: snapshot?.pluginVersion ?? "—", runtimePhase: snapshot?.phase ?? "—", theme: currentTheme, themeId: storedNativeThemeId() };
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
