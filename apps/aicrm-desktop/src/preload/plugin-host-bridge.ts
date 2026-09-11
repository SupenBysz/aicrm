import { ipcRenderer } from 'electron';
import { IPC_CHANNELS as C } from '../shared/constants';
import type { DesktopPluginsBridge, DesktopPluginSnapshot } from '../shared/types';
const call=async(channel:string,...args:unknown[])=>{const r=await ipcRenderer.invoke(channel,...args);if(!r.ok)throw Error(r.error?.code??'plugin_unavailable');return r.data;};
export const desktopPlugins:DesktopPluginsBridge={
 inventory:input=>call(C.desktopPluginsInventory,input),
 registerUi:input=>call(C.desktopPluginsRegisterUi,input),
 unregisterUi:()=>call(C.desktopPluginsUnregisterUi),
 getSnapshot:()=>call(C.desktopPluginsSnapshot),
 ackRendered:input=>call(C.desktopPluginsAck,input),
 action:input=>call(C.desktopPluginsAction,input),
 onChanged(listener){const fn=(_e:unknown,p:DesktopPluginSnapshot)=>{try{listener(p);}catch{}};ipcRenderer.on(C.desktopPluginsChanged,fn);return()=>ipcRenderer.off(C.desktopPluginsChanged,fn);}
};
