import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=await mkdtemp(join(tmpdir(),'kycrm-theme-test-'));
for(const name of ['classic-tokens','tokens']){
 const source=await readFile(new URL(`./${name}.ts`,import.meta.url),'utf8');
 const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});
 await writeFile(join(dir,name+'.mjs'),outputText.replace('"./classic-tokens"','"./classic-tokens.mjs"'));
}
const theme=await import(pathToFileURL(join(dir,'tokens.mjs')).href);
test.after(()=>rm(dir,{recursive:true,force:true}));
function luminance(hex){
 const channels=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);
 return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
}
test('every preset has readable surfaces, complete shell preview pairs and distinct light/dark values',()=>{
 for(const preset of theme.THEMES){
  for(const dark of [false,true]){
   const c=theme.themeColors(preset.id,dark);const vars=theme.themeVariables(preset.id,dark);
   const values=[luminance(c.surface),luminance(c.text)].sort((a,b)=>b-a);assert.ok((values[0]+0.05)/(values[1]+0.05)>=4.5,`${preset.id} body text contrast`);assert.match(c.primary,/^#[a-f\d]{6}$/i);
   for(const mode of ['light','dark'])for(const suffix of ['base','nav','right','selected-text'])assert.ok(vars[`--admin-shell-${mode}-${suffix}`]);
   for(const key of ['--admin-accent','--admin-surface','--admin-text','--admin-stroke','--admin-focus-ring'])assert.ok(vars[key]);
  }
  assert.notEqual(theme.themeColors(preset.id,false).bg,theme.themeColors(preset.id,true).bg);
 }
});
test('removed palettes preserve mode; invalid configuration does not become valid',()=>{
 const v={...theme.DEFAULT_APPEARANCE,themeId:'removed',mode:'dark'};
 assert.equal(theme.normalizeAppearance(v).themeId,'classic-gold');assert.equal(theme.normalizeAppearance(v).mode,'dark');
 assert.equal(theme.normalizeAppearance({...v,mode:'unsafe'}),null);
 assert.equal(theme.validAppearance({...v,themeId:'classic-gold',revision:-1}),false);
 assert.equal(theme.validAppearance({...v,themeId:'classic-gold'},true),false);
 assert.equal(theme.validAppearance({schemaVersion:1,source:'platform',themeId:'',mode:'',revision:0},true),true);
});
test('system mode resolves without replacing DOM children or WebView identity',()=>{
 const props=new Map();const root={dataset:{},style:{setProperty:(k,v)=>props.set(k,v)},children:[{id:'existing-webview'}]};
 globalThis.document={documentElement:root};globalThis.matchMedia=()=>({matches:true});
 const existing=root.children[0];assert.equal(theme.applyAppearance('business-blue','system'),true);
 assert.equal(root.dataset.adminTheme,'dark');assert.equal(root.dataset.adminPalette,'business-blue');assert.equal(root.children[0],existing);
 assert.equal(theme.applyAppearance('jade-green','light'),false);assert.equal(root.style.colorScheme,'light');assert.equal(root.children[0],existing);
 delete globalThis.document;delete globalThis.matchMedia;
});
test('lost-response retry reconciles same values and never overwrites a newer different preference',()=>{
 const desired={schemaVersion:1,source:'personal',themeId:'business-blue',mode:'system',revision:4};
 assert.equal(theme.appearanceRetryOutcome({...desired,revision:4},desired,4),'retry');
 assert.equal(theme.appearanceRetryOutcome({...desired,revision:5},desired,4),'saved');
 assert.equal(theme.appearanceRetryOutcome({...desired,revision:5,themeId:'jade-green'},desired,4),'conflict');
 assert.equal(theme.appearanceRetryOutcome({...desired,revision:3},desired,4),'conflict');
 const follow={...desired,source:'platform',themeId:'',mode:''};
 assert.equal(theme.appearanceRetryOutcome({...follow,revision:5},desired,4),'conflict');
 assert.equal(theme.appearanceRetryOutcome({...follow,revision:5},follow,4),'saved');
});
