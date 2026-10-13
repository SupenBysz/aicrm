const HELP_DRAWER_VIEWPORT_GUTTER = 16;
const HELP_DRAWER_MIN_WIDTH = 560;
const HELP_DRAWER_MAX_WIDTH = 1600;
export const HELP_DRAWER_DEFAULT_WIDTH = 900;
export const HELP_DRAWER_WIDTH_STORAGE_KEY = "ky-script-management:help-drawer-width";

export interface HelpDrawerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const clampHelpDrawerWidth = (width: number, viewportWidth: number): number => {
  const safeWidth = Number.isFinite(width) ? width : HELP_DRAWER_MIN_WIDTH;
  const safeViewportWidth = Number.isFinite(viewportWidth) ? viewportWidth : HELP_DRAWER_MAX_WIDTH + HELP_DRAWER_VIEWPORT_GUTTER;
  const maxWidth = Math.min(HELP_DRAWER_MAX_WIDTH, Math.max(0, safeViewportWidth - HELP_DRAWER_VIEWPORT_GUTTER));
  const minWidth = Math.min(HELP_DRAWER_MIN_WIDTH, maxWidth);
  return Math.min(maxWidth, Math.max(minWidth, safeWidth));
};

export const resizeHelpDrawerWidth = (startWidth: number, startX: number, currentX: number, viewportWidth: number): number =>
  clampHelpDrawerWidth(startWidth + startX - currentX, viewportWidth);

export const nudgeHelpDrawerWidth = (width: number, delta: number, viewportWidth: number): number =>
  clampHelpDrawerWidth(clampHelpDrawerWidth(width, viewportWidth) + delta, viewportWidth);

export const readHelpDrawerWidth = (storage: HelpDrawerStorage | null | undefined, viewportWidth: number): number => {
  let stored: string | null = null;
  try {
    stored = storage?.getItem(HELP_DRAWER_WIDTH_STORAGE_KEY) ?? null;
  } catch {
    return clampHelpDrawerWidth(HELP_DRAWER_DEFAULT_WIDTH, viewportWidth);
  }
  const parsed = stored === null ? Number.NaN : Number(stored.trim());
  return clampHelpDrawerWidth(Number.isFinite(parsed) && parsed > 0 ? parsed : HELP_DRAWER_DEFAULT_WIDTH, viewportWidth);
};

export const writeHelpDrawerWidth = (storage: HelpDrawerStorage | null | undefined, width: number, viewportWidth: number): void => {
  try {
    storage?.setItem(HELP_DRAWER_WIDTH_STORAGE_KEY, String(clampHelpDrawerWidth(width, viewportWidth)));
  } catch {
    // localStorage may be blocked by browser privacy or sandbox policy.
  }
};
