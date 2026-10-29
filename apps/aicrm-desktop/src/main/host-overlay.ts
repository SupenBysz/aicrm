import { isHostScreenLocked, lockHostScreen, unlockHostScreen, clearHostScreenLock, onHostScreenLock, isAnyHostScreenLocked } from "./host-screen-lock";
import { app, BrowserWindow, WebContentsView } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IPC_CHANNELS } from "../shared/constants";
import type { HostOverlayInput, HostOverlayAction, HostOverlayPresentation } from "../shared/host-overlay";
import { registerSender, scopedIpc, onSenderInvalidated } from "./guarded-ipc";
interface Overlay {
    owner: BrowserWindow;
    view: WebContentsView;
    input: HostOverlayInput;
    sequence: number;
    unlockPending?: boolean;
    dispose: () => void;
}
const overlays = new Map<number, Overlay>();
const entry = () => pathToFileURL(join(__dirname, "../native-overlay/index.html")).href;
export function restoreHostOverlayOrder(owner: BrowserWindow) { const overlay = overlays.get(owner.id); if (overlay && !overlay.view.webContents.isDestroyed())
    owner.contentView.addChildView(overlay.view);const protectedCover=protectedWindows.get(owner.id);if(protectedCover&&isAnyHostScreenLocked())owner.contentView.addChildView(protectedCover.view); }
function layout(overlay: Overlay) {
    if (overlay.owner.isDestroyed())
        return;
    const { width, height } = overlay.owner.getContentBounds();
    const zoom = overlay.owner.webContents.getZoomFactor();
    overlay.view.webContents.setZoomFactor(zoom);
    const top = Math.min(height, Math.max(0, Math.round(overlay.input.top * zoom)));
    const bottom = Math.min(height - top, Math.max(0, Math.round(overlay.input.bottom * zoom)));
    overlay.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top - bottom) });
}
function close(owner: BrowserWindow, expected?: Overlay) { if (!owner.isDestroyed() && isHostScreenLocked(owner.webContents.id))
    return false; const overlay = overlays.get(owner.id); if (!overlay || (expected && expected !== overlay))
    return false; overlays.delete(owner.id); overlay.dispose(); if (!owner.isDestroyed())
    owner.contentView.removeChildView(overlay.view); if (!overlay.view.webContents.isDestroyed())
    overlay.view.webContents.close(); return true; }
function validAction(value: unknown): value is HostOverlayAction {
    if (!value || typeof value !== "object")
        return false;
    const v = value as Record<string, unknown>;
    if (["close", "followPlatform", "retry", "refresh", "openPreferences", "openPassword", "openWorkspaces", "logout", "refreshNetwork", "clearNetwork"].includes(String(v.type)))
        return true;
    if (v.type === "workspace")
        return typeof v.id === "string" && v.id.length <= 128 && ["platform", "agency", "enterprise"].includes(String(v.workspaceType));
    if (v.type === "password")
        return [v.currentPassword, v.newPassword, v.confirmPassword].every(value => typeof value === "string" && value.length > 0 && value.length <= 1024);
    if (v.type === "unlock")
        return typeof v.password === "string" && v.password.length > 0 && v.password.length <= 1024;
    return v.type === "choose" && ["classic-gold", "business-blue", "jade-green"].includes(String(v.themeId)) && ["light", "dark", "system"].includes(String(v.mode));
}
function validInput(value: unknown): value is HostOverlayInput {
    if (!value || typeof value !== "object")
        return false;
    const v = value as HostOverlayInput;
    return ["preferences", "password", "workspaces", "network", "user", "lock"].includes(v.kind) && [v.top, v.bottom].every(n => Number.isFinite(n) && n >= 0 && n < 10000) && Boolean(v.projection) && JSON.stringify(v.projection).length < 60000;
}
const presentation = (overlay: Overlay): HostOverlayPresentation => ({ sequence: overlay.sequence, kind: overlay.input.kind, projection: overlay.input.projection });
const protectedWindows=new Map<number,{window:BrowserWindow;view:WebContentsView;resize:()=>void}>();
function coverWindow(window:BrowserWindow){
 if(window.isDestroyed()||protectedWindows.has(window.id)||isHostScreenLocked(window.webContents.id))return;
 const view=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false}});view.setBackgroundColor("#101820");
 const resize=()=>{if(!window.isDestroyed()){const {width,height}=window.getContentBounds();view.setBounds({x:0,y:0,width,height});}};
 window.contentView.addChildView(view);resize();window.on("resize",resize);
 const record={window,view,resize};protectedWindows.set(window.id,record);
 window.once("closed",()=>removeCover(window.id));
 void view.webContents.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent('<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><body style="background:#101820;color:white;font:18px system-ui;display:grid;place-items:center;height:90vh">屏幕已锁定，请在主窗口解锁</body>')).catch(()=>{});
}
function removeCover(id:number){const record=protectedWindows.get(id);if(!record)return;protectedWindows.delete(id);record.window.removeListener("resize",record.resize);if(!record.window.isDestroyed())record.window.contentView.removeChildView(record.view);if(!record.view.webContents.isDestroyed())record.view.webContents.close();}
export function destroyHostLockProtectedWindows(){for(const [id,record] of [...protectedWindows]){if(!record.window.isDestroyed())record.window.destroy();removeCover(id);}}
export function registerHostOverlayIpc() {
    app.on("browser-window-created",(_event,window)=>{if(isAnyHostScreenLocked())coverWindow(window);});
    onHostScreenLock((_ownerId,locked)=>{if(locked){for(const window of BrowserWindow.getAllWindows())coverWindow(window);}else if(!isAnyHostScreenLocked()){for(const id of [...protectedWindows.keys()])removeCover(id);}});
    onHostScreenLock((ownerId, locked) => { if (!locked)
        for (const overlay of overlays.values())
            if (overlay.owner.webContents.id === ownerId && overlay.input.kind === "lock")
                close(overlay.owner); });
    onSenderInvalidated(sender => { for (const overlay of overlays.values())
        if (overlay.owner.webContents === sender && !isHostScreenLocked(sender.id))
            close(overlay.owner); });
    const main = scopedIpc(["main"], args => args.length <= 1 && (args.length === 0 || validInput(args[0])));
    main.handle(IPC_CHANNELS.hostOverlayShow, async (event, input: HostOverlayInput) => {
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner || owner.webContents !== event.sender || owner.isDestroyed())
            return false;
        if (input.kind === "lock") { input={...input,top:0,bottom:0}; lockHostScreen(event.sender.id); }
        if (isHostScreenLocked(event.sender.id) && input.kind !== "lock")
            return false;
        const existing = overlays.get(owner.id);
        if (existing) {
            const changed = existing.input.kind !== input.kind;
            const unlockError = existing.input.projection.unlockError;
            existing.input = input;
            if (input.kind === "lock")
                existing.input.projection = { ...input.projection, unlocking: !!existing.unlockPending, unlockError };
            existing.sequence++;
            existing.view.setBackgroundColor(input.kind === "lock" ? "#101820" : "#00000000");
            layout(existing);
            restoreHostOverlayOrder(owner);
            existing.view.webContents.send(IPC_CHANNELS.hostOverlayProjection, presentation(existing));
            if (changed)
                existing.view.webContents.focus();
            return true;
        }
        const view = new WebContentsView({ webPreferences: { preload: join(__dirname, "../preload/host-overlay.js"), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } });
        view.setBackgroundColor(input.kind === "lock" ? "#101820" : "#00000000");
        const unregister = registerSender(view.webContents, "host-overlay", url => url === entry());
        const overlay: Overlay = { owner, view, input, sequence: 1, dispose: () => { } };
        const resize = () => layout(overlay);
        const destroyed = () => { if(isHostScreenLocked(event.sender.id))destroyHostLockProtectedWindows();clearHostScreenLock(event.sender.id); close(owner); };
        owner.on("resize", resize);
        owner.webContents.on("zoom-changed", resize);
        owner.once("closed", destroyed);
        event.sender.once("destroyed", destroyed);
        overlay.dispose = () => { unregister(); owner.removeListener("resize", resize); owner.webContents.removeListener("zoom-changed", resize); owner.removeListener("closed", destroyed); event.sender.removeListener("destroyed", destroyed); };
        view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        view.webContents.on("will-navigate", (event, url) => { if (url !== entry())
            event.preventDefault(); });
        view.webContents.on("will-redirect", event => event.preventDefault());
        view.webContents.on("render-process-gone", () => { if (isHostScreenLocked(event.sender.id)) {
            view.setBackgroundColor("#101820");
            void view.webContents.loadURL(entry()).catch(() => { });
            return;
        } close(owner); if (!owner.webContents.isDestroyed())
            owner.webContents.send(IPC_CHANNELS.hostOverlayAction, { type: "close" }); });
        overlays.set(owner.id, overlay);
        owner.contentView.addChildView(view);
        layout(overlay);
        try {
            await view.webContents.loadURL(entry());
            if (overlays.get(owner.id) !== overlay)
                return false;
            restoreHostOverlayOrder(owner);
            view.webContents.focus();
            return true;
        }
        catch {
            close(owner, overlay);
            return false;
        }
    });
    main.handle(IPC_CHANNELS.hostOverlayClose, event => { const owner = BrowserWindow.fromWebContents(event.sender); return owner ? close(owner) : false; });
    const presenter = scopedIpc(["host-overlay"], args => args.length <= 1 && (args.length === 0 || validAction(args[0])));
    presenter.handle(IPC_CHANNELS.hostOverlayGet, event => { const overlay = [...overlays.values()].find(item => item.view.webContents === event.sender); if (!overlay)
        throw Error("permission_denied"); return presentation(overlay); });
    presenter.handle(IPC_CHANNELS.hostOverlayDispatch, async (event, action: HostOverlayAction) => {
        const overlay = [...overlays.values()].find(item => item.view.webContents === event.sender);
        if (!overlay || overlay.owner.isDestroyed())
            return false;
        const ownerId = overlay.owner.webContents.id;
        if (action.type === "unlock") {
            if (overlay.unlockPending)
                return false;
            overlay.unlockPending = true;
            overlay.input.projection = { ...overlay.input.projection, unlocking: true, unlockError: "" };
            overlay.sequence++;
            overlay.view.webContents.send(IPC_CHANNELS.hostOverlayProjection, presentation(overlay));
            const unlocked = await unlockHostScreen(ownerId, action.password);
            overlay.unlockPending = false;
            if (unlocked) {
                overlay.owner.webContents.send(IPC_CHANNELS.hostOverlayAction, { type: "unlocked" });
                close(overlay.owner, overlay);
                return true;
            }
            overlay.input.projection = { ...overlay.input.projection, unlocking: false, unlockError: "解锁失败，请检查当前账号密码或网络后重试" };
            overlay.sequence++;
            if (!overlay.view.webContents.isDestroyed())
                overlay.view.webContents.send(IPC_CHANNELS.hostOverlayProjection, presentation(overlay));
            return false;
        }
        if (isHostScreenLocked(ownerId) && action.type !== "logout")
            return false;
        overlay.owner.webContents.send(IPC_CHANNELS.hostOverlayAction, action);
        if (action.type === "close")
            close(overlay.owner);
        return true;
    });
}
