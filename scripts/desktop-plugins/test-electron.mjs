/** 仅 Node 单元测试的 Electron 替身；不构成真实沙箱证据。 */
import {EventEmitter} from 'node:events';
export const handles=new Map(),listeners=new Map();
export const ipcMain={handle:(c,f)=>{if(handles.has(c))throw Error('重复');handles.set(c,f);},on:(c,f)=>{listeners.set(c,f);}};
let id=0;
export class FakeContents extends EventEmitter{constructor(){super();this.id=++id;this.mainFrame={url:'https://example.test/'};this.sent=[];this.dead=false;}isDestroyed(){return this.dead;}send(c,p){this.sent.push({c,p});}getURL(){return this.mainFrame.url;}setWindowOpenHandler(){} }
export class BrowserWindow extends EventEmitter{static windows=[];static fromWebContents(wc){return this.windows.find(w=>w.webContents===wc);}constructor(){super();this.webContents=new FakeContents();this.visible=true;this.minimized=false;this.dead=false;BrowserWindow.windows.push(this);}isVisible(){return this.visible;}isMinimized(){return this.minimized;}isDestroyed(){return this.dead;}destroy(){this.dead=true;this.webContents.dead=true;this.webContents.emit('destroyed');this.emit('closed');} }
export const app={isPackaged:false,getPath:()=>'/tmp/kww-unit-only'};
export const protocol={registerSchemesAsPrivileged(){},handle(){}};
export const session={};
