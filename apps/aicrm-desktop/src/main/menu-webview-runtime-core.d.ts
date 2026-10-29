export interface MenuWebViewInputLike { directoryType: "management" | "workbench"; menuKey: string; workspaceType: "platform" | "agency" | "enterprise"; workspaceId: string }
export interface MenuWebViewBoundsLike { instanceId: string; x: number; y: number; width: number; height: number; visible: boolean }
export interface MenuWebViewCommandLike { instanceId: string; command: "back" | "forward" | "reload" }
export interface MenuWebViewCloseLike { instanceId: string }
export interface MenuRuntimeAssetLike { id: string; identifier: string; version: string; runAt: string; priority: number; assetType: string; sourceContent: string; sourceBytes: number; sourceSha256: string; publicDependency?: boolean }
export const MENU_WEBVIEW_RUN_AT: readonly string[];
export function validMenuWebViewOpenInput(value: unknown): value is MenuWebViewInputLike;
export function validMenuWebViewBounds(value: unknown): value is MenuWebViewBoundsLike;
export function validMenuWebViewCommand(value: unknown): value is MenuWebViewCommandLike;
export function validMenuWebViewClose(value: unknown): value is MenuWebViewCloseLike;
export function menuWebViewUrlAllowed(raw: string, protocols: string[]): boolean;
export function menuRuntimeAssetKey(asset: MenuRuntimeAssetLike): string;
export function createMenuRuntimeSchedule(data: any): { styles: MenuRuntimeAssetLike[]; scripts: MenuRuntimeAssetLike[]; byRunAt(runAt: string): MenuRuntimeAssetLike[] };
export function menuRuntimeAssetSource(asset: MenuRuntimeAssetLike): string;
export function menuRuntimeLifecycleBootstrap(): string;
