import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'../../..');
const {build}=createRequire(resolve(root,'apps/aicrm-desktop/package.json'))('esbuild');
const host=resolve(root,'apps/ky-admin-host');
test('platform preview restores personal appearance and never persists or calls the native shell',async()=>{
 const folder=mkdtempSync(join(host,'preview-test-'));
 try{
 const code=`import assert from 'node:assert/strict';import React from 'react';import {create,act} from 'react-test-renderer';import {AppearanceProvider} from './src/appearance-provider';import {AppearanceContext} from 'core-port';
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const data=new Map(),writes=[],native=[],applied=[],events=new EventTarget();
 const personal={schemaVersion:1,source:'personal',themeId:'jade-green',mode:'dark',revision:3};
 const platform={schemaVersion:1,source:'platform',themeId:'classic-gold',mode:'system',revision:4};
 data.set('ky.admin.appearance.v1:tester',JSON.stringify({value:personal,dirty:false}));data.set('ky.admin.appearance.v1:platform',JSON.stringify(platform));
 globalThis.localStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>{writes.push(k);data.set(k,v)}};
 globalThis.window=events;globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.CustomEvent=class extends Event{constructor(t,o){super(t);this.detail=o.detail}};
 globalThis.__applied=applied;globalThis.__native=native;globalThis.__request=async path=>path.includes('/auth/me/')?personal:platform;
 let current;function Read(){current=React.useContext(AppearanceContext);return null}let view;
 await act(async()=>{view=create(<AppearanceProvider><Read/></AppearanceProvider>)});
 assert.equal(current.themeId,'jade-green');const snapshot=data.get('ky.admin.appearance.snapshot.v1');writes.length=0;native.length=0;
 await act(async()=>current.previewPlatform({...platform,themeId:'business-blue',mode:'light'}));
 assert.equal(current.themeId,'business-blue');assert.equal(current.dark,false);assert.equal(writes.length,0);assert.equal(native.length,0);assert.equal(data.get('ky.admin.appearance.snapshot.v1'),snapshot);assert.deepEqual(current.preference,personal);
 await act(async()=>current.previewPlatform({...platform,mode:'system'}));assert.equal(current.dark,false);
 await act(async()=>current.previewPlatform(null));assert.equal(current.themeId,'jade-green');assert.equal(current.dark,true);assert.ok(native.length>0);
 await act(async()=>view.unmount());`;
 await build({stdin:{contents:code,resolveDir:host,loader:'tsx'},bundle:true,platform:'node',format:'esm',external:['react','react-test-renderer','node:*'],define:{'import.meta.env.VITE_APPEARANCE_DISABLED':'"0"'},outfile:join(folder,'test.mjs'),plugins:[{name:'ports',setup(b){
 b.onResolve({filter:/^(@ky\/admin-core|core-port)$/},()=>({path:'core',namespace:'port'}));
 b.onResolve({filter:/^\.\/(desktop-client|app-store|remote-api)$/},args=>({path:args.path,namespace:'port'}));
 b.onLoad({filter:/.*/,namespace:'port'},({path})=>({loader:'js',resolveDir:host,contents:path==='core'?`import {createContext} from 'react';export const AppearanceContext=createContext(null);export const APPEARANCE_SNAPSHOT_KEY='ky.admin.appearance.snapshot.v1';export const DEFAULT_APPEARANCE={schemaVersion:1,source:'platform',themeId:'classic-gold',mode:'system',revision:0};export const validAppearance=v=>!!v&&v.schemaVersion===1;export const normalizeAppearance=v=>validAppearance(v)?v:null;export const appearanceRetryOutcome=()=>'';export const applyAppearance=(...v)=>globalThis.__applied.push(v);`:path.includes('desktop-client')?`export const getDesktopBridge=()=>({window:{setAppearance:async v=>globalThis.__native.push(v)}});`:path.includes('app-store')?`export const loadSession=()=>({});export const loadBootstrap=()=>({user:{id:'tester'}});`:`export const requestClient={request:(...args)=>globalThis.__request(...args)};` }));
 }}]});execFileSync(process.execPath,[join(folder,'test.mjs')],{cwd:host,stdio:'pipe'});
 }finally{rmSync(folder,{recursive:true,force:true})}
});
