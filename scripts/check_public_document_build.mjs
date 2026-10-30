import {readFileSync}from'node:fs';import{resolve,dirname}from'node:path';import assert from'node:assert/strict';
const root=resolve(import.meta.dirname,'../apps/ky-admin-host/dist');const html=readFileSync(resolve(root,'public-document.html'),'utf8');const seen=new Set();
function visit(file){if(seen.has(file))return;seen.add(file);const text=readFileSync(file,'utf8');for(const match of text.matchAll(/(?:from\s*|import\s*)["']([^"']+\.js)["']/g)){if(match[1].startsWith('.'))visit(resolve(dirname(file),match[1]))}}
for(const match of html.matchAll(/(?:src|href)="(\/assets\/[^"?]+\.js)"/g))visit(resolve(root,'.'+match[1]));
const text=[...seen].map(f=>readFileSync(f,'utf8')).join('\n');assert.ok(seen.size);assert.ok(text.includes('/api/v1/public/documents/'));for(const forbidden of ['/api/v1/auth/','/api/v1/platform/documents','导入.md','monaco-editor','ky:session-changed'])assert.ok(!text.includes(forbidden),'public entry loads '+forbidden);
console.log('PASS independent public document entry:',seen.size,'JS assets; no auth, private document API, editor or session bridge');
