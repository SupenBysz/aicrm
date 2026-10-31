import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'../../..'),host=resolve(root,'apps/ky-admin-host');
const {build}=createRequire(resolve(root,'apps/aicrm-desktop/package.json'))('esbuild');
test('settings retain failed drafts, prevent duplicate saves and explicitly reconcile revision conflicts',async()=>{
 const folder=mkdtempSync(join(host,'settings-test-'));
 try{
 const code=`import React from 'react';import {create,act} from 'react-test-renderer';import assert from 'node:assert/strict';import {AppearancePage} from '${resolve(root,'plugins/ky-system-settings/src/pages/appearance-page.tsx')}';
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;globalThis.window=new EventTarget();globalThis.matchMedia=()=>({matches:false});const cache=new Map();globalThis.sessionStorage={getItem:k=>cache.get(k)??null,setItem:(k,v)=>cache.set(k,v),removeItem:k=>cache.delete(k)};
 const errors=[],confirms=[],previews=[],requests=[];let pending;
 const platform={schemaVersion:1,source:'platform',themeId:'classic-gold',mode:'light',revision:2};
 globalThis.__ui={message:{error:v=>errors.push(v),success(){}},modal:{confirm:v=>confirms.push(v)}};
 globalThis.__appearance={enabled:true,dark:false,platform,previewPlatform:v=>previews.push(v),reloadPlatform:async v=>{globalThis.__appearance.platform=v}};
 globalThis.__client={request:(url,options)=>{requests.push({url,options});return new Promise((resolve,reject)=>pending={resolve,reject})}};
 let view;await act(async()=>{view=create(<AppearancePage/>)});const controls=()=>view.root.findByType('appearance-controls');const save=()=>view.root.findAllByType('button').find(n=>n.props.type==='primary');
 assert.equal(save().props.disabled,true);await act(async()=>controls().props.onChange('business-blue','dark'));assert.equal(save().props.disabled,false);assert.ok(cache.size);assert.equal(previews.at(-1).themeId,'business-blue');
 await act(async()=>{save().props.onClick();save().props.onClick()});assert.equal(requests.length,1);assert.equal(controls().props.disabled,true);assert.equal(requests[0].options.body.revision,2);
 await act(async()=>pending.reject(new Error('offline')));assert.equal(errors.length,1);assert.equal(controls().props.themeId,'business-blue');assert.equal(save().props.disabled,false);assert.ok(cache.size);assert.equal(view.root.findAllByType('alert').length,0);
 await act(async()=>save().props.onClick());await act(async()=>pending.reject({code:'appearance_conflict'}));assert.equal(confirms.length,1);assert.equal(controls().props.themeId,'business-blue');
 await act(async()=>{confirms[0].onOk()});assert.equal(requests.at(-1).options,undefined);await act(async()=>pending.resolve({...platform,revision:3,themeId:'jade-green'}));assert.equal(controls().props.themeId,'jade-green');assert.equal(save().props.disabled,true);assert.equal(cache.size,0);
 await act(async()=>controls().props.onChange('graphite-cyan','light'));await act(async()=>view.unmount());assert.equal(previews.at(-1),null);assert.ok(cache.size);
 // Re-entering restores the draft, but does not silently force a page preview.
 await act(async()=>{view=create(<AppearancePage/>)});assert.equal(controls().props.themeId,'graphite-cyan');assert.equal(previews.at(-1),null);await act(async()=>view.unmount());`;
 await build({stdin:{contents:code,loader:'tsx',resolveDir:host},bundle:true,platform:'node',format:'esm',external:['react','react-test-renderer','node:*'],loader:{'.css':'empty'},outfile:join(folder,'test.mjs'),plugins:[{name:'ports',setup(b){
 b.onResolve({filter:/^(@ky\/admin-core|antd|@ant-design\/icons)$/},({path})=>({path,namespace:'port'}));
 b.onLoad({filter:/.*/,namespace:'port'},({path})=>({loader:'js',resolveDir:host,contents:`import {createElement as h} from 'react';const c=n=>p=>h(n,p,p.children);`+(path==='antd'?`export const App={useApp:()=>globalThis.__ui},Button=c('button'),Empty=c('empty'),Segmented=c('segmented'),Space=c('space'),Tooltip=c('tooltip'),Typography={Text:c('text')};`:path==='@ant-design/icons'?`export const QuestionCircleOutlined=c('icon');`:`export const AppearanceControls=c('appearance-controls'),ListPageCard=p=>h('main',null,p.extra,p.children),DEFAULT_APPEARANCE={themeId:'classic-gold',mode:'system'},themeVariables=()=>({}),useAppearance=()=>globalThis.__appearance,useCurrentUser=()=>({id:'tester'}),validAppearance=v=>!!v?.schemaVersion,usePermissions=()=>({can:()=>true}),useRequestClient=()=>globalThis.__client;`)}));
 }}]});execFileSync(process.execPath,[join(folder,'test.mjs')],{cwd:host,stdio:'pipe'});
 }finally{rmSync(folder,{recursive:true,force:true})}
});
