import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import {readFileSync} from 'node:fs';
test('unsaved document cache is isolated, copied and cleared when session changes',async()=>{
 globalThis.window=new EventTarget();
 try{const text=ts.transpileModule(readFileSync(new URL('./document-draft-cache.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;const cache=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
 cache.rememberDocumentDraft('user-a/platform/root',{id:'fixture',markdown:'unsaved'});assert.equal(cache.readDocumentDraft('user-b/platform/root'),null);assert.equal(cache.readDocumentDraft('user-a/agency/other'),null);
 cache.readDocumentDraft('user-a/platform/root').markdown='changed copy';assert.equal(cache.readDocumentDraft('user-a/platform/root').markdown,'unsaved');window.dispatchEvent(new Event('ky:session-changed'));assert.equal(cache.readDocumentDraft('user-a/platform/root'),null);
 }finally{delete globalThis.window}
});
