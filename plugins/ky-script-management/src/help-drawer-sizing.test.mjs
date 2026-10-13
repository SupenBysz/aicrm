import assert from "node:assert/strict";
import test from "node:test";
import { clampHelpDrawerWidth, HELP_DRAWER_WIDTH_STORAGE_KEY, nudgeHelpDrawerWidth, readHelpDrawerWidth, resizeHelpDrawerWidth, writeHelpDrawerWidth } from "./help-drawer-sizing.ts";

test("帮助抽屉宽度按默认值、边界和视口约束计算", () => {
  assert.equal(clampHelpDrawerWidth(900, 1920), 900);
  assert.equal(clampHelpDrawerWidth(100, 1920), 560);
  assert.equal(clampHelpDrawerWidth(2000, 1920), 1600);
  assert.equal(clampHelpDrawerWidth(900, 700), 684);
  assert.equal(clampHelpDrawerWidth(100, 700), 560);
  assert.equal(clampHelpDrawerWidth(2000, 700), 684);
  assert.equal(clampHelpDrawerWidth(900, 500), 484);
  assert.equal(clampHelpDrawerWidth(900, 320), 304);
  assert.equal(clampHelpDrawerWidth(900, 100), 84);
});

test("帮助抽屉从实际显示宽度开始按拖拽方向调整", () => {
  const displayedWidth = clampHelpDrawerWidth(900, 500);
  assert.equal(displayedWidth, 484);
  assert.equal(resizeHelpDrawerWidth(displayedWidth, 1000, 900, 1200), 584);
  assert.equal(resizeHelpDrawerWidth(displayedWidth, 1000, 1100, 1200), 560);
  assert.equal(resizeHelpDrawerWidth(displayedWidth, 1000, 700, 1200), 784);
  assert.equal(resizeHelpDrawerWidth(displayedWidth, 1000, 0, 500), 484);
  assert.equal(resizeHelpDrawerWidth(560, 1000, 976, 1200), 584);
  assert.equal(resizeHelpDrawerWidth(560, 1000, 1024, 1200), 560);
});

test("方向键从当前实际显示宽度开始增减", () => {
  assert.equal(nudgeHelpDrawerWidth(900, -24, 500), 484);
  assert.equal(nudgeHelpDrawerWidth(900, 24, 500), 484);
  assert.equal(nudgeHelpDrawerWidth(900, -24, 700), 660);
  assert.equal(nudgeHelpDrawerWidth(900, 24, 700), 684);
  assert.equal(nudgeHelpDrawerWidth(560, -24, 1200), 560);
  assert.equal(nudgeHelpDrawerWidth(560, 24, 1200), 584);
});

test("帮助抽屉宽度偏好安全读写并按视口约束", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
  assert.equal(readHelpDrawerWidth(storage, 1920), 900);
  values.set(HELP_DRAWER_WIDTH_STORAGE_KEY, "720");
  assert.equal(readHelpDrawerWidth(storage, 1920), 720);
  values.set(HELP_DRAWER_WIDTH_STORAGE_KEY, "900");
  assert.equal(readHelpDrawerWidth(storage, 700), 684);
  for (const invalid of ["", "0", "-1", "nope"]) {
    values.set(HELP_DRAWER_WIDTH_STORAGE_KEY, invalid);
    assert.equal(readHelpDrawerWidth(storage, 1920), 900);
  }
  writeHelpDrawerWidth(storage, 900, 700);
  assert.equal(values.get(HELP_DRAWER_WIDTH_STORAGE_KEY), "684");
  assert.equal(readHelpDrawerWidth({getItem: () => { throw new Error("blocked") }, setItem: storage.setItem}, 1920), 900);
  assert.doesNotThrow(() => writeHelpDrawerWidth({getItem: storage.getItem, setItem: () => { throw new Error("blocked") }}, 900, 1920));
});
