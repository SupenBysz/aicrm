import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
const root=resolve(import.meta.dirname,'..');
const {build}=createRequire(resolve(root,'apps/aicrm-desktop/package.json'))('esbuild');

test('Core public dist entry bundles its theme stylesheet without Host source aliases',async()=>{
 const result=await build({
  stdin:{contents:"import {AppearanceControls} from '@ky/admin-core'; console.log(AppearanceControls);",resolveDir:resolve(root,'apps/ky-admin-host'),loader:'tsx'},
  // Deliberately bypass Host tsconfig paths and Vite source aliases.
  tsconfigRaw:{compilerOptions:{}},bundle:true,platform:'browser',format:'esm',write:false,
  outdir:resolve(root,'tmp/admin-core-package-check'),metafile:true,logLevel:'silent',
  external:['react','react-dom','antd','@ant-design/icons','react-router-dom']
 });
 const inputs=Object.keys(result.metafile.inputs).map(p=>resolve(p));
 assert.ok(inputs.some(p=>p.endsWith('/ky-admin-core/dist/index.js')),'must consume the declared public package entry');
 assert.ok(!inputs.some(p=>p.includes('/ky-admin-core/src/')),'must not silently use Core source aliases');
 assert.ok(inputs.some(p=>p.endsWith('/ky-admin-core/dist/theme/controls.css')),'CSS must come from the build output');
 assert.ok(existsSync(resolve(root,'packages/ky-admin-core/dist/theme/controls.css')));
 const css=result.outputFiles.find(f=>f.path.endsWith('.css'));
 assert.ok(css,'consumer must receive a real CSS bundle');
 assert.match(css.text,/appearance-theme-grid/);
 assert.match(css.text,/grid-template-columns/);
});
