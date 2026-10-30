import { Component, useEffect, useState, type ReactNode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, Alert, Spin } from "antd";
import zhCN from "antd/locale/zh_CN";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { themeVariables, appearanceAntdTheme, AppearanceContext, CurrentUserContextProvider, WorkspaceContextProvider, PermissionContextProvider, RequestClientProvider, type AppearanceValue } from "@ky/admin-core";
import { validConfig, validGeneration, findComponent, defaultsFor, type PreviewConfig, type DemoArgs } from "../catalog/protocol";
import { createDemoClient } from "./fixtures";
import { loaders } from "./loaders";
const origin=window.location.origin;
const query=new URLSearchParams(window.location.search);
const generation=validGeneration(query.get("generation"))?query.get("generation")!:"cc_standalone";
const standalone=window.parent===window;
function reply(kind:"ready"|"applied"|"error",code?:string){if(!standalone)window.parent.postMessage({version:1,kind,generation,...(code?{code}:{})},origin);}
export class PreviewBoundary extends Component<{children:ReactNode},{failed:boolean}> {
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}componentDidCatch(){reply("error","render_failed");}
 render(){return this.state.failed?<Alert type="error" title="示例渲染失败，请使用外部重置或刷新重试。"/>:this.props.children;}
}
function Providers({config,children}:{config:PreviewConfig;children:ReactNode}) {
 const [client]=useState(()=>new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}}));
 useEffect(()=>()=>client.clear(),[client]);
 const dark=config.mode==="dark"||(config.mode==="system"&&config.systemDark);
 const value:AppearanceValue={schemaVersion:1,source:"personal",themeId:config.themeId,mode:config.mode,revision:0};
 useEffect(()=>{for(const [k,v] of Object.entries(themeVariables(config.themeId,dark)))document.documentElement.style.setProperty(k,v);document.documentElement.style.colorScheme=dark?"dark":"light";},[config.themeId,dark]);
 return <AppearanceContext.Provider value={{origin:"personal",syncState:"idle",canReload:false,enabled:true,preference:value,platform:{...value,source:"platform"},themeId:config.themeId,mode:config.mode,dark,status:"模拟外观，不保存",dirty:false,loading:false,choose:()=>{},followPlatform:()=>{},retry:()=>{},refresh:async()=>{},reloadPlatform:async()=>{}}}><ConfigProvider locale={zhCN} theme={{...appearanceAntdTheme(config.themeId,dark),cssVar:{key:"component-preview"}}} getPopupContainer={()=>document.getElementById("preview-content")!}><QueryClientProvider client={client}><MemoryRouter><CurrentUserContextProvider user={{id:"demo_user",displayName:"演示用户",avatarUrl:""}}><WorkspaceContextProvider workspace={{id:"demo_workspace",type:"platform",name:"演示工作区",membershipId:"demo_member",roles:[],permissions:[],actionPermissions:[],menuKeys:[],dataScopes:[]}}><PermissionContextProvider value={{permissions:[],actionPermissions:[]}}><RequestClientProvider client={createDemoClient()}>{children}</RequestClientProvider></PermissionContextProvider></WorkspaceContextProvider></CurrentUserContextProvider></MemoryRouter></QueryClientProvider></ConfigProvider></AppearanceContext.Provider>;
}
function standaloneConfig():PreviewConfig|undefined {const item=findComponent(query.get("component")||"list-overview");if(!item)return;const example=query.get("example")||"default";const candidate={version:1,kind:"config",generation,componentId:item.id,exampleId:example,themeId:query.get("theme")||"classic-gold",mode:query.get("mode")||"light",systemDark:false,reset:0,args:defaultsFor(item.id,example)};return validConfig(candidate)?candidate:undefined;}
function Renderer(){
 const [config,setConfig]=useState<PreviewConfig|undefined>(()=>standalone?standaloneConfig():undefined),[Demo,setDemo]=useState<ComponentType<Partial<DemoArgs>>|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{const receive=(event:MessageEvent)=>{if(event.origin!==origin||event.source!==window.parent||!validConfig(event.data)||event.data.generation!==generation)return;setConfig(event.data);reply("applied");};window.addEventListener("message",receive);reply("ready");return ()=>window.removeEventListener("message",receive);},[]);
 const id=config?.componentId;
 useEffect(()=>{if(!id)return;let cancelled=false;setDemo(null);setFailed(false);void loaders[id]().then(module=>{if(!cancelled)setDemo(()=>module.default)},()=>{if(!cancelled){setFailed(true);reply("error","load_failed")}});return ()=>{cancelled=true}},[id]);
 if(!config)return <Alert title={standalone?"示例或参数不存在":"正在初始化隔离预览…"} type="info"/>;
 return <Providers key={`${config.componentId}/${config.exampleId}/${config.reset}`} config={config}><main id="preview-content" style={{padding:16,minHeight:"100vh",boxSizing:"border-box",color:"var(--admin-text)",background:"var(--admin-content-bg)",overflowX:"auto"}}><p style={{color:"var(--admin-text-muted)",fontSize:12}}>交互预览 · 全部使用虚构数据 · 不连接业务服务</p>{failed?<Alert type="error" title="示例加载失败，请从组件中心重试。"/>:Demo?<PreviewBoundary key={`${id}/${config.exampleId}/${config.reset}`}><Demo {...config.args}/></PreviewBoundary>:<Spin aria-label="正在加载示例"/>}</main></Providers>;
}
createRoot(document.getElementById("root")!).render(<Renderer/>);
