/** 仅独立验收程序使用，产品构建不包含此入口。固定探针，不转发任意 channel。 */
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('kwwProbe',{
 sandboxed: process.sandboxed,
 version:()=>ipcRenderer.invoke('app:get-version'),
 inventory:()=>ipcRenderer.invoke('desktop-plugins:inventory',{}),
 inventoryDenied:async()=>{try{const value=await ipcRenderer.invoke('desktop-plugins:inventory',{});return value?.ok===false&&value?.error?.code==='permission_denied';}catch(e){return String((e as Error).message).includes('permission_denied');}},
 denied:async()=>{let denied=0;for(const channel of ['session:load','api:request']){try{await ipcRenderer.invoke(channel,{path:'/forbidden-e2e'});}catch(e){if(String((e as Error).message).includes('permission_denied'))denied++;}}return denied===2;}
});
