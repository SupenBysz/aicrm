import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS as C } from '../shared/constants';
// 固定 preload 无通道转发，不暴露会话或原始 ipcRenderer。
const call=async(channel:string,...args:unknown[])=>{const result=await ipcRenderer.invoke(channel,...args);if(!result.ok)throw Error(result.error?.code??'plugin_unavailable');return result.data;};
const subscribe=(channel:string,listener:(payload:any)=>void)=>{const fn=(_e:unknown,p:any)=>{try{Promise.resolve(listener(p)).catch(()=>{});}catch{}};ipcRenderer.on(channel,fn);return()=>ipcRenderer.off(channel,fn);};
const arg=process.argv.find(x=>x.startsWith('--kww-plugin-bootstrap='));
const bootstrap=arg?JSON.parse(atob(arg.slice('--kww-plugin-bootstrap='.length))):null;
contextBridge.exposeInMainWorld('kwwPlugin',{
 getHostVersion:()=>call(C.desktopPluginsVersion),
 hello:()=>call(C.desktopPluginsHello,bootstrap),
 ready:()=>call(C.desktopPluginsReady),
 publishStatusBar:(value:unknown)=>call(C.desktopPluginsPublish,value),
 ackDrained:()=>call(C.desktopPluginsDrained),
 ackAction:(requestId:string)=>call(C.desktopPluginsActionAck,requestId),
 onLifecycle:(listener:(p:any)=>void)=>subscribe(C.desktopPluginsLifecycle,listener),
 onAction:(listener:(p:any)=>void)=>subscribe(C.desktopPluginsActionEvent,listener)
});
// 心跳来自固定 preload；主进程另验证插件应用层 ready/投影，事件循环卡死时心跳也停止。
const timer=setInterval(()=>{void call(C.desktopPluginsHeartbeat).catch(()=>{});},2000);
window.addEventListener('unload',()=>clearInterval(timer));
