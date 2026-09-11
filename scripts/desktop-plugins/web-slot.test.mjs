import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../apps/ky-admin-host/src/desktop-plugin-slot.tsx', import.meta.url), 'utf8');

test('A09 Web 槽重复挂载具备独立 unsubscribe、live 门闸和注销', () => {
  assert.match(source, /let live=true/);
  assert.match(source, /const off=bridge\.onChanged/);
  assert.match(source, /return\(\)=>\{live=false;off\(\);void bridge\.unregisterUi\(\)/);
  assert.match(source, /if\(!live\)return/);
  assert.equal((source.match(/bridge\.onChanged\(/g) ?? []).length, 1);
  assert.equal((source.match(/bridge\.registerUi\(/g) ?? []).length, 1);
});

test('A09 Web 槽 gap 会重新读取快照，乱序增量不会倒退', () => {
  assert.match(source, /s\.nativeSequence<latest\.nativeSequence\)return/);
  assert.match(source, /s\.nativeSequence>latest\.nativeSequence\+1/);
  assert.match(source, /void bridge\.getSnapshot\(\)\.then\(apply\)/);
  assert.match(source, /buffered\.push\(s\)/);
  assert.match(source, /buffered\.length>64/);
});

test('A09 Web 槽跨 runtime epoch 不接受旧事件，注册失败安全降级', () => {
  assert.match(source, /s\.runtimeEpoch===latest\.runtimeEpoch/);
  assert.match(source, /const epochs=new Set/);
  assert.match(source, /epochs\.has\(s\.runtimeEpoch\)/);
  assert.match(source, /registerUi\([^)]*\)\.then\(s=>/);
  assert.match(source, /\.catch\(\(\)=>\{\}\)/);
  assert.match(source, /if\(!snapshot\?\.items\.length\)return <ClientVersion\/>/);
});

test('B08 兼容矩阵：状态栏槽只声明固定 uiApi，未知项目类型无渲染入口', () => {
  assert.match(source, /uiApiVersion:'1\.0\.0'/);
  assert.match(source, /slots:\['statusBar\.right'\]/);
  assert.match(source, /item\.type==='button'\?/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(source, /window\.aicrm/);
});

test('B09 组件通过既有 desktop-plugin-item 槽类，不创建遮挡层或固定定位', () => {
  assert.match(source, /className="desktop-plugin-item"/);
  assert.doesNotMatch(source, /position:\s*fixed/);
  assert.doesNotMatch(source, /z-index/);
});
