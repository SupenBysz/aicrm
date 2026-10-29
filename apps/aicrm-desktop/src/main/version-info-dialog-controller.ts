export type VersionDialogTheme = "light" | "dark";

/** Applies only recognized host themes; malformed IPC/theme values never become light mode. */
export function applyVersionDialogTheme(
  value: unknown,
  controller: { setTheme: (theme: VersionDialogTheme) => void },
  updateCurrentTheme: (theme: VersionDialogTheme) => void
): boolean {
  if (value !== "light" && value !== "dark") return false;
  updateCurrentTheme(value);
  controller.setTheme(value);
  return true;
}

export interface VersionDialogControllerPort<TParent, TDialog> {
  parentAlive(parent: TParent): boolean;
  dialogAlive(dialog: TDialog): boolean;
  create(parent: TParent): TDialog;
  focus(dialog: TDialog): void;
  close(dialog: TDialog): void;
  setTheme(dialog: TDialog, theme: VersionDialogTheme): void;
  onDialogClosed(dialog: TDialog, listener: () => void): () => void;
  onParentClosed(parent: TParent, listener: () => void): () => void;
}

interface Entry<TParent, TDialog> {
  parent: TParent;
  dialog: TDialog;
  disposeDialogClosed: () => void;
  disposeParentClosed: () => void;
}

/** Owns one reusable native version dialog per host window. */
export function createVersionDialogController<TParent, TDialog>(port: VersionDialogControllerPort<TParent, TDialog>) {
  const entries = new Map<TParent, Entry<TParent, TDialog>>();

  function dispose(entry: Entry<TParent, TDialog>): void {
    entry.disposeDialogClosed();
    entry.disposeParentClosed();
    if (entries.get(entry.parent) === entry) entries.delete(entry.parent);
  }

  function open(parent: TParent): TDialog | null {
    if (!port.parentAlive(parent)) return null;
    const existing = entries.get(parent);
    if (existing && port.dialogAlive(existing.dialog)) {
      port.focus(existing.dialog);
      return existing.dialog;
    }
    if (existing) dispose(existing);

    const dialog = port.create(parent);
    const entry: Entry<TParent, TDialog> = {
      parent,
      dialog,
      disposeDialogClosed: () => undefined,
      disposeParentClosed: () => undefined
    };
    entries.set(parent, entry);
    entry.disposeDialogClosed = port.onDialogClosed(dialog, () => dispose(entry));
    entry.disposeParentClosed = port.onParentClosed(parent, () => {
      if (entries.get(parent) === entry) {
        dispose(entry);
        if (port.dialogAlive(dialog)) port.close(dialog);
      }
    });
    return dialog;
  }

  function ownerOf(dialog: TDialog): TParent | null {
    for (const entry of entries.values()) if (entry.dialog === dialog && port.dialogAlive(dialog)) return entry.parent;
    return null;
  }

  function closeDialog(dialog: TDialog): boolean {
    for (const entry of entries.values()) {
      if (entry.dialog !== dialog) continue;
      dispose(entry);
      if (port.dialogAlive(dialog)) port.close(dialog);
      return true;
    }
    return false;
  }

  function closeForParent(parent: TParent): boolean {
    const entry = entries.get(parent);
    if (!entry) return false;
    dispose(entry);
    if (port.dialogAlive(entry.dialog)) port.close(entry.dialog);
    return true;
  }

  function setTheme(theme: VersionDialogTheme): void {
    for (const entry of entries.values()) if (port.dialogAlive(entry.dialog)) port.setTheme(entry.dialog, theme);
  }

  function closeAll(): void {
    for (const entry of [...entries.values()]) closeForParent(entry.parent);
  }

  return { open, ownerOf, closeDialog, closeForParent, setTheme, closeAll };
}
