import assert from "node:assert/strict";
import test from "node:test";
import { buildMenuPermissionTree } from "./menu-permission-tree.ts";

const permission=(id,code)=>({id,code,name:code,category:"menu",resource:"menu",action:"view",status:"normal",workspaceTypes:["platform"]});
const entry=(menuKey,permissionCode,parentKey,nodeType="leaf",sortOrder=0)=>({directoryType:"management",menuKey,permissionCode,parentKey,nodeType,name:menuKey,icon:"",workspaceTypes:["platform"],pageType:"internal",status:"active",sortOrder,revision:1});

test("menu authorization tree follows server hierarchy and maps only matching permission codes",()=>{
  const perms=[permission("p-leaf","menu.profile.view"),permission("p-other","menu.orphan.view")];
  const group=entry("management.profile","menu.profile.group",undefined,"group");
  const leaf=entry("management.profile.details","menu.profile.view","management.profile");
  const result=buildMenuPermissionTree(perms,[leaf],[group],"management");
  assert.deepEqual([...result.permissionIds],["p-leaf"]);
  assert.equal(result.nodes[0].key,"menu:management:management.profile");
  assert.equal(result.nodes[0].children[0].key,"p-leaf");
  assert.equal(result.permissionIds.has("p-other"),false);
});

test("menu with missing permission metadata is not rendered as assignable",()=>{
  const leaf=entry("management.orphan","menu.orphan.view",undefined);
  const result=buildMenuPermissionTree([], [leaf], [], "management");
  assert.equal(result.nodes.length,0);
  assert.equal(result.permissionIds.size,0);
});
