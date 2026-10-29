import { getDesktopBridge } from "./desktop-client";
import { loadSession } from "./app-store";
type Session = {
    token: string;
    expiresAt: string;
};
export function createDesktopSessionCoordinator(load: () => Session | null, port: {
    save(session: Session): Promise<boolean>;
    clear(): Promise<boolean>;
}) {
    let tail = Promise.resolve();
    let acknowledged: string | undefined;
    return { sync() {
            const value = load();
            const snapshot = value ? { token: value.token, expiresAt: value.expiresAt } : null;
            const identity = JSON.stringify(snapshot);
            const operation = tail.catch(() => { }).then(async () => { if (acknowledged === identity)
                return; const ok = snapshot ? await port.save(snapshot) : await port.clear(); if (!ok)
                throw Error("桌面登录会话同步失败，请重新登录后重试"); acknowledged = identity; });
            tail = operation;
            return operation;
        } };
}
let coordinator: ReturnType<typeof createDesktopSessionCoordinator> | undefined;
export function syncDesktopSession(): Promise<void> {
    const session = getDesktopBridge()?.session;
    if (!session?.save || !session?.clear)
        return Promise.resolve();
    coordinator ??= createDesktopSessionCoordinator(loadSession, { save: session.save, clear: session.clear });
    return coordinator.sync();
}
