import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./pages/script-management-page.tsx", import.meta.url), "utf8");

assert.match(source, /const assetStatusLabel=\(status:AssetVersion\["status"\]\)=>status==="draft"\?"草稿":"已发布"/);
assert.doesNotMatch(source, />只读查看<|已生效<\/Tag>/);
assert.match(source, /title:"版本",dataIndex:"version",render:\(version:string,item:AssetVersion\)=>\<Button[^>]+onClick=\{\(\)=>void openAssetPreview\(item\)\}/);
assert.match(source, /const formatPublishedTime=.*published!==.*updated!==.*—/);
assert.match(source, /title:"发布时间",dataIndex:"publishedAt",render:\(published:string\|null\|undefined,item:AssetVersion\)=>formatPublishedTime\(published,item\.updatedAt\)/);
assert.match(source, /label:"发布时间",children:formatPublishedTime\(previewAsset\.publishedAt,previewAsset\.updatedAt\)/);
assert.match(source, /title:"字符数",dataIndex:"sourceChars",render:\(chars:number\)=>`\$\{chars\} 字符`/);
assert.match(source, /label:"字符数",children:`\$\{previewAsset\.sourceChars\} 字符`/);
assert.match(source, /label:"注入时机",children:previewAsset\.assetType==="style"\?styleRunAtLabel\(previewAsset\.runAt\)/);
assert.match(source, /样式属性/);
assert.match(source, /document_start/);
assert.match(source, /name="priority"/);
assert.match(source, /const openAssetPreview=async/);
assert.match(source, /changeAssetState\(item,"archive"\)/);
assert.match(source, /确认删除历史版本/);
assert.match(source, /can\(perm\.archive\)/);
assert.match(source, /历史版本/);
