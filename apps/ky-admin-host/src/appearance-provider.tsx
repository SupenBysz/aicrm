import { getDesktopBridge } from "./desktop-client";
import { useEffect, useLayoutEffect, useRef, useState, type PropsWithChildren } from "react";
import { AppearanceContext, APPEARANCE_SNAPSHOT_KEY, DEFAULT_APPEARANCE, applyAppearance, validAppearance, normalizeAppearance, appearanceRetryOutcome, type AppearanceValue, type AppearanceMode, type ThemeId } from "@ky/admin-core";
import { loadBootstrap, loadSession } from "./app-store";
import { requestClient } from "./remote-api";
const KEY = "ky.admin.appearance.v1:";
const inherited = (): AppearanceValue => ({ schemaVersion: 1, source: "platform", themeId: "", mode: "", revision: 0 });
function read(key: string): unknown { try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
}
catch {
    return null;
} }
function write(key: string, value: unknown) { try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
}
catch {
    return false;
} }
function identity() { try { return loadSession() ? loadBootstrap()?.user.id ?? "anonymous" : "anonymous"; } catch { return "anonymous"; } }
export function AppearanceProvider({ children }: PropsWithChildren) {
    const [account, setAccount] = useState(identity);
    const [platformPreview, setPlatformPreview] = useState<AppearanceValue | null>(null);
    const [preference, setPreference] = useState<AppearanceValue>(() => {
        const cached=read(KEY+account) as {value?:unknown}|null;
        const value=normalizeAppearance(cached?.value,true);
        if(value)return value;
        try{const old=localStorage.getItem("ky.admin.colorScheme.v1");if(!localStorage.getItem("ky.admin.appearance.migrated.v1")&&(old==="light"||old==="dark"))return {...inherited(),source:"personal",themeId:"classic-gold",mode:old};}catch{}
        return inherited();
    });
    const [platform, setPlatform] = useState<AppearanceValue>(() => normalizeAppearance(read(KEY + "platform")) ?? DEFAULT_APPEARANCE);
    const platformRevision = useRef(platform.revision);
    function acceptPlatform(value: AppearanceValue) {
        if (value.revision < platformRevision.current) return;
        platformRevision.current = value.revision;
        setPlatform(value);
        write(KEY + "platform", value);
    }
    const [status, setStatus] = useState("");
    const [dirty, setDirty] = useState(false);
    const [loading, setLoading] = useState(true);
    const [originLegacy, setOriginLegacy] = useState(false);
    const [syncState, setSyncState] = useState<import("@ky/admin-core").AppearanceSyncState>("loading");
    const [uncertain, setUncertain] = useState(false);
    const reading = useRef(false);
    const readEpoch = useRef(0);
    const uncertainRef = useRef(false);
    function markUncertain(value:boolean){uncertainRef.current=value;setUncertain(value);}
    const [, systemChanged] = useState(0);
    const current = useRef({ account, preference, dirty, revision: 0, ready: false, blocked: false, legacy: false });
    const controller = useRef<AbortController | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const running = useRef<{
        owner: string;
    } | null>(null);
    function cache(p: AppearanceValue, isDirty: boolean) { write(KEY + current.current.account, { value: p, dirty: isDirty }); }
    async function flush() {
        const state = current.current;
        if (identity() !== state.account || running.current?.owner === state.account || reading.current || !state.dirty || !state.ready || state.blocked || state.account === "anonymous")
            return;
        const owner = state.account;
        const desired = state.preference;
        const revision = state.revision;
        const ticket = { owner };
        running.current = ticket;
        setSyncState("saving");
        setStatus("保存中…");
        try {
            const saved = await requestClient.request<AppearanceValue>("/api/v1/auth/me/appearance", { method: "PUT", body: { ...desired, revision }, signal: controller.current?.signal, skipAuthRedirect: true });
            if (current.current.account !== owner || identity() !== owner)
                return;
            current.current.revision = saved.revision;
            if (current.current.preference === desired) {
                current.current.preference = saved;
                current.current.dirty = false;
                setPreference(saved);
                setDirty(false);
                cache(saved, false);
                setSyncState("saved");markUncertain(false);
                setStatus("已保存");
            }
            else {
                current.current.preference = { ...current.current.preference, revision: saved.revision };
                cache(current.current.preference, true);
            }
        }
        catch (error) {
            if (current.current.account !== owner || identity() !== owner)
                return;
            // Do not auto-retry a failed/ambiguous write; refresh revision on explicit retry.
            current.current.blocked = true;
            const conflict=!!error&&typeof error==="object"&&"code" in error&&error.code==="appearance_conflict";
            markUncertain(!conflict);setSyncState(conflict?"conflict":"offline");
            setStatus(conflict?"服务器外观已更新；本机选择已保留，请重新读取后再选择":"仅在本机生效，尚未同步；请重试确认保存结果");
        }
        finally {
            if (running.current === ticket) {
                running.current = null;
                if (current.current.account === owner && !current.current.blocked && current.current.dirty)
                    void flush();
            }
        }
    }
    async function refresh() {
        const owner = current.current.account;
        const epoch=readEpoch.current;
        const signal = controller.current?.signal;
        const results = await Promise.allSettled([
            requestClient.request<AppearanceValue>("/api/v1/public/appearance", { signal, skipAuthRedirect: true }),
            owner === "anonymous" ? Promise.resolve(null) : requestClient.request<AppearanceValue>("/api/v1/auth/me/appearance", { signal, skipAuthRedirect: true })
        ]);
        if (current.current.account !== owner || identity() !== owner || signal?.aborted || epoch!==readEpoch.current || reading.current)
            return;
        const shared = results[0];
        const sharedValue = shared.status === "fulfilled" ? normalizeAppearance(shared.value) : null;
        if (sharedValue) {
            acceptPlatform(sharedValue);
        }
        if(running.current?.owner===owner){setLoading(false);return;}
        const personal = results[1];
        const remote = personal.status === "fulfilled" ? normalizeAppearance(personal.value, true) : null;
        if (remote) {
            if (remote.revision < current.current.revision) {
                setLoading(false);
                return;
            }
            if (!current.current.dirty && !(current.current.legacy && remote.revision === 0 && remote.source === "platform")) {
                current.current.legacy = false;setOriginLegacy(false);
                current.current.preference = remote;
                setPreference(remote);
                cache(remote, false);
                current.current.revision = remote.revision;
                setSyncState("idle");markUncertain(false);setStatus("");
            }
            else if (remote.revision !== current.current.revision) {
                current.current.blocked = true;
                setSyncState("conflict");markUncertain(false);
                setStatus("服务器外观已更新；本机选择已保留，请重新读取后再选择");
            }
            current.current.ready = true;
            if(current.current.legacy&&!current.current.dirty)setSyncState("idle");
            if(current.current.dirty&&current.current.blocked&&remote.revision===current.current.revision)setSyncState("offline");
        }
        else if (owner === "anonymous")
            current.current.ready = true;
        else {setSyncState("offline");setStatus("外观同步暂不可用，当前使用本机设置");}
        setLoading(false);
        if (current.current.dirty && !current.current.blocked)
            void flush();
    }
    useEffect(() => {
        const changed = () => setAccount(identity());
        window.addEventListener("ky:session-changed", changed);
        window.addEventListener("storage", changed);
        return () => { window.removeEventListener("ky:session-changed", changed); window.removeEventListener("storage", changed); };
    }, []);
    useEffect(() => {
        controller.current?.abort();
        setPlatformPreview(null);
        readEpoch.current++;reading.current=false;
        controller.current = new AbortController();
        if (timer.current)
            clearTimeout(timer.current);
        const cached = read(KEY + account) as {
            value?: unknown;
            dirty?: boolean;
            legacy?: boolean;
        } | null;
        let p = normalizeAppearance(cached?.value, true) ?? inherited();
        let pending = !!cached?.dirty;
        let legacy = !!cached?.legacy;
        // Legacy device choice is never uploaded as an account preference.
        if (!cached) {
            try {
                const old = localStorage.getItem("ky.admin.colorScheme.v1");
                if (!localStorage.getItem("ky.admin.appearance.migrated.v1") && (old === "light" || old === "dark")) {
                    p = { ...p, source: "personal", themeId: "classic-gold", mode: old };
                    legacy = true;
                    write(KEY + account, { value: p, dirty: false, legacy: true });
                    localStorage.setItem("ky.admin.appearance.migrated.v1", "1");
                }
            }
            catch { /* memory fallback */ }
        }
        current.current = { account, preference: p, dirty: pending, revision: p.revision, ready: false, blocked: pending, legacy };
        setPreference(p);
        setDirty(pending);
        setLoading(true);setOriginLegacy(legacy);markUncertain(pending);setSyncState("loading");
        setStatus(pending ? "有尚未同步的本机设置，请重试或重新读取" : legacy ? "沿用本机旧版外观，尚未设为账号偏好" : "");
        void refresh();
        return () => controller.current?.abort();
    }, [account]);
    useEffect(() => {
        const media = matchMedia("(prefers-color-scheme: dark)");
        const changed = () => systemChanged(v => v + 1);
        media.addEventListener("change", changed);
        const focus = () => void refresh();
        window.addEventListener("focus", focus);
        const storage = (event: StorageEvent) => { if (event.key === KEY + current.current.account) {
            // An explicit read or an in-flight write owns reconciliation until it settles.
            if (reading.current || running.current?.owner === current.current.account)
                return;
            if (current.current.dirty) {
                current.current.blocked = true;setSyncState("conflict");
                setStatus("其他窗口已修改外观；请重新读取后再选择");
                return;
            }
            const cached = read(event.key) as {
                value: unknown;
                dirty?: boolean;
            } | null;
            if (cached?.dirty)
                return;
            if (validAppearance(cached?.value, true) && cached.value.revision >= current.current.revision) {
                current.current.preference = cached.value;
                current.current.revision = cached.value.revision;
                setPreference(cached.value);
            }
            void refresh();
        } if (event.key === KEY + "platform") {
            const v = read(event.key);
            if (validAppearance(v))
                acceptPlatform(v);
        } };
        window.addEventListener("storage", storage);
        return () => { media.removeEventListener("change", changed); window.removeEventListener("focus", focus); window.removeEventListener("storage", storage); if (timer.current)
            clearTimeout(timer.current); };
    }, []);
    const enabled = import.meta.env.VITE_APPEARANCE_DISABLED !== "1";
    const effective = !enabled ? DEFAULT_APPEARANCE : platformPreview ?? (preference.source === "personal" ? preference : platform);
    const themeId = (effective.themeId || "classic-gold") as ThemeId;
    const mode = (effective.mode || "system") as AppearanceMode;
    const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    useLayoutEffect(() => {
        applyAppearance(themeId, mode);
        // Editing is transient: do not persist snapshots or notify the native shell.
        if (platformPreview) return;
        write(APPEARANCE_SNAPSHOT_KEY, { themeId, mode });
        // Projection for an older frontend during rollback, never used as new account state.
        if(!loading){try{localStorage.setItem("ky.admin.appearance.migrated.v1","1");localStorage.setItem("ky.admin.colorScheme.v1",dark?"dark":"light")}catch{}}
        window.dispatchEvent(new CustomEvent("ky:appearance-applied", { detail: { themeId, dark } }));
        void getDesktopBridge()?.window?.setAppearance?.({ themeId, dark }).catch(() => { });
    }, [themeId, mode, dark, loading, preference.source, platformPreview]);
    function select(p: AppearanceValue) {
        if(reading.current||loading||identity()!==current.current.account)return;
        current.current.legacy = false;setOriginLegacy(false);setSyncState("pending");
        current.current.preference = p;
        current.current.dirty = current.current.account !== "anonymous";
        setPreference(p);
        setDirty(current.current.dirty);
        const persisted = write(KEY + current.current.account, { value: p, dirty: current.current.dirty });
        setStatus(persisted ? (current.current.account === "anonymous" ? "已在本机保存" : "等待同步…") : "无法本地保存，当前仅在内存生效");
        if (timer.current)
            clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), 250);
    }
    async function reloadPlatform(saved?: AppearanceValue) {
        const raw = saved ?? await requestClient.request<AppearanceValue>("/api/v1/public/appearance", { skipAuthRedirect: true });
        const value = normalizeAppearance(raw);
        if (value) acceptPlatform(value);
    }
    function followPlatform() {
        try { localStorage.removeItem("ky.admin.colorScheme.v1"); } catch { /* optional storage */ }
        select({ ...inherited(), revision: current.current.revision });
    }
    async function reloadPersonal() {
        if(reading.current||running.current?.owner===current.current.account||uncertainRef.current||loading){
            setStatus(uncertainRef.current?"请先重试确认上次保存结果，再重新读取":"请等待当前同步完成");return;
        }
        const owner=current.current.account;
        if(owner==="anonymous")return;
        if(timer.current){clearTimeout(timer.current);timer.current=null;}
        reading.current=true;const epoch=++readEpoch.current;
        setSyncState("reading");setStatus("正在重新读取…");
        try {
            const [value, defaults]=await Promise.all([
                requestClient.request<AppearanceValue>("/api/v1/auth/me/appearance",{signal:controller.current?.signal,skipAuthRedirect:true}),
                requestClient.request<AppearanceValue>("/api/v1/public/appearance",{signal:controller.current?.signal,skipAuthRedirect:true})
            ]);
            if(owner!==identity()||owner!==current.current.account||epoch!==readEpoch.current)return;
            if(!validAppearance(value,true)||!validAppearance(defaults))throw new Error("invalid appearance");
            acceptPlatform(defaults);
            current.current.legacy=false;setOriginLegacy(false);
            current.current.preference=value;current.current.revision=value.revision;
            current.current.dirty=false;current.current.blocked=false;current.current.ready=true;
            setPreference(value);setDirty(false);cache(value,false);markUncertain(false);
            setSyncState("idle");setStatus("已读取服务器设置");
        } catch {
            if(owner===identity()&&epoch===readEpoch.current){
                current.current.blocked=true;setSyncState("offline");setStatus("重新读取失败，本机选择已保留");
            }
        } finally {if(epoch===readEpoch.current)reading.current=false;}
    }
    async function retry() {
        if(reading.current||running.current?.owner===current.current.account||loading)return;
        const owner=current.current.account;
        if(timer.current){clearTimeout(timer.current);timer.current=null;}
        reading.current=true;const epoch=++readEpoch.current;
        setSyncState("reading");setStatus("正在核对服务器设置…");
        let resend=false;
        try {
            const remote=await requestClient.request<AppearanceValue>("/api/v1/auth/me/appearance",{skipAuthRedirect:true,signal:controller.current?.signal});
            if(owner!==identity()||owner!==current.current.account||epoch!==readEpoch.current)return;
            if(!validAppearance(remote,true))throw new Error("invalid appearance");
            const outcome=appearanceRetryOutcome(remote,current.current.preference,current.current.revision);
            if(outcome==="saved"){
                current.current.preference=remote;current.current.revision=remote.revision;
                current.current.dirty=false;current.current.blocked=false;
                setPreference(remote);setDirty(false);cache(remote,false);markUncertain(false);
                setSyncState("saved");setStatus("已保存");
            }else if(outcome==="conflict"){
                markUncertain(false);current.current.blocked=true;setSyncState("conflict");
                setStatus("服务器外观已更新，请重新读取后再选择");
            }else{
                current.current.ready=true;current.current.blocked=false;resend=true;
            }
        }catch{
            if(owner===identity()&&epoch===readEpoch.current){setSyncState("offline");setStatus("同步仍不可用，请稍后重试");}
        }finally{
            if(epoch===readEpoch.current){reading.current=false;if(resend)void flush();}
        }
    }
    return <AppearanceContext.Provider value={{enabled, preference, platform, themeId, mode, dark, status, dirty, loading,
        origin:originLegacy?"legacy":preference.source,
        syncState, canReload:!loading&&syncState!=="saving"&&syncState!=="reading"&&!uncertain&&running.current?.owner!==account,
        choose: (id,m) => select({schemaVersion:1,source:"personal",themeId:id,mode:m,revision:current.current.revision}),
        previewPlatform: setPlatformPreview, followPlatform, reloadPlatform, refresh:reloadPersonal, retry:()=>void retry()
    }}>{children}</AppearanceContext.Provider>;
}
