import assert from "node:assert/strict";
import test from "node:test";
import { applyVersionDialogTheme, createVersionDialogController } from "./version-info-dialog-controller.ts";

function harness() {
  const parents = new Map();
  const dialogs = new Map();
  let nextId = 0;
  const port = {
    parentAlive: (parent) => parents.get(parent)?.alive === true,
    dialogAlive: (dialog) => dialogs.get(dialog)?.alive === true,
    create: (parent) => {
      const dialog = { id: ++nextId, parent };
      dialogs.set(dialog, { alive: true, focus: 0, close: 0, theme: "light", closed: new Set() });
      return dialog;
    },
    focus: (dialog) => { dialogs.get(dialog).focus += 1; },
    close: (dialog) => {
      const state = dialogs.get(dialog);
      if (!state?.alive) return;
      state.alive = false;
      state.close += 1;
      for (const listener of [...state.closed]) listener();
    },
    setTheme: (dialog, theme) => { dialogs.get(dialog).theme = theme; },
    onDialogClosed: (dialog, listener) => {
      const state = dialogs.get(dialog);
      state.closed.add(listener);
      return () => state.closed.delete(listener);
    },
    onParentClosed: (parent, listener) => {
      const state = parents.get(parent);
      state.closed.add(listener);
      return () => state.closed.delete(listener);
    }
  };
  return {
    controller: createVersionDialogController(port),
    dialogs,
    parents,
    makeParent() {
      const parent = { id: parents.size + 1 };
      parents.set(parent, { alive: true, closed: new Set() });
      return parent;
    },
    destroyParent(parent) {
      const state = parents.get(parent);
      state.alive = false;
      for (const listener of [...state.closed]) listener();
    }
  };
}

test("reopening the native version dialog reuses and focuses the existing window", () => {
  const h = harness();
  const parent = h.makeParent();
  const first = h.controller.open(parent);
  const second = h.controller.open(parent);
  assert.equal(second, first);
  assert.equal(h.dialogs.size, 1);
  assert.equal(h.dialogs.get(first).focus, 1);
});

test("closing the parent destroys its dialog and clears the reusable instance", () => {
  const h = harness();
  const parent = h.makeParent();
  const first = h.controller.open(parent);
  h.destroyParent(parent);
  assert.equal(h.dialogs.get(first).alive, false);
  assert.equal(h.controller.ownerOf(first), null);
  assert.equal(h.controller.open(parent), null);
});

test("only an owned dialog is accepted for read and close operations", () => {
  const h = harness();
  const parent = h.makeParent();
  const dialog = h.controller.open(parent);
  const foreign = { id: 999 };
  assert.equal(h.controller.ownerOf(dialog), parent);
  assert.equal(h.controller.ownerOf(foreign), null);
  assert.equal(h.controller.closeDialog(foreign), false);
  assert.equal(h.controller.closeDialog(dialog), true);
  assert.equal(h.controller.ownerOf(dialog), null);
});

test("manual light/dark theme updates reach every open dialog", () => {
  const h = harness();
  const one = h.controller.open(h.makeParent());
  const two = h.controller.open(h.makeParent());
  h.controller.setTheme("dark");
  assert.equal(h.dialogs.get(one).theme, "dark");
  assert.equal(h.dialogs.get(two).theme, "dark");
  h.controller.setTheme("light");
  assert.equal(h.dialogs.get(one).theme, "light");
});

test("the host theme path applies only light/dark values and ignores malformed values", () => {
  const h = harness();
  const dialog = h.controller.open(h.makeParent());
  let currentTheme = "light";
  const update = (value) => applyVersionDialogTheme(value, h.controller, (theme) => { currentTheme = theme; });

  assert.equal(update("dark"), true);
  assert.equal(currentTheme, "dark");
  assert.equal(h.dialogs.get(dialog).theme, "dark");
  assert.equal(update("system"), false);
  assert.equal(update(null), false);
  assert.equal(currentTheme, "dark");
  assert.equal(h.dialogs.get(dialog).theme, "dark");
  assert.equal(update("light"), true);
  assert.equal(currentTheme, "light");
  assert.equal(h.dialogs.get(dialog).theme, "light");
});
