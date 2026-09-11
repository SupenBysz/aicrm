import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {download} from '../../apps/aicrm-desktop/src/main/desktop-plugin-host/downloader.mjs';
import {SOURCE} from '../../packages/desktop-plugin-contracts/src/index.ts';
// 测试只把实际 HTTP 传输接到临时监听器，产品下载源和超时常量均不改。
async function transport(t,handler,run){
 const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
 const original=http.get;t.mock.method(http,'get',(url,options,callback)=>{assert.equal(url.href,SOURCE+'index.json');return original(new URL('/index.json','http://127.0.0.1:'+server.address().port),options,callback);});
 try{await run();}finally{t.mock.restoreAll();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
for(const [name,handler] of [
 ['超大分块响应',(_q,r)=>{r.writeHead(200);r.end('x'.repeat(1025));}],
 ['超大声明长度',(_q,r)=>{r.writeHead(200,{'Content-Length':'2048'});r.end('x');}],
 ['伪造长度后截断',(_q,r)=>{r.writeHead(200,{'Content-Length':'30'});r.write('x');setImmediate(()=>r.destroy());}],
 ['压缩响应',(_q,r)=>{r.writeHead(200,{'Content-Encoding':'gzip'});r.end('x');}],
 ['重定向不跟随',(_q,r)=>{r.writeHead(302,{Location:'http://127.0.0.1:1/'});r.end();}]
])test('A05 '+name,async t=>{let hits=0;await transport(t,(q,r)=>{hits++;handler(q,r);},async()=>{await assert.rejects(download('index.json',1024),/插件下载失败/);assert.equal(hits,1);});});
test('A05 正常有界传输保持精确字节',async t=>transport(t,(_q,r)=>r.end('公共数据'),async()=>assert.equal((await download('index.json',1024)).toString(),'公共数据')));
test('A05 外部 URL、路径和跨源输入在发请求前拒绝',()=>{for(const name of ['http://example.test/x','../index.json','//example.test/x','index.json?url=x'])assert.throws(()=>download(name,1024));});
test('A05 总超时使用产品 30000ms 定时器中止可达但不结束响应',async t=>{let started;const received=new Promise(r=>started=r);await transport(t,(_q,r)=>{r.writeHead(200);r.write('x');started();},async()=>{t.mock.timers.enable({apis:['setTimeout']});const pending=download('index.json',1024);const rejected=assert.rejects(pending,/插件下载失败/);await received;t.mock.timers.tick(30001);await rejected;t.mock.timers.reset();});});
test('A05 连接超时使用产品 5000ms 定时器且销毁请求',async t=>{const {EventEmitter}=await import('node:events');const req=new EventEmitter();let destroyed=false;req.destroy=()=>{destroyed=true;};t.mock.method(http,'get',()=>req);t.mock.timers.enable({apis:['setTimeout']});const result=assert.rejects(download('index.json',1024));t.mock.timers.tick(5001);await result;assert(destroyed);});
