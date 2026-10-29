import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {buildSync}=createRequire(new URL('../../aicrm-desktop/package.json',import.meta.url))('esbuild');
const code=buildSync({entryPoints:[new URL('./desktop-session-sync.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false}).outputFiles[0].text;
const {createDesktopSessionCoordinator}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('desktop session writes are serialized, immutable and de-duplicated; logout is the last durable effect',async()=>{
 let session={token:'fixture-A',expiresAt:'2099-01-01'};const effects=[];let release;
 const coordinator=createDesktopSessionCoordinator(()=>session,{save:async value=>{effects.push(value.token);if(value.token==='fixture-A')await new Promise(resolve=>release=resolve);return true;},clear:async()=>{effects.push('clear');return true;}});
 const first=coordinator.sync();await Promise.resolve();await Promise.resolve();
 session={token:'fixture-B',expiresAt:'2099-01-02'};const second=coordinator.sync();const duplicate=coordinator.sync();
 session=null;const logout=coordinator.sync();release();await Promise.all([first,second,duplicate,logout]);
 assert.deepEqual(effects,['fixture-A','fixture-B','clear']);
});
test('a failed write is not acknowledged and can be retried without silently marking ready',async()=>{
 let calls=0;const coordinator=createDesktopSessionCoordinator(()=>({token:'fixture',expiresAt:'2099-01-01'}),{save:async()=>++calls>1,clear:async()=>true});
 await assert.rejects(coordinator.sync(),/同步失败/);await coordinator.sync();assert.equal(calls,2);
});
