import ts from 'typescript';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const path=resolve(root,'plugins/ky-component-center/src/catalog/metadata.ts');
const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {catalog,categories}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const seen=new Set();const files={};
for(const row of catalog){
 if(!/^[a-z][a-z0-9-]+$/.test(row.id)||seen.has(row.id)||!categories[row.category])throw Error('Invalid component '+row.id);seen.add(row.id);
 if(!['component','pattern','token','hook','utility'].includes(row.kind)||!['experimental','stable','deprecated'].includes(row.status))throw Error('Invalid kind/status');
 if(['component','hook','utility'].includes(row.kind)&&(!row.importPath||!row.exportName))throw Error('Missing public export '+row.id);
 if(new Set(row.examples.map(e=>e.id)).size!==row.examples.length||!row.examples.length)throw Error('Invalid examples');
 for(const p of [...row.sourcePaths,...row.files])if(!p||p.startsWith('/')||p.includes('..')||!existsSync(resolve(root,p)))throw Error('Missing or unsafe path '+p);
 files[row.id]=row.files.map(p=>{const text=readFileSync(resolve(root,p),'utf8');
  const ast=ts.createSourceFile(p,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  for(const n of ast.statements)if(ts.isImportDeclaration(n)&&!['react','antd','react-router-dom','@ky/admin-core','@ant-design/icons','@ky/markdown','@ky/markdown/editor'].includes(n.moduleSpecifier.text))throw Error('Private example dependency '+p);
  if(/\bfetch\s*\(|\bXMLHttpRequest\b|\blocalStorage\b|\bsessionStorage\b|window\.aicrm|window\.parent|window\.top|\beval\s*\(/.test(text))throw Error('Forbidden example effect '+p);
  return {path:p,text};
 });
}
for(const row of catalog){for(const related of row.relatedComponents)if(!seen.has(related))throw Error('Missing related component '+related);let id=row.replacementId;const visited=new Set([row.id]);while(id){if(visited.has(id)||!seen.has(id))throw Error('Invalid replacement '+id);visited.add(id);id=catalog.find(r=>r.id===id).replacementId;}}
const sourceHashes=Object.fromEntries([...new Set(catalog.flatMap(row=>row.sourcePaths))].sort().map(path=>[path,createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex')]));
const hash=createHash('sha256').update(JSON.stringify(catalog)+JSON.stringify(files)+JSON.stringify(sourceHashes)).digest('hex');
const index=JSON.stringify({schemaVersion:1,contentHash:hash,sourceHashes,categories,items:catalog},null,2)+'\n';
const readme=`# 项目组件复用索引\n\n本文件由 scripts/generate_component_catalog.mjs 生成，请勿手改。组件中心入口：管理中心 → 系统设置 → 组件中心。\n\n开发前按用途检索本文件或 component-index.json，优先antd、再Core、再组合模式；确需新增时说明现有能力缺口。experimental代表展示项验收状态，不改写原组件业务发布状态。\n\n| 名称 | 用途 | 导入/归属 | 示例 |\n| --- | --- | --- | --- |\n`+catalog.map(r=>`| ${r.title} | ${r.summary} | ${r.importPath||'组合模式'}${r.exportName?' / '+r.exportName:''} | [源码](../../${r.files[0]}) |`).join('\n')+'\n\n详细规范：[项目复用规则](../../template/skills/aicrm-solution/references/component-reuse.md)。索引只含静态元数据，无业务数据和凭证。\n';
if(!process.argv.includes('--assets'))for(const [p,text] of [['docs/components/component-index.json',index],['docs/components/README.md',readme]]){
 const full=resolve(root,p);if(process.argv.includes('--check')){if(!existsSync(full)||readFileSync(full,'utf8')!==text)throw Error('Component index drift: '+p)}else{mkdirSync(dirname(full),{recursive:true});writeFileSync(full,text)}
}
if(!process.argv.includes('--check'))rmSync(resolve(root,'apps/ky-admin-host/public/component-examples'),{recursive:true,force:true});
if(!process.argv.includes('--check'))for(const [id,items] of Object.entries(files))for(const item of items){const target=resolve(root,'apps/ky-admin-host/public/component-examples',id,'usage.txt');mkdirSync(dirname(target),{recursive:true});writeFileSync(target,item.text)}
console.log(`Validated ${catalog.length} components / ${catalog.reduce((n,r)=>n+r.examples.length,0)} examples; content ${hash.slice(0,12)}`);
