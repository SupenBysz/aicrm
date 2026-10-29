import type { MenuDirectoryEntry } from "./api";
import type { Permission } from "./api";

export interface MenuTreeNode { key:string; title:string; selectable?:boolean; isLeaf?:boolean; children?:MenuTreeNode[] }
export interface MenuPermissionTree { nodes:MenuTreeNode[]; permissionIds:Set<string>; expandedKeys:string[] }

/** Build menu permissions from the authorized directory hierarchy, never from guessed key prefixes. */
export function buildMenuPermissionTree(permissions:readonly Permission[], entries:readonly MenuDirectoryEntry[], ancestors:readonly MenuDirectoryEntry[], directory:string):MenuPermissionTree {
  const permissionByCode=new Map(permissions.filter(item=>item.category==="menu"&&item.status==="normal").map(item=>[item.code,item]));
  const all=new Map<string,MenuDirectoryEntry>();for(const entry of [...ancestors,...entries])all.set(entry.menuKey,entry);
  const visible=new Map<string,MenuTreeNode>();const ids=new Set<string>();
  const nodeFor=(entry:MenuDirectoryEntry):MenuTreeNode=>{
    const current=visible.get(entry.menuKey);if(current)return current;
    const node:MenuTreeNode={key:`menu:${directory}:${entry.menuKey}`,title:entry.name,selectable:false,children:[]};visible.set(entry.menuKey,node);
    return node;
  };
  const roots:MenuTreeNode[]=[];
  for(const entry of entries.filter(item=>item.nodeType==="leaf").slice().sort((a,b)=>a.sortOrder-b.sortOrder||a.menuKey.localeCompare(b.menuKey))){
    const permission=permissionByCode.get(entry.permissionCode);if(!permission)continue;
    const leaf:MenuTreeNode={key:permission.id,title:`${entry.name}（${entry.permissionCode}）`,isLeaf:true};ids.add(permission.id);
    if(!entry.parentKey){roots.push(leaf);continue;}
    const chain:MenuDirectoryEntry[]=[];let parent=all.get(entry.parentKey);const seen=new Set<string>();
    while(parent&&parent.nodeType==="group"&&!seen.has(parent.menuKey)){seen.add(parent.menuKey);chain.unshift(parent);parent=parent.parentKey?all.get(parent.parentKey):undefined;}
    if(!chain.length)continue;
    let parentNode=nodeFor(chain[0]);if(!roots.includes(parentNode))roots.push(parentNode);
    for(let index=1;index<chain.length;index++){const child=nodeFor(chain[index]);parentNode.children??=[];if(!parentNode.children.some(item=>item.key===child.key))parentNode.children.push(child);parentNode=child;}
    parentNode.children??=[];parentNode.children.push(leaf);
  }
  const order=new Map([...all.values()].map(item=>[`menu:${directory}:${item.menuKey}`,item.sortOrder]));
  const normalize=(items:MenuTreeNode[])=>{items.sort((a,b)=>(order.get(a.key)??0)-(order.get(b.key)??0)||a.key.localeCompare(b.key));for(const item of items)if(item.children){normalize(item.children);if(!item.children.length)delete item.children;}};
  normalize(roots);
  const expanded=[...visible.values()].map(node=>node.key);
  return {nodes:roots,permissionIds:ids,expandedKeys:expanded};
}

export function filterMenuPermissionIds(permissionIds:readonly string[],allowed:ReadonlySet<string>):string[]{return permissionIds.filter(id=>allowed.has(id));}
