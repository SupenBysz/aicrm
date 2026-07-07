import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/constants";
import type { DesktopWindowState } from "../shared/types";

const CONTROLS_ID = "aicrm-desktop-window-controls";
const FLOATING_CHROME_ID = "aicrm-desktop-floating-window-chrome";
const HOST_CLASS = "aicrm-desktop-window-host";
const STYLE_ID = "aicrm-desktop-window-chrome-style";

const WINDOW_CHROME_CSS = `
:root {
  --aicrm-desktop-topbar-height: 60px;
  --aicrm-window-controls-width: 138px;
  --aicrm-window-accent: #d49a3d;
  --aicrm-window-border: rgba(221, 182, 113, 0.24);
  --aicrm-window-content-bg: #f7efe4;
  --aicrm-window-control-hover: #fcf6ed;
  --aicrm-window-control-active: #f1e6d8;
  --aicrm-window-text: #34281a;
  --aicrm-window-text-muted: rgba(79, 59, 36, 0.72);
}

@media (prefers-color-scheme: dark) {
  :root {
    --aicrm-window-accent: #ffd47d;
    --aicrm-window-border: rgba(255, 212, 125, 0.16);
    --aicrm-window-content-bg: #050505;
    --aicrm-window-control-hover: rgba(255, 255, 255, 0.12);
    --aicrm-window-control-active: rgba(255, 255, 255, 0.18);
    --aicrm-window-text: #ffffff;
    --aicrm-window-text-muted: rgba(255, 255, 255, 0.66);
  }
}

:root[data-admin-theme="light"] {
  --aicrm-window-accent: #d49a3d;
  --aicrm-window-border: rgba(221, 182, 113, 0.24);
  --aicrm-window-content-bg: #f7efe4;
  --aicrm-window-control-hover: #fcf6ed;
  --aicrm-window-control-active: #f1e6d8;
  --aicrm-window-text: #34281a;
  --aicrm-window-text-muted: rgba(79, 59, 36, 0.72);
}

:root[data-admin-theme="dark"] {
  --aicrm-window-accent: #ffd47d;
  --aicrm-window-border: rgba(255, 212, 125, 0.16);
  --aicrm-window-content-bg: #050505;
  --aicrm-window-control-hover: rgba(255, 255, 255, 0.12);
  --aicrm-window-control-active: rgba(255, 255, 255, 0.18);
  --aicrm-window-text: #ffffff;
  --aicrm-window-text-muted: rgba(255, 255, 255, 0.66);
}

html.aicrm-desktop-window-root,
body.aicrm-desktop-window-chrome-enabled {
  --admin-header-height: var(--aicrm-desktop-topbar-height);
  background: var(--aicrm-window-content-bg) !important;
  min-height: 100vh !important;
}

body.aicrm-desktop-window-chrome-enabled .app-header,
body.aicrm-desktop-window-chrome-enabled .global-account-header,
body.aicrm-desktop-window-chrome-enabled .workspace-selection-header {
  -webkit-app-region: drag;
}

body.aicrm-desktop-window-chrome-enabled .app-header {
  height: var(--aicrm-desktop-topbar-height) !important;
  padding-block: 0 !important;
  padding-right: calc(5px + var(--aicrm-window-controls-width)) !important;
}

body.aicrm-desktop-window-chrome-enabled .app-body {
  margin-top: var(--aicrm-desktop-topbar-height) !important;
}

body.aicrm-desktop-window-chrome-enabled .app-sider {
  top: var(--aicrm-desktop-topbar-height) !important;
}

body.aicrm-desktop-window-chrome-enabled .app-sider-scroll {
  height: calc(100vh - var(--aicrm-desktop-topbar-height)) !important;
}

body.aicrm-desktop-window-chrome-enabled .app-content {
  height: calc(100vh - var(--aicrm-desktop-topbar-height)) !important;
  min-height: calc(100vh - var(--aicrm-desktop-topbar-height)) !important;
}

body.aicrm-desktop-window-chrome-enabled.aicrm-app-overlay-active .app-header,
body.aicrm-desktop-window-chrome-enabled.aicrm-app-overlay-active .global-account-header,
body.aicrm-desktop-window-chrome-enabled.aicrm-app-overlay-active .workspace-selection-header {
  -webkit-app-region: no-drag !important;
  pointer-events: none !important;
}

body.aicrm-desktop-window-chrome-enabled .ant-drawer,
body.aicrm-desktop-window-chrome-enabled .ant-drawer *,
body.aicrm-desktop-window-chrome-enabled .ant-modal-root,
body.aicrm-desktop-window-chrome-enabled .ant-modal-root * {
  -webkit-app-region: no-drag !important;
}

body.aicrm-desktop-window-chrome-enabled .aicrm-desktop-window-host button,
body.aicrm-desktop-window-chrome-enabled .aicrm-desktop-window-host a,
body.aicrm-desktop-window-chrome-enabled .aicrm-desktop-window-host input,
body.aicrm-desktop-window-chrome-enabled .aicrm-desktop-window-host textarea,
body.aicrm-desktop-window-chrome-enabled .aicrm-desktop-window-host select,
body.aicrm-desktop-window-chrome-enabled .aicrm-desktop-window-host [role="button"],
body.aicrm-desktop-window-chrome-enabled .aicrm-desktop-window-host .ant-btn,
body.aicrm-desktop-window-chrome-enabled .aicrm-desktop-window-host .ant-dropdown-trigger,
body.aicrm-desktop-window-chrome-enabled .aicrm-desktop-window-host .ant-select,
body.aicrm-desktop-window-chrome-enabled .aicrm-desktop-window-host .ant-tag,
body.aicrm-desktop-window-chrome-enabled .aicrm-desktop-window-host .aicrm-window-controls {
  -webkit-app-region: no-drag;
}

body.aicrm-desktop-window-chrome-enabled .app-header .app-mode-segmented,
body.aicrm-desktop-window-chrome-enabled .app-header .app-mode-segmented *,
body.aicrm-desktop-window-chrome-enabled .app-header .app-header-actions,
body.aicrm-desktop-window-chrome-enabled .app-header .app-header-actions *,
body.aicrm-desktop-window-chrome-enabled .app-header button,
body.aicrm-desktop-window-chrome-enabled .app-header a,
body.aicrm-desktop-window-chrome-enabled .app-header input,
body.aicrm-desktop-window-chrome-enabled .app-header textarea,
body.aicrm-desktop-window-chrome-enabled .app-header select,
body.aicrm-desktop-window-chrome-enabled .app-header [role="button"],
body.aicrm-desktop-window-chrome-enabled .app-header .ant-btn,
body.aicrm-desktop-window-chrome-enabled .app-header .ant-segmented,
body.aicrm-desktop-window-chrome-enabled .app-header .ant-segmented *,
body.aicrm-desktop-window-chrome-enabled .app-header .ant-dropdown-trigger,
body.aicrm-desktop-window-chrome-enabled .app-header .ant-badge {
  -webkit-app-region: no-drag !important;
}

body.aicrm-desktop-window-chrome-enabled .app-header .brand-block,
body.aicrm-desktop-window-chrome-enabled .app-header .brand-title,
body.aicrm-desktop-window-chrome-enabled .app-header .brand-subtitle {
  -webkit-app-region: drag;
}

.aicrm-window-controls {
  -webkit-app-region: no-drag;
  align-self: stretch;
  display: inline-flex;
  flex: 0 0 auto;
  height: auto;
  margin-left: 4px;
  overflow: hidden;
  pointer-events: auto;
  width: var(--aicrm-window-controls-width);
}

.app-header .aicrm-window-controls {
  height: var(--aicrm-desktop-topbar-height);
  margin-right: -22px;
}

.global-account-header .aicrm-window-controls,
.workspace-selection-header .aicrm-window-controls {
  align-self: center;
  border: 1px solid var(--aicrm-window-border);
  border-radius: 10px;
  height: 36px;
  margin-left: auto;
}

.aicrm-window-control {
  -webkit-app-region: no-drag;
  align-items: center;
  background: transparent !important;
  border: 0;
  border-left: 1px solid var(--aicrm-window-border);
  border-radius: 0;
  color: var(--aicrm-window-text-muted);
  cursor: pointer;
  display: inline-flex;
  height: 100%;
  justify-content: center;
  margin: 0;
  padding: 0;
  pointer-events: auto;
  position: relative;
  transition: background-color 120ms ease, box-shadow 120ms ease, color 120ms ease;
  width: 46px;
  z-index: 1;
}

.aicrm-window-control::before {
  display: none;
}

.aicrm-window-control:first-child {
  border-left: 0;
}

.aicrm-window-control:hover,
.aicrm-window-control.is-hovered {
  background: var(--aicrm-window-control-hover) !important;
  box-shadow: none;
  color: var(--aicrm-window-text) !important;
}

.aicrm-window-control:active,
.aicrm-window-control.is-pressed {
  background: var(--aicrm-window-control-active) !important;
  box-shadow: none;
  color: var(--aicrm-window-text) !important;
}

.aicrm-window-control:focus-visible {
  outline: 2px solid var(--aicrm-window-accent);
  outline-offset: -2px;
}

.aicrm-window-control-close:hover,
.aicrm-window-control-close.is-hovered {
  background: #d92d20 !important;
  box-shadow: none;
  color: #ffffff !important;
}

.aicrm-window-control-close:active,
.aicrm-window-control-close.is-pressed {
  background: #b42318 !important;
  box-shadow: none;
  color: #ffffff !important;
}

.aicrm-window-icon {
  display: inline-block;
  height: 14px;
  position: relative;
  width: 14px;
  z-index: 1;
}

.aicrm-window-icon-minimize::before {
  background: currentColor;
  content: "";
  height: 1.5px;
  left: 2px;
  position: absolute;
  top: 9px;
  width: 10px;
}

.aicrm-window-icon-maximize::before {
  border: 1.4px solid currentColor;
  content: "";
  height: 9px;
  left: 2px;
  position: absolute;
  top: 2px;
  width: 9px;
}

.aicrm-window-icon-maximize::after {
  border: 1.4px solid currentColor;
  content: "";
  display: none;
  height: 8px;
  left: 5px;
  position: absolute;
  top: 1px;
  width: 8px;
}

#${CONTROLS_ID}.is-maximized .aicrm-window-icon-maximize::before {
  height: 8px;
  left: 1px;
  top: 5px;
  width: 8px;
}

#${CONTROLS_ID}.is-maximized .aicrm-window-icon-maximize::after {
  display: block;
}

.aicrm-window-icon-close::before,
.aicrm-window-icon-close::after {
  background: currentColor;
  content: "";
  height: 1.5px;
  left: 2px;
  position: absolute;
  top: 6px;
  width: 10px;
}

.aicrm-window-icon-close::before {
  transform: rotate(45deg);
}

.aicrm-window-icon-close::after {
  transform: rotate(-45deg);
}

#${FLOATING_CHROME_ID} {
  align-items: stretch;
  display: flex;
  height: var(--aicrm-desktop-topbar-height);
  left: 0;
  pointer-events: none;
  position: fixed;
  right: 0;
  top: 0;
  z-index: 2147483647;
}

#${FLOATING_CHROME_ID}.is-hidden {
  display: none;
}

#${FLOATING_CHROME_ID}.is-obscured-by-app-overlay {
  display: none;
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
}

#${FLOATING_CHROME_ID}.is-integrated {
  -webkit-app-region: no-drag;
  justify-content: flex-end;
  left: auto;
  pointer-events: auto;
  width: var(--aicrm-window-controls-width);
}

.aicrm-floating-window-drag-region {
  -webkit-app-region: drag;
  flex: 1 1 auto;
  min-width: 80px;
  pointer-events: auto;
}

#${FLOATING_CHROME_ID}.is-integrated .aicrm-floating-window-drag-region {
  display: none;
  pointer-events: none;
}

#${FLOATING_CHROME_ID} .aicrm-window-controls {
  align-self: stretch;
  background: rgba(255, 249, 236, 0.82);
  border: 1px solid var(--aicrm-window-border);
  border-radius: 0 0 0 10px;
  border-right: 0;
  border-top: 0;
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.08);
  height: 36px;
  margin-left: 0;
  pointer-events: auto;
}

#${FLOATING_CHROME_ID}.is-integrated .aicrm-window-controls {
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  height: var(--aicrm-desktop-topbar-height);
}

@media (prefers-color-scheme: dark) {
  #${FLOATING_CHROME_ID} .aicrm-window-controls {
    background: rgba(23, 23, 23, 0.86);
    box-shadow: none;
  }
}
`;

type ChromeTarget = {
  host: HTMLElement;
  mount: HTMLElement;
};

const boundDoubleClickHosts = new WeakSet<HTMLElement>();
let lastWindowControlActionAt = 0;
let syncQueued = false;

function injectWindowChromeStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = WINDOW_CHROME_CSS;
  document.head.appendChild(style);
}

function invokeWindowChannel<T>(channel: string): Promise<T> {
  return ipcRenderer.invoke(channel) as Promise<T>;
}

function updateChromeState(controls: HTMLElement, state: DesktopWindowState): void {
  controls.classList.toggle("is-maximized", state.isMaximized);
  const toggleButton = controls.querySelector<HTMLButtonElement>('button[data-window-action="toggle-maximize"]');
  if (!toggleButton) return;
  const label = state.isMaximized ? "Restore window" : "Maximize window";
  toggleButton.setAttribute("aria-label", label);
  toggleButton.title = label;
}

function clearWindowControlInteraction(controls: HTMLElement): void {
  controls.querySelectorAll<HTMLButtonElement>(".aicrm-window-control").forEach((button) => {
    button.classList.remove("is-hovered", "is-pressed");
  });
}

function applyWindowControlHover(controls: HTMLElement, target: EventTarget | null): void {
  const hoveredButton = target instanceof HTMLElement ? target.closest<HTMLButtonElement>(".aicrm-window-control") : null;
  controls.querySelectorAll<HTMLButtonElement>(".aicrm-window-control").forEach((button) => {
    button.classList.toggle("is-hovered", button === hoveredButton);
    if (button !== hoveredButton) button.classList.remove("is-pressed");
  });
}

function getWindowControlButton(target: EventTarget | null): HTMLButtonElement | null {
  return target instanceof HTMLElement ? target.closest<HTMLButtonElement>(".aicrm-window-control") : null;
}

function isPointInsideElement(element: HTMLElement, clientX: number, clientY: number): boolean {
  const rect = element.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function handleWindowControlAction(controls: HTMLElement, button: HTMLButtonElement): void {
  const now = Date.now();
  if (now - lastWindowControlActionAt < 180) return;
  lastWindowControlActionAt = now;

  const action = button.dataset.windowAction;
  if (action === "minimize") {
    void invokeWindowChannel<DesktopWindowState>(IPC_CHANNELS.windowMinimize).then((state) => {
      updateChromeState(controls, state);
    });
    return;
  }
  if (action === "toggle-maximize") {
    void invokeWindowChannel<DesktopWindowState>(IPC_CHANNELS.windowToggleMaximize).then((state) => {
      updateChromeState(controls, state);
    });
    return;
  }
  if (action === "close") {
    void invokeWindowChannel<boolean>(IPC_CHANNELS.windowClose);
  }
}

function createWindowControls(): HTMLElement {
  const existing = document.getElementById(CONTROLS_ID);
  if (existing) return existing;

  const controls = document.createElement("div");
  controls.id = CONTROLS_ID;
  controls.className = "aicrm-window-controls";
  controls.style.setProperty("-webkit-app-region", "no-drag");
  controls.innerHTML = `
    <button class="aicrm-window-control" type="button" aria-label="Minimize window" title="Minimize window" data-window-action="minimize">
      <span class="aicrm-window-icon aicrm-window-icon-minimize" aria-hidden="true"></span>
    </button>
    <button class="aicrm-window-control" type="button" aria-label="Maximize window" title="Maximize window" data-window-action="toggle-maximize">
      <span class="aicrm-window-icon aicrm-window-icon-maximize" aria-hidden="true"></span>
    </button>
    <button class="aicrm-window-control aicrm-window-control-close" type="button" aria-label="Close window" title="Close window" data-window-action="close">
      <span class="aicrm-window-icon aicrm-window-icon-close" aria-hidden="true"></span>
    </button>
  `;

  controls.querySelectorAll<HTMLButtonElement>(".aicrm-window-control").forEach((button) => {
    button.style.setProperty("-webkit-app-region", "no-drag");
  });

  controls.addEventListener("pointerover", (event) => {
    applyWindowControlHover(controls, event.target);
  });

  controls.addEventListener("pointermove", (event) => {
    if (!isPointInsideElement(controls, event.clientX, event.clientY)) {
      clearWindowControlInteraction(controls);
      return;
    }
    applyWindowControlHover(controls, event.target);
  });

  controls.addEventListener("pointerout", (event) => {
    if (event.relatedTarget instanceof Node && controls.contains(event.relatedTarget)) return;
    clearWindowControlInteraction(controls);
  });

  controls.addEventListener("pointerdown", (event) => {
    const button = getWindowControlButton(event.target);
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    applyWindowControlHover(controls, button);
    button.classList.add("is-pressed");
  });

  controls.addEventListener("pointerup", (event) => {
    const button = getWindowControlButton(event.target);
    controls.querySelectorAll<HTMLButtonElement>(".aicrm-window-control").forEach((controlButton) => {
      controlButton.classList.remove("is-pressed");
    });
    if (!button || !isPointInsideElement(controls, event.clientX, event.clientY)) {
      clearWindowControlInteraction(controls);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    applyWindowControlHover(controls, button);
    handleWindowControlAction(controls, button);
  });

  controls.addEventListener("mouseup", (event) => {
    const button = getWindowControlButton(event.target);
    controls.querySelectorAll<HTMLButtonElement>(".aicrm-window-control").forEach((controlButton) => {
      controlButton.classList.remove("is-pressed");
    });
    if (!button || !isPointInsideElement(controls, event.clientX, event.clientY)) {
      clearWindowControlInteraction(controls);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    applyWindowControlHover(controls, button);
    handleWindowControlAction(controls, button);
  });

  controls.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  controls.addEventListener("pointercancel", () => {
    clearWindowControlInteraction(controls);
  });

  document.addEventListener(
    "pointermove",
    (event) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (target instanceof Node && controls.contains(target) && isPointInsideElement(controls, event.clientX, event.clientY)) {
        applyWindowControlHover(controls, target);
        return;
      }
      clearWindowControlInteraction(controls);
    },
    true
  );

  document.addEventListener(
    "mouseout",
    (event) => {
      if (event.relatedTarget === null) clearWindowControlInteraction(controls);
    },
    true
  );

  document.documentElement.addEventListener("pointerleave", () => clearWindowControlInteraction(controls));
  window.addEventListener("mouseout", (event) => {
    if (event.relatedTarget === null) clearWindowControlInteraction(controls);
  });
  window.addEventListener("blur", () => clearWindowControlInteraction(controls));

  ipcRenderer.on(IPC_CHANNELS.windowStateChanged, (_event, state: DesktopWindowState) => {
    updateChromeState(controls, state);
  });

  void invokeWindowChannel<DesktopWindowState>(IPC_CHANNELS.windowGetState).then((state) => {
    updateChromeState(controls, state);
  });

  return controls;
}

function createFloatingChrome(): HTMLElement {
  const existing = document.getElementById(FLOATING_CHROME_ID);
  if (existing) return existing;

  const chrome = document.createElement("div");
  chrome.id = FLOATING_CHROME_ID;
  chrome.innerHTML = '<div class="aicrm-floating-window-drag-region"></div>';
  chrome.style.setProperty("-webkit-app-region", "no-drag");
  document.body.appendChild(chrome);
  bindDoubleClickToToggle(chrome);
  return chrome;
}

function hasBlockingAppOverlay(): boolean {
  const overlay = document.querySelector<HTMLElement>(
    ".ant-drawer-open, .ant-modal-root .ant-modal-wrap, .ant-modal-root .ant-modal-mask"
  );
  if (!overlay) return false;

  const style = window.getComputedStyle(overlay);
  if (style.display === "none" || style.visibility === "hidden") return false;

  const rect = overlay.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function updateFloatingChromeOverlayState(floatingChrome: HTMLElement): void {
  const isOverlayActive = hasBlockingAppOverlay();
  floatingChrome.classList.toggle("is-obscured-by-app-overlay", isOverlayActive);
  document.body.classList.toggle("aicrm-app-overlay-active", isOverlayActive);
  if (isOverlayActive) {
    const controls = document.getElementById(CONTROLS_ID);
    if (controls) clearWindowControlInteraction(controls);
  }
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'button, a, input, textarea, select, [role="button"], .ant-btn, .ant-dropdown-trigger, .ant-select, .ant-segmented, .ant-badge, .app-mode-segmented, .app-header-actions, .aicrm-window-controls'
    )
  );
}

function bindDoubleClickToToggle(host: HTMLElement): void {
  if (boundDoubleClickHosts.has(host)) return;
  boundDoubleClickHosts.add(host);
  host.addEventListener("dblclick", (event) => {
    if (isInteractiveTarget(event.target)) return;
    const controls = createWindowControls();
    void invokeWindowChannel<DesktopWindowState>(IPC_CHANNELS.windowToggleMaximize).then((state) =>
      updateChromeState(controls, state)
    );
  });
}

function resolveIntegratedTarget(): ChromeTarget | null {
  const appHeader = document.querySelector<HTMLElement>(".app-header");
  if (appHeader) {
    return {
      host: appHeader,
      mount: appHeader.querySelector<HTMLElement>(":scope > .ant-space") ?? appHeader
    };
  }

  const globalHeader = document.querySelector<HTMLElement>(".global-account-header");
  if (globalHeader) {
    return { host: globalHeader, mount: globalHeader };
  }

  const workspaceHeader = document.querySelector<HTMLElement>(".workspace-selection-header");
  if (workspaceHeader) {
    return { host: workspaceHeader, mount: workspaceHeader };
  }

  return null;
}

function markActiveHost(host: HTMLElement | null): void {
  document.querySelectorAll<HTMLElement>(`.${HOST_CLASS}`).forEach((element) => {
    if (element !== host) element.classList.remove(HOST_CLASS);
  });

  if (host) {
    host.classList.add(HOST_CLASS);
    bindDoubleClickToToggle(host);
  }
}

function syncWindowChrome(): void {
  injectWindowChromeStyle();
  document.documentElement.classList.add("aicrm-desktop-window-root");
  document.body.classList.add("aicrm-desktop-window-chrome-enabled");

  const controls = createWindowControls();
  const floatingChrome = createFloatingChrome();
  const target = resolveIntegratedTarget();

  if (target) {
    markActiveHost(target.host);
    floatingChrome.appendChild(controls);
    floatingChrome.style.setProperty("-webkit-app-region", "no-drag");
    floatingChrome.classList.add("is-integrated");
    floatingChrome.classList.remove("is-hidden");
    updateFloatingChromeOverlayState(floatingChrome);
    return;
  }

  markActiveHost(null);
  floatingChrome.appendChild(controls);
  floatingChrome.style.removeProperty("-webkit-app-region");
  floatingChrome.classList.remove("is-integrated");
  floatingChrome.classList.remove("is-hidden");
  updateFloatingChromeOverlayState(floatingChrome);
}

function scheduleSyncWindowChrome(): void {
  if (syncQueued) return;
  syncQueued = true;
  window.requestAnimationFrame(() => {
    syncQueued = false;
    syncWindowChrome();
  });
}

function mountWindowChrome(): void {
  syncWindowChrome();

  const observer = new MutationObserver(() => {
    scheduleSyncWindowChrome();
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"], childList: true, subtree: true });
}

export function installDesktopWindowChrome(): void {
  if (typeof document === "undefined") return;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountWindowChrome, { once: true });
    return;
  }

  mountWindowChrome();
}
