/** 主窗口不等待插件；超时/失败均只降级插件域。 */
export function supervisePluginStartup(start:()=>Promise<unknown>,disable:()=>void,timeoutMs=20000):Promise<boolean>{
 return new Promise(resolve=>{let done=false;const finish=(ok:boolean)=>{if(done)return;done=true;clearTimeout(timer);if(!ok)disable();resolve(ok);};const timer=setTimeout(()=>finish(false),timeoutMs);try{void start().then(()=>finish(true),()=>finish(false));}catch{finish(false);}});
}
