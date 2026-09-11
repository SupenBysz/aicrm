import { ipcMain, type WebContents, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
export type WindowRole = 'main' | 'terminal' | 'controlled' | 'offline' | 'plugin';
type Registration = {role:WindowRole; generation:number; ready:boolean; origin:(url:string)=>boolean};
const senders=new Map<WebContents,Registration>();
const cleanups=new Set<(wc:WebContents)=>void>();
export function onSenderInvalidated(fn:(wc:WebContents)=>void){cleanups.add(fn);return()=>cleanups.delete(fn);}
export function changeSenderRole(wc:WebContents,role:WindowRole){const r=senders.get(wc);if(r)r.role=role;}
export function senderRegistration(wc:WebContents){return senders.get(wc);}
export function registerSender(wc:WebContents,role:WindowRole,origin:(url:string)=>boolean){
 if(senders.has(wc))throw Error('调用方重复登记');const record:Registration={role,generation:0,ready:false,origin};senders.set(wc,record);
 const invalidate=()=>{record.ready=false;record.generation++;for(const fn of cleanups)fn(wc);};
 wc.on('did-start-navigation',(_e,_url,inPlace,main)=>{if(main&&!inPlace)invalidate();});
 wc.on('did-frame-navigate',(_e,url,_code,_text,main)=>{if(main)record.ready=origin(url);});
 wc.on('did-navigate-in-page',(_e,url,main)=>{if(main&&!origin(url))invalidate();});
 wc.on('render-process-gone',invalidate);
 wc.once('destroyed',()=>{invalidate();senders.delete(wc);});
 return ()=>{invalidate();senders.delete(wc);};
}
export function authorized(event:IpcMainInvokeEvent|IpcMainEvent,roles:readonly WindowRole[]){const r=senders.get(event.sender);return !!r&&r.ready&&roles.includes(r.role)&&!!event.senderFrame&&event.senderFrame===event.sender.mainFrame&&!event.sender.isDestroyed()&&r.origin(event.senderFrame.url);}
const entries=new Map<string,{roles:readonly WindowRole[];kind:'handle'|'on'}>();
const deny=()=>{throw new Error('permission_denied');};
function register(channel:string,roles:readonly WindowRole[],kind:'handle'|'on',handler:(event:any,...args:any[])=>any,valid:(args:any[])=>boolean,envelope=false){
 if(!roles.length||entries.has(channel)||!Object.values(IPC_CHANNELS).includes(channel as any))throw Error('IPC 注册合同无效');entries.set(channel,{roles,kind});
 const run=(event:any,...args:any[])=>{if(!authorized(event,roles)||!valid(args)){if(kind==='handle')return deny();return;}const generation=senders.get(event.sender)!.generation;const result=handler(event,...args);if(result&&typeof result.then==='function')return result.then((value:any)=>{if(!authorized(event,roles)||senders.get(event.sender)?.generation!==generation)return deny();return value;});return result;};
 if(kind==='handle')ipcMain.handle(channel,envelope?async(event,...args)=>{try{return {ok:true,data:await run(event,...args)};}catch(e){return {ok:false,error:{code:(e as Error).message==='permission_denied'?'permission_denied':'validation_error',message:'客户端插件请求被拒绝'}};}}:run);else ipcMain.on(channel,run);
}
export function scopedIpc(roles:readonly WindowRole[],valid:(args:any[])=>boolean){return {handle:(channel:string,fn:(event:any,...args:any[])=>any)=>register(channel,roles,'handle',fn,valid,true),on:(channel:string,fn:(event:any,...args:any[])=>any)=>register(channel,roles,'on',fn,valid)};}
// 旧 handler 继续验证领域输入并保持原返回；这里仅补充有界跨进程输入与调用角色。
function bounded(args:any[]){try{return args.length<=8&&Buffer.byteLength(JSON.stringify(args))<=1048576;}catch{return false;}}
const legacyChannels=new Set<string>([IPC_CHANNELS.apiRequest, IPC_CHANNELS.appGetConfig, IPC_CHANNELS.appGetVersion, IPC_CHANNELS.sessionLoad, IPC_CHANNELS.sessionSave, IPC_CHANNELS.sessionClear, IPC_CHANNELS.windowGetState, IPC_CHANNELS.windowMinimize, IPC_CHANNELS.windowToggleMaximize, IPC_CHANNELS.windowSetFullScreen, IPC_CHANNELS.windowSetAlwaysOnTop, IPC_CHANNELS.windowMoveBy, IPC_CHANNELS.windowOpenDevTools, IPC_CHANNELS.windowClose, IPC_CHANNELS.windowStateChanged, IPC_CHANNELS.matrixAccountGetCapabilities, IPC_CHANNELS.matrixAccountStartLogin, IPC_CHANNELS.matrixAccountOpenAccount, IPC_CHANNELS.matrixAccountCheckSession, IPC_CHANNELS.matrixAccountClearProfile, IPC_CHANNELS.matrixAccountLoginStateChanged, IPC_CHANNELS.matrixAccountCreateWebSpaceLogin, IPC_CHANNELS.matrixAccountOpenWebSpace, IPC_CHANNELS.matrixAccountDetectWebSpaceAccount, IPC_CHANNELS.matrixAccountClearWebSpace, IPC_CHANNELS.matrixAccountWebSpaceStateChanged, IPC_CHANNELS.matrixAccountCaptureWebSpaceSnapshot, IPC_CHANNELS.matrixAccountRunWebSpaceLoginScript, IPC_CHANNELS.matrixAccountStartOnboarding, IPC_CHANNELS.matrixAccountGetOnboarding, IPC_CHANNELS.matrixAccountGetOnboardingQrCode, IPC_CHANNELS.matrixAccountRefreshOnboardingQrCode, IPC_CHANNELS.matrixAccountCancelOnboarding, IPC_CHANNELS.matrixAccountOnboardingEvent, IPC_CHANNELS.matrixAccountSealSessionSnapshot, IPC_CHANNELS.matrixAccountVerifySessionSnapshot, IPC_CHANNELS.matrixAccountRestoreSessionSnapshot, IPC_CHANNELS.matrixAccountCleanupSessionWebSpace, IPC_CHANNELS.aiExecutorOpenTerminalWindow, IPC_CHANNELS.aiExecutorBindDevice, IPC_CHANNELS.codexExecutorAuthorize, IPC_CHANNELS.codexExecutorGetAuthStatus, IPC_CHANNELS.codexAuthorizationGetCapabilities, IPC_CHANNELS.codexAuthorizationStart, IPC_CHANNELS.codexAuthorizationGetSnapshot, IPC_CHANNELS.codexAuthorizationCancel, IPC_CHANNELS.codexAuthorizationReopen, IPC_CHANNELS.codexAuthorizationVerify, IPC_CHANNELS.codexAuthorizationCheckReadiness, IPC_CHANNELS.codexAuthorizationGetModelCatalog, IPC_CHANNELS.codexAuthorizationRefreshModelCatalog, IPC_CHANNELS.codexAuthorizationLogout, IPC_CHANNELS.codexAuthorizationChanged, IPC_CHANNELS.desktopDeviceGetIdentity, IPC_CHANNELS.desktopDeviceEnsureRegistration, IPC_CHANNELS.desktopDeviceGetRegistrationState, IPC_CHANNELS.desktopDeviceResetRegistrationRecovery, IPC_CHANNELS.networkLogSnapshot, IPC_CHANNELS.networkLogClear]);
const windowChannels=new Set<string>(Object.entries(IPC_CHANNELS).filter(([k])=>k.startsWith('window')).map(([,v])=>v));
const terminalChannels=new Set<string>([IPC_CHANNELS.appGetVersion,IPC_CHANNELS.appGetConfig,IPC_CHANNELS.apiRequest,IPC_CHANNELS.sessionLoad]);
export const guardedIpc={
 handle(channel:string,fn:(event:any,...args:any[])=>any){if(!legacyChannels.has(channel))throw Error('未声明旧通道');return register(channel,windowChannels.has(channel)?['main','terminal']:terminalChannels.has(channel)?['main','terminal']:['main'],'handle',fn,bounded);},
 on(channel:string,fn:(event:any,...args:any[])=>any){if(!legacyChannels.has(channel))throw Error('未声明旧通道');return register(channel,windowChannels.has(channel)?['main','terminal']:['main'],'on',fn,bounded);}
};
export function ipcRegistrationSnapshot(){return [...entries].map(([channel,v])=>({channel,...v}));}
