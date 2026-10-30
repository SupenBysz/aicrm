import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const temp=await mkdtemp(join(tmpdir(),'kycrm-overview-contract-'));
async function load(path,name){const source=await readFile(new URL(path,import.meta.url),'utf8');const out=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;const target=join(temp,name+'.mjs');await writeFile(target,out);return import(pathToFileURL(target).href)}
const identity=await load('./api.ts','identity'),matrix=await load('../../ky-matrix-account/src/api.ts','matrix'),audit=await load('../../ky-audit-management/src/api.ts','audit'),query=await load('../../ky-audit-management/src/pages/login-log-query.ts','query');
test.after(()=>rm(temp,{recursive:true,force:true}));
test('new filter clients reject legacy acknowledgements while old unfiltered contracts remain valid',async()=>{
 const old={request:async()=>({items:[{id:'unfiltered'}],pagination:{total:1}})};const upgraded={request:async()=>({filterVersion:1,items:[],pagination:{total:0}})};
 await assert.rejects(identity.listInvitations(old,{page:1,pageSize:10,effectiveStatus:'expired'}),/待升级/);
 await assert.rejects(matrix.listMatrixAccounts(old,{platform:'douyin',page:1,pageSize:10,attention:'required'}),/待升级/);
 await assert.rejects(audit.listLoginLogs(old,{page:1,pageSize:10,startAt:'2026-01-01T00:00:00Z',endBefore:'2026-01-02T00:00:00Z'}),/待升级/);
 assert.equal((await identity.listInvitations(old,{page:1,pageSize:10})).items.length,1);
 assert.equal((await identity.listInvitations(upgraded,{page:1,pageSize:10,effectiveStatus:'expired'})).items.length,0);
});
test('log window freezes an exact day and uses explicit Shanghai offset independent of machine timezone',()=>{
 const now=Date.parse('2026-01-02T00:00:00Z');const range=query.recentLogWindow(now);assert.equal(range.startAt,'2026-01-01T00:00:00.000Z');assert.ok(query.validLogWindow(range));
 assert.equal(query.shanghaiInput('2026-01-01T00:00:00Z'),'2026-01-01T08:00:00');assert.equal(Date.parse(query.inputToTimestamp('2026-01-01T08:00:00')),Date.parse(range.startAt));
 assert.equal(query.validLogWindow({...range,endBefore:range.startAt}),false);assert.equal(query.validLogWindow({...range,endBefore:'2026-03-01T00:00:00Z'}),false);
});
