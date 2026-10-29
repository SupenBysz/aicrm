export type HostOverlayAction = {
    type: "close" | "followPlatform" | "retry" | "refresh" | "openPreferences" | "openPassword" | "openWorkspaces" | "logout" | "refreshNetwork" | "clearNetwork" | "unlocked";
} | {
    type: "password";
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
} | {
    type: "workspace";
    id: string;
    workspaceType: string;
} | {
    type: "unlock";
    password: string;
} | {
    type: "choose";
    themeId: "classic-gold" | "business-blue" | "jade-green";
    mode: "light" | "dark" | "system";
};
export interface HostOverlayProjection {
    username?: string;
    displayName?: string;
    passwordChanging?: boolean;
    passwordError?: string;
    unlockError?: string;
    unlocking?: boolean;
    workspaces?: Array<{
        id: string;
        type: string;
        name: string;
        roles: string[];
        current: boolean;
    }>;
    network?: {
        loading: boolean;
        entries: Array<{
            id: string;
            method: string;
            url: string;
            statusCode?: number;
            status: string;
            durationMs?: number;
        }>;
    };
    origin: "platform" | "personal" | "legacy";
    syncState: "loading" | "idle" | "pending" | "saving" | "saved" | "offline" | "conflict" | "reading";
    canReload: boolean;
    enabled: boolean;
    preference: {
        schemaVersion: number;
        source: string;
        themeId: string;
        mode: string;
        revision: number;
    };
    platform: {
        schemaVersion: number;
        source: string;
        themeId: string;
        mode: string;
        revision: number;
    };
    themeId: "classic-gold" | "business-blue" | "jade-green";
    mode: "light" | "dark" | "system";
    dark: boolean;
    status: string;
    dirty: boolean;
    loading: boolean;
}
export interface HostOverlayInput {
    kind: HostOverlayKind;
    projection: HostOverlayProjection;
    top: number;
    bottom: number;
}
export interface HostOverlayBridge {
    show(input: HostOverlayInput): Promise<boolean>;
    close(): Promise<boolean>;
    onAction(listener: (action: HostOverlayAction) => void): () => void;
}
export type HostOverlayKind = "preferences" | "password" | "workspaces" | "network" | "user" | "lock";
export interface HostOverlayPresentation {
    sequence: number;
    kind: HostOverlayKind;
    projection: HostOverlayProjection;
}
