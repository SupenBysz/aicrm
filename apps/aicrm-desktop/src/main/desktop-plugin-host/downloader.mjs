import http from 'node:http';
import { SOURCE, ensure } from '../../../../../packages/desktop-plugin-contracts/src/index.ts';
/** 仅固定 SSH 回环开发源；不跟随跳转、压缩或任意 URL。 */
export function download(name,max){ensure(name==='policy.json'||name==='index.json'||/^[a-f0-9]{64}\.kwwplugin\.json$/.test(name));return new Promise((resolve,reject)=>{
let settled=false,connection;const finish=(e,b)=>{if(settled)return;settled=true;clearTimeout(total);clearTimeout(connection);if(e){req.destroy();reject(new Error('插件下载失败'));}else resolve(b);};
const req=http.get(new URL(name,SOURCE),{headers:{'Accept-Encoding':'identity'},agent:false},res=>{clearTimeout(connection);if(res.statusCode!==200||(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'))return finish(true);const declared=res.headers['content-length'];if(declared&&(!/^\d+$/.test(declared)||Number(declared)>max))return finish(true);const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>max)finish(true);else chunks.push(b);});res.on('end',()=>{if(declared&&size!==Number(declared))return finish(true);finish(null,Buffer.concat(chunks));});res.on('error',()=>finish(true));});const total=setTimeout(()=>finish(true),30000);connection=setTimeout(()=>finish(true),5000);req.on('socket',s=>s.once('connect',()=>clearTimeout(connection)));req.on('error',()=>finish(true));
});}
