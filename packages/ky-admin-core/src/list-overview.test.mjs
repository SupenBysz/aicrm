import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const require=createRequire(new URL('../../../apps/aicrm-desktop/package.json',import.meta.url));
const {build}=require('esbuild');
const host=fileURLToPath(new URL('../../../apps/ky-admin-host/',import.meta.url));
const core=fileURLToPath(new URL('./list-overview.tsx',import.meta.url));
const urlState=fileURLToPath(new URL('./url-state.ts',import.meta.url));
const page=fileURLToPath(new URL('../../../plugins/ky-audit-management/src/pages/login-logs-page.tsx',import.meta.url));
test('real overview and log page preserve query scope, drill filters, handle outage and reject unacknowledged legacy filters',async()=>{
 const root=host+'/tmp';mkdirSync(root,{recursive:true});const temp=mkdtempSync(root+'/overview-test-');
 const mocks={
  antd:`import {createElement as h} from 'react';const c=n=>p=>h(n,p,p.children);export const Alert=c('alert'),Button=c('button'),Input=c('input'),Select=c('select'),Space=c('space'),Table=c('table'),Tag=c('tag'),Tooltip=c('tooltip'),Typography={Text:c('text')},Skeleton={Input:c('skeleton')};`,
  '@ky/admin-core':`import {createElement as h} from 'react';export {ListOverview} from ${JSON.stringify(core)};export {readListQueryState} from ${JSON.stringify(urlState)};export const useRequestClient=()=>globalThis.client;export const useOverviewIdentity=()=>"test-actor/platform/root/permission-version";export const ListPageCard=p=>h('main',null,p.toolbar,p.children);`,
  'react-router-dom':`import {useState} from 'react';export const useSearchParams=()=>{const [value,set]=useState(()=>new URLSearchParams(globalThis.startQuery));return [value,(next)=>{globalThis.currentParams=new URLSearchParams(next);set(new URLSearchParams(next))}];};`
 };
 const source=`import React from 'react';import assert from 'node:assert/strict';import TestRenderer,{act} from 'react-test-renderer';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {LoginLogsPage} from ${JSON.stringify(page)};import {ListOverview} from ${JSON.stringify(core)};
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;globalThis.startQuery='startAt=2026-01-01T00:00:00.123Z&endBefore=2026-01-02T00:00:00Z&window=custom';
 const calls=[];let outage=false,legacy=false;
 const summary={schemaVersion:1,total:4,asOf:'2026-01-02T00:00:00Z',scope:{basis:'search_without_status',ignoredFilters:['result'],filters:{},timezone:'Asia/Shanghai',start:'2026-01-01T00:00:00Z',end:'2026-01-02T00:00:00Z'},metrics:[{key:'success',count:1},{key:'failed',count:3},{key:'failedAccounts',count:2}]};
 globalThis.client={async request(path){calls.push(path);const u=new URL(path,'http://local');if(u.pathname.endsWith('/summary')){if(outage)throw Object.assign(new Error('unavailable'),{status:503,code:'statistics_unavailable'});return summary;}return {filterVersion:legacy?undefined:1,items:[{id:'record',loginAccount:u.searchParams.get('account')??'Alice',result:u.searchParams.get('result')??'success'}],pagination:{page:Number(u.searchParams.get('page')),pageSize:10,total:u.searchParams.get('result')==='failed'?3:4}};}};
 const settle=async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,40))})};
 let query,root;
 async function mount(){query=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});await act(async()=>{root=TestRenderer.create(React.createElement(QueryClientProvider,{client:query},React.createElement(LoginLogsPage)))});await settle();}
 await mount();
 assert.equal(root.root.findByType('table').props.dataSource.length,1);
 assert.equal(root.root.findAllByType('button').filter(b=>b.props['aria-label']==='失败账号数').length,0,'distinct-account metric must be read-only');
 const summaries=()=>calls.filter(p=>p.includes('/summary')).length;const initial=summaries();
 await act(async()=>root.root.findByProps({'aria-label':'失败记录数'}).props.onClick());await settle();assert.equal(globalThis.currentParams.get('result'),'failed');assert.equal(summaries(),initial);assert.equal(globalThis.currentParams.get('startAt'),'2026-01-01T00:00:00.123Z');
 await act(async()=>root.root.findByType('table').props.pagination.onChange(2,10));await settle();assert.equal(summaries(),initial);assert.equal(globalThis.currentParams.get('page'),'2');
 await act(async()=>root.root.findByProps({'aria-label':'登录账号精确匹配'}).props.onChange({target:{value:'Alice'}}));await settle();assert.equal(summaries(),initial,'draft input must not fetch');
 const button=label=>root.root.findAllByType('button').find(b=>b.children.join('')===label);
 await act(async()=>button('查询').props.onClick());await settle();assert.equal(globalThis.currentParams.get('account'),'Alice');assert.equal(globalThis.currentParams.get('startAt'),'2026-01-01T00:00:00.123Z','unchanged custom time must retain milliseconds');assert.equal(globalThis.currentParams.get('page'),'1');assert.equal(summaries(),initial+1);
 outage=true;await act(async()=>button('刷新概览').props.onClick());await settle();assert.equal(root.root.findByType('table').props.dataSource.length,1,'summary failure must not block list');assert.ok(root.root.findAllByType('alert').some(a=>String(a.props.title).includes('旧数据')));
 await act(async()=>root.unmount());query.clear();outage=false;legacy=true;await mount();assert.equal(root.root.findByType('table').props.dataSource.length,0,'unacknowledged time filter must not display broader legacy results');assert.ok(root.root.findAllByType('alert').some(a=>String(a.props.title).includes('待升级')));await act(async()=>root.unmount());query.clear();
 await act(async()=>{root=TestRenderer.create(React.createElement(ListOverview,{data:summary,loading:false,error:{status:403},onRetry(){},metrics:[{key:'total',label:'总数',description:'旧值辅助统计123'}]}))});assert.deepEqual(root.root.findAllByType('strong').map(n=>n.children.join('')),['—'],'permission denial must clear stale counts');assert.equal(root.root.findAll(n=>typeof n.type==='string'&&n.children.some(c=>typeof c==='string'&&c.includes('旧值辅助统计123'))).length,0);await act(async()=>root.unmount());
 `;
 try{
  const output=await build({stdin:{contents:source,resolveDir:host,loader:'tsx'},bundle:true,platform:'node',format:'esm',external:['react','react-test-renderer','@tanstack/react-query','node:*'],write:false,plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},args=>mocks[args.path]?{path:args.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'js',resolveDir:host}));}}]});
  const target=temp+'/test.mjs';writeFileSync(target,output.outputFiles[0].text);execFileSync(process.execPath,[target],{stdio:'pipe'});
 }finally{rmSync(temp,{recursive:true,force:true})}
});
