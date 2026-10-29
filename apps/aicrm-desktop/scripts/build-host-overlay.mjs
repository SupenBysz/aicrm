import {build} from 'esbuild';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=root+'apps/aicrm-desktop/out/native-overlay';mkdirSync(out,{recursive:true});
await build({entryPoints:[root+'apps/ky-admin-host/src/native-overlay/main.tsx'],bundle:true,platform:'browser',format:'iife',outfile:out+'/index.js',minify:true,nodePaths:[root+'apps/ky-admin-host/node_modules'],alias:{'@ky/admin-core':root+'packages/ky-admin-core/src/index.ts','antd':root+'apps/ky-admin-host/node_modules/antd','react':root+'apps/ky-admin-host/node_modules/react','react-dom':root+'apps/ky-admin-host/node_modules/react-dom','@ant-design/icons':root+'apps/ky-admin-host/node_modules/@ant-design/icons'},define:{'process.env.NODE_ENV':'"production"'},jsx:'automatic'});
writeFileSync(out+'/index.html','<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><link rel="stylesheet" href="index.css"><style>html,body,#root{margin:0;width:100%;height:100%;background:transparent}</style></head><body><div id="root"></div><script src="index.js"></script></body></html>');
