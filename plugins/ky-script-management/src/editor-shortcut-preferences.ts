export type EditorShortcutCommand = "completion" | "find" | "replace";
export type EditorShortcutPreferences = Record<EditorShortcutCommand, string>;
export type ShortcutPlatform = "mac" | "other";

export type EditorShortcutAction = {
  command: EditorShortcutCommand;
  shortcut: string;
};

const namedKeyCodes: Record<string, string> = {
  SPACE: "Space", ENTER: "Enter", RETURN: "Enter", TAB: "Tab", ESC: "Escape", ESCAPE: "Escape",
  BACKSPACE: "Backspace", DELETE: "Delete", INSERT: "Insert", HOME: "Home", END: "End",
  PAGEUP: "PageUp", PAGEDOWN: "PageDown", ARROWLEFT: "LeftArrow", LEFT: "LeftArrow",
  ARROWRIGHT: "RightArrow", RIGHT: "RightArrow", ARROWUP: "UpArrow", UP: "UpArrow",
  ARROWDOWN: "DownArrow", DOWN: "DownArrow", SEMICOLON: "Semicolon", EQUAL: "Equal",
  COMMA: "Comma", MINUS: "Minus", PERIOD: "Period", SLASH: "Slash", BACKQUOTE: "Backquote",
  BRACKETLEFT: "BracketLeft", BACKSLASH: "Backslash", BRACKETRIGHT: "BracketRight", QUOTE: "Quote"
};

const displayKeys: Record<string, string> = {
  SPACE: "Space", ENTER: "Enter", ESCAPE: "Esc", BACKSPACE: "Backspace", DELETE: "Delete",
  INSERT: "Insert", HOME: "Home", END: "End", PAGEUP: "Page Up", PAGEDOWN: "Page Down",
  ARROWLEFT: "←", LEFT: "←", ARROWRIGHT: "→", RIGHT: "→", ARROWUP: "↑", UP: "↑",
  ARROWDOWN: "↓", DOWN: "↓", SEMICOLON: ";", EQUAL: "=", COMMA: ",", MINUS: "-",
  PERIOD: ".", SLASH: "/", BACKQUOTE: "`", BRACKETLEFT: "[", BACKSLASH: "\\", BRACKETRIGHT: "]", QUOTE: "'"
};

export function shortcutPlatform(platform: string | null | undefined): ShortcutPlatform {
  return /mac|iphone|ipad|darwin/i.test(platform ?? "") ? "mac" : "other";
}

export function defaultEditorShortcuts(platform: ShortcutPlatform): EditorShortcutPreferences {
  return {
    completion: "",
    find: "Mod+F",
    replace: platform === "mac" ? "Mod+Alt+F" : "Mod+H"
  };
}

function normalizeKey(value: string): string | null {
  const raw = value.trim();
  if (/^[a-z]$/i.test(raw)) return raw.toUpperCase();
  if (/^\d$/.test(raw)) return raw;
  if (/^F(?:[1-9]|1\d|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  const alias = raw.replace(/[\s_-]/g, "").toUpperCase();
  if (namedKeyCodes[alias]) return alias === "RETURN" ? "Enter" : alias === "ESC" ? "Escape" : raw[0].toUpperCase() + raw.slice(1);
  return null;
}

export function normalizeEditorShortcut(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const parts = value.split("+").map(part => part.trim()).filter(Boolean);
  if (!parts.length) return "";
  const modifiers = new Set<string>();
  let key: string | null = null;
  for (const part of parts) {
    const modifier = part.toLowerCase();
    if (["mod", "ctrl", "control", "cmd", "command", "meta", "⌘"].includes(modifier)) {
      if (modifiers.has("Mod")) return "";
      modifiers.add("Mod");
      continue;
    }
    if (["shift", "⇧"].includes(modifier)) {
      if (modifiers.has("Shift")) return "";
      modifiers.add("Shift");
      continue;
    }
    if (["alt", "option", "⌥"].includes(modifier)) {
      if (modifiers.has("Alt")) return "";
      modifiers.add("Alt");
      continue;
    }
    if (key) return "";
    key = normalizeKey(part);
    if (!key) return "";
  }
  if (!key || modifiers.size === 0) return "";
  return [...["Mod", "Shift", "Alt"].filter(item => modifiers.has(item)), key].join("+");
}

export function normalizeEditorShortcutPreferences(value: unknown, platform: ShortcutPlatform): EditorShortcutPreferences {
  const stored = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const defaults = defaultEditorShortcuts(platform);
  return {
    completion: normalizeEditorShortcut(stored.completionShortcut ?? stored.shortcut),
    find: stored.findShortcut === undefined ? defaults.find : normalizeEditorShortcut(stored.findShortcut),
    replace: stored.replaceShortcut === undefined ? defaults.replace : normalizeEditorShortcut(stored.replaceShortcut)
  };
}

export function validateEditorShortcuts(shortcuts: EditorShortcutPreferences): string | null {
  for (const command of ["completion", "find", "replace"] as const) {
    const value = shortcuts[command];
    if (value && !normalizeEditorShortcut(value)) return `${command}:invalid`;
  }
  if (shortcuts.completion === "Mod+F" || shortcuts.replace === "Mod+F") return "Mod+F 仅可分配给查找";
  const used = new Map<string, EditorShortcutCommand>();
  for (const command of ["completion", "find", "replace"] as const) {
    const shortcut = normalizeEditorShortcut(shortcuts[command]);
    if (!shortcut) continue;
    const previous = used.get(shortcut);
    if (previous) return `快捷键冲突：${previous} 与 ${command}`;
    used.set(shortcut, command);
  }
  return null;
}

export function editorShortcutActions(shortcuts: EditorShortcutPreferences, _platform: ShortcutPlatform, readOnly: boolean): EditorShortcutAction[] {
  if (validateEditorShortcuts(shortcuts)) return [];
  const actions: EditorShortcutAction[] = [];
  for (const command of ["completion", "find", "replace"] as const) {
    const shortcut = normalizeEditorShortcut(shortcuts[command]);
    if (shortcut && (command !== "replace" || !readOnly)) actions.push({ command, shortcut });
  }
  return actions;
}

export function shortcutKeyCodeName(shortcut: string): string | null {
  const normalized = normalizeEditorShortcut(shortcut);
  if (!normalized) return null;
  const key = normalized.split("+").at(-1)!;
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(key)) return key;
  return namedKeyCodes[key.replace(/[\s_-]/g, "").toUpperCase()] ?? null;
}

export function displayEditorShortcut(shortcut: string, platform: ShortcutPlatform): string {
  const normalized = normalizeEditorShortcut(shortcut);
  if (!normalized) return "未配置";
  return normalized.split("+").map(part => {
    if (part === "Mod") return platform === "mac" ? "⌘" : "Ctrl";
    if (part === "Alt") return platform === "mac" ? "⌥" : "Alt";
    if (part === "Shift") return platform === "mac" ? "⇧" : "Shift";
    return displayKeys[part.toUpperCase()] ?? part;
  }).join(platform === "mac" ? "" : "+");
}

export function shortcutKeyFromEvent(event: { key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): string {
  const code = event.code;
  const key = code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code.startsWith("Numpad") && /^Numpad\d$/.test(code) ? code.slice(6) : code;
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return "";
  const parts = [event.metaKey || event.ctrlKey ? "Mod" : "", event.shiftKey ? "Shift" : "", event.altKey ? "Alt" : "", normalizedKey].filter(Boolean);
  return normalizeEditorShortcut(parts.join("+"));
}
