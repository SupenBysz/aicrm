import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'../..');
test('reader strips executable markup and links while preserving Markdown tables',async()=>{
 const require=createRequire(resolve(root,'apps/aicrm-desktop/package.json'));const {build}=require('esbuild');const host=resolve(root,'apps/ky-admin-host');const dir=mkdtempSync(join(host,'tmp/markdown-safety-'));
 try{await build({stdin:{contents:`import React from 'react';import assert from 'node:assert/strict';import {renderToStaticMarkup} from 'react-dom/server';import {MarkdownReader} from '@ky/markdown';
 const md='# 标题\\n\\n<script>alert(1)</script>\\n\\n<img src=x onerror=alert(1)>\\n\\n[bad](javascript:alert%281%29)\\n\\n[good](https://example.com)\\n\\n![data](data:image/svg+xml,anything)\\n\\n| 列 | 值 |\\n|---|---|\\n| a | b |';
 const html=renderToStaticMarkup(React.createElement(MarkdownReader,{markdown:md}));
 assert.ok(!html.includes('<script'));assert.ok(!html.includes('onerror'));assert.ok(!html.includes('javascript:'));assert.ok(!html.includes('data:image'));assert.ok(html.includes('<table>'));assert.ok(html.includes('rel="noopener noreferrer"'));assert.ok(html.includes('https://example.com'));
 `,loader:'tsx',resolveDir:host},bundle:true,platform:'node',format:'esm',loader:{'.css':'empty'},external:['react','react-dom/server','node:*'],outfile:join(dir,'reader.mjs')});execFileSync(process.execPath,[join(dir,'reader.mjs')],{stdio:'pipe'})}finally{rmSync(dir,{recursive:true,force:true})}
});
