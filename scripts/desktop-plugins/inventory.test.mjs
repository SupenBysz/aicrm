import './test-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserWindow,handles} from './test-electron.mjs';
import {registerSender,senderRegistration} from '../../apps/aicrm-desktop/src/main/guarded-ipc.ts';
import {IPC_CHANNELS as C} from '../../apps/aicrm-desktop/src/shared/constants.ts';
import {DesktopPluginHost} from '../../apps/aicrm-desktop/src/main/desktop-plugin-host/host.ts';
import manifest from '../../desktop-plugins/kww-status-bar/v1/manifest.json';
const event=w=>({sender:w.webContents,senderFrame:w.webContents.mainFrame});
const window=(role='main')=>{const w=new BrowserWindow();if(role){registerSender(w.webContents,role,url=>url==='https://example.test/');w.webContents.emit('did-frame-navigate',{},w.webContents.mainFrame.url,200,'',true);}return w;};
function instance(){const w=new BrowserWindow();return {win:w,wc:w.webContents,pkg:{manifest:structuredClone(manifest),digest:'a'.repeat(64)},ready:true,heartbeat:Date.now(),revoked:false};}
const host=new DesktopPluginHost();host.registerIpc();host.active=instance();host.storage.state={phase:'stable',activeRevision:1,bootLedger:{},recovery:{updatesBlocked:false}};
const invoke=handles.get(C.desktopPluginsInventory);
test('只有登记的主窗口主框架能查询清单',async()=>{
 const main=window();assert.equal((await invoke(event(main),{})).ok,true);
 for(const role of ['offline','plugin','terminal','controlled',null]) assert.equal((await invoke(event(window(role)),{})).ok,false);
 assert.equal((await invoke({...event(main),senderFrame:{url:main.webContents.mainFrame.url}},{})).ok,false);
 main.webContents.emit('did-start-navigation',{},'https://example.test/',false,true);assert.equal((await invoke(event(main),{})).ok,false);
});
test('只接受恰好一个空普通对象',async()=>{
 const main=window();for(const args of [[],[null],[[]],[{},{}],[{id:'x'}],[new Date()],[''],[1]])assert.equal((await invoke(event(main),...args)).ok,false);
 assert.equal((await invoke(event(main),{})).ok,true);
});
test('心跳未来、超时、未ready、撤销、销毁不能报运行中',()=>{
 for(const kind of ['future','timeout','not_ready','revoked','destroyed']){
  host.active=instance();if(kind==='future')host.active.heartbeat=Date.now()+60000;if(kind==='timeout')host.active.heartbeat=Date.now()-7000;
  if(kind==='not_ready')host.active.ready=false;if(kind==='revoked')host.active.revoked=true;if(kind==='destroyed')host.active.win.destroy();
  const rows=host.inventory();assert.equal(rows.length,1);assert.notEqual(rows[0].runtimeState,'running');
 }
 host.active=instance();assert.equal(host.inventory()[0].runtimeState,'running');assert.equal(host.inventory()[0].loadState,'loaded');
});
test('查询不改变界面登记、确认挑战、序列和生命周期存储',()=>{
 host.active=instance();const main=window();host.uis.set(main.webContents,{generation:senderRegistration(main.webContents).generation,sessionId:'session',challenge:'fixed',ack:true,stamp:'fixed'});
 const before=JSON.stringify({uis:[...host.uis.values()],sequence:host.sequence,storage:host.storage.state,membership:host.uiMembershipRevision});
 host.inventory();host.inventory();
 assert.equal(JSON.stringify({uis:[...host.uis.values()],sequence:host.sequence,storage:host.storage.state,membership:host.uiMembershipRevision}),before);
});
test('最小化不降低原生运行状态；旧导航ACK不能显示已确认',()=>{
 host.active=instance();host.uis.clear();const main=window();const reg=senderRegistration(main.webContents);
 host.uis.set(main.webContents,{generation:reg.generation-1,sessionId:'old',challenge:'old',ack:true,stamp:'old'});main.minimized=true;
 const result=host.inventory()[0];assert.equal(result.runtimeState,'running');assert.notEqual(result.uiConfirmationState,'confirmed');
});
test('输出有64KiB界限，不能泄漏私密实例字段',async()=>{
 host.active=instance();host.active.secret='synthetic-private-value';const main=window();let response=await invoke(event(main),{});
 assert.equal(response.ok,true);assert.equal(JSON.stringify(response).includes('synthetic-private-value'),false);
 host.active.pkg.manifest.capabilities=['x'.repeat(70000)];response=await invoke(event(main),{});assert.equal(response.ok,false);
 host.active=instance();
});
