import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const {buildSync}=createRequire(new URL('../../../apps/aicrm-desktop/package.json',import.meta.url))('esbuild');
const source=buildSync({entryPoints:[new URL('./authorization-tree.ts',import.meta.url).pathname],bundle:true,format:'esm',platform:'node',write:false}).outputFiles[0].text;
const { buildAuthorizationTree, authorizationNodePermissionIds }=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const permissions=[{id:'view',code:'platform.roles.view',name:'查看角色',resource:'roles',category:'page',status:'normal'},{id:'edit',code:'platform.roles.update',name:'编辑角色',resource:'roles',category:'action',status:'normal'},{id:'legacy',code:'menu.platform.old',name:'历史入口',resource:'old',category:'menu',status:'normal'}];
const group={menuKey:'group',name:'权限中心',nodeType:'group',sortOrder:0};
const entry={menuKey:'roles',name:'角色管理',nodeType:'leaf',parentKey:'group',sortOrder:1,permissionBindings:{platform:['platform.roles.view']}};
test('empty catalog keeps every assignable permission visible, including existing menu grants',()=>{
 const result=buildAuthorizationTree(permissions,[]);
 assert.deepEqual([...result.renderedIds].sort(),['edit','legacy','view']);
 assert.equal(result.nodes[0].title,'公共权限');
});
test('category filters preserve module hierarchy and link operation/page permissions to the registered module',()=>{
 const dirs=[{directory:'management',entries:[entry],ancestors:[group]}];
 const result=buildAuthorizationTree(permissions,dirs,'action');
 assert.equal(result.nodes[0].title,'管理中心');
 assert.equal(result.nodes[0].children[0].children[0].title,'角色管理');
 assert.deepEqual([...result.renderedIds],['edit']);
});
test('permission shared by multiple menus uses distinct tree keys and one stable permission identity',()=>{
 const result=buildAuthorizationTree(permissions,[{directory:'workbench',entries:[entry,{...entry,menuKey:'roles2',name:'角色入口2'}],ancestors:[group]}]);
 const aliases=[...result.keyToId].filter(([,id])=>id==='edit');
 assert.equal(aliases.length,2);assert.notEqual(aliases[0][0],aliases[1][0]);
 assert.equal(result.renderedIds.size,3);
});

test('unchecking one alias affects its stable permission and group operations stay inside the filtered tree',()=>{
 const result=buildAuthorizationTree(permissions,[{directory:'management',entries:[entry,{...entry,menuKey:'roles2'}],ancestors:[group]}],'action');
 const key=[...result.keyToId].find(([,id])=>id==='edit')[0];
 assert.deepEqual([...authorizationNodePermissionIds(result.nodes,result.keyToId,key)],['edit']);
 assert.deepEqual([...authorizationNodePermissionIds(result.nodes,result.keyToId,'directory:management')],['edit']);
});
