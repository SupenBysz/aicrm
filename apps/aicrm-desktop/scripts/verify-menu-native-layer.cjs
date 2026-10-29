// Opt-in local Electron 43 probe. Captures this probe's window only.
// Does not connect to an API, touch a user session, or change business WebViews.
const {app,BrowserWindow,WebContentsView,desktopCapturer}=require('electron');
const {mkdirSync,writeFileSync}=require('node:fs');
const {join,resolve}=require('node:path');
const assert=require('node:assert/strict');
const output=resolve(process.env.KY_NATIVE_LAYER_PROBE_OUTPUT || '/tmp/kycrm-native-layer-proof');
if(process.platform==='darwin')app.commandLine.appendSwitch('use-mock-keychain');
app.setPath('userData',join(output,'user-data'));
const url=html=>'data:text/html;charset=utf-8,'+encodeURIComponent('<meta charset="utf-8">'+html);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
 mkdirSync(output,{recursive:true});
 const owner=new BrowserWindow({width:900,height:640,title:'KyCRM Native Layer Probe',backgroundColor:'#f7efe4',webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
 await owner.loadURL(url('<body style="margin:0;font:16px system-ui"><header style="padding:16px">宿主 Header</header><footer style="position:fixed;bottom:0;padding:8px">宿主状态栏</footer></body>'));
 const business=new WebContentsView({webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
 await business.webContents.loadURL(url('<body style="background:#a72c2c;color:white;font:20px system-ui"><h2>实时业务网页</h2><input id="draft" value="必须保留的输入"><p>右侧白色侧滑应覆盖业务页，左侧红色网页仍实时显示。</p></body>'));
 const originalId=business.webContents.id;
 const overlay=new WebContentsView({webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
 overlay.setBackgroundColor('#00000000');
 await overlay.webContents.loadURL(url('<style>html,body{margin:0;background:transparent;font:16px system-ui}aside{position:fixed;top:0;bottom:0;right:0;width:320px;background:#fffdf7;box-shadow:-8px 0 24px #0004}header{padding:16px;border-bottom:1px solid #e5d4b5;font-weight:bold}section{padding:16px}</style><aside><header>可信宿主浮层 <button id="close">关闭</button></header><section>固定标题与右侧操作。关闭后原网页实例和输入必须保持。</section></aside>'));
 owner.contentView.addChildView(business);owner.contentView.addChildView(overlay);
 const measure=()=>{const {width,height}=owner.getContentBounds();business.setBounds({x:16,y:60,width:width-32,height:height-96});overlay.setBounds({x:0,y:60,width,height:height-96});};
 owner.on('resize',measure);measure();await pause(600);
 assert.equal(owner.contentView.children.at(-1),overlay);
 const sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:1800,height:1280}});
 const own=sources.find(source=>source.id===owner.getMediaSourceId());
 if(own)writeFileSync(join(output,'overlay-open.png'),own.thumbnail.toPNG());
 owner.contentView.removeChildView(overlay);overlay.webContents.close();
 assert.equal(business.webContents.id,originalId);
 assert.equal(await business.webContents.executeJavaScript('document.querySelector("#draft").value'),'必须保留的输入');
 const report={electron:process.versions.electron,platform:process.platform,businessId:originalId,nativeOrderPassed:true,preservedInputPassed:true,nativeCaptureAvailable:Boolean(own),notVerified:['physical pointer hit testing','keyboard focus and tab','full screen and mixed DPI','real Host drawers','lock and unlock']};
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 business.webContents.close();owner.close();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
