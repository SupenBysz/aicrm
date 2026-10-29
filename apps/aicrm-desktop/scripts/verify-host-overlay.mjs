// Builds and executes an isolated probe against the real presenter/controller.
// Uses fake in-memory auth responses and a private user-data directory only.
import {build} from 'esbuild';
import {writeFileSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const desktop=fileURLToPath(new URL('../',import.meta.url));
mkdirSync(desktop+'out/main',{recursive:true});mkdirSync(desktop+'out/preload',{recursive:true});
writeFileSync(desktop+'out/preload/probe-owner.cjs',`const {contextBridge,ipcRenderer}=require('electron');const actions=[];ipcRenderer.on('host-overlay:action',(_event,action)=>actions.push(action));contextBridge.exposeInMainWorld('probe',{show:input=>ipcRenderer.invoke('host-overlay:show',input),close:()=>ipcRenderer.invoke('host-overlay:close'),actions:()=>actions,openVersion:anchor=>ipcRenderer.invoke('version-dialog:open',anchor)});`);
const source=String.raw`import {app,BrowserWindow,WebContentsView,desktopCapturer} from 'electron';import {join} from 'node:path';import {writeFileSync,mkdirSync} from 'node:fs';import assert from 'node:assert/strict';import {registerVersionDialogIpc} from './src/main/version-info-dialog';import {registerHostOverlayIpc} from './src/main/host-overlay';import {registerSender} from './src/main/guarded-ipc';import {isHostScreenLocked} from './src/main/host-screen-lock';import {saveSession} from './src/main/session-store';
if(process.platform==='darwin')app.commandLine.appendSwitch('use-mock-keychain');
const output='/tmp/kycrm-host-overlay-proof';app.setPath('userData',output+'/user-data');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));const html=value=>'data:text/html;charset=utf-8,'+encodeURIComponent('<meta charset="utf-8">'+value);
app.whenReady().then(async()=>{
 mkdirSync(output,{recursive:true});registerHostOverlayIpc();
 const owner=new BrowserWindow({width:1000,height:740,frame:false,backgroundColor:'#f7efe4',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:join(__dirname,'../preload/probe-owner.cjs')}});
 const parentURL=html('<body style="margin:0;font:16px system-ui"><header style="padding:16px">主窗口 Header</header><footer style="position:fixed;bottom:0;padding:8px">状态栏</footer></body>');registerSender(owner.webContents,'main',url=>url===parentURL);await owner.loadURL(parentURL);
 const business=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await business.webContents.loadURL(html('<body style="background:#a72c2c;color:white;font:20px system-ui"><h2>实时业务网页</h2><input id="draft" value="验收草稿保持"><p>浮层不得隐藏或重载此业务页面。</p></body>'));business.setBounds({x:16,y:60,width:968,height:640});owner.contentView.addChildView(business);const businessId=business.webContents.id;
 const pref={schemaVersion:1,source:'personal',themeId:'jade-green',mode:'light',revision:1};const projection={origin:'personal',syncState:'saved',canReload:true,enabled:true,preference:pref,platform:{...pref,source:'platform'},themeId:'jade-green',mode:'light',dark:false,status:'已保存',dirty:false,loading:false,username:'测试账号',displayName:'隔离验证',workspaces:[{id:'root',type:'platform',name:'平台工作区',roles:['管理员'],current:true}],network:{loading:false,entries:[]}};
 const show=async(kind,changes={})=>{const input={kind,projection:{...projection,...changes},top:kind==='lock'?0:60,bottom:kind==='lock'?0:40};const result=await owner.webContents.executeJavaScript('window.probe.show('+JSON.stringify(input)+')');assert.equal(result.ok,true);assert.equal(result.data,true);await pause(250);return owner.contentView.children.at(-1)};
 const overlay=await show('preferences');assert.equal(business.getVisible(),true);
 owner.setSize(1080,780);owner.webContents.setZoomFactor(1.25);await show('preferences');assert.equal(overlay.webContents.getZoomFactor(),1.25);assert.equal(overlay.getBounds().y,75);owner.webContents.setZoomFactor(1);await show('preferences');
 assert.ok((await overlay.webContents.executeJavaScript('document.body.innerText')).includes('个人偏好'));
 assert.equal(await overlay.webContents.executeJavaScript('typeof window.aicrm'),'undefined');
 await overlay.webContents.executeJavaScript('document.querySelector(\'[aria-label="个人偏好：商务蓝"]\').click()');await pause(50);
 assert.deepEqual((await owner.webContents.executeJavaScript('window.probe.actions()')).at(-1),{type:'choose',themeId:'business-blue',mode:'light'});
 const sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:2000,height:1480}});const own=sources.find(source=>source.id===owner.getMediaSourceId());if(own)writeFileSync(output+'/preferences.png',own.thumbnail.toPNG());
 for(const kind of ['password','workspaces','network','user']){const view=await show(kind);assert.ok((await view.webContents.executeJavaScript('document.body.innerText')).length>0);assert.equal(view,overlay);}
 await show('preferences',{themeId:'business-blue',dark:true});assert.equal(await overlay.webContents.executeJavaScript('document.documentElement.dataset.adminPalette'),'business-blue');assert.equal(await overlay.webContents.executeJavaScript('document.documentElement.dataset.adminTheme'),'dark');
 const secondary=new BrowserWindow({width:480,height:320,title:'Isolated secondary business',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await secondary.loadURL(html('<input id=kept value=secondary-draft>'));const secondaryId=secondary.webContents.id;
 await saveSession({token:'fixture-session-only',expiresAt:'2099-01-01T00:00:00Z'});
 globalThis.fetch=async(url,options)=>({ok:true,json:async()=>url.endsWith('/bootstrap')?{data:{user:{id:'fixture-user',username:'fixture'}}}:{data:JSON.parse(options.body).password==='correct-test-only'?{user:{id:'fixture-user'},token:'fixture-renewed-only',expiresAt:'2099-01-01T00:00:00Z'}:{user:{id:'wrong-user'},token:'fixture-wrong-only',expiresAt:'2099-01-01T00:00:00Z'}}});
 await show('lock');assert.equal(isHostScreenLocked(owner.webContents.id),true);assert.equal(secondary.contentView.children.length,1);
 const tamper=await owner.webContents.executeJavaScript('window.probe.show('+JSON.stringify({kind:'lock',projection,top:9999,bottom:9999})+')');assert.equal(tamper.data,true);assert.equal(overlay.getBounds().y,0);assert.equal(overlay.getBounds().height,owner.getContentBounds().height);
 assert.equal((await owner.webContents.executeJavaScript('window.probe.close()')).data,false);
 assert.equal(await overlay.webContents.executeJavaScript('window.kyHostOverlay.dispatch({type:"unlocked"})'),false);
 assert.equal(await overlay.webContents.executeJavaScript('window.kyHostOverlay.dispatch({type:"unlock",password:"wrong-test-only"})'),false);
 assert.equal(isHostScreenLocked(owner.webContents.id),true);
 await overlay.webContents.executeJavaScript('void window.kyHostOverlay.dispatch({type:"unlock",password:"correct-test-only"})');await pause(300);
 assert.equal(isHostScreenLocked(owner.webContents.id),false);assert.equal(secondary.contentView.children.length,0);assert.equal(secondary.webContents.id,secondaryId);assert.equal(await secondary.webContents.executeJavaScript('document.querySelector("#kept").value'),'secondary-draft');secondary.close();
 assert.equal(business.webContents.id,businessId);assert.equal(await business.webContents.executeJavaScript('document.querySelector("#draft").value'),'验收草稿保持');
 writeFileSync(app.getPath('userData')+'/appearance.json',JSON.stringify({themeId:'business-blue',dark:true}));registerVersionDialogIpc();
 const anchor={x:900,y:710,width:80,height:20};const versionResult=await owner.webContents.executeJavaScript('window.probe.openVersion('+JSON.stringify(anchor)+')');assert.equal(versionResult.data,true);await pause(350);
 const dialog=BrowserWindow.getAllWindows().find(window=>window!==owner);assert.ok(dialog);const card=dialog.getBounds();assert.ok(card.height<owner.getContentBounds().height/2);assert.ok(card.y+card.height<=owner.getContentBounds().y+anchor.y);
 assert.equal(await dialog.webContents.executeJavaScript('document.documentElement.dataset.theme'),'dark');assert.equal(await dialog.webContents.executeJavaScript('document.documentElement.dataset.palette'),'business-blue');
 await dialog.webContents.executeJavaScript('document.querySelector("button").focus()');assert.equal(await dialog.webContents.executeJavaScript('getComputedStyle(document.querySelector("button")).outlineStyle'),'none');dialog.close();
 const report={electron:process.versions.electron,panels:['preferences','password','workspaces','network','user','lock'],projectionActionPassed:true,themeProjectionPassed:true,minimalBridgePassed:true,mainOwnedLockPassed:true,wrongIdentityRejected:true,rendererCannotUnlockOrClose:true,lockBoundsTamperingRejected:true,secondaryWindowCovered:true,versionPopupAnchored:true,versionThemePassed:true,noCloseFocusBox:true,preservedBusinessId:businessId,preservedInputPassed:true,resizeAndZoomPassed:true,notVerified:['physical pointer and keyboard focus','mixed DPI and full screen','installed client with real API']};writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));business.webContents.close();owner.close();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});`;
try {
 await build({stdin:{contents:source,resolveDir:desktop,loader:'ts'},bundle:true,platform:'node',format:'cjs',external:['electron'],plugins:[{name:'raw-assets',setup(build){build.onResolve({filter:/\?raw$/},args=>({path:resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'raw'}));build.onLoad({filter:/.*/,namespace:'raw'},args=>({contents:readFileSync(args.path,'utf8'),loader:'text'}));}}],define:{__KWW_PLUGIN_DEV_POLICY__:'null'},outfile:desktop+'out/main/probe-host-overlay.cjs'});
 const child=spawnSync(desktop+'node_modules/.bin/electron',[desktop+'out/main/probe-host-overlay.cjs'],{stdio:'inherit',timeout:45000});process.exitCode=child.status??1;
} finally {
 rmSync(desktop+'out/main/probe-host-overlay.cjs',{force:true});
 rmSync(desktop+'out/preload/probe-owner.cjs',{force:true});
}
