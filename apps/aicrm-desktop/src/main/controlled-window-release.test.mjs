import assert from "node:assert/strict";
import test from "node:test";

import { closeControlledWindow, controlledWindowReleaseMode } from "./controlled-window-release.ts";

class FakeWindow {
  #closedListener;
  #destroyed = false;

  constructor({ closeSucceeds = false, destroySucceeds = true } = {}) {
    this.closeSucceeds = closeSucceeds;
    this.destroySucceeds = destroySucceeds;
  }

  once(event, listener) {
    assert.equal(event, "closed");
    this.#closedListener = listener;
  }

  close() {
    if (this.closeSucceeds) this.#completeClose();
  }

  destroy() {
    if (this.destroySucceeds) this.#completeClose();
  }

  isDestroyed() {
    return this.#destroyed;
  }

  #completeClose() {
    this.#destroyed = true;
    this.#closedListener?.();
  }
}

const immediateDelay = async () => undefined;

test("normal BrowserWindow close is confirmed by the closed event", async () => {
  assert.equal(await closeControlledWindow(new FakeWindow({ closeSucceeds: true }), immediateDelay), true);
});

test("a cancelled close is force-destroyed and confirmed", async () => {
  assert.equal(await closeControlledWindow(new FakeWindow(), immediateDelay), true);
});

test("release fails closed when neither close nor destroy completes", async () => {
  assert.equal(
    await closeControlledWindow(new FakeWindow({ closeSucceeds: false, destroySucceeds: false }), immediateDelay),
    false
  );
});

test("an explicit deferred release does not depend on native identity detection", () => {
  assert.equal(
    controlledWindowReleaseMode({ releaseWindowOnDetect: true, hasDetectedIdentity: false }),
    "before_detect"
  );
  assert.equal(
    controlledWindowReleaseMode({ releaseWindowOnDetect: false, hasDetectedIdentity: true }),
    "keep"
  );
  assert.equal(
    controlledWindowReleaseMode({ hasDetectedIdentity: true }),
    "after_detect"
  );
});
