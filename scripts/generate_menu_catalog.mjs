import ts from 'typescript';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const cache = new Map();
function values(file) {
  if (cache.has(file)) return cache.get(file);
  const env = {}; cache.set(file, env);
  const ast = ts.createSourceFile(file, readFileSync(file,'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function evaluate(n) {
    if (!n) return undefined;
    if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) return evaluate(n.expression);
    if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return ts.isNumericLiteral(n) ? Number(n.text) : n.text;
    if (ts.isArrayLiteralExpression(n)) return n.elements.map(evaluate);
    if (ts.isObjectLiteralExpression(n)) return Object.fromEntries(n.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText(ast).replaceAll('"',''), evaluate(p.initializer)]));
    if (ts.isIdentifier(n)) return env[n.text];
    if (ts.isPropertyAccessExpression(n)) return evaluate(n.expression)?.[n.name.text];
    return undefined;
  }
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text.startsWith('.') && !statement.moduleSpecifier.text.includes('routes')) {
      const imported = values(resolve(dirname(file), statement.moduleSpecifier.text + '.ts'));
      for (const element of statement.importClause?.namedBindings?.elements ?? []) env[element.name.text] = imported[element.propertyName?.text ?? element.name.text];
    }
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) env[declaration.name.getText(ast)] = evaluate(declaration.initializer);
  }
  return env;
}
const entries = [];
const types = ['platform','agency','enterprise'];
for (const folder of readdirSync('plugins').sort()) {
  const file = resolve('plugins',folder,'src/index.tsx');
  let all; try { all = values(file); } catch (e) { throw new Error(`Cannot inventory ${file}: ${e.message}`); }
  const plugin = Object.values(all).find(v=>v?.name === folder);
  if (!plugin) continue;
  function add(menu,directory,parentKey,order) {
    const group = Boolean(menu.children?.length);
    const required = menu.requiredAnyPermissions ?? (menu.requiredPermission ? [menu.requiredPermission] : []);
    const workspaceTypes = types.filter(t=>!required.length || required.some(p=>p?.startsWith(t+'.')));
    if (!workspaceTypes.length) throw new Error(`Unresolved permissions: ${menu.key}`);
    entries.push({directoryType:directory, menuKey:menu.key,nodeType:group?'group':'leaf',parentKey:parentKey??null,name:menu.label,icon:menu.icon??'AppstoreOutlined',workspaceTypes,routeKey:group?null:menu.key,routePath:group?null:menu.path,pageType:'internal',status:'active',sortOrder:order,permissionCode:'',permissionBindings:group?{}:Object.fromEntries(workspaceTypes.map(t=>[t,required.filter(p=>p.startsWith(t+'.'))]))});
    menu.children?.forEach((child,i)=>add(child,directory,menu.key,i));
  }
  if (plugin.menus?.length) {
    const key='group.'+plugin.name;
    entries.push({directoryType:'management',menuKey:key,nodeType:'group',parentKey:null,name:plugin.navGroup,icon:plugin.menus[0].icon??'AppstoreOutlined',workspaceTypes:[...new Set(plugin.menus.flatMap(m=>(m.requiredAnyPermissions??[m.requiredPermission]).filter(Boolean).map(p=>p.split('.')[0])))],routeKey:null,routePath:null,pageType:'internal',status:'active',sortOrder:plugin.navOrder??100,permissionCode:'',permissionBindings:{}});
    plugin.menus.forEach((m,i)=>add(m,'management',key,i));
  }
  plugin.workbenchMenus?.forEach((m,i)=>add(m,'workbench',null,(plugin.navOrder??100)+i));
}
for (const [i,[key,name,path,icon]] of [['overview','概览','/workbench','AppstoreOutlined'],['todos','待办事项','/workbench/todos','BookOutlined'],['messages','我的消息','/workbench/messages','BellOutlined'],['shortcuts','快捷入口','/workbench/shortcuts','StarOutlined']].entries()) entries.push({directoryType:'workbench',menuKey:'workbench.'+key,nodeType:'leaf',parentKey:null,name,icon,workspaceTypes:types,routeKey:'workbench.'+key,routePath:path,pageType:'internal',status:'active',sortOrder:i,permissionCode:'',permissionBindings:{}});
const output = JSON.stringify({version:1,entries},null,2)+'\n';
if(process.argv.includes('--check')) { if(readFileSync('shared/menucatalog/builtin.json','utf8')!==output) throw new Error('Menu catalog drift; regenerate and review'); }
else writeFileSync('shared/menucatalog/builtin.json',output);
console.log(`Inventoried ${entries.length} trusted menu nodes`);
