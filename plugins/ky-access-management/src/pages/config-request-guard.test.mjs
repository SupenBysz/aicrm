import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigRequestGuard } from './config-request-guard.ts';
test('late menu, scope and previous drawer responses cannot become current', () => {
  const guard = new ConfigRequestGuard();
  const a = guard.begin('management/A/platform/root/workspace');
  const b = guard.begin('management/B/platform/root/workspace');
  assert.equal(guard.current(a), false);
  assert.equal(guard.current(b), true);
  const common = guard.begin('management/B/platform/root/common');
  assert.equal(guard.current(b), false);
  guard.invalidate();
  assert.equal(guard.current(common), false);
  const reopened = guard.begin(common.target);
  assert.equal(guard.current(common), false);
  assert.equal(guard.current(reopened), true);
});
