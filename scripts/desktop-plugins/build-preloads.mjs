import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { rm, readFile } from 'node:fs/promises';
const require=createRequire(new URL('../../apps/aicrm-desktop/package.json',import.meta.url));const {build}=require('esbuild');const root=new URL('../../apps/aicrm-desktop/',import.meta.url).pathname;
for(const name of ['index','desktop-plugin','desktop-offline','version-info-dialog','host-overlay']){const output=resolve(root,'out/preload',name+'.js');await build({entryPoints:[resolve(root,'src/preload',name+'.ts')],outfile:output,bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron'],logLevel:'silent'});const text=await readFile(output,'utf8');if(/require\(["']\./.test(text))throw Error('preload 存在沙箱不支持的本地分块引用');}
await rm(resolve(root,'out/preload/chunks'),{recursive:true,force:true});console.log('五个固定 preload 已分别独立打包，无本地 require 分块');
