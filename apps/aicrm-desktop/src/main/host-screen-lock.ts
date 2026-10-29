import { loadSession, saveSession } from "./session-store";
import { loadDesktopConfig } from "./config";
const locked = new Set<number>();
const listeners = new Set<(ownerId: number, locked: boolean) => void>();
const attempts = new Map<number, number>();
export const isAnyHostScreenLocked=()=>locked.size>0;
export const isHostScreenLocked = (ownerId: number) => locked.has(ownerId);
export function onHostScreenLock(listener: (ownerId: number, locked: boolean) => void) { listeners.add(listener); return () => listeners.delete(listener); }
export function lockHostScreen(ownerId: number) { if (locked.has(ownerId))
    return; locked.add(ownerId); attempts.set(ownerId, (attempts.get(ownerId) ?? 0) + 1); for (const listener of listeners)
    listener(ownerId, true); }
export function clearHostScreenLock(ownerId: number) { if (!locked.delete(ownerId))
    return; attempts.set(ownerId, (attempts.get(ownerId) ?? 0) + 1); for (const listener of listeners)
    listener(ownerId, false); }
export function clearAllHostScreenLocks() { for (const ownerId of [...locked])
    clearHostScreenLock(ownerId); }
async function auth(path: string, token?: string, body?: unknown) {
    const response = await fetch(loadDesktopConfig().apiBaseUrl + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000), redirect: "error" });
    if (!response.ok)
        throw Error("authentication_failed");
    const envelope = await response.json() as {
        data?: unknown;
    };
    return envelope.data as {
        user?: {
            id?: string;
            username?: string;
            email?: string;
        };
        token?: string;
        expiresAt?: string;
    };
}
/** Authentication is performed in main; a renderer cannot send an unlocked flag. */
async function performUnlock(ownerId: number, password: string): Promise<boolean> {
    if (!locked.has(ownerId))
        return false;
    const generation = (attempts.get(ownerId) ?? 0) + 1;
    attempts.set(ownerId, generation);
    const previous = await loadSession().catch(() => null);
    if (!previous?.token)
        return false;
    try {
        const current = await auth('/api/v1/auth/bootstrap', previous.token);
        const account = current.user?.username || current.user?.email;
        if (!account || !current.user?.id)
            return false;
        const next = await auth('/api/v1/auth/login', undefined, { account, password, clientMode: "desktop", clientName: "AiCRM" });
        const latest = await loadSession();
        if (!locked.has(ownerId) || attempts.get(ownerId) !== generation || latest?.token !== previous.token || next.user?.id !== current.user.id || !next.token || !next.expiresAt)
            return false;
        await saveSession({ token: next.token, expiresAt: next.expiresAt });
        if (!locked.has(ownerId) || attempts.get(ownerId) !== generation)
            return false;
        clearHostScreenLock(ownerId);
        return true;
    }
    catch {
        return false;
    }
}
const pendingUnlocks = new Set<Promise<boolean>>();
export function unlockHostScreen(ownerId: number, password: string): Promise<boolean> {
    const promise = performUnlock(ownerId, password).catch(() => false);
    pendingUnlocks.add(promise);
    void promise.finally(() => pendingUnlocks.delete(promise));
    return promise;
}
export async function waitForHostUnlocks() { await Promise.allSettled([...pendingUnlocks]); }
