import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const require=createRequire(new URL('../../../aicrm-desktop/package.json',import.meta.url));
const {build}=require('esbuild');
const host=fileURLToPath(new URL('../../',import.meta.url));
const mocks={
 antd:`import {createElement} from 'react';const c=n=>p=>createElement(n,p,p.children);export const Alert=c('alert'),Button=c('button'),Result=c('result'),Space=c('space'),Spin=c('spin'),Typography={Text:c('text')};`,
 '@ky/admin-core':`export const useCurrentWorkspace=()=>({type:'platform',id:'root'});`,
 'react-router-dom':`export const useParams=()=>({directoryType:'workbench',menuKey:'test.web'});`,
 '../desktop-session-sync':`export const syncDesktopSession=async()=>{};`,
 '../desktop-client':`export const getDesktopBridge=()=>globalThis.desktopProbe;`
};
test('real page binds the committed viewport, merges early state, and retains resource warnings',async()=>{
 const tmpRoot=host+'/tmp';mkdirSync(tmpRoot,{recursive:true});const dir=mkdtempSync(tmpRoot+'/menu-page-test-');
 const contents=`import assert from 'node:assert/strict';import React from 'react';import TestRenderer,{act} from 'react-test-renderer';import {MenuWebViewPage} from './src/pages/menu-webview-page';
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const observed=[],disconnected=[],bounds=[],frames=new Map();let nextFrame=0;let listener;let opens=0;
 globalThis.ResizeObserver=class{observe(e){observed.push(e)}disconnect(){disconnected.push('resize')}};
 globalThis.IntersectionObserver=class{observe(e){observed.push(e)}disconnect(){disconnected.push('intersection')}};
 globalThis.MutationObserver=class{observe(e){observed.push(e)}disconnect(){disconnected.push('mutation')}};
 globalThis.requestAnimationFrame=fn=>{frames.set(++nextFrame,fn);return nextFrame};globalThis.cancelAnimationFrame=id=>frames.delete(id);
 globalThis.window={innerWidth:1200,innerHeight:800,addEventListener(){},removeEventListener(){}};globalThis.document={visibilityState:'visible',addEventListener(){},removeEventListener(){}};
 globalThis.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1',overflow:'visible',overflowX:'visible',overflowY:'visible'});
 const element={parentElement:null,hidden:false,inert:false,getAttribute(){return null},getBoundingClientRect(){return {left:200,top:150,right:1000,bottom:700,width:800,height:550}}};
 const ready={instanceId:'instance',sequence:3,status:'ready',title:'加载完成',errorCode:'resource_injection_failed'};
 globalThis.desktopProbe={menuWebView:{protocolVersion:2,onChanged(fn){listener=fn;return()=>{}},async open(){opens++;listener({instanceId:'instance',state:ready});return {ok:true,data:{instanceId:'instance',activationId:'lease',protocolVersion:2,openMode:'embedded',stateSnapshot:{...ready,sequence:2,title:'较旧快照'}}}},async setBounds(value){bounds.push(value);return {ok:true}},async close(){return {ok:true}},async navigate(){return {ok:true}}}};
 let root;await act(async()=>{root=TestRenderer.create(React.createElement(MenuWebViewPage),{createNodeMock:p=>p.props.className==='menu-webview-viewport'?element:null});});
 assert.ok(observed.includes(element));assert.equal(root.root.findByType('section').props['aria-label'],'加载完成');assert.equal(root.root.findAllByType('alert').length,1);
 await act(async()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn();}});
 assert.equal(bounds.at(-1).visible,true);assert.equal(bounds.at(-1).activationId,'lease');
 await act(async()=>{listener({instanceId:'instance',state:{...ready,sequence:1,status:'loading',title:'过期状态'}})});
 assert.equal(root.root.findByType('section').props['aria-label'],'加载完成');
 await act(async()=>root.unmount());assert.deepEqual(disconnected.sort(),['intersection','mutation','resize']);assert.equal(bounds.at(-1).visible,false);
 globalThis.desktopProbe.menuWebView.protocolVersion=undefined;await act(async()=>{root=TestRenderer.create(React.createElement(MenuWebViewPage));});assert.equal(root.root.findByType('result').props.title,'请升级桌面客户端');assert.equal(opens,1);await act(async()=>root.unmount());
 `;
 try{
 const built=await build({stdin:{contents,resolveDir:host,loader:'tsx'},bundle:true,platform:'node',format:'esm',external:['react','react-test-renderer','node:*'],write:false,plugins:[{name:'test-ports',setup(build){build.onResolve({filter:/.*/},args=>mocks[args.path]?{path:args.path,namespace:'mock'}:undefined);build.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'js',resolveDir:host}));}}]});
 const output=dir+'/page.mjs';writeFileSync(output,built.outputFiles[0].text);execFileSync(process.execPath,[output],{stdio:'pipe'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
