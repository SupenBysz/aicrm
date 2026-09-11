import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventoryModel } from '../../apps/ky-admin-host/src/plugin-inventory-model.ts';
const row=(id,type='admin')=>({id,name:id,type,version:'1.0.0',services:[{key:'org',state:'unknown',reason:null,checkedAtUtc:null,version:null}],availability:'supported',freshness:'fresh',loadState:'loaded',runtimeState:type==='desktop'?'running':'not_applicable',sampledAtUtc:'2026-01-01T00:00:00Z'});
const ready=[{key:'org',state:'healthy',reason:null,checkedAtUtc:'2026-01-01T00:00:00Z',version:null}];
const setup=extra=>createInventoryModel({admin:()=>[row('后台')],desktop:async()=>[row('客户端','desktop')],unsupportedReason:'browser_not_supported',health:async()=>ready,...extra});

test('来源失败立即未知并保留最后成功资料，恢复后重新有效',async()=>{
 let fail=false,clock=0;
 const p=setup({now:()=>clock,desktop:async()=>{if(fail)throw Error('private');return [row('客户端','desktop')]},health:async()=>{if(fail)throw Error('private');return ready}});
 const first=await p.list();assert.equal(first.total,2);assert.equal(first.items.find(x=>x.type==='desktop').runtimeState,'running');
 fail=true;clock=1000;const failed=await p.list();assert.equal(failed.total,2);
 assert.equal(failed.items.find(x=>x.type==='desktop').runtimeState,'unknown');assert.equal(failed.items[0].services[0].state,'unknown');
 assert.equal(failed.sources.desktop.lastSuccess,first.sources.desktop.lastSuccess);assert.equal(JSON.stringify(failed).includes('private'),false);
 fail=false;const recovered=await p.list();assert.equal(recovered.items.find(x=>x.type==='desktop').runtimeState,'running');p.dispose();
});
test('单独原生失败不污染服务健康',async()=>{
 const p=setup({desktop:async()=>{throw Error('offline')}});const result=await p.list();
 assert.equal(result.total,1);assert.equal(result.items[0].services[0].state,'healthy');assert.equal(result.sources.desktop.availability,'unknown');p.dispose();
});
test('90秒使用单调时间过期，缓存查询不重复采集',async()=>{
 let clock=0,calls=0;const p=setup({now:()=>clock,health:async()=>{calls++;return ready}});
 await p.list();clock=89_999;assert.equal((await p.list({refresh:false})).items[0].freshness,'fresh');
 clock=90_000;const stale=await p.list({refresh:false});assert.equal(stale.items[0].freshness,'stale');assert.equal(stale.items[0].services[0].state,'unknown');assert.equal(calls,1);p.dispose();
});
test('401和403清空全部缓存与详情',async()=>{
 for(const code of ['unauthorized','permission_denied','workspace_forbidden']){
  let failure=false;const p=setup({health:async()=>{if(failure)throw Object.assign(Error('拒绝'),{code});return ready}});
  await p.list();failure=true;await assert.rejects(p.list(),e=>e.code===code);assert.equal(await p.get('后台'),null);assert.equal(await p.get('客户端'),null);p.dispose();
 }
});
test('新请求完成后迟到旧请求不能覆盖缓存',async()=>{
 let resolveOld;let count=0;const old=new Promise(r=>resolveOld=r);
 const p=setup({health:async()=>++count===1?old:ready});
 const first=p.list().catch(e=>e);await new Promise(r=>setImmediate(r));const next=await p.list();
 resolveOld([{...ready[0],state:'unhealthy'}]);assert.equal((await first).name,'AbortError');assert.equal(next.items[0].services[0].state,'healthy');assert.equal((await p.list({refresh:false})).items[0].services[0].state,'healthy');p.dispose();
});
test('外部取消不提交迟到结果',async()=>{
 let done;const pending=new Promise(r=>done=r);const p=setup({health:()=>pending});const ac=new AbortController();
 const work=p.list({signal:ac.signal}).catch(e=>e);ac.abort();done(ready);assert.equal((await work).name,'AbortError');assert.equal(await p.get('后台'),null);p.dispose();
});
test('分页、筛选、稳定排序及第101项详情读取完整缓存',async()=>{
 const rows=Array.from({length:120},(_,i)=>row('项目'+String(i).padStart(3,'0')));const p=setup({admin:()=>rows,desktop:null});
 const first=await p.list({page:1,pageSize:100});assert.equal(first.total,120);assert.equal(first.items.length,100);
 const next=await p.list({page:2,pageSize:100,refresh:false});assert.equal(next.items.length,20);assert.equal((await p.get('项目100')).id,'项目100');
 const filtered=await p.list({keyword:'项目119',refresh:false});assert.equal(filtered.total,1);assert.equal(filtered.items[0].id,'项目119');p.dispose();
});
test('超过200项显式报错，不能静默截断',async()=>{
 const p=setup({admin:()=>Array.from({length:201},(_,i)=>row(String(i))),desktop:null});const result=await p.list();assert.equal(result.total,0);assert.equal(result.sourceError.code,'source_error');p.dispose();
});
test('普通浏览器与旧客户端分别说明不可用且不伪造插件行',async()=>{
 for(const reason of ['browser_not_supported','client_upgrade_required']){const p=setup({desktop:null,unsupportedReason:reason});const r=await p.list();assert.equal(r.total,1);assert.equal(r.sources.desktop.reason,reason);assert.equal(r.sources.desktop.availability,'not_supported');p.dispose();}
});
