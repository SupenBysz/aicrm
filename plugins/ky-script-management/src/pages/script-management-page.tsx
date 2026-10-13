import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement, useEffect, useRef, useState } from "react";
import { App, Button, Checkbox, Descriptions, Drawer, Form, Input, InputNumber, Modal, Radio, Segmented, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import { CodeOutlined, CompressOutlined, CopyOutlined, DeleteOutlined, ExpandOutlined, InfoCircleOutlined, PlusOutlined, ReadOutlined, RedoOutlined, ScissorOutlined, SelectOutlined, SettingOutlined, SnippetsOutlined, UndoOutlined } from "@ant-design/icons";
import { ListPageCard, useCurrentWorkspace, usePermissions, useRequestClient } from "@ky/admin-core";
import { publicStylePermissions, scriptManagementPermissions as perm } from "../permissions";
import { MonacoSourceEditor } from "../components/monaco-source-editor";
import { jssdkCompletionItems } from "../jssdk-reference";
import { defaultEditorShortcuts, displayEditorShortcut, normalizeEditorShortcutPreferences, shortcutKeyFromEvent, shortcutPlatform, validateEditorShortcuts, type EditorShortcutCommand, type EditorShortcutPreferences } from "../editor-shortcut-preferences";
import { clampHelpDrawerWidth, nudgeHelpDrawerWidth, readHelpDrawerWidth, resizeHelpDrawerWidth, writeHelpDrawerWidth } from "../help-drawer-sizing";
import { assetAction, copyAsset, createAsset, createPublicScript, createPublicStyle, createScript, deletePublicScript, deletePublicStyle, getAsset, getPublicScript, getPublicStyle, getScript, listAssets, listEditorModels, listEditorProviders, listPublicScripts, listPublicStyles, listScripts, testEditorModel, updateAsset, updatePublicScript, updatePublicScriptStatus, updatePublicStyle, updatePublicStyleStatus, updateScript, updateScriptStatus, type AssetType, type AssetVersion, type EditorAiModel, type EditorAiProvider, type PublicScriptRow, type PublicStyleRow, type ScriptMatchRule, type ScriptRow } from "../api";

const errorText=(e:unknown)=>{const x=e as {code?:string;message?:string};return x?.code==="permission_denied"?"当前身份无权执行该操作":x?.code==="conflict"?"数据已被修改，请刷新后重试":x?.code==="validation_error"&&x.message?x.message:x?.code==="validation_error"?"输入内容不符合要求":"操作失败，请稍后重试"};
const formatTime=(v:string|number|null|undefined)=>{if(v===null||v===undefined||v==="")return "—";const n=typeof v==="number"?(v<1_000_000_000_000?v*1000:v):v;const date=new Date(n);return Number.isNaN(date.getTime())?"—":date.toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})};
const formatPublishedTime=(published:string|number|null|undefined,updated:string|number|null|undefined)=>{if(published!==null&&published!==undefined&&published!=="")return formatTime(published);if(updated!==null&&updated!==undefined&&updated!=="")return formatTime(updated);return "—"};
const actorLabel=(item:AssetVersion)=>item.updatedByName||item.createdByName||item.updatedBy||item.createdBy||"—";
const matchUrlCodeStyle={display:"block",marginTop:6,padding:"5px 8px",borderRadius:4,background:"rgba(127,127,127,0.16)",fontFamily:"ui-monospace, SFMono-Regular, Menlo, monospace",fontSize:13,wordBreak:"break-all",overflowWrap:"anywhere"} as const;
const matchUrlHelp=(<div style={{width:480,maxWidth:"min(480px, calc(100vw - 32px))",maxHeight:420,overflowY:"auto",fontSize:13,lineHeight:1.7}}><div style={{fontSize:15,fontWeight:600,marginBottom:10}}>匹配规则说明</div><div style={{marginBottom:12}}>当前服务会校验并规范化 URL 配置，但不会执行脚本注入。exact 是规范化后的完整 URL 精确匹配；wildcard 仅把 * 作为通配符，最多 32 个。wildcard 不含 * 时按完整 URL 字面量匹配。</div><div style={{marginBottom:12}}><strong>完整 URL</strong><span style={matchUrlCodeStyle}>https://shop.example.com/product/list</span></div><div style={{marginBottom:12}}><strong>域名 / 路径前缀</strong><span style={matchUrlCodeStyle}>https://shop.example.com/product</span><div>必须包含 http 或 https 协议和域名；仅填写 shop.example.com 或 /product/ 不会通过校验。</div></div><div style={{marginBottom:12}}><strong>路径后缀</strong><span style={matchUrlCodeStyle}>https://shop.example.com/*/detail</span></div><div style={{marginBottom:12}}><strong>wildcard</strong><span style={matchUrlCodeStyle}>https://shop.example.com/product/*</span><div>* 只匹配 URL 中的任意字符，不扩展到其他协议或域名；不含 * 的 wildcard URL 等同字面量。</div></div><div><strong>注意事项</strong><div>空值、片段（#fragment）、账号信息、控制字符和非法 URL 不能保存；查询字符串按原始顺序参与匹配。当前不会执行 URL 中的脚本内容。</div></div></div>);
const assetTypeLabel=(type:AssetType)=>type==="script"?"脚本内容":"样式内容";
const assetStatusLabel=(status:AssetVersion["status"])=>status==="draft"?"草稿":"已发布";
const styleRunAtOptions=[{value:"document_start",label:"页面开始加载"},{value:"dom_content_loaded",label:"DOM 就绪"},{value:"document_idle",label:"页面加载完成"},{value:"spa_route_change",label:"SPA 路由变化"}];
const styleRunAtLabel=(value:string)=>styleRunAtOptions.find(item=>item.value===value)?.label??value;
type CompletionItem={label:string;description:string;insertText?:string;scope?:string};
type SnippetPlaceholder={start:number;end:number;index:number};
function parseSnippet(source:string):{text:string;placeholders:SnippetPlaceholder[]} {
 const placeholders:SnippetPlaceholder[]=[];
 let text=""; let cursor=0; let match:RegExpExecArray|null;
 const pattern=/\$\{(\d+)(?::([^}]*))?\}/g;
 while((match=pattern.exec(source))){
  text+=source.slice(cursor,match.index);
  const value=match[2]??""; const start=text.length;
  text+=value; placeholders.push({start,end:start+value.length,index:Number(match[1])});
  cursor=match.index+match[0].length;
 }
 text+=source.slice(cursor);
 placeholders.sort((a,b)=>a.index-b.index);
 return {text,placeholders};
}
const jsCompletionItems:CompletionItem[]=[{label:"function",description:"函数代码片段",insertText:"function ${1:name}(${2:args}) {\n  ${0}\n}"},{label:"if",description:"条件判断代码片段",insertText:"if (${1:condition}) {\n  ${0}\n}"},{label:"for",description:"循环代码片段",insertText:"for (const ${1:item} of ${2:items}) {\n  ${0}\n}"},{label:"try",description:"异常处理代码片段",insertText:"try {\n  ${1}\n} catch (${2:error}) {\n  ${0}\n}"},{label:"setTimeout",description:"延迟执行回调",insertText:"setTimeout(() => {\n  ${0}\n}, ${1:1000})"},{label:"setInterval",description:"按间隔重复执行回调",insertText:"setInterval(() => {\n  ${0}\n}, ${1:1000})"},{label:"clearTimeout",description:"取消延迟任务",insertText:"clearTimeout(${1:timeoutId})"},{label:"clearInterval",description:"取消重复任务",insertText:"clearInterval(${1:intervalId})"},{label:"fetch",description:"发起网络请求",insertText:"fetch(${1:url}, {\n  method: \"GET\"\n})"},{label:"Promise",description:"表示异步操作结果",insertText:"Promise.resolve(${1:value})"},{label:"JSON",description:"处理 JSON 文本",insertText:"JSON.stringify(${1:value})"},{label:"console",description:"输出调试信息",insertText:"console.log(${1:value})"},{label:"document",description:"访问文档对象",insertText:"document.querySelector(${1:selector})"},{label:"window",description:"访问页面窗口对象",insertText:"window.location.href"}];
const javascriptCompletionItems=[...jsCompletionItems,...jssdkCompletionItems];
const completionTokenAt=(source:string,position:number)=>source.slice(0,position).match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.?$/)?.[0]??"";
const completionScopeFor=(token:string)=>token.startsWith("jssdk.")?token.slice(0,token.lastIndexOf(".")+1):token==="jssdk"?"root":"";
const lifecycleSnippets=[
 {key:"documentStart",label:"documentStart",description:"文档开始解析时执行",insertText:'jssdk.lifecycle.on("documentStart", () => {\n  // 文档开始解析时执行\n});\n'},
 {key:"domReady",label:"domReady",description:"DOM 结构构建完成后执行",insertText:'jssdk.lifecycle.on("domReady", () => {\n  // DOM 就绪后执行\n});\n'},
 {key:"pageLoad",label:"pageLoad",description:"页面资源加载完成后执行",insertText:'jssdk.lifecycle.on("pageLoad", () => {\n  // 页面加载完成后执行\n});\n'},
 {key:"routeChange",label:"routeChange",description:"单页应用路由发生变化时执行",insertText:'jssdk.lifecycle.on("routeChange", ({ url, previousUrl }) => {\n  // SPA 路由变化时执行\n});\n'},
 {key:"userAction",label:"userAction",description:"用户明确操作后执行",insertText:'jssdk.lifecycle.on("userAction", (event) => {\n  // 用户明确操作时执行\n});\n'}
 ] as const;
const networkSnippets=[
 {key:"subscribeRequest",label:"subscribeRequest",description:"观察匹配的请求",insertText:'jssdk.net.subscribeRequest({\n  match: { url: "${1:https://example.com/api/*}" }\n}, async (event) => {\n  // 请求发送前执行\n  console.log(event.url, event.method);\n});\n'},
 {key:"subscribeResponse",label:"subscribeResponse",description:"观察匹配的响应",insertText:'jssdk.net.subscribeResponse({\n  match: { url: "${1:https://example.com/api/*}" },\n  includeBody: true\n}, async (event) => {\n  // 收到响应时执行\n  console.log(event.status, event.body);\n});\n'},
 {key:"interceptRequest",label:"interceptRequest",description:"拦截并修改请求",insertText:'jssdk.net.interceptRequest({\n  match: { url: "${1:https://example.com/api/*}" }\n}, async (event) => {\n  await event.continue({\n    headers: { "X-Debug": "${2:1}" }\n  });\n});\n'},
 {key:"interceptResponse",label:"interceptResponse",description:"拦截并改写响应",insertText:'jssdk.net.interceptResponse({\n  match: { url: "${1:https://example.com/api/*}" },\n  includeBody: true\n}, async (event) => {\n  await event.fulfill(${1:"{\\"ok\\":true}"}, ${2:200}, {\n    "content-type": "application/json"\n  });\n});\n'},
 {key:"waitForRequest",label:"waitForRequest",description:"等待一次匹配请求",insertText:'const requestEvent = await jssdk.net.waitForRequest({\n  match: { url: "${1:https://example.com/api/*}" }\n});\n'},
 {key:"waitForResponse",label:"waitForResponse",description:"等待一次匹配响应",insertText:'const responseEvent = await jssdk.net.waitForResponse({\n  match: { url: "${1:https://example.com/api/*}" },\n  includeBody: true\n});\n'}
] as const;
const monacoContextSnippets=[...lifecycleSnippets,...networkSnippets].map(item=>({id:item.key,label:item.label,description:item.description,insertText:item.insertText}));
const cssCompletionItems:CompletionItem[]=[{label:"display",description:"设置元素显示方式",insertText:"display: ${1:flex};"},{label:"position",description:"设置定位方式",insertText:"position: ${1:relative};"},{label:"margin",description:"设置外边距",insertText:"margin: ${1:0};"},{label:"padding",description:"设置内边距",insertText:"padding: ${1:0};"},{label:"color",description:"设置文字颜色",insertText:"color: ${1:#333};"},{label:"background",description:"设置背景",insertText:"background: ${1:#fff};"},{label:"width",description:"设置宽度",insertText:"width: ${1:100%};"},{label:"height",description:"设置高度",insertText:"height: ${1:auto};"},{label:"transition",description:"过渡效果代码片段",insertText:"transition: ${1:all 0.2s ease};"},{label:".class",description:"按 class 选择元素",insertText:".class {\n  ${0}\n}"},{label:"#id",description:"按 id 选择元素",insertText:"#id {\n  ${0}\n}"}];
type EditorPrefs={enabled:boolean;providerId:string;modelId:string;completionShortcut:string;findShortcut:string;replaceShortcut:string};
const toEditorPrefsShortcuts=(shortcuts:EditorShortcutPreferences)=>({completionShortcut:shortcuts.completion,findShortcut:shortcuts.find,replaceShortcut:shortcuts.replace});
const currentShortcutPlatform=()=>shortcutPlatform(typeof navigator==="undefined"?"":navigator.platform);
const emptyEditorPrefs=():EditorPrefs=>({enabled:false,providerId:"",modelId:"",...toEditorPrefsShortcuts(defaultEditorShortcuts(currentShortcutPlatform()))});
const editorPrefsShortcuts=(value:EditorPrefs):EditorShortcutPreferences=>({completion:value.completionShortcut,find:value.findShortcut,replace:value.replaceShortcut});
const normalizePrefs=(v:unknown):EditorPrefs=>{const x=v as Partial<EditorPrefs>&{shortcut?:unknown}|null|undefined;return {enabled:x?.enabled===true,providerId:typeof x?.providerId==="string"?x.providerId:"",modelId:typeof x?.modelId==="string"?x.modelId:"",...toEditorPrefsShortcuts(normalizeEditorShortcutPreferences(x,currentShortcutPlatform()))}};
const isCompletionModifierKey=(event:ReactKeyboardEvent)=>["Shift","Control","Meta","Alt","Option","Fn","ShiftLeft","ShiftRight","ControlLeft","ControlRight","MetaLeft","MetaRight","AltLeft","AltRight"].includes(event.key)||["ShiftLeft","ShiftRight","ControlLeft","ControlRight","MetaLeft","MetaRight","AltLeft","AltRight","Fn"].includes(event.code);
const isCompletionPrintableKey=(event:ReactKeyboardEvent)=>event.key.length===1&&!/[\u0000-\u001f\u007f]/.test(event.key)&&!event.ctrlKey&&!event.metaKey&&!event.altKey;

type SourceToken={text:string;kind?:"comment"|"string"|"number"|"keyword"|"property"|"selector"|"atRule"};
const jsKeywords=new Set(["const","let","var","function","return","if","else","for","while","new","class","import","export","async","await","true","false","null","undefined"]);
const tokenColor:Record<NonNullable<SourceToken["kind"]>,string>={comment:"#6a737d",string:"#b35c00",number:"#8250df",keyword:"#0969da",property:"#0550ae",selector:"#953800",atRule:"#8250df"};
function tokenizeSource(source:string,language:string):SourceToken[]{
 const pattern=language==="JavaScript"
  ? /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g
  : /(\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[A-Za-z-]+|\b\d+(?:\.\d+)?(?:px|rem|em|%)?\b|[.#]?[A-Za-z_-][\w-]*(?=\s*:)|[.#][A-Za-z_-][\w-]*)/g;
 const result:SourceToken[]=[]; let last=0; let match:RegExpExecArray|null;
 while((match=pattern.exec(source))){
  if(match.index>last)result.push({text:source.slice(last,match.index)});
  const text=match[0]; let kind:SourceToken["kind"];
  if(text.startsWith("/*")||text.startsWith("//"))kind="comment";
  else if(/^['"`]/.test(text))kind="string";
  else if(/^\d/.test(text))kind="number";
  else if(language==="JavaScript"&&jsKeywords.has(text))kind="keyword";
  else if(language==="JavaScript"&&/^[A-Za-z_$][\w$]*$/.test(text)&&/^\s*\(/.test(source.slice(match.index+text.length)))kind="property";
  else if(language!=="JavaScript"&&text.startsWith("@"))kind="atRule";
  else if(language!=="JavaScript"&&/^[.#]/.test(text))kind="selector";
  else if(language!=="JavaScript"&&/^[A-Za-z_-]/.test(text))kind="property";
  result.push({text,kind}); last=match.index+text.length;
 }
 if(last<source.length)result.push({text:source.slice(last)});
 return result;
}

function findSearchMatches(source: string, query: string): number[] {
 const normalizedSource = source.toLocaleLowerCase();
 const normalizedQuery = query.toLocaleLowerCase();
 if (!normalizedQuery) return [];
 const matches: number[] = [];
 let cursor = 0;
 while (cursor <= normalizedSource.length) {
  const index = normalizedSource.indexOf(normalizedQuery, cursor);
  if (index < 0) break;
  matches.push(index);
  cursor = index + Math.max(normalizedQuery.length, 1);
 }
 return matches;
}

function renderHighlightedTokens(tokens: SourceToken[], query: string, currentMatch: number): ReactElement[] {
 const normalizedQuery = query.toLocaleLowerCase();
 let occurrence = 0;
 return tokens.flatMap((token, tokenIndex) => {
  const baseStyle = token.kind ? { color: tokenColor[token.kind] } : undefined;
  if (!normalizedQuery) return [<span key={`${tokenIndex}-${token.text.slice(0, 8)}`} style={baseStyle}>{token.text}</span>];
  const normalizedText = token.text.toLocaleLowerCase();
  const pieces: ReactElement[] = [];
  let cursor = 0;
  while (cursor < token.text.length) {
   const index = normalizedText.indexOf(normalizedQuery, cursor);
   if (index < 0) {
    pieces.push(<span key={`${tokenIndex}-tail-${cursor}`} style={baseStyle}>{token.text.slice(cursor)}</span>);
    break;
   }
   if (index > cursor) pieces.push(<span key={`${tokenIndex}-text-${cursor}`} style={baseStyle}>{token.text.slice(cursor, index)}</span>);
   const matchIndex = occurrence;
   occurrence += 1;
   pieces.push(<mark key={`${tokenIndex}-match-${index}`} style={{ ...baseStyle, color: matchIndex === currentMatch ? "var(--admin-search-current-fg, #1f1f1f)" : "var(--admin-search-hit-fg, #1f1f1f)", backgroundColor: matchIndex === currentMatch ? "var(--admin-search-current-bg, #ffb020)" : "var(--admin-search-hit-bg, #ffe58f)", borderRadius: 3, padding: "0 1px", boxShadow: matchIndex === currentMatch ? "0 0 0 1px var(--admin-primary)" : "none" }}>{token.text.slice(index, index + query.length)}</mark>);
   cursor = index + query.length;
  }
  return pieces;
 });
}

function renderCompletionLabel(label: string, prefix: string): ReactElement {
 const normalizedPrefix = prefix.toLocaleLowerCase();
 if (!normalizedPrefix) return <span>{label}</span>;
 const index = label.toLocaleLowerCase().indexOf(normalizedPrefix);
 if (index < 0) return <span>{label}</span>;
 return <span>{label.slice(0, index)}<mark style={{ color: "#c2410c", WebkitTextFillColor: "#c2410c", backgroundColor: "var(--admin-search-current-bg, #ffb020)", borderRadius: 3, padding: "0 2px", fontWeight: 600 }}>{label.slice(index, index + prefix.length)}</mark>{label.slice(index + prefix.length)}</span>;
}

type EditorContextMenuState={x:number;y:number;start:number;end:number;index:number};
function formatJavaScriptSource(source:string):string {
 let output=""; let line=""; let indent=0; let quote=""; let escaped=false; let lineComment=false; let blockComment=false; let braceDepth=0;
 const push=()=>{const value=line.trimEnd();if(value.trim())output+=`${"  ".repeat(Math.max(indent,0))}${value.trim()}\n`;line=""};
 for(let i=0;i<source.length;i+=1){const ch=source[i];const next=source[i+1]??"";
  if(lineComment){line+=ch;if(ch==="\n"){lineComment=false;push()}continue}
  if(blockComment){line+=ch;if(ch==="*"&&next==="/"){line+=next;i+=1;blockComment=false}continue}
  if(quote){line+=ch;if(escaped)escaped=false;else if(ch==="\\")escaped=true;else if(ch===quote)quote="";continue}
  if((ch==='"'||ch==="'"||ch==='`')){quote=ch;line+=ch;continue}
  if(ch==="/"&&next==="/"){line+=ch+next;i+=1;lineComment=true;continue}
  if(ch==="/"&&next==="*"){line+=ch+next;i+=1;blockComment=true;continue}
  if(ch==="{"){line=line.trimEnd()+" {";push();indent+=1;braceDepth+=1;continue}
  if(ch==="}"){if(line.trim())push();indent-=1;braceDepth-=1;if(indent<0||braceDepth<0)throw new Error("花括号不匹配");line="}";if(next!==";"&&next!==","&&next!==")")push();continue}
  if(ch===';'){line+=ch;push();continue}
  if(ch==='\n'){if(line.trim())push();continue}
  line+=ch;
 }
 if(quote||lineComment||blockComment||braceDepth!==0)throw new Error("字符串、注释或花括号未闭合");
 if(line.trim())push();
 return output.replace(/\n+$/,"\n");
}

function completionPreview(item: CompletionItem): string {
 const source = item.insertText?.trim() || item.label;
 if (!source) return "";
 return source.replace(/\$\{\d+(?::([^}]*))?\}/g, (_, fallback: string | undefined) => fallback ?? "").replace(/\s+/g, " ").trim();
}

function PublicScriptsPanel({client,can,message,modal,onDirtyChange,onOpenHelp,shortcuts}:{client:ReturnType<typeof useRequestClient>;can:(permission:string)=>boolean;message:{success:(content:string)=>void;error:(content:string)=>void;warning:(content:string)=>void};modal:{confirm:(options:Record<string,unknown>)=>void};onDirtyChange:(dirty:boolean)=>void;onOpenHelp:()=>void;shortcuts:EditorShortcutPreferences}){
 const [items,setItems]=useState<PublicScriptRow[]>([]); const [selected,setSelected]=useState<PublicScriptRow|null>(null); const [content,setContent]=useState(""); const [savedContent,setSavedContent]=useState(""); const [loading,setLoading]=useState(false); const [saving,setSaving]=useState(false); const [basicOpen,setBasicOpen]=useState(false); const [dirty,setDirty]=useState(false); const [form]=Form.useForm();
 const markDirty=(value:boolean)=>{setDirty(value);onDirtyChange(value)};
 useEffect(()=>{form.setFieldsValue({enabled:true})},[form]);
 const load=async()=>{setLoading(true);try{const result=await listPublicScripts(client,1,200,"","");setItems(result.items??[]);if(selected){const next=(result.items??[]).find(item=>item.id===selected.id);if(next)setSelected(next)}}catch(e){message.error(errorText(e))}finally{setLoading(false)}};
 useEffect(()=>{void load()},[]);
 const select=async(item:PublicScriptRow)=>{const next=async()=>{try{const fresh=await getPublicScript(client,item.id,true);setSelected(fresh);const nextContent=fresh.sourceContent??"";setContent(nextContent);setSavedContent(nextContent);form.setFieldsValue({name:fresh.name,identifier:fresh.identifier,description:fresh.description??"",enabled:fresh.enabled!==false});markDirty(false)}catch(e){message.error(errorText(e))}};if(dirty){modal.confirm({title:"当前公共脚本有未保存内容",content:"切换脚本后当前修改将被覆盖，确定继续吗？",okText:"继续切换",cancelText:"取消",onOk:next});return}await next()};
 const create=()=>{setSelected(null);setContent("");setSavedContent("");form.resetFields();form.setFieldsValue({enabled:true});markDirty(false);setBasicOpen(true)};
 const edit=()=>{if(!selected)return;form.setFieldsValue({name:selected.name,identifier:selected.identifier,description:selected.description??"",enabled:selected.enabled!==false});setBasicOpen(true)};
 const saveBasic=async()=>{try{const values=await form.validateFields();setSaving(true);const payload={name:values.name.trim(),identifier:values.identifier.trim(),description:(values.description??"").trim(),enabled:values.enabled!==false};const saved=selected?await updatePublicScript(client,selected.id,payload,selected.revision):await createPublicScript(client,{...payload,sourceContent:content});setSelected(saved);if(!selected){setContent("");setSavedContent("")}setBasicOpen(false);markDirty(false);await load();message.success(selected?"公共脚本基本信息已保存":"公共脚本已创建")}catch(e){if((e as {errorFields?:unknown}).errorFields)return;message.error(errorText(e))}finally{setSaving(false)}};
 const saveContent=async()=>{if(!selected)return;try{setSaving(true);const saved=await updatePublicScript(client,selected.id,{name:selected.name,identifier:selected.identifier,description:selected.description??"",enabled:selected.enabled!==false,sourceContent:content},selected.revision);setSelected(saved);const nextContent=saved.sourceContent??content;setContent(nextContent);setSavedContent(nextContent);setItems(current=>current.map(item=>item.id===saved.id?saved:item));markDirty(false);message.success("公共脚本内容已保存")}catch(e){message.error(errorText(e))}finally{setSaving(false)}};
 const remove=()=>{if(!selected)return;modal.confirm({title:"删除公共脚本？",content:`删除“${selected.name}”后将无法恢复。`,okText:"确认删除",okType:"danger",cancelText:"取消",onOk:async()=>{try{await deletePublicScript(client,selected.id,selected.revision);create();await load();message.success("公共脚本已删除")}catch(e){message.error(errorText(e))}}})};
 const toggle=async(enabled:boolean)=>{if(!selected)return;try{const fresh=await updatePublicScriptStatus(client,selected.id,enabled?"enabled":"disabled",selected.revision);setSelected(fresh);setItems(current=>current.map(item=>item.id===fresh.id?fresh:item));form.setFieldValue("enabled",fresh.enabled);message.success(enabled?"公共脚本已启用":"公共脚本已停用")}catch(e){message.error(errorText(e))}};
 return <div className="public-scripts-panel" style={{display:"flex",flex:1,minHeight:0,overflow:"hidden",borderTop:"1px solid var(--admin-border-color)"}}>
   <aside className="public-scripts-tabs" aria-label="公共脚本列表" style={{width:190,flex:"0 0 190px",display:"flex",flexDirection:"column",minHeight:0,borderRight:"1px solid var(--admin-border-color)",background:"var(--admin-bg-color)"}}>
    <div style={{padding:8,borderBottom:"1px solid var(--admin-border-color)"}}><Button block size="small" type="primary" onClick={create} disabled={!can(perm.create)}>新增公共脚本</Button></div>
    <div style={{flex:1,minHeight:0,overflowY:"auto",padding:"4px 6px 8px"}}>{loading?<Typography.Text type="secondary" style={{display:"block",padding:8}}>正在加载…</Typography.Text>:items.length?items.map(item=><button type="button" key={item.id} onClick={()=>void select(item)} className={`public-script-tab ${selected?.id===item.id?"is-active":""}`}><span>{item.name}</span><small>{item.identifier}</small></button>):<Typography.Text type="secondary" style={{display:"block",padding:8}}>暂无公共脚本</Typography.Text>}</div>
   </aside>
   <section style={{display:"flex",flex:1,minWidth:0,minHeight:0,flexDirection:"column",overflow:"hidden"}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,padding:"8px 12px",borderBottom:"1px solid var(--admin-border-color)",background:"var(--admin-bg-color)"}}><div style={{minWidth:0}}><Typography.Text strong ellipsis>{selected?.name??"未选择公共脚本"}</Typography.Text>{selected&&<Typography.Text type="secondary" style={{marginLeft:8}}>{selected.identifier}</Typography.Text>}</div><Space size={6}>{selected&&can(perm.update)&&<Button size="small" onClick={edit}>编辑基本信息</Button>}{selected&&can(perm.update)&&<Switch size="small" checked={selected.enabled!==false} checkedChildren="启用" unCheckedChildren="停用" onChange={value=>void toggle(value)}/>} {selected&&can(perm.archive)&&<Button size="small" danger onClick={remove}>删除</Button>}<Button size="small" type="primary" loading={saving} onClick={()=>void saveContent()} disabled={!selected||!can(perm.update)}>{selected?"保存脚本":"保存脚本"}</Button></Space></div>
    <div style={{display:"flex",flex:1,minHeight:0,padding:0,overflow:"hidden"}}><MonacoSourceEditor value={content} onChange={value=>{setContent(value);if(value!==savedContent)markDirty(true)}} language="JavaScript" scriptName={selected?.name??"公共脚本"} version={null} editable={Boolean(selected)&&can(perm.update)} completionItems={javascriptCompletionItems} contextSnippets={monacoContextSnippets} shortcuts={shortcuts} onFormat={formatJavaScriptSource} onOpenHelp={onOpenHelp}/></div>
   </section>
   <Drawer title={selected?`编辑公共脚本：${selected.name}`:"新增公共脚本"} open={basicOpen} onClose={()=>setBasicOpen(false)} width="min(420px, 100vw)" extra={<Button type="primary" loading={saving} onClick={()=>void saveBasic()}>保存</Button>}>
    <Form form={form} layout="vertical" onValuesChange={()=>markDirty(true)}><Form.Item name="name" label="名称" rules={[{required:true,message:"请输入公共脚本名称"}]}><Input placeholder="例如：登录页公共初始化" autoFocus/></Form.Item><Form.Item name="identifier" label="标识符" rules={[{required:true,message:"请输入标识符"},{pattern:/^[A-Za-z0-9][A-Za-z0-9._-]*$/,message:"仅允许字母、数字、点、下划线和连字符，且必须以字母或数字开头"},{max:64,message:"标识符不能超过64个字符"}]}><Input placeholder="例如：COMMON_LOGIN" disabled={Boolean(selected)}/></Form.Item><Form.Item name="description" label="说明"><Input.TextArea rows={3} placeholder="可选，用于说明公共脚本用途"/></Form.Item><Form.Item name="enabled" label="状态" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用"/></Form.Item></Form>
   </Drawer>
 </div>;
}


function PublicStylesPanel({client,can,message,modal,onDirtyChange,onOpenHelp,shortcuts}:{client:ReturnType<typeof useRequestClient>;can:(permission:string)=>boolean;message:{success:(content:string)=>void;error:(content:string)=>void;warning:(content:string)=>void};modal:{confirm:(options:Record<string,unknown>)=>void};onDirtyChange:(dirty:boolean)=>void;onOpenHelp:()=>void;shortcuts:EditorShortcutPreferences}){
 const [items,setItems]=useState<PublicStyleRow[]>([]); const [selected,setSelected]=useState<PublicStyleRow|null>(null); const [content,setContent]=useState(""); const [savedContent,setSavedContent]=useState(""); const [loading,setLoading]=useState(false); const [saving,setSaving]=useState(false); const [basicOpen,setBasicOpen]=useState(false); const [dirty,setDirty]=useState(false); const [form]=Form.useForm();
 const markDirty=(value:boolean)=>{setDirty(value);onDirtyChange(value)};
 useEffect(()=>{form.setFieldsValue({enabled:true})},[form]);
 const load=async()=>{setLoading(true);try{const result=await listPublicStyles(client,1,200,"","");setItems(result.items??[]);if(selected){const next=(result.items??[]).find(item=>item.id===selected.id);if(next)setSelected(next)}}catch(e){message.error(errorText(e))}finally{setLoading(false)}};
 useEffect(()=>{void load()},[]);
 const select=async(item:PublicStyleRow)=>{const next=async()=>{try{const fresh=await getPublicStyle(client,item.id,true);setSelected(fresh);const nextContent=fresh.sourceContent??"";setContent(nextContent);setSavedContent(nextContent);form.setFieldsValue({name:fresh.name,identifier:fresh.identifier,description:fresh.description??"",matchType:fresh.matchType,matchUrl:fresh.matchUrl,runAt:fresh.runAt,priority:fresh.priority,enabled:fresh.enabled!==false});markDirty(false)}catch(e){message.error(errorText(e))}};if(dirty){modal.confirm({title:"当前公共样式有未保存内容",content:"切换脚本后当前修改将被覆盖，确定继续吗？",okText:"继续切换",cancelText:"取消",onOk:next});return}await next()};
 const create=()=>{setSelected(null);setContent("");setSavedContent("");form.resetFields();form.setFieldsValue({enabled:true});markDirty(false);setBasicOpen(true)};
 const edit=()=>{if(!selected)return;form.setFieldsValue({name:selected.name,identifier:selected.identifier,description:selected.description??"",matchType:selected.matchType,matchUrl:selected.matchUrl,runAt:selected.runAt,priority:selected.priority,enabled:selected.enabled!==false});setBasicOpen(true)};
 const saveBasic=async()=>{try{const values=await form.validateFields();setSaving(true);const payload={name:values.name.trim(),identifier:values.identifier.trim(),description:(values.description??"").trim(),matchType:values.matchType||"wildcard",matchUrl:String(values.matchUrl||"").trim(),runAt:values.runAt||"document_start",priority:Number(values.priority??0),enabled:values.enabled!==false,sourceContent:content};const saved=selected?await updatePublicStyle(client,selected.id,payload,selected.revision):await createPublicStyle(client,payload);setSelected(saved);if(!selected){setContent("");setSavedContent("")}setBasicOpen(false);markDirty(false);await load();message.success(selected?"公共样式基本信息已保存":"公共样式已创建")}catch(e){if((e as {errorFields?:unknown}).errorFields)return;message.error(errorText(e))}finally{setSaving(false)}};
 const saveContent=async()=>{if(!selected)return;try{setSaving(true);const saved=await updatePublicStyle(client,selected.id,{name:selected.name,identifier:selected.identifier,description:selected.description??"",matchType:selected.matchType,matchUrl:selected.matchUrl,runAt:selected.runAt,priority:selected.priority,enabled:selected.enabled!==false,sourceContent:content},selected.revision);setSelected(saved);const nextContent=saved.sourceContent??content;setContent(nextContent);setSavedContent(nextContent);setItems(current=>current.map(item=>item.id===saved.id?saved:item));markDirty(false);message.success("公共样式内容已保存")}catch(e){message.error(errorText(e))}finally{setSaving(false)}};
 const remove=()=>{if(!selected)return;modal.confirm({title:"删除公共样式？",content:`删除“${selected.name}”后将无法恢复。`,okText:"确认删除",okType:"danger",cancelText:"取消",onOk:async()=>{try{await deletePublicStyle(client,selected.id,selected.revision);create();await load();message.success("公共样式已删除")}catch(e){message.error(errorText(e))}}})};
 const toggle=async(enabled:boolean)=>{if(!selected)return;try{const fresh=await updatePublicStyleStatus(client,selected.id,enabled?"enabled":"disabled",selected.revision);setSelected(fresh);setItems(current=>current.map(item=>item.id===fresh.id?fresh:item));form.setFieldValue("enabled",fresh.enabled);message.success(enabled?"公共样式已启用":"公共样式已停用")}catch(e){message.error(errorText(e))}};
 return <div className="public-scripts-panel" style={{display:"flex",flex:1,minHeight:0,overflow:"hidden",borderTop:"1px solid var(--admin-border-color)"}}>
   <aside className="public-scripts-tabs" aria-label="公共样式列表" style={{width:190,flex:"0 0 190px",display:"flex",flexDirection:"column",minHeight:0,borderRight:"1px solid var(--admin-border-color)",background:"var(--admin-bg-color)"}}>
    <div style={{padding:8,borderBottom:"1px solid var(--admin-border-color)"}}><Button block size="small" type="primary" onClick={create} disabled={!can(publicStylePermissions.manage)}>新增公共样式</Button></div>
    <div style={{flex:1,minHeight:0,overflowY:"auto",padding:"4px 6px 8px"}}>{loading?<Typography.Text type="secondary" style={{display:"block",padding:8}}>正在加载…</Typography.Text>:items.length?items.map(item=><button type="button" key={item.id} onClick={()=>void select(item)} className={`public-script-tab ${selected?.id===item.id?"is-active":""}`}><span>{item.name}</span><small>{item.identifier}</small></button>):<Typography.Text type="secondary" style={{display:"block",padding:8}}>暂无公共样式</Typography.Text>}</div>
   </aside>
   <section style={{display:"flex",flex:1,minWidth:0,minHeight:0,flexDirection:"column",overflow:"hidden"}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,padding:"8px 12px",borderBottom:"1px solid var(--admin-border-color)",background:"var(--admin-bg-color)"}}><div style={{minWidth:0}}><Typography.Text strong ellipsis>{selected?.name??"未选择公共样式"}</Typography.Text>{selected&&<Typography.Text type="secondary" style={{marginLeft:8}}>{selected.identifier}</Typography.Text>}</div><Space size={6}>{selected&&can(publicStylePermissions.manage)&&<Button size="small" onClick={edit}>编辑基本信息</Button>}{selected&&can(publicStylePermissions.manage)&&<Switch size="small" checked={selected.enabled!==false} checkedChildren="启用" unCheckedChildren="停用" onChange={value=>void toggle(value)}/>} {selected&&can(publicStylePermissions.manage)&&<Button size="small" danger onClick={remove}>删除</Button>}<Button size="small" type="primary" loading={saving} onClick={()=>void saveContent()} disabled={!selected||!can(publicStylePermissions.manage)}>{selected?"保存样式":"保存样式"}</Button></Space></div>
    <div style={{display:"flex",flex:1,minHeight:0,padding:0,overflow:"hidden"}}><MonacoSourceEditor value={content} onChange={value=>{setContent(value);if(value!==savedContent)markDirty(true)}} language="CSS" scriptName={selected?.name??"公共样式"} version={null} editable={Boolean(selected)&&can(publicStylePermissions.manage)} completionItems={cssCompletionItems} contextSnippets={monacoContextSnippets} shortcuts={shortcuts} onOpenHelp={onOpenHelp}/></div>
   </section>
   <Drawer title={selected?`编辑公共样式：${selected.name}`:"新增公共样式"} open={basicOpen} onClose={()=>setBasicOpen(false)} width="min(420px, 100vw)" extra={<Button type="primary" loading={saving} onClick={()=>void saveBasic()}>保存</Button>}>
    <Form form={form} layout="vertical" onValuesChange={()=>markDirty(true)}><Form.Item name="name" label="名称" rules={[{required:true,message:"请输入公共样式名称"}]}><Input placeholder="例如：登录页公共初始化" autoFocus/></Form.Item><Form.Item name="identifier" label="标识符" rules={[{required:true,message:"请输入标识符"},{pattern:/^[A-Za-z0-9][A-Za-z0-9._-]*$/,message:"仅允许字母、数字、点、下划线和连字符，且必须以字母或数字开头"},{max:64,message:"标识符不能超过64个字符"}]}><Input placeholder="例如：COMMON_LOGIN" disabled={Boolean(selected)}/></Form.Item><Form.Item name="description" label="说明"><Input.TextArea rows={3} placeholder="可选，用于说明公共样式用途"/></Form.Item><Form.Item name="matchType" label="匹配方式"><Select options={[{value:"exact",label:"精确匹配"},{value:"wildcard",label:"通配匹配"}]}/></Form.Item><Form.Item name="matchUrl" label="匹配 URL" rules={[{required:true,message:"请输入匹配 URL"}]}><Input placeholder="https://example.com/*"/></Form.Item><Form.Item name="runAt" label="注入时机"><Select options={styleRunAtOptions}/></Form.Item><Form.Item name="priority" label="注入优先级"><InputNumber min={-10000} max={10000} precision={0} style={{width:"100%"}}/></Form.Item><Form.Item name="enabled" label="状态" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用"/></Form.Item></Form>
   </Drawer>
 </div>;
}



 const getHelpDrawerStorage=()=>{if(typeof window==="undefined")return null;try{return window.localStorage}catch{return null}};

export function ScriptManagementPage(){
 const client=useRequestClient(); const permissions=usePermissions(); const {message,modal}=App.useApp(); const can=(p:string)=>permissions.can(p);
 const workspace=useCurrentWorkspace();
 const [rows,setRows]=useState<ScriptRow[]>([]); const [page,setPage]=useState(1); const [pageSize,setPageSize]=useState(20); const [total,setTotal]=useState(0); const [keyword,setKeyword]=useState(""); const [status,setStatus]=useState(""); const [loading,setLoading]=useState(false); const [selected,setSelected]=useState<ScriptRow|null>(null); const [detailOpen,setDetailOpen]=useState(false); const [editorOpen,setEditorOpen]=useState(false); const [assetEditorOpen,setAssetEditorOpen]=useState(false); const [assetTab,setAssetTab]=useState("content"); const [publicScriptsDirty,setPublicScriptsDirty]=useState(false); const [assetType,setAssetType]=useState<AssetType>("script"); const [assetRows,setAssetRows]=useState<Record<AssetType,AssetVersion[]>>({script:[],style:[]}); const [activeAsset,setActiveAsset]=useState<AssetVersion|null>(null); const [assetContent,setAssetContent]=useState(""); const [assetLoading,setAssetLoading]=useState(false); const [previewAsset,setPreviewAsset]=useState<AssetVersion|null>(null); const [previewContent,setPreviewContent]=useState(""); const [previewOpen,setPreviewOpen]=useState(false); const [previewLoading,setPreviewLoading]=useState(false); const [helpOpen,setHelpOpen]=useState(false); const [helpSection,setHelpSection]=useState("start"); const [helpWidth,setHelpWidth]=useState(()=>readHelpDrawerWidth(getHelpDrawerStorage(),typeof window==="undefined"?1600:window.innerWidth)); const [helpFullscreen,setHelpFullscreen]=useState(false); const [helpDragging,setHelpDragging]=useState(false); const helpWidthRef=useRef(helpWidth); const helpDragRef=useRef<{startX:number;startWidth:number}|null>(null); const [form]=Form.useForm();
 const helpWidthForViewport=(width:number)=>clampHelpDrawerWidth(width,window.innerWidth);
 const openScriptWritingHelp=()=>{setHelpSection("start");setHelpOpen(true)};
 const applyHelpWidth=(width:number)=>{const next=helpWidthForViewport(width);helpWidthRef.current=next;setHelpWidth(next);return next};
 const persistHelpWidth=()=>{const viewport=typeof window==="undefined"?1600:window.innerWidth;writeHelpDrawerWidth(getHelpDrawerStorage(),helpWidthRef.current,viewport)};
 const startHelpResize=(event:ReactPointerEvent<HTMLDivElement>)=>{if(event.button!==0||helpFullscreen)return;event.preventDefault();const actual=applyHelpWidth(helpWidth);helpDragRef.current={startX:event.clientX,startWidth:actual};setHelpDragging(true)};
 const onHelpResizeKeyDown=(event:ReactKeyboardEvent<HTMLDivElement>)=>{if(helpFullscreen||!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();applyHelpWidth(nudgeHelpDrawerWidth(helpWidthRef.current,event.key==='ArrowLeft'?24:-24,window.innerWidth));persistHelpWidth()};
 useEffect(()=>{if(!helpDragging)return;const onMove=(event:PointerEvent)=>{const drag=helpDragRef.current;if(!drag)return;applyHelpWidth(resizeHelpDrawerWidth(drag.startWidth,drag.startX,event.clientX,window.innerWidth))};const stop=()=>{persistHelpWidth();helpDragRef.current=null;setHelpDragging(false)};const previousCursor=document.body.style.cursor;const previousSelect=document.body.style.userSelect;document.body.style.cursor="ew-resize";document.body.style.userSelect="none";window.addEventListener("pointermove",onMove);window.addEventListener("pointerup",stop);window.addEventListener("pointercancel",stop);window.addEventListener("mouseup",stop);window.addEventListener("blur",stop);return()=>{persistHelpWidth();window.removeEventListener("pointermove",onMove);window.removeEventListener("pointerup",stop);window.removeEventListener("pointercancel",stop);window.removeEventListener("mouseup",stop);window.removeEventListener("blur",stop);document.body.style.cursor=previousCursor;document.body.style.userSelect=previousSelect;helpDragRef.current=null}},[helpDragging]);
 const [editorPrefs,setEditorPrefs]=useState<Record<AssetType,EditorPrefs>>({script:emptyEditorPrefs(),style:emptyEditorPrefs()}); const [editorDrafts,setEditorDrafts]=useState<Record<AssetType,EditorPrefs>>({script:emptyEditorPrefs(),style:emptyEditorPrefs()}); const [aiProviders,setAiProviders]=useState<EditorAiProvider[]>([]); const [aiModels,setAiModels]=useState<EditorAiModel[]>([]); const [aiLoading,setAiLoading]=useState(false); const [aiTestStatus,setAiTestStatus]=useState<Record<AssetType,string>>({script:"",style:""}); const [capturingShortcut,setCapturingShortcut]=useState<{type:AssetType;command:EditorShortcutCommand}|null>(null); const [assetActionLoading,setAssetActionLoading]=useState<string|null>(null); const [stylePropertiesOpen,setStylePropertiesOpen]=useState(false); const [stylePropertiesForm]=Form.useForm(); const [scriptPropertiesOpen,setScriptPropertiesOpen]=useState(false); const [scriptPropertiesForm]=Form.useForm();
 const prefsKey=(type:AssetType)=>`ky-script-editor-assist:${workspace?.type??"unknown"}:${workspace?.id??"unknown"}:${type}`;
 const readPrefs=(type:AssetType)=>{if(typeof window==="undefined")return emptyEditorPrefs();try{const raw=JSON.parse(window.localStorage.getItem(prefsKey(type))||"null") as Record<string,unknown>|null;const normalized=normalizePrefs(raw);if(raw&&typeof raw==="object"&&"shortcut" in raw&&!("completionShortcut" in raw)){const migrated:Record<string,unknown>={...raw,...toEditorPrefsShortcuts(editorPrefsShortcuts(normalized))};delete migrated.shortcut;window.localStorage.setItem(prefsKey(type),JSON.stringify(migrated))}return normalized}catch{return emptyEditorPrefs()}};
 useEffect(()=>{if(!workspace?.id||typeof window==="undefined")return;const next={script:readPrefs("script"),style:readPrefs("style")};setEditorPrefs(next);setEditorDrafts(next)},[workspace?.type,workspace?.id]);
 const loadAiOptions=async()=>{if(aiLoading)return;setAiLoading(true);try{const [p,m]=await Promise.all([listEditorProviders(client),listEditorModels(client)]);setAiProviders(p.items??[]);setAiModels(m.items??[])}catch(e){message.warning("AI供应商/模型暂不可用，静态补全仍可继续使用")}finally{setAiLoading(false)}};
 const saveAiPreferences=(type:AssetType)=>{const draft=editorDrafts[type];if(draft.enabled&&(!draft.providerId||!draft.modelId)){message.error("启用 AI 辅助前请选择已配置的供应商和模型");return}const value={...editorPrefs[type],enabled:draft.enabled,providerId:draft.providerId,modelId:draft.modelId};const next={...editorPrefs,[type]:value};if(typeof window!=="undefined")window.localStorage.setItem(prefsKey(type),JSON.stringify(value));setEditorPrefs(next);setEditorDrafts(v=>({...v,[type]:{...v[type],...value}}));message.success("AI 配置已保存")};
 const saveShortcutPreferences=(type:AssetType)=>{const draft=editorDrafts[type];const error=validateEditorShortcuts(editorPrefsShortcuts(draft));if(error){message.error(error);return}const next={...editorPrefs};for(const t of ["script","style"] as AssetType[]){const value={...editorPrefs[t],completionShortcut:draft.completionShortcut,findShortcut:draft.findShortcut,replaceShortcut:draft.replaceShortcut};next[t]=value;if(typeof window!=="undefined")window.localStorage.setItem(prefsKey(t),JSON.stringify(value))}setEditorPrefs(next);setEditorDrafts(v=>({script:{...v.script,...next.script},style:{...v.style,...next.style}}));message.success("快捷键已保存并生效")};
 const editorPrefsDirty=(type:AssetType)=>JSON.stringify(editorPrefs[type])!==JSON.stringify(editorDrafts[type]);
 const closeAssetEditor=()=>{if(editorPrefsDirty("script")||editorPrefsDirty("style")){modal.confirm({title:"放弃未保存的其他设置？",content:"关闭后本次 AI 配置和快捷键修改不会生效。",onOk:()=>{setEditorDrafts({script:{...editorPrefs.script},style:{...editorPrefs.style}});setAssetEditorOpen(false);setActiveAsset(null);setAssetContent("")}});return}setAssetEditorOpen(false);setActiveAsset(null);setAssetContent("")};
 const captureShortcut=(type:AssetType,command:EditorShortcutCommand,e:ReactKeyboardEvent)=>{e.preventDefault();if(e.key==="Escape"){setCapturingShortcut(null);return}if(["Control","Meta","Shift","Alt"].includes(e.key))return;const shortcut=shortcutKeyFromEvent(e.nativeEvent);if(!shortcut){message.error("快捷键必须包含 Cmd/Ctrl、Shift 或 Alt，并使用受支持的按键");setCapturingShortcut(null);return}const field=command==="completion"?"completionShortcut":command==="find"?"findShortcut":"replaceShortcut";setEditorDrafts(current=>({...current,[type]:{...current[type],[field]:shortcut}}));setCapturingShortcut(null)};
 const load=()=>{setLoading(true);listScripts(client,page,pageSize,keyword,status).then(x=>{setRows(x.items);setTotal(x.pagination.total)}).catch(e=>message.error(errorText(e))).finally(()=>setLoading(false))}; useEffect(load,[page,pageSize,keyword,status]);
 const openDetail=async(r:ScriptRow)=>{try{setSelected(await getScript(client,r.id));setDetailOpen(true)}catch(e){message.error(errorText(e))}};
 const openEdit=async(r:ScriptRow)=>{try{const fresh=await getScript(client,r.id);setSelected(fresh);form.setFieldsValue({identifier:fresh.identifier,name:fresh.name,matchType:fresh.matchType,matchUrl:fresh.matchUrl});setEditorOpen(true)}catch(e){message.error(errorText(e))}};
 const loadAssets=async(type:AssetType,scriptID:string)=>{const items=await listAssets(client,scriptID,type);setAssetRows(current=>({...current,[type]:items}));return items};
 const selectAsset=async(item:AssetVersion,scriptID=selected?.id)=>{if(!scriptID)return;setAssetLoading(true);try{const fresh=await getAsset(client,scriptID,item.id,true);setActiveAsset(fresh);setAssetContent(fresh.sourceContent??"")}catch(e){message.error(errorText(e))}finally{setAssetLoading(false)}};
 const openAssetPreview=async(item:AssetVersion,scriptID=selected?.id)=>{if(!scriptID)return;setPreviewLoading(true);setPreviewOpen(true);setPreviewAsset(item);setPreviewContent("");try{const fresh=await getAsset(client,scriptID,item.id,true);setPreviewAsset(fresh);setPreviewContent(fresh.sourceContent??"")}catch(e){setPreviewOpen(false);message.error(errorText(e))}finally{setPreviewLoading(false)}};
 const ensureDraft=async(type:AssetType,scriptID:string)=>{let items=await loadAssets(type,scriptID);let draft=items.find(item=>item.status==="draft");if(!draft){const source=items[0];if(source)draft=await copyAsset(client,scriptID,source.id);else draft=await createAsset(client,scriptID,{assetType:type,version:"0.1.0",sourceContent:""});items=await loadAssets(type,scriptID)}if(draft)await selectAsset(draft,scriptID)};
 const openAssetEditor=async(r:ScriptRow,type:AssetType)=>{try{const fresh=await getScript(client,r.id);setSelected(fresh);setAssetEditorOpen(true);setAssetTab("content");setAssetType(type);setActiveAsset(null);setAssetContent("");const items=await loadAssets(type,fresh.id);const draft=items.find(item=>item.status==="draft");const readable=draft??items.find(item=>item.status==="active")??items[0];if(readable)await selectAsset(readable,fresh.id)}catch(e){message.error(errorText(e))}};
 const saveAsset=async()=>{if(!selected||!activeAsset)return;try{const saved=await updateAsset(client,selected.id,activeAsset.id,{assetType:activeAsset.assetType,version:activeAsset.version,sourceContent:assetContent,runAt:activeAsset.assetType==="style"?activeAsset.runAt:undefined,priority:activeAsset.assetType==="style"?activeAsset.priority:undefined,enabled:activeAsset.assetType==="style"?activeAsset.enabled:undefined},activeAsset.revision);setActiveAsset(saved);setAssetContent(saved.sourceContent??"");await loadAssets(saved.assetType,selected.id);message.success(`${assetTypeLabel(saved.assetType)}草稿已保存`)}catch(e){message.error(errorText(e))}};
 const openStyleProperties=()=>{if(!activeAsset||activeAsset.assetType!=="style")return;if(activeAsset.status!=="draft"){message.warning("已发布版本不可直接修改，请先复制为草稿");return}stylePropertiesForm.setFieldsValue({runAt:activeAsset.runAt||"document_start",priority:activeAsset.priority??0,enabled:activeAsset.enabled!==false});setStylePropertiesOpen(true)};
 const saveStyleProperties=async()=>{if(!selected||!activeAsset||activeAsset.assetType!=="style")return;try{const values=await stylePropertiesForm.validateFields();const saved=await updateAsset(client,selected.id,activeAsset.id,{assetType:"style",version:activeAsset.version,sourceContent:assetContent,runAt:"document_start",priority:values.priority,enabled:values.enabled},activeAsset.revision);setActiveAsset(saved);setStylePropertiesOpen(false);await loadAssets("style",selected.id);message.success("样式属性已保存")}catch(e){message.error(errorText(e))}};
 const openScriptProperties=()=>{if(!selected||assetType!=="script")return;const rules=selected.matchRules?.length?selected.matchRules:[{matchType:selected.matchType,pattern:selected.matchUrl,ignoreQuery:true,enabled:true,remark:""} satisfies ScriptMatchRule];scriptPropertiesForm.setFieldsValue({identifier:selected.identifier,name:selected.name,platform:selected.platform==="douyin"?"抖店（douyin）":selected.platform,matchRules:rules,runAt:selected.runAt||"document_idle",priority:selected.priority??0,enabled:selected.status==="enabled"});setScriptPropertiesOpen(true)};
 const saveScriptProperties=async()=>{if(!selected)return;try{const values=await scriptPropertiesForm.validateFields();const rules=(values.matchRules??[]) as ScriptMatchRule[];if(!rules.length||!rules.some(rule=>rule.enabled!==false&&String(rule.pattern??"").trim())){message.error("至少需要一条启用的 URL 匹配规则");return}const first=rules.find(rule=>rule.enabled!==false&&String(rule.pattern??"").trim())??rules[0];const saved=await updateScript(client,selected.id,{identifier:selected.identifier,name:values.name,matchType:first.matchType === "prefix" ? "wildcard" : first.matchType,matchUrl:first.pattern,matchRules:rules,runAt:"document_start",priority:values.priority},selected.revision) as ScriptRow;let latest=saved;if(values.enabled!==undefined&&((values.enabled?"enabled":"disabled")!==saved.status)&&saved.status!=="archived")latest=await updateScriptStatus(client,saved.id,values.enabled?"enabled":"disabled",saved.revision) as ScriptRow;setSelected(latest);setRows(current=>current.map(item=>item.id===latest.id?latest:item));setScriptPropertiesOpen(false);message.success("脚本属性已保存")}catch(e){message.error(errorText(e))}};
 const copyHistorical=async(item:AssetVersion)=>{if(!selected)return;try{const draft=await copyAsset(client,selected.id,item.id);await loadAssets(item.assetType,selected.id);setAssetTab("content");await selectAsset(draft);message.success("已复制为草稿")}catch(e){message.error(errorText(e))}};
 const performAssetAction=async(item:AssetVersion,action:"release"|"activate"|"archive")=>{if(!selected)return;const actionKey=`${item.id}:${action}`;if(assetActionLoading)return;setAssetActionLoading(actionKey);try{await assetAction(client,selected.id,item.id,action,item.revision);await loadAssets(item.assetType,selected.id);const fresh=await getScript(client,selected.id);setSelected(fresh);load();message.success(action==="release"?"版本已发布":action==="activate"?"版本已生效":"版本已删除")}catch(e){message.error(errorText(e))}finally{setAssetActionLoading(null)}};
 const changeAssetState=(item:AssetVersion,action:"release"|"activate"|"archive")=>{if(action==="activate"){modal.confirm({title:"确认设为生效版本？",content:`将${assetTypeLabel(item.assetType)} ${item.version}设为当前生效版本。`,okText:"确认生效",cancelText:"取消",onOk:()=>performAssetAction(item,action)});return}if(action==="archive"){modal.confirm({title:"确认删除历史版本？",content:`删除${assetTypeLabel(item.assetType)} ${item.version}后将从历史列表移除，且不能恢复。`,okText:"确认删除",okType:"danger",cancelText:"取消",onOk:()=>performAssetAction(item,action)});return}void performAssetAction(item,action)};
 const saveScript=async()=>{try{const v=await form.validateFields();if(selected)await updateScript(client,selected.id,v,selected.revision);else await createScript(client,v);message.success("脚本已保存");setEditorOpen(false);form.resetFields();setSelected(null);load()}catch(e){message.error(errorText(e))}};
 const columns=[{title:"名称",dataIndex:"name",width:360,render:(_:string,r:ScriptRow)=><div style={{display:"flex",flexDirection:"column",gap:3,minWidth:0}}><Typography.Text strong ellipsis={{tooltip:r.name||"—"}} style={{display:"block"}}>{r.name||"—"}</Typography.Text><Typography.Text type="secondary" ellipsis={{tooltip:r.identifier||"—"}} style={{display:"block",fontSize:12,lineHeight:"18px"}}>{r.identifier||"—"}</Typography.Text></div>},{title:"匹配URL",dataIndex:"matchUrl",width:280,ellipsis:true},{title:"内容",width:190,render:(_:unknown,r:ScriptRow)=><Space wrap><Button type="link" size="small" onClick={()=>void openAssetEditor(r,"script")}>JavaScript {r.latestJsBytes} B</Button><Button type="link" size="small" onClick={()=>void openAssetEditor(r,"style")}>CSS {r.latestCssBytes} B</Button></Space>},{title:"状态",dataIndex:"status",width:100,render:(v:ScriptRow["status"])=>v==="enabled"?<Tag color="green">启用</Tag>:<Tag>{v==="disabled"?"停用":"已归档"}</Tag>},{title:"更新时间",dataIndex:"updatedAt",width:180,render:formatTime},{title:"操作",key:"actions",fixed:"right" as const,width:160,className:"table-action-column",render:(_:unknown,r:ScriptRow)=><div className="table-action-grid"><Button type="link" size="small" onClick={()=>void openDetail(r)}>详情</Button>{can(perm.update)&&<Button type="link" size="small" onClick={()=>void openEdit(r)}>编辑</Button>}</div>}];
 const assetHistory=(type:AssetType)=><Table rowKey="id" size="small" dataSource={assetRows[type]} pagination={false} columns={[{title:"版本",dataIndex:"version",render:(version:string,item:AssetVersion)=><Button type="link" size="small" onClick={()=>void openAssetPreview(item)}>{version}</Button>},{title:"发布时间",dataIndex:"publishedAt",render:(published:string|null|undefined,item:AssetVersion)=>formatPublishedTime(published,item.updatedAt)},{title:"字符数",dataIndex:"sourceChars",render:(chars:number)=>`${chars} 字符`},{title:"操作者",render:(_:unknown,item:AssetVersion)=>actorLabel(item)},{title:"状态",dataIndex:"status",render:(v:AssetVersion["status"])=>assetStatusLabel(v)},{title:"操作",render:(_:unknown,item:AssetVersion)=><Space wrap>{item.status==="draft"&&can(perm.release)&&<Button size="small" loading={assetActionLoading===`${item.id}:release`} onClick={()=>changeAssetState(item,"release")}>发布</Button>}{item.status==="released"&&can(perm.activate)&&<Button size="small" type="primary" loading={assetActionLoading===`${item.id}:activate`} onClick={()=>changeAssetState(item,"activate")}>激活</Button>}{item.status!=="draft"&&can(perm.update)&&<Button size="small" onClick={()=>void copyHistorical(item)}>复制为草稿</Button>}{item.status!=="active"&&can(perm.archive)&&<Button danger size="small" loading={assetActionLoading===`${item.id}:archive`} onClick={()=>changeAssetState(item,"archive")}>删除</Button>}</Space>}]}/>;
 const assetHeaderTabIndex=assetTab==="content"?0:assetTab==="history"?1:assetTab==="public"?2:3;
 const changeAssetTab=(next:string)=>{if(next===assetTab)return;if(assetTab==="public"&&publicScriptsDirty){modal.confirm({title:"公共脚本有未保存内容",content:"切换后当前修改仍会保留在当前窗口，但请确认是否离开编辑页？",okText:"确认切换",cancelText:"继续编辑",onOk:()=>setAssetTab(next)});return}setAssetTab(next)};
 const assetHeaderTabs=<div className="script-asset-editor-header-tabs-anchor"><div className="script-asset-editor-header-tabs" role="tablist" aria-label={`${assetTypeLabel(assetType)}编辑器内容`}><span className="script-asset-editor-header-tabs-slider" aria-hidden="true" style={{transform:`translate3d(${assetHeaderTabIndex*100}%, 0, 0)`}}/><button type="button" role="tab" aria-selected={assetTab==="content"} className={assetTab==="content"?"is-active":""} onClick={()=>changeAssetTab("content")}>{assetTypeLabel(assetType)}</button><button type="button" role="tab" aria-selected={assetTab==="history"} className={`script-asset-editor-history-tab ${assetTab==="history"?"is-active":""}`} onClick={()=>changeAssetTab("history")}>历史版本</button><button type="button" role="tab" aria-selected={assetTab==="public"} className={assetTab==="public"?"is-active":""} onClick={()=>changeAssetTab("public")}>{assetType==="style"?"公共样式":"公共脚本"}</button><button type="button" role="tab" aria-selected={assetTab==="other"} className={assetTab==="other"?"is-active":""} onClick={()=>{changeAssetTab("other");void loadAiOptions()}}>其他</button></div></div>;
 const assetEditor=(type:AssetType)=><div className="script-editor-wrapper" style={{position:"relative",display:"flex",flex:"1 1 auto",flexBasis:0,flexDirection:"column",minHeight:0,minWidth:0,height:"100%",overflow:"hidden"}}>{assetLoading?<Typography.Text>正在加载源码…</Typography.Text>:activeAsset?<MonacoSourceEditor value={assetContent} onChange={setAssetContent} language={type==="script"?"JavaScript":"CSS"} version={activeAsset.version} scriptName={selected?.name} editable={activeAsset.status==="draft"} businessScriptId={type==="script"&&activeAsset.status==="draft"&&can(perm.update)?selected?.id:null} completionItems={type==="script"?javascriptCompletionItems:cssCompletionItems} contextSnippets={monacoContextSnippets} shortcuts={editorPrefsShortcuts(editorPrefs[type])} notice={(kind,text)=>kind==="warning"?message.warning(text):message.error(text)} onOpenHelp={()=>{setHelpSection("start");setHelpOpen(true)}} onOpenScriptProperties={type==="script"?openScriptProperties:undefined} onOpenStyleProperties={type==="style"?openStyleProperties:undefined} onFormat={type==="script"?formatJavaScriptSource:undefined}/>:<div style={{padding:24}}><Typography.Title level={5}>尚未创建草稿</Typography.Title><Typography.Paragraph type="secondary">当前资源没有可编辑草稿。查看历史版本不会自动创建草稿。</Typography.Paragraph>{can(perm.update)&&<Button type="primary" onClick={()=>selected&&void ensureDraft(type,selected.id)}>创建首个草稿</Button>}</div>}</div>;
 const assetOther=(type:AssetType)=>{
  const draft=editorDrafts[type];
  const shortcutError=validateEditorShortcuts(editorPrefsShortcuts(draft));
  const providerOptions=aiProviders.map(item=>({value:item.id,label:item.name}));
  const modelOptions=aiModels.filter(item=>!draft.providerId||item.providerId===draft.providerId).map(item=>({value:item.id,label:item.name||item.modelKey}));
  const testConnection=async()=>{
   if(!draft.modelId){message.error("请先选择模型");return}
   try{const result=await testEditorModel(client,draft.modelId);if(result.ok===false)throw new Error(result.errorMessage||"连接失败");setAiTestStatus(v=>({...v,[type]:"连接成功"}));message.success("AI 模型连接成功")}
   catch{setAiTestStatus(v=>({...v,[type]:"连接失败"}));message.error("AI 模型连接失败，请检查系统配置")}
  };
  const aiPanel=<Form layout="vertical" style={{maxWidth:760}}>
   <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:16}}><Typography.Title level={5} style={{margin:0}}>AI 辅助配置</Typography.Title><Space wrap><Button onClick={()=>setEditorDrafts(v=>({...v,[type]:{...v[type],enabled:false,providerId:"",modelId:""}}))}>恢复默认设置</Button><Button type="primary" onClick={()=>saveAiPreferences(type)}>保存 AI 配置</Button></Space></div>
   <Form.Item label="供应商"><Select disabled={!draft.enabled} style={{width:"100%"}} placeholder={aiLoading?"正在加载供应商…":"请选择已配置供应商"} value={draft.providerId||undefined} loading={aiLoading} options={providerOptions} onChange={providerId=>setEditorDrafts(v=>({...v,[type]:{...v[type],providerId,modelId:""}}))}/></Form.Item>
   <Form.Item label="模型"><Select disabled={!draft.enabled} style={{width:"100%"}} placeholder="请选择模型" value={draft.modelId||undefined} options={modelOptions} onChange={modelId=>setEditorDrafts(v=>({...v,[type]:{...v[type],modelId}}))}/></Form.Item>
   <Form.Item label="启用 AI 辅助"><Space><Switch checked={draft.enabled} onChange={enabled=>setEditorDrafts(v=>({...v,[type]:{...v[type],enabled}}))}/><Typography.Text type="secondary">{draft.enabled?"已启用":"未启用"}</Typography.Text></Space></Form.Item>
   <div style={{marginTop:-8}}><Button disabled={!draft.enabled||!draft.providerId||!draft.modelId} onClick={()=>void testConnection()}>测试连接</Button>{aiTestStatus[type]&&<Typography.Text type={aiTestStatus[type]==="连接成功"?"success":"danger"} style={{marginLeft:12}}>{aiTestStatus[type]}</Typography.Text>}</div>
  </Form>;
  const shortcutPanel=<div style={{maxWidth:760}}>
   <Typography.Title level={5} style={{marginTop:0}}>快捷键</Typography.Title>
   <Typography.Text type="secondary" style={{display:"block",marginBottom:16}}>快捷键仅在源码编辑器获得焦点时生效；Mac 使用 Cmd，Windows/Linux 使用 Ctrl。查找支持 Monaco 原生查找控件及正则选项。</Typography.Text>
   <div style={{borderTop:"1px solid var(--admin-border-color)"}}>
    {(["completion","find","replace"] as const).map(command=>{const field=command==="completion"?"completionShortcut":command==="find"?"findShortcut":"replaceShortcut";const shortcut=draft[field];const title=command==="completion"?"唤出补全候选":command==="find"?"查找":"查找并替换";const description=command==="completion"?"手动打开当前语言的静态补全候选":command==="find"?"查找当前编辑器文本模型中的内容":"打开原生查找控件并展开替换区";const activeCapture=capturingShortcut?.type===type&&capturingShortcut.command===command;return <div key={command} style={{padding:"16px 0",borderBottom:"1px solid var(--admin-border-color)"}}><div style={{display:"flex",gap:16,alignItems:"center",justifyContent:"space-between",flexWrap:"wrap"}}><Space align="start"><Checkbox checked={Boolean(shortcut)} onChange={event=>{const next=event.target.checked?defaultEditorShortcuts(currentShortcutPlatform())[command]:"";setEditorDrafts(current=>({...current,[type]:{...current[type],[field]:next}}))}}/><div><Typography.Text strong>{title}</Typography.Text><Typography.Text type="secondary" style={{display:"block",marginTop:4}}>{description}</Typography.Text></div></Space><Space wrap><Button style={{fontFamily:"ui-monospace, SFMono-Regular, Menlo, monospace",minWidth:132}} onClick={()=>setCapturingShortcut({type,command})}>{activeCapture?"请按组合键…":displayEditorShortcut(shortcut,currentShortcutPlatform())}</Button>{shortcut&&<Button type="link" danger onClick={()=>setEditorDrafts(current=>({...current,[type]:{...current[type],[field]:""}}))}>清除</Button>}</Space></div>{activeCapture&&<div style={{paddingTop:12}}><Input autoFocus onKeyDown={event=>captureShortcut(type,command,event)} onKeyUp={event=>{if(event.key==="Escape"){event.preventDefault();setCapturingShortcut(null)}}} placeholder="按下包含 Cmd/Ctrl、Shift 或 Alt 的组合键；Esc 取消"/></div>}</div>})}
    {shortcutError&&<Typography.Text type="danger" style={{display:"block",padding:"10px 0"}}>{shortcutError}，请调整后再保存。</Typography.Text>}
    <Space style={{marginTop:16}}><Button onClick={()=>{const defaults=toEditorPrefsShortcuts(defaultEditorShortcuts(currentShortcutPlatform()));setEditorDrafts(current=>({script:{...current.script,...defaults},style:{...current.style,...defaults}}))}}>恢复默认设置</Button><Button type="primary" onClick={()=>saveShortcutPreferences(type)}>保存快捷键</Button></Space>
   </div>
  </div>;
  return <div style={{display:"flex",flexDirection:"column",minWidth:0,width:"100%"}}><Tabs tabPosition="left" items={[{key:"ai",label:"AI 辅助配置",children:aiPanel},{key:"shortcut",label:"快捷键",children:shortcutPanel}]} style={{width:"100%"}} tabBarStyle={{minWidth:132}}/></div>;
 };

 const helpFieldTable=(rows:readonly [string,string,string,string][]) => <table className="script-writing-help-fields"><thead><tr><th>字段</th><th>类型/可选</th><th>含义</th><th>何时使用/示例</th></tr></thead><tbody>{rows.map(([field,type,meaning,usage])=><tr key={field}><td><Typography.Text code>{field}</Typography.Text></td><td>{type}</td><td>{meaning}</td><td>{usage}</td></tr>)}</tbody></table>;
 const helpSections=[
  {key:"start",label:"JSSDK 入门",content:<><Typography.Title level={5}>JSSDK 入门</Typography.Title><Typography.Paragraph>在 Web 专用窗口中，脚本通过 <Typography.Text code>window.jssdk</Typography.Text> 使用受控宿主 API；先判断对象是否存在，再按能力和错误安全降级。浏览器/编辑器 fallback 只提供部分生命周期、网络模拟和公共注册能力，不等价于桌面宿主。</Typography.Paragraph><Typography.Title level={5}>公开根对象</Typography.Title>{helpFieldTable([
    ["version","string","SDK 版本标识，用于兼容性诊断，不代表能力授权。","记录版本用于排查；当前桌面实现为 1.0.0，fallback 版本不同。"],
    ["lifecycle","LifecycleApi","页面事件订阅、一次订阅和解绑。","使用 on/once/off 监听受支持事件。"],
    ["net","NetworkApi","请求/响应观察、等待和受授权拦截入口。","先按资源授权判断，再选择观察或等待。"],
    ["host","HostApi","读取窗口上下文、能力清单、受控表单填充，并上报当前登录空间名称/登录状态。","登录空间信息仅在空间绑定且服务器权限满足时更新；不触发同步。"],
    ["window","WindowApi","设置窗口标题和受管工具栏按钮。","按钮回调在业务页执行，导航时由宿主清理。"],
    ["ui","WebWindowUiApi","客户端封装的 Ant Design 轻提示、通知与弹窗。","只接受普通文本；不直接暴露 React、HTML 或任意组件。"],
    ["public","PublicApi","注册和读取冻结的公共导出。","公共脚本依赖满足后读取命名空间。"],
    ["getCapabilities()","Promise<string[]>","返回 SDK/宿主方法入口清单，不是当前资源授权。host.getCapabilities() 是同一宿主清单的命名空间封装。","清单有方法名也必须接受服务端/宿主拒绝。"],
  ])}<Typography.Title level={5}>适用范围</Typography.Title><ul><li><Typography.Text code>jssdk.lifecycle</Typography.Text>：订阅页面生命周期回调。</li><li><Typography.Text code>jssdk.net</Typography.Text>：观察、等待或在获批后处理网络事件。</li><li><Typography.Text code>jssdk.host</Typography.Text>、<Typography.Text code>jssdk.window</Typography.Text>、<Typography.Text code>jssdk.public</Typography.Text>：分别访问受控上下文、窗口标题和公共导出。</li></ul><pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`const sdk = window.jssdk;
if (!sdk) {
  console.info("JSSDK 不可用，跳过增强行为");
} else {
  const methods = await sdk.getCapabilities();
  console.log("入口清单", methods.length);
}`}</pre><Typography.Paragraph type="secondary"><Typography.Text code>getCapabilities()</Typography.Text> 只是 SDK/宿主方法入口清单，不代表当前资源已经获准使用这些能力。</Typography.Paragraph><Tag color="green">作者入口</Tag></>},
  {key:"lifecycle",label:"生命周期与注入时机",content:<><Typography.Title level={5}>生命周期与注入时机</Typography.Title><Typography.Paragraph>资源调度字段使用 snake_case，脚本订阅事件使用 camelCase：<Typography.Text code>document_start</Typography.Text>→<Typography.Text code>documentStart</Typography.Text>、<Typography.Text code>dom_content_loaded</Typography.Text>→<Typography.Text code>domReady</Typography.Text>、<Typography.Text code>document_idle</Typography.Text>→<Typography.Text code>pageLoad</Typography.Text>、<Typography.Text code>spa_route_change</Typography.Text>→<Typography.Text code>routeChange</Typography.Text>。当前服务器运行时自动接入前四项；<Typography.Text code>load</Typography.Text> 只有资源枚举，未形成通用自动入口；<Typography.Text code>user_action</Typography.Text>/<Typography.Text code>userAction</Typography.Text> 仅由受信宿主显式派发语义动作；当前没有产品操作入口，不会自动监听页面 click、input、keydown 或 DOM 选择器。宿主派发时 detail 包含 actionId 与 url。</Typography.Paragraph><Typography.Title level={5}>事件与字段</Typography.Title>{helpFieldTable([
    ["documentStart / domReady / pageLoad","事件 detail","通常提供 url；分别对应导航开始、DOM 就绪、did-finish-load 后的稳定页面。","用 detail.url 判断当前文档；缺失时使用当前页面地址。"],
    ["routeChange","事件 detail","提供 url 和 previousUrl；同一页面内导航可重复发生。","用两者更新页面状态，并清理旧路由 listener。"],
    ["userAction","事件 detail","受信宿主派发时包含 actionId 和 url；当前没有产品操作入口。","按 actionId 识别宿主语义动作，不要把它当作 DOM 事件对象。"],
    ["on / once / off","方法与取消","on/once 返回取消函数；off 可按 handler 或事件清理。","组件销毁时执行取消函数，避免迟到回放造成重复绑定。"],
  ])}<ul><li><Typography.Text code>on(event, handler)</Typography.Text>、<Typography.Text code>once(event, handler)</Typography.Text> 返回取消函数；<Typography.Text code>off(event, handler?)</Typography.Text> 可移除指定或全部本地监听。</li><li><Typography.Text code>LifecycleDetail</Typography.Text> 通常包含 <Typography.Text code>url?</Typography.Text>；<Typography.Text code>routeChange</Typography.Text> 还包含 <Typography.Text code>previousUrl?</Typography.Text>。迟到订阅会在微任务中回放最近状态，<Typography.Text code>routeChange</Typography.Text> 可能多次触发。</li><li>资源的 <Typography.Text code>run_at</Typography.Text> 不是事件名；JavaScript 读取脚本级 <Typography.Text code>s.run_at</Typography.Text>，样式版本级 <Typography.Text code>v.run_at</Typography.Text> 优先于脚本级配置，缺失时回退到脚本级再回退 <Typography.Text code>document_start</Typography.Text>。<Typography.Text code>priority</Typography.Text> 范围为 -10000 至 10000，数值越小越早；公共脚本先遵守依赖拓扑。</li></ul><pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`let dispose;
const onRoute = ({ url, previousUrl }) => {
  console.log("路由变化", url, previousUrl);
};
dispose = window.jssdk?.lifecycle.on("routeChange", onRoute);

// 页面离开或组件销毁时清理，避免重复绑定。
dispose?.();`}</pre><Typography.Paragraph type="secondary">页面刷新会产生新的文档代次；宿主会清理主进程订阅和待处理决定。<Typography.Text code>page_first</Typography.Text>、<Typography.Text code>strict_document_start</Typography.Text>、<Typography.Text code>missed_document_start</Typography.Text> 仅是当前设计/诊断名，不是本帮助页可配置的现成功能。</Typography.Paragraph><Tag color="green">documentStart / domReady / pageLoad / routeChange</Tag></>},
  {key:"network",label:"网络请求与响应",content:<><Typography.Title level={5}>网络请求与响应</Typography.Title><Typography.Paragraph>观察适合读取匹配请求或响应的状态、方法和路径；等待适合一次性等待下一次事件。可用入口包括 <Typography.Text code>subscribeRequest</Typography.Text>、<Typography.Text code>subscribeResponse</Typography.Text>、<Typography.Text code>waitForRequest</Typography.Text>、<Typography.Text code>waitForResponse</Typography.Text>。桌面 host 的通用 resolver 默认只授予观察/等待能力，浏览器 fallback 通过 fetch 模拟，覆盖范围更窄。</Typography.Paragraph><Typography.Title level={5}>参数与事件</Typography.Title><Typography.Paragraph><Typography.Text code>NetworkMatch</Typography.Text> 和 <Typography.Text code>NetworkOptions</Typography.Text> 控制筛选与阶段；<Typography.Text code>NetworkEvent</Typography.Text> 是观察事件，<Typography.Text code>NetworkDecision</Typography.Text> 只用于获批拦截。</Typography.Paragraph>{helpFieldTable([
    ["url","string|string[]，可选","完整 URL 或通配模式；普通字符按字面量、* 匹配任意字符，整体锚定。","只观察接口：https://example.com/api/*。"],
    ["method","string|string[]，可选","HTTP 方法匹配；比较不区分大小写。","限制为 GET，避免订阅无关请求。"],
    ["resourceTypes","string[]，可选","DevTools resourceType 精确包含匹配。","只关心 xhr/fetch 时显式填写。"],
    ["match","NetworkMatch，可选","组合 url、method、resourceTypes；缺失表示不增加该维度过滤。","等待单个接口时使用。"],
    ["stages","NetworkStage[]，可选","共享类型允许 beforeRequest、responseHeaders、completed、error；当前 host 实际投递前两种。","当前只依赖 beforeRequest 或 responseHeaders。"],
    ["includeBody","boolean，可选","响应观察时是否读取 body；默认不读取，请求 body 不在 payload。","仅在确有必要时开启，避免敏感内容暴露。"],
    ["timeoutMs","整数，可选","订阅/等待时限；host 校验 100–10000，等待默认 10 秒。","短时观察可用 3000；超时后清理订阅。"],
    ["kind / stage / requestId","事件字段","事件方向、实际阶段和请求关联 ID。","用 stage 区分请求头阶段与响应头阶段。"],
    ["url / method / resourceType","事件字段","实际 URL、方法和资源类型；resourceType 可能缺失。","只记录非敏感路径摘要。"],
    ["status / headers / body","可选事件字段","响应 status；headers 会脱敏和截断；body 仅响应可有，512 KiB 超限追加 [TRUNCATED]。","不要把 headers/body 写入日志。"],
    ["decisionToken / subscriptions","拦截事件字段","仅拦截 handler 有 decisionToken；subscriptions 是命中的订阅 ID。观察事件通常无 token。","不要把 token 当作授权；不要在观察 handler 决策。"],
  ])}{helpFieldTable([
    ["action","continue|abort|redirect|fulfill，必有","动作类型；continue 放行，abort 终止，redirect 改 URL，fulfill 直接返回响应。","只在拦截 handler 且服务端显式授权时使用。"],
    ["url","redirect 必填；请求 continue 可选","redirect 仅在请求阶段使用 decision.url；请求阶段 continue 可选使用 url；响应阶段不要依赖 continue 修改 URL。","调用 redirect 前自行限制为可信且业务允许的目标；订阅 match 不会自动约束新目标。"],
    ["method","string，可选","仅 continue 在请求阶段可替换请求方法；redirect 不应用。","仅在请求拦截且业务明确需要时使用。"],
    ["headers","Record<string,string>，可选","仅 continue 在请求阶段可作为请求头覆盖；响应阶段不要传入该字段，redirect 不应用。本地决策路径不额外过滤敏感头。","这是高权限拦截能力，必须有显式授权；绝不写入账号、密码或 token。"],
    ["body","string，可选","continue 在请求阶段作为 postData；fulfill 作为响应体；响应阶段不要用 continue 传 body。redirect 不应用。","超过 512 KiB 时继续原请求/响应，不应用该决定。"],
    ["status","number，可选","仅 fulfill 使用的 HTTP 状态，默认 200。","仅 fulfill 有意义。"],
    ["responseHeaders","Record<string,string>，可选","仅 fulfill 使用的响应头；continue 不使用该字段。","仅在明确获批的响应拦截中使用。"],
    ["continue / abort / redirect / fulfill","NetworkHandlerEvent 方法","仅拦截 handler 收到；每个待处理 token 只能成功决定一次。","observer 没有有效改变网络的授权，即使类型中出现这些方法也不能调用。"],
  ])}<ul><li>字段表解释过滤和事件字段；实际响应阶段仍以 host 投递为准。</li><li>观察示例只读取摘要；观察路径会按宿主规则脱敏并限制 body 大小；决策路径不应处理凭据。</li><li><Typography.Text code>redirect</Typography.Text> 只把 <Typography.Text code>decision.url</Typography.Text> 用于请求阶段 URL 改写；当前宿主不校验 redirect 目标来源，也不会把订阅 match 自动应用到新目标，因此调用方必须自行限制为可信且业务允许的 URL。</li><li><Typography.Text code>continue</Typography.Text> 无覆盖字段时可继续请求或原响应，请求阶段才可依赖 url/method/headers/body，响应阶段不要传这些覆盖字段。</li><li><Typography.Text code>fulfill</Typography.Text> 用 body/status/headers 替换响应，status 默认 200、body 默认空字符串。</li></ul><pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`const off = await window.jssdk?.net.subscribeResponse(
  {
    match: { url: "https://example.com/api/*", method: "GET" },
    stages: ["responseHeaders"],
    includeBody: false,
    timeoutMs: 3000,
  },
  (event) => {
    // 只使用非敏感摘要，不输出 headers/body。
    console.log(event.status, new URL(event.url).pathname);
  },
);
await off?.();`}</pre><pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`const off = await window.jssdk?.net.interceptRequest(
  { match: { url: "https://example.com/api/*" } },
  async (event) => {
    await event.continue({
      url: "https://example.com/api/v2",
      method: "POST",
      headers: { "X-Debug": "1" },
      body: JSON.stringify({ ok: true }),
    });
  },
);
await off?.();`}</pre><pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`const off = await window.jssdk?.net.interceptResponse(
  { match: { url: "https://example.com/api/*" }, includeBody: true },
  async (event) => {
    await event.fulfill(JSON.stringify({ ok: true }), 200, {
      "content-type": "application/json",
    });
  },
);
await off?.();`}</pre><Typography.Paragraph>取消函数是异步解绑函数；<Typography.Text code>waitForRequest/Response</Typography.Text> 返回一次事件，默认等待超时 10 秒。观察处理器不应调用决策方法。响应阶段需要替换内容时使用 <Typography.Text code>fulfill</Typography.Text>，不要依赖 <Typography.Text code>continue</Typography.Text> 修改响应字段。</Typography.Paragraph><Typography.Title level={5}>拦截边界</Typography.Title><Typography.Paragraph><Typography.Text code>interceptRequest</Typography.Text>、<Typography.Text code>interceptResponse</Typography.Text> 的 handler 才会收到 <Typography.Text code>NetworkHandlerEvent</Typography.Text>，其 <Typography.Text code>NetworkDecision</Typography.Text> 可表达 continue、abort、redirect、fulfill；必须有服务端显式 networkCapabilities 并经宿主复验。未授权返回 <Typography.Text code>NETWORK_CAPABILITY_DENIED</Typography.Text>，决定 deadline 默认 1500ms，超时自动继续，过期 token 返回 <Typography.Text code>NETWORK_DECISION_EXPIRED</Typography.Text>。不要在观察示例中执行拦截，也不要接触 Token/Cookie。</Typography.Paragraph><Tag color="green">观察可用，拦截按授权</Tag></>},
  {key:"host",label:"宿主上下文",content:<><Typography.Title level={5}>宿主上下文</Typography.Title>{helpFieldTable([
    ["getShopAccount() / getPlatform()","Promise<string>","返回窗口绑定的非凭据账号和平台字符串。","用于展示上下文；不可用于读取密码。"],
    ["jssdk.store.getStoreInfo()","Promise<WebWindowStoreInfo>","读取当前窗口绑定店铺的脱敏展示资料。","使用该命名空间读取名称、平台、店铺号、城市、备注和 LOGO 资源 ID。"],
    ["jssdk.store.setStoreInfo(input)","Promise<WebWindowStoreInfo>","部分更新当前绑定店铺的展示资料；只允许 name、shopId、city、remark、logoImageId，省略字段保持不变。","不能通过此方法修改账号、密码、工作区或店铺归属。"],
    ["jssdk.host.upload({ url, purpose: \"logo\" })","Promise<{ imageId, mime, bytes, width, height }>","由桌面主进程下载公网 HTTPS PNG/JPEG 图片并上传到受控图片服务；返回可绑定的 imageId。","仅支持 purpose=logo；限制 2 MiB、超时和重定向目标，不会转发页面 Cookie。"],
    ["updateLoginSpaceInfo(input)","Promise<LoginSpaceInfo>","部分更新当前登录空间名称和/或登录状态；displayName 与 loginStatus 可独立提供，至少提供一个。","只在绑定的桌面登录空间中调用；不触发上传或改变同步状态。"],
    ["displayName","可选 string，1–128 字符","登录空间在列表中的名称；省略时保持不变。","账号昵称变化后单独更新。"],
    ["loginStatus","可选枚举","unknown、logging_in、logged_in、logged_out、expired、error；省略时保持不变。","只有 logged_in 会被列表识别为登录成功。"],
    ["LoginSpaceInfo 返回值","displayName、loginStatus、updatedAt、revision","服务端确认的当前值和更新时间/版本。","重复提交相同值是安全的；可多次更新。"],
    ["id / workspaceType / workspaceId","可选 string","店铺记录和工作区身份；未返回时表示资料不完整。","关联当前脚本工作区，不能自行改写。"],
    ["ownerMembershipId / account / platform","可选/必有 string","归属成员、账号和平台；account 不是密码。","展示或选择当前店铺。"],
    ["storeId / shopId / name / city / remark / logoImageId","可选 string/null","当前绑定店铺的标识及展示资料；空值表示服务端没有该资料。","展示或更新时使用 jssdk.store；LOGO 先用 host.upload 获取 imageId。"],
    ["platformAttributes","可选 Record","平台扩展属性，内容由服务端决定。","只读取已约定字段，避免遍历输出敏感值。"],
    ["hasPassword","可选 boolean","仅表示是否配置密码，不含密码本身。","只用于显示是否已配置。"],
    ["status / revision","可选 string/number","店铺状态和资料修订号。","状态变化时丢弃旧异步结果。"],
    ["createdAt / updatedAt / deletedAt / lastLoginAt","可选时间/null","服务端审计和登录时间；缺失或 null 表示未知。","仅用于展示或排查，不用于授权。"],
    ["loginStatus","枚举","unknown、logged_in、logged_out。","决定是否显示登录状态提示。"],
    ["fetchedAt","string","本次上下文快照获取时间。","判断快照新旧，不代表登录成功。"],
    ["user / organization / workspace","对象","当前用户、组织和工作区身份容器。","读取其子字段，不猜测其它私有字段。"],
    ["roles","readonly string[]","当前角色名称列表，可能为空。","只做展示/已授权功能判断，仍需服务端复验。"],
  ])}{helpFieldTable([
    ["user.id","string，必有","用户稳定 ID。","用于关联当前用户，不用于替代权限校验。"],
    ["user.username","string，必有","登录用户名。","展示或审计标识，避免写入公开日志。"],
    ["user.displayName","string|null，必有键","用户展示名，可能为空。","为空时使用 username 作为展示回退。"],
    ["user.avatarUrl","string|null，可选","头像地址；可能缺失或为空。","仅用于可选头像展示。"],
    ["user.status","string，必有","用户状态。","仅显示状态，业务权限仍由服务端判断。"],
    ["organization.id","string，必有","组织稳定 ID。","确认当前组织上下文。"],
    ["organization.name","string，必有","组织名称。","用于页面标题或提示。"],
    ["organization.code","string|null，可选","组织编码，可能为空。","需要编码时先判断非空。"],
    ["organization.status","string，必有","组织状态。","状态异常时停止增强行为。"],
    ["workspace.type","platform|agency|enterprise，必有","工作区类型。","决定脚本数据范围。"],
    ["workspace.id","string，必有","工作区稳定 ID。","与服务端 resolver 上下文对应。"],
    ["workspace.name","string|null，可选","工作区展示名，可能为空。","为空时只展示 type/id。"],
    ["roles","readonly string[]，必有，可为空","角色名称数组；空数组表示没有可展示角色。","只用于展示/提示，不自行授予能力。"],
    ["fetchedAt","string，必有","整份用户快照获取时间。","判断快照是否过期，不代表实时登录状态。"],
  ])}<Typography.Paragraph>这些方法读取当前窗口绑定的店铺和用户上下文；窗口未绑定、来源不匹配、工作区权限不足或浏览器 fallback 不支持时会拒绝。它们分别返回简化的 <Typography.Text code>WebWindowStoreInfo</Typography.Text>、<Typography.Text code>WebWindowCurrentUserInfo</Typography.Text>；不返回密码、Token 或 Cookie；<Typography.Text code>hasPassword</Typography.Text> 仅是布尔值。<Typography.Text code>updateLoginSpaceInfo</Typography.Text> 只能在宿主绑定了当前登录空间且服务器授权时使用；调用目标由宿主上下文确定，脚本不能传入空间 ID。该方法只更新展示名称/登录状态，不会上传浏览器数据，也不能修改同步状态；同步需要由登录空间列表中的“同步”操作单独发起。</Typography.Paragraph><ul><li>窗口上下文缺失、普通浏览器 fallback 不支持或服务器拒绝时会返回错误；脚本应安全降级。</li><li>返回快照字段仅用于展示和上下文判断，权限仍由服务端复验。</li></ul><pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`const sdk = window.jssdk;
try {
  const store = await sdk.host.getStoreInfo();
  const user = await sdk.host.getCurrentUser();
  console.log({ storeId: store.storeId, workspaceId: user.workspace.id });
  // 名称和登录状态可分别提交；未传入的字段不会被清空。
  await sdk.host.updateLoginSpaceInfo({ displayName: "抖店账号昵称" });
  await sdk.host.updateLoginSpaceInfo({ loginStatus: "logged_in" });
} catch (error) {
  console.warn("上下文不可用", error instanceof Error ? error.message : "unknown");
}`}</pre><Typography.Title level={5}>店铺资料与 LOGO</Typography.Title><Typography.Paragraph><Typography.Text code>jssdk.store.getStoreInfo()</Typography.Text> 读取当前绑定店铺的脱敏资料；<Typography.Text code>jssdk.store.setStoreInfo(input)</Typography.Text> 允许独立、重复提交 <Typography.Text code>name</Typography.Text>、<Typography.Text code>shopId</Typography.Text>、<Typography.Text code>city</Typography.Text>、<Typography.Text code>remark</Typography.Text> 或 <Typography.Text code>logoImageId</Typography.Text>，省略字段保持不变。它不能修改账号、密码、工作区或店铺归属。设置远程 LOGO 时先调用 <Typography.Text code>{'jssdk.host.upload({ url, purpose: "logo" })'}</Typography.Text>，再把返回的 <Typography.Text code>imageId</Typography.Text> 传给 <Typography.Text code>jssdk.store.setStoreInfo</Typography.Text>。桌面端只接受 HTTPS 公网 PNG/JPEG，最大 2 MiB，并重新校验每次重定向；不会把页面 Cookie 转发给图片站。登录空间列表显示的 UUID 由服务端生成，用于其他功能关联，不是此方法的可写字段。</Typography.Paragraph><pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`const image = await jssdk.host.upload({ url: "https://images.example.com/logo.png", purpose: "logo" });
await jssdk.store.setStoreInfo({ logoImageId: image.imageId });`}</pre><Typography.Title level={5}>表单填充返回</Typography.Title>{helpFieldTable([
    ["accountSelector / passwordSelector","必填 string","页面中账号和密码输入框选择器；非空、最长 512，不能含控制字符。","只传当前页面明确的 selector。"],
    ["submitSelector","可选 string","提交按钮选择器；不传则只填充、不点击提交。","需要自动提交时显式传入。"],
    ["timeoutMs","可选整数","填充等待时限，1000–10000，默认 5000ms。","页面慢时适度增加，超限会被拒绝。"],
    ["accountFilled / passwordFilled","boolean","分别表示账号和密码是否成功写入。","缺一项时提示用户检查 selector。"],
    ["submitted","boolean","是否按 submitSelector 尝试提交。","false 不代表登录失败，只代表未提交。"],
  ])}<Typography.Paragraph><Typography.Text code>fillLoginForm</Typography.Text> 返回 <Typography.Text code>{`{ accountFilled: boolean, passwordFilled: boolean, submitted: boolean }`}</Typography.Text>；可能失败为 <Typography.Text code>INVALID_FILL_OPTIONS</Typography.Text>、<Typography.Text code>SHOP_CONTEXT_MISSING</Typography.Text>、<Typography.Text code>ORIGIN_MISMATCH</Typography.Text>、<Typography.Text code>SELECTOR_NOT_FOUND</Typography.Text> 或 <Typography.Text code>FILL_TIMEOUT</Typography.Text>。不要把账号或密码写入日志。</Typography.Paragraph><Tag color="green">受控上下文</Tag></>},
  {key:"window",label:"窗口标题",content:<><Typography.Title level={5}>窗口标题</Typography.Title>{helpFieldTable([
    ["getTitle()","Promise<WebWindowTitleState>","读取 header 与 taskbar 当前状态。","更新标题前先读取当前状态。"],
    ["text","string，可选/必填","header 文本可选；taskbar 文本必填且非空，最多 128 字符。","显示订单号等短标题，不放凭据。"],
    ["color / fontFamily","string，可选","标题颜色和字体名；输入需通过格式和危险字符校验。","只使用固定主题色或安全字体。"],
    ["fontSize / fontWeight","number|string，可选","字号 12–64；字重 100–900 或有限关键字。","用小范围强调，不超过校验边界。"],
    ["letterSpacing / width","number，可选","字间距 -10–20；width 是标题容器最小宽度 145–320，默认 145；容器随标题自适应，最大 320px。","仅在需要更大的标题起始宽度时设置。"],
    ["align / visible","枚举/boolean，可选","对齐 left/center/right 和是否显示。","不用于任意 DOM/CSS 注入。"],
    ["header / taskbar","WebWindowTitleState 字段","header 含 text/style，taskbar 是任务栏标题字符串。","resetTitle 后恢复宿主默认。"],
  ])}<Typography.Paragraph>标题 API 只修改受管窗口的 header/taskbar 标题，不提供 DOM、CSS 或任意 IPC 能力。</Typography.Paragraph><ul><li>字段表覆盖标题返回值和样式边界；标题 API 不提供 DOM/CSS 注入。</li></ul><pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`const state = await window.jssdk?.window.setHeaderTitle({
  text: "订单页",
  style: { color: "#d97706", fontSize: 16, fontWeight: 600, align: "left" },
});
console.log(state?.header.text);
await window.jssdk?.window.setTaskbarTitle({ text: "订单页" });
await window.jssdk?.window.resetTitle();`}</pre><Typography.Paragraph type="secondary">非法输入会返回 <Typography.Text code>WINDOW_TITLE_INVALID</Typography.Text> 或 <Typography.Text code>WINDOW_TITLE_STYLE_INVALID</Typography.Text>。</Typography.Paragraph><Tag color="green">桌面宿主已实现</Tag></>},
  {key:"window-actions",label:"工具栏按钮与 Ant Design",content:<><Typography.Title level={5}>工具栏按钮与 Ant Design</Typography.Title><Typography.Paragraph>业务脚本可以向 Web 专用窗口顶部工具栏添加最多 4 个自定义功能按钮。按钮尺寸、圆形边框、悬停状态与窗口内置操作保持一致；页面完整导航或 SPA 路由变化时，旧按钮和回调会被清理。脚本通过 <Typography.Text code>jssdk.window.addActionButton({`{ icon, onClick }`})</Typography.Text> 注册按钮，<Typography.Text code>title</Typography.Text> 和 <Typography.Text code>id</Typography.Text> 可选；成功返回 <Typography.Text code>{`{ id, remove }`}</Typography.Text>，页面导航会自动清理，不需要手动删除时可忽略返回值。</Typography.Paragraph>{helpFieldTable([
    ["icon","必填 WebWindowActionIconInput","图标来源和名称；支持客户端内置 Ant Design 图标，及 Iconfont 的字体类、Unicode、页面内 SVG symbol。","Ant Design 用 { provider: 'antd', name: 'SettingOutlined' }。"],
    ["provider: antd","{ provider: 'antd', name }","name 必须是当前客户端随附 @ant-design/icons 中存在的导出名。客户端使用 antd 6.6.5、@ant-design/icons 6.3.4。","例如 SettingOutlined、ReloadOutlined、SearchOutlined。"],
    ["provider: iconfont / font-class","stylesheetUrl + className","CSS 地址仅支持 https://at.alicdn.com/t/...css；className 使用 Iconfont 项目生成的类名。","按 font-class 方式发布的 Iconfont 项目。"],
    ["provider: iconfont / unicode","stylesheetUrl + className + codePoint","codePoint 为十六进制字符码，例如 e600。字体 CSS 和类名仍需对应同一 Iconfont 项目。","按 Unicode 方式发布的 Iconfont 项目。"],
    ["provider: iconfont / symbol","symbolId","页面必须已包含 id 为 icon-… 的 SVG symbol。宿主只复制安全的 SVG 几何节点和属性。","按 symbol 方式发布且已在当前页面加载的图标。"],
    ["onClick(context)","必填 function","点击时在业务页面调用；参数含当前 url 和 navigationGeneration。可返回 Promise，拒绝会被捕获并记录错误。","回调中调用 jssdk.ui.message 或 jssdk.ui.modal。"],
    ["title / id","可选 string","title 同时用于悬停提示和无障碍名称；id 用于稳定识别。未传时宿主生成默认值。","建议为可重复执行的业务按钮传稳定 id。"],
    ["handle.remove()","Promise<void>","显式移除当前按钮；重复调用安全。页面跳转时宿主自动清理。","功能暂时失效或业务模块销毁时调用。"],
  ])}<Typography.Title level={5}>使用 Ant Design UI</Typography.Title><Typography.Paragraph>桌面客户端按当前最新稳定版打包 Ant Design（当前 <Typography.Text code>antd 6.6.5</Typography.Text>、<Typography.Text code>@ant-design/icons 6.3.4</Typography.Text>）。业务脚本通过受控的 <Typography.Text code>jssdk.ui</Typography.Text> 调用组件能力，无需加载 React 或 JSX。支持 <Typography.Text code>message.success/info/warning/error/loading</Typography.Text>、<Typography.Text code>notification.success/info/warning/error</Typography.Text> 和 <Typography.Text code>modal.confirm/info/success/warning/error</Typography.Text>；只接受普通文本，不接收 HTML、React 节点或任意组件属性。</Typography.Paragraph>{helpFieldTable([
    ["jssdk.ui.message.*(text, options?)","Promise<void>","显示轻提示；durationMs 默认 3000，取值 0–30000。","await jssdk.ui.message.success('已完成');"],
    ["jssdk.ui.notification.*(options)","Promise<void>","message、description 为普通文本；可选 durationMs。","显示较长的状态说明。"],
    ["jssdk.ui.modal.confirm(options)","Promise<boolean>","title/content 必填；okText/cancelText 可选；确认返回 true，取消返回 false。","先确认，再执行有影响的业务操作。"],
    ["jssdk.ui.modal.info/success/warning/error(options)","Promise<void>","显示信息弹窗；只接受 title/content 和可选按钮文字。","用于需要用户阅读的结果说明。"],
    ["错误","UI_ARGUMENT_INVALID / HOST_CAPABILITY_UNAVAILABLE","参数不符合普通文本与长度限制，或当前不是桌面 Web 专用窗口。","捕获后安全降级，不直接改写页面布局。"],
  ])}<pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`const button = await window.jssdk?.window.addActionButton({
  icon: { provider: "antd", name: "SettingOutlined" },
  onClick: async () => {
    const confirmed = await window.jssdk.ui.modal.confirm({
      title: "刷新数据",
      content: "是否重新读取当前页面数据？",
    });
    if (confirmed) await window.jssdk.ui.message.success("刷新请求已提交");
  },
});

// Iconfont font-class 示例：stylesheetUrl 需是 Iconfont 生成的 CDN CSS。
await window.jssdk?.window.addActionButton({
  icon: {
    provider: "iconfont",
    mode: "font-class",
    stylesheetUrl: "https://at.alicdn.com/t/font_xxxxx.css",
    className: "icon-example",
  },
  onClick: () => window.jssdk.ui.notification.info({ message: "自定义操作" }),
});

// 当前页面卸载前可主动移除；导航时宿主也会自动清理。
await button?.remove();`}</pre><Typography.Paragraph type="secondary">普通浏览器中的编辑器 fallback 保留 API 形状，但没有宿主工具栏和 Ant Design 容器，调用会以 <Typography.Text code>HOST_CAPABILITY_UNAVAILABLE</Typography.Text> 拒绝。工具栏最多显示 4 个按钮；Iconfont symbol 中不支持的 SVG 滤镜、渐变或外部引用会被安全过滤。</Typography.Paragraph><Tag color="green">桌面 Web 专用窗口</Tag></>},
  {key:"public",label:"公共脚本",content:<><Typography.Title level={5}>公共脚本</Typography.Title>{helpFieldTable([
    ["identifier","必填 string","大写标识符，匹配 ^[A-Z][A-Z0-9_]\{0,63\}$，不能覆盖保留命名空间。","用 EXAMPLE_HELPERS 这类稳定名称读取导出。"],
    ["factory","必填 function","接收 { jssdk } 并返回公共导出对象。","只注册小型、无副作用的共享工具。"],
    ["返回对象","Record<string, unknown>","factory 返回的导出对象，宿主冻结后由 public.get(identifier) 返回。","const helpers = jssdk.public.get(\"EXAMPLE_HELPERS\")。"],
    ["get / has","同步查询","get 读取已注册模块；has 判断标识符是否已注册。两者都不会动态加载。","用 get(identifier) 读取模块，用 has(identifier) 防止重复注册。"],
    ["dependencies","服务端公共资源字段","公共脚本依赖先校验缺失/循环，再按拓扑展开。","依赖导出的脚本必须在拓扑顺序后使用。"],
    ["PUBLIC_REGISTRATION_CONFLICT / INVALID","错误码","保留标识符、格式错误或 factory 未返回对象时返回；重复注册保留首次结果。","捕获错误并保持页面原行为。"],
  ])}<Typography.Paragraph><Typography.Text code>jssdk.public.register</Typography.Text> 用于注册受限公共导出。<Typography.Text code>identifier</Typography.Text> 必须匹配大写标识符规则；<Typography.Text code>factory</Typography.Text> 接收 <Typography.Text code>{`{ jssdk }`}</Typography.Text>，factory 返回值会被冻结；用 get(identifier) 和 has(identifier) 访问动态命名空间。contextBridge 暴露后不会同步 preload 后续追加的属性，因此不要读取 public.identifier。</Typography.Paragraph><ul><li>导出对象冻结且只读；公共依赖先校验缺失/循环，再按拓扑顺序提供。</li></ul><pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`try {
  window.jssdk?.public.register({
    identifier: "EXAMPLE_HELPERS",
    factory: ({ jssdk }) => ({
      formatId: (value) => value.trim().toUpperCase(),
      sdkVersion: jssdk.version,
    }),
  });
  const helpers = window.jssdk?.public.get("EXAMPLE_HELPERS");
  console.log(helpers?.formatId("a-1"));
} catch (error) {
  console.warn("公共导出不可用", error instanceof Error ? error.message : "unknown");
}`}</pre><Typography.Paragraph type="secondary">公共注册是资源间的受控页面 API，不是任意 IPC、Token/Cookie/Storage 或 URL 执行入口。</Typography.Paragraph><Tag color="green">受控公共导出</Tag></>},
  {key:"business-example",label:"完整业务脚本示例",content:<><Typography.Title level={5}>完整业务脚本示例</Typography.Title><Typography.Paragraph>业务脚本在模板插入处的 <Typography.Text code>KWW_PUBLIC_DEPENDENCIES</Typography.Text> 单行 JSON 数组中按需声明公共脚本标识符和必需方法；resolver 会从匹配到的业务 JavaScript 全文识别这份声明并准备模块，无需在登录空间重复配置。旧客户端请求里的 <Typography.Text code>publicIdentifiers</Typography.Text> 仍兼容，但新脚本不需要维护第二份清单。公共脚本用 <Typography.Text code>jssdk.public.register</Typography.Text> 注册导出，factory 需返回导出对象；业务脚本用 <Typography.Text code>jssdk.public.get(identifier)</Typography.Text> 同步读取已准备模块；该方法不动态加载。</Typography.Paragraph><Typography.Paragraph>公共脚本可能随导航重复执行；先用 <Typography.Text code>has(identifier)</Typography.Text> 检查并复用首次注册结果。业务脚本也用页面级单例标记防止重复安装；已有订阅继续处理 <Typography.Text code>routeChange</Typography.Text>，离开文档时清理订阅并移除标记。</Typography.Paragraph><Typography.Paragraph>依赖声明无效、公共模块缺失或依赖循环时，resolver 返回可定位错误；必需方法是否导出由模板在业务逻辑前检查，缺失时记录具体模块和方法并安全退出。下面示例只处理虚构的 <Typography.Text code>https://orders.example.com/orders/123?tab=detail</Typography.Text> 页面，不读取账号凭据，也不改变页面请求。</Typography.Paragraph><Typography.Title level={5}>公共脚本：注册订单工具</Typography.Title><pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`const jssdk = window.jssdk;
// 先在公共脚本管理中启用此资源；业务脚本通过源码中的模板声明依赖，无需在空间配置里重复绑定。
// 先拿到受控公共命名空间；未注入时本段不会注册任何内容。
const publicApi = jssdk?.public;
// 导航可能让公共脚本再次运行；复用已有命名空间，避免重复注册同一标识符。
if (publicApi && !publicApi.has("ORDER_HELPERS")) {
  try {
    // 能力缺失时不伪造导出，业务脚本会通过缺少公共工具的路径安全退出。
    if (typeof publicApi.register !== "function") {
      throw new Error("HOST_CAPABILITY_UNAVAILABLE");
    }
    jssdk.public.register({
      identifier: "ORDER_HELPERS",
      factory: ({ jssdk }) => ({
        // 纯转换函数：接收字符串并返回规范化字符串，不读取或修改页面状态。
        normalizeOrderId: (value) => {
          if (typeof value !== "string") return "";
          return value.trim().replaceAll(" ", "").toUpperCase();
        },
        sdkVersion: jssdk.version,
      }),
    });
  } catch (error) {
    console.info("公共订单工具注册失败，保持页面原行为", error instanceof Error ? error.message : "UNKNOWN");
  }
}`}</pre><Typography.Title level={5}>业务脚本：增强订单详情</Typography.Title><pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"ORDER_HELPERS","methods":["normalizeOrderId"]}];
(async function () {
  // 普通浏览器或能力未注入时直接退出，不影响页面原有流程。
  const jssdk = window.jssdk;
  if (!jssdk) return;

  // 服务端按 KWW_PUBLIC_DEPENDENCIES 准备模块；这里继续校验导出，避免依赖不完整时半初始化。
  const helpers = jssdk.public?.get("ORDER_HELPERS");
  if (!helpers || typeof helpers.normalizeOrderId !== "function") {
    console.info("公共脚本方法未导出：ORDER_HELPERS.normalizeOrderId，保留页面原行为");
    return;
  }

  // 同一文档可能重复执行资源；稳定单例标记保留既有订阅，routeChange 继续跟进 SPA 导航。
  const instanceKey = Symbol.for("kww.script-management.orders-example.v1");
  if (window[instanceKey]) return;
  window[instanceKey] = true;

  // 每次路由变化递增代次；旧的异步店铺信息返回后会被丢弃，不能覆盖新路由标题。
  let generation = 0;
  let disposed = false;
  let titleSet = false;
  let disposeDomReady = () => {};
  let disposeRouteChange = () => {};
  let disposeResponseObserver;
  let routeQueue = Promise.resolve();

  async function updateOrderContext(currentGeneration) {
    if (disposed || currentGeneration !== generation) return;
    let pageUrl;
    try {
      pageUrl = new URL(location.href);
    } catch {
      return;
    }

    // 示例仅处理虚构订单域名；订单标识优先取路径 /orders/:id，其次取 query 的 orderId。
    const pathParts = pageUrl.pathname.split("/").filter(Boolean);
    const pathOrderId = pathParts[0] === "orders" ? pathParts[1] : "";
    const rawOrderId = pageUrl.searchParams.get("orderId") || pathOrderId || "";
    if (pageUrl.origin !== "https://orders.example.com" || !rawOrderId) {
      if (titleSet) {
        // 离开本示例路由时只恢复先前设置的宿主标题。
        await jssdk.window.resetTitle().catch(() => undefined);
        titleSet = false;
      }
      return;
    }

    try {
      // 接口返回完整店铺上下文；本例只使用其中的 storeName/account 作为展示标题。
      const store = await jssdk.host.getStoreInfo();
      if (disposed || currentGeneration !== generation) return;
      const orderId = helpers.normalizeOrderId(rawOrderId);
      if (!orderId) return;
      const storeLabel = (store.storeName || store.account || "订单").trim().slice(0, 40);
      // 标题 API 只改变宿主窗口标题，不修改网页标题或业务数据。
      await jssdk.window.setHeaderTitle({ text: storeLabel + " · 订单 " + orderId.slice(0, 64) });
      titleSet = true;
    } catch (error) {
      if (!disposed && currentGeneration === generation) {
        console.info("店铺上下文或标题能力不可用，保留页面原行为", error instanceof Error ? error.message : "UNKNOWN");
      }
    }
  }

  function scheduleOrderUpdate() {
    const currentGeneration = ++generation;
    // 串行队列避免多个路由更新并行；代次检查再阻止排队中的旧结果生效。
    routeQueue = routeQueue
      .then(() => updateOrderContext(currentGeneration))
      .catch((error) => console.info("订单增强已跳过", error instanceof Error ? error.message : "UNKNOWN"));
  }

  disposeDomReady = jssdk.lifecycle.on("domReady", scheduleOrderUpdate);
  disposeRouteChange = jssdk.lifecycle.on("routeChange", scheduleOrderUpdate);

  const responseObserverReady = jssdk.net.subscribeResponse({
    match: {
      // 只观察虚构订单 API 的 GET 响应头阶段；includeBody:false 表示不请求响应体。
      url: "https://orders.example.com/api/orders/*",
      method: "GET",
    },
    stages: ["responseHeaders"],
    includeBody: false,
  }, (event) => {
    // 本例只读取状态码用于诊断，不改变请求或响应。
    if (!disposed && typeof event.status === "number") {
      console.info("订单接口响应状态", event.status);
    }
  }).then((dispose) => {
    // 订阅异步返回取消函数；若页面先关闭，拿到函数后立即取消，避免留下监听。
    if (disposed) return dispose();
    disposeResponseObserver = dispose;
  }).catch((error) => {
    // 网络观察未获授权时降级，不阻止订单页面或标题增强继续工作。
    console.info("网络观察未获授权，保留页面原行为", error instanceof Error ? error.message : "UNKNOWN");
  });

  function cleanup() {
    // 清理保持幂等：卸载订阅、恢复宿主标题并释放单例标记，允许后续新文档正常安装。
    if (disposed) return;
    disposed = true;
    generation++;
    disposeDomReady();
    disposeRouteChange();
    delete window[instanceKey];
    // 取消函数可能尚未异步返回，因此等订阅建立完成后再执行它。
    void responseObserverReady.then(() => disposeResponseObserver?.()).catch(() => undefined);
    // 等当前串行更新结束后恢复本例设置过的标题。
    void routeQueue.then(async () => {
      if (titleSet) await jssdk.window.resetTitle().catch(() => undefined);
      titleSet = false;
    });
  }

  // 页面离开时回收当前文档资源；once 与 cleanup 内的 disposed 检查共同保证安全重复清理。
  window.addEventListener("pagehide", cleanup, { once: true });
})();`}</pre><Typography.Paragraph>示例用代次丢弃过期路由结果；网络观察只查看匹配 GET 响应的状态码，不读取或输出 URL、响应头、响应体。网络订阅可能因当前资源授权被拒绝，错误会被捕获并降级；页面原有行为继续保留。<Typography.Text code>getCapabilities()</Typography.Text> 或 <Typography.Text code>host.getCapabilities()</Typography.Text> 只是入口清单，不代表当前脚本已获授权。</Typography.Paragraph><Typography.Paragraph type="secondary">宿主仍会检查工作区、来源、启用/发布状态、版本、URL 规则与 SHA-256；宿主能力也受窗口上下文和权限约束。</Typography.Paragraph><Tag color="green">公共资源与业务脚本协作示例</Tag></>},
  {key:"errors",label:"授权与错误处理",content:<><Typography.Title level={5}>授权与错误处理</Typography.Title><Typography.Paragraph>先区分入口存在、资源授权和运行时状态：<Typography.Text code>getCapabilities()</Typography.Text> 只给方法清单；工作区/来源/平台/启用发布状态、版本指针、URL 规则与 SHA-256 仍由服务端 resolver 和宿主复验。</Typography.Paragraph><ul><li><Typography.Text code>HOST_CAPABILITY_UNAVAILABLE</Typography.Text>：窗口或 fallback 不支持该宿主能力；捕获后跳过增强功能。</li><li><Typography.Text code>AUTH_CONTEXT_MISSING</Typography.Text>、<Typography.Text code>SHOP_CONTEXT_MISSING</Typography.Text>、<Typography.Text code>ORIGIN_MISMATCH</Typography.Text>：上下文、店铺或来源不满足；不要重试绕过校验。</li><li><Typography.Text code>WEB_WINDOW_CLOSED</Typography.Text>、<Typography.Text code>WINDOW_NAVIGATION_CHANGED</Typography.Text>：窗口已销毁或导航代次变化；丢弃旧异步结果。</li><li><Typography.Text code>NETWORK_WAIT_TIMEOUT</Typography.Text>、<Typography.Text code>INVALID_NETWORK_SUBSCRIPTION</Typography.Text>：订阅/等待参数或时限问题；清理取消函数后安全结束。</li><li><Typography.Text code>NETWORK_CAPABILITY_DENIED</Typography.Text>、<Typography.Text code>NETWORK_DECISION_EXPIRED</Typography.Text>：拦截未获授权或决定 token 过期；保持观察/放行，不把失败当作授权成功。</li></ul><pre style={{whiteSpace:"pre",overflowX:"auto",fontFamily:"var(--admin-code-font, ui-monospace)",padding:12,borderRadius:3,background:"var(--admin-code-bg, #f6f8fa)"}}>{`try {
  await window.jssdk?.net.waitForResponse({ timeoutMs: 3000 });
} catch (error) {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  if (code === "HOST_CAPABILITY_UNAVAILABLE" || code === "NETWORK_CAPABILITY_DENIED") {
    console.info("保持页面原行为");
  } else {
    console.warn("网络等待结束", code);
  }
}`}</pre><Typography.Paragraph type="secondary">错误处理只记录非敏感错误码和摘要，不记录 headers、body、Token、Cookie、密码或原始 IPC。</Typography.Paragraph><Tag color="green">安全失败</Tag></>},
  {key:"url",label:"URL 匹配",content:<><Typography.Title level={5}>URL 匹配</Typography.Title><Typography.Paragraph>先区分业务脚本多规则与公共资源：业务脚本的 <Typography.Text code>matchRules</Typography.Text> 最多 32 条，至少一条启用，启用规则任一命中即可；停用规则跳过。业务脚本的公共 JavaScript 依赖通过源码中的 <Typography.Text code>KWW_PUBLIC_DEPENDENCIES</Typography.Text> 声明；旧 <Typography.Text code>publicIdentifiers</Typography.Text> 请求字段继续兼容。公共资源不在服务端按 URL 过滤；公共 CSS 使用一条 exact 或 wildcard 规则。</Typography.Paragraph><Typography.Title level={5}>配置位置与命中示例</Typography.Title><table className="script-writing-help-fields"><thead><tr><th>规则</th><th>当前 URL</th><th>结果</th><th>原因</th></tr></thead><tbody><tr><td><Typography.Text code>exact</Typography.Text><br/><Typography.Text code>https://shop.example.com/product/list?channel=1</Typography.Text></td><td><Typography.Text code>https://shop.example.com/product/list?channel=2</Typography.Text></td><td>不命中</td><td>query 默认参与比较；开启 <Typography.Text code>ignoreQuery</Typography.Text> 后只忽略 <Typography.Text code>?</Typography.Text> 及其后的整段查询，路径仍须一致。</td></tr><tr><td><Typography.Text code>prefix</Typography.Text><br/><Typography.Text code>https://shop.example.com/product/</Typography.Text></td><td><Typography.Text code>https://shop.example.com/product/42?channel=1</Typography.Text></td><td>命中</td><td>业务脚本多规则的字面 URL 前缀；末尾 <Typography.Text code>/</Typography.Text> 可避免误命中 <Typography.Text code>/products/42</Typography.Text>。</td></tr><tr><td><Typography.Text code>prefix</Typography.Text><br/><Typography.Text code>https://shop.example.com/product/</Typography.Text></td><td><Typography.Text code>https://shop.example.com/products/42</Typography.Text></td><td>不命中</td><td>路径前缀不同，不能把相邻路径当作同一路径。</td></tr><tr><td><Typography.Text code>wildcard</Typography.Text><br/><Typography.Text code>https://shop.example.com/product/*</Typography.Text></td><td><Typography.Text code>https://shop.example.com/product/42?channel=1</Typography.Text></td><td>命中</td><td><Typography.Text code>*</Typography.Text> 匹配 URL 中任意字符；主机、协议和其余字面部分仍需匹配。</td></tr><tr><td><Typography.Text code>wildcard</Typography.Text><br/><Typography.Text code>https://shop.example.com/product/*</Typography.Text></td><td><Typography.Text code>https://other.example.com/product/42</Typography.Text></td><td>不命中</td><td>不同 host 不会跨域命中；星号不是任意正则表达式。</td></tr></tbody></table><Typography.Paragraph>exact 和 wildcard 都会先按服务端规则规范化协议、主机名、默认端口和路径；query 是否参与由规则的 <Typography.Text code>ignoreQuery</Typography.Text> 决定。空值、片段、控制字符、非法 URL 和任意正则语法不能保存。</Typography.Paragraph><Typography.Title level={5}>自动与显式调度</Typography.Title><Typography.Paragraph>正常资源调度缺省 <Typography.Text code>matchConfiguredUrlRules=true</Typography.Text>，按当前页面 URL 应用已保存规则。受信宿主逐资源显式传递 <Typography.Text code>matchConfiguredUrlRules=false</Typography.Text> 时，只跳过该资源保存的 URL 规则，不跳过工作区、平台、启用/发布状态、版本或 SHA-256 校验；这是宿主调度参数，不是 <Typography.Text code>window.jssdk</Typography.Text> 方法。</Typography.Paragraph><Tag color="green">当前可用</Tag></>},
  {key:"javascript",label:"JavaScript 编写规范",content:<><Typography.Title level={5}>JavaScript 编写规范</Typography.Title><Typography.Paragraph>建议使用 IIFE 或命名空间封装，避免污染全局；回调保存取消函数并隔离异常，不要依赖未声明的宿主能力。</Typography.Paragraph><Typography.Text code>{`(() => {
  const namespace = window.__KWW_SCRIPT__ ?? {};
  window.__KWW_SCRIPT__ = namespace;
})();`}</Typography.Text><Typography.Paragraph type="secondary">生命周期回调只处理当前页面允许的数据，不记录 Token、Cookie 或密钥。</Typography.Paragraph><Tag color="green">编写建议</Tag></>},
  {key:"idempotency",label:"幂等与重复执行",content:<><Typography.Title level={5}>幂等与重复执行</Typography.Title><Typography.Paragraph>页面刷新产生新文档代次，SPA 路由变化可多次触发 <Typography.Text code>routeChange</Typography.Text>。使用清理函数和页面内标记避免重复绑定，不能把旧代次异步结果写回新页面。</Typography.Paragraph><Typography.Text code>{`let dispose;
function bindForRoute(handleRoute) {
  dispose?.();
  dispose = window.jssdk?.lifecycle.on("routeChange", handleRoute);
}`}</Typography.Text><Typography.Paragraph type="secondary">宿主按 workspace、资源、版本、规范化 URL、导航代次、routeKey 和 runAt 约束幂等；脚本自身仍需对重复事件安全。</Typography.Paragraph><Tag color="green">运行时约束与编写建议</Tag></>},
  {key:"css",label:"CSS 与 JavaScript",content:<><Typography.Title level={5}>CSS 与 JavaScript</Typography.Title><Typography.Paragraph>样式和脚本是独立资产，各自拥有版本、启用状态、runAt 与 priority。document_start 样式会尝试在页面文档创建阶段注册；当前页面注入和未来文档注册不是同一机制，注册成功也不等于当前页面已经生效。</Typography.Paragraph><Typography.Paragraph>公共脚本依赖拓扑优先；CSS/JS 相对顺序只有在不破坏依赖且有明确产品约束时才成立，不能概括为所有场景 CSS 永远先于 JavaScript。</Typography.Paragraph><Tag color="green">独立资产与受控加载</Tag></>},
  {key:"debug",label:"调试与版本排查",content:<><Typography.Title level={5}>调试与版本排查</Typography.Title><Typography.Paragraph>先检查资源版本、状态、发布时间、字符数/字节数、SHA-256、工作区权限和 URL 匹配；再区分能力拒绝、上下文缺失、导航变化、超时和资源失败。</Typography.Paragraph><Typography.Paragraph>运行时按资源记录成功、失败、超时和未匹配；单个资源失败不应覆盖其他资源结果。生产问题不要把源码、Token、Cookie 或响应密钥写入日志。</Typography.Paragraph><Tag color="green">可操作排查</Tag></>}
 ];
 const helpContent=helpSections.find(item=>item.key===helpSection)??helpSections[0];
 const closeHelp=()=>{setHelpOpen(false);setHelpFullscreen(false);setHelpDragging(false)};
 const helpTitle=<div className="script-writing-help-title"><span>脚本编写帮助</span><Tooltip title={helpFullscreen?"退出全屏":"全屏显示"}><Button type="text" size="small" aria-label={helpFullscreen?"退出全屏":"全屏显示"} icon={helpFullscreen?<CompressOutlined/>:<ExpandOutlined/>} onClick={()=>setHelpFullscreen(current=>!current)}/></Tooltip></div>;
 return <><ListPageCard title="抖店脚本" subtitle="管理脚本配置及 JavaScript、CSS 独立源码版本。" toolbar={<Space wrap><Input.Search placeholder="名称 / 匹配 URL" allowClear onSearch={v=>{setPage(1);setKeyword(v.trim())}} style={{width:260}}/><Segmented options={[{label:"全部",value:""},{label:"启用",value:"enabled"},{label:"停用",value:"disabled"},{label:"归档",value:"archived"}]} value={status} onChange={v=>{setPage(1);setStatus(String(v))}}/></Space>} extra={can(perm.create)?<Button type="primary" onClick={()=>{setSelected(null);form.resetFields();setEditorOpen(true)}}>新建脚本</Button>:null}><Table rowKey="id" loading={loading} columns={columns} dataSource={rows} scroll={{x:1300}} pagination={{current:page,pageSize,total,showSizeChanger:true,onChange:(p,s)=>{setPage(p);setPageSize(s)}}}/></ListPageCard>
 <Drawer title={selected?`脚本详情：${selected.name}`:"脚本详情"} open={detailOpen} onClose={()=>{setDetailOpen(false);setSelected(null)}} width={560} extra={selected&&<Space><Button onClick={()=>void openAssetEditor(selected,"script")}>查看 JavaScript</Button><Button onClick={()=>void openAssetEditor(selected,"style")}>查看 CSS</Button>{can(perm.update)&&<Button type="primary" onClick={()=>void openEdit(selected)}>编辑</Button>}</Space>}>{selected&&<><Descriptions bordered size="small" column={1} items={[{key:"identifier",label:"标识符",children:selected.identifier},{key:"name",label:"名称",children:selected.name},{key:"matchType",label:"匹配方式",children:selected.matchType==="wildcard"?"通配匹配":"精确匹配"},{key:"matchUrl",label:<Space size={4}>匹配 URL<Tooltip title={matchUrlHelp} styles={{root:{maxWidth:"min(520px, calc(100vw - 24px))"},container:{padding:12}}}><InfoCircleOutlined style={{color:"var(--admin-primary)"}} /></Tooltip></Space>,children:<Typography.Text style={{wordBreak:"break-all"}}>{selected.matchUrl}</Typography.Text>},{key:"status",label:"脚本状态",children:selected.status==="enabled"?"启用":selected.status==="disabled"?"停用":"已归档"},{key:"latest",label:"最新版本",children:selected.latestVersion||"—"},{key:"effective",label:"生效版本",children:selected.effectiveVersion||"—"},{key:"content",label:"内容大小",children:`JavaScript ${selected.latestJsBytes} B / CSS ${selected.latestCssBytes} B`},{key:"updated",label:"更新时间",children:formatTime(selected.updatedAt)}]}/></>}</Drawer>
 <Drawer title={selected?`编辑脚本：${selected.name}`:"新建抖店脚本"} open={editorOpen} onClose={()=>{setEditorOpen(false);form.resetFields();setSelected(null)}} width={560} extra={<Button type="primary" onClick={()=>void saveScript()}>保存</Button>}><Form form={form} layout="vertical"><Form.Item name="identifier" label="标识符" normalize={(value)=>typeof value==="string"?value.trim():value} rules={[{required:true,message:"请输入标识符"},{validator:(_,value)=>{const identifier=typeof value==="string"?value.trim():"";if(!identifier)return Promise.resolve();if(identifier.length>64)return Promise.reject(new Error("标识符不能超过64个字符"));if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier))return Promise.reject(new Error("标识符仅允许字母、数字、点、下划线和连字符，且必须以字母或数字开头"));return Promise.resolve()}}]}><Input placeholder="例如 product-list" /></Form.Item><Form.Item name="name" label="名称" rules={[{required:true,message:"请输入名称"}]}><Input/></Form.Item><Form.Item name="matchType" label="匹配方式" initialValue="exact"><Select options={[{value:"exact",label:"精确匹配"},{value:"wildcard",label:"通配匹配"}]}/></Form.Item><Form.Item name="matchUrl" label={<Space size={4}>匹配 URL<Tooltip title={matchUrlHelp} styles={{root:{maxWidth:"min(520px, calc(100vw - 24px))"},container:{padding:12}}}><InfoCircleOutlined style={{color:"var(--admin-primary)"}} /></Tooltip></Space>} rules={[{required:true,message:"请输入匹配 URL"}]}><Input /></Form.Item><Typography.Text type="secondary">脚本源码仅作为纯文本配置保存，不会在本页面执行。</Typography.Text></Form></Drawer>
 <Drawer className={assetTab==="content"||assetTab==="public"?"script-asset-editor-drawer script-asset-editor-content-drawer":"script-asset-editor-drawer"} styles={{content:{display:"flex",flexDirection:"column",flex:"1 1 0%",height:"100%",minHeight:0,overflow:"hidden"},body:{position:"relative",display:"flex",flex:"1 1 0%",flexDirection:"column",height:"100%",minHeight:0,overflow:"hidden"}}} title={<div className="script-asset-editor-header-title"><span className="script-asset-editor-header-label">{selected?`${assetTypeLabel(assetType)}：${selected.name}`:assetTypeLabel(assetType)}</span>{assetHeaderTabs}</div>} open={assetEditorOpen} keyboard={false} onClose={closeAssetEditor} width="min(1100px, 100vw)" extra={<Space>{assetTab!=="public"&&can(perm.update)&&(!activeAsset||activeAsset.status!=="draft")&&<Button onClick={()=>selected&&void ensureDraft(assetType,selected.id)}>编辑</Button>}{assetTab!=="public"&&can(perm.update)&&<Button onClick={()=>void saveAsset()} disabled={!activeAsset||activeAsset.status!=="draft"} loading={assetLoading}>保存当前草稿</Button>}</Space>}><div className="script-asset-editor-direct-layer" style={{position:"relative",display:"flex",flexDirection:"column",flex:"1 1 auto",minHeight:0,minWidth:0,overflow:"hidden"}}>{assetTab!=="public"&&(assetTab==="content"?assetEditor(assetType):assetTab==="history"?assetHistory(assetType):assetOther(assetType))}<div style={{display:assetTab==="public"?"flex":"none",flex:1,minHeight:0,minWidth:0,overflow:"hidden"}}>{assetType==="style"?<PublicStylesPanel client={client} can={can} message={message} modal={modal} onDirtyChange={setPublicScriptsDirty} onOpenHelp={openScriptWritingHelp} shortcuts={editorPrefsShortcuts(editorPrefs.style)}/>:<PublicScriptsPanel client={client} can={can} message={message} modal={modal} onDirtyChange={setPublicScriptsDirty} onOpenHelp={openScriptWritingHelp} shortcuts={editorPrefsShortcuts(editorPrefs.script)}/>}</div></div></Drawer>
 <Drawer className="script-asset-preview-drawer" title={previewAsset?`${assetTypeLabel(previewAsset.assetType)}历史版本：${previewAsset.version}`:"历史版本"} open={previewOpen} onClose={()=>{setPreviewOpen(false);setPreviewAsset(null);setPreviewContent("")}} width="min(1000px, 100vw)" keyboard={false} styles={{content:{display:"flex",flexDirection:"column",height:"100%",minHeight:0,overflow:"hidden"},body:{display:"flex",flexDirection:"column",flex:1,minHeight:0,overflow:"hidden"}}}><div style={{padding:"12px 16px 8px",borderBottom:"1px solid var(--admin-border-color)"}}>{previewAsset&&<Descriptions size="small" column={{xs:1,sm:2}} items={[{key:"version",label:"版本",children:previewAsset.version},{key:"type",label:"资源类型",children:assetTypeLabel(previewAsset.assetType)},{key:"status",label:"状态",children:assetStatusLabel(previewAsset.status)},{key:"published",label:"发布时间",children:formatPublishedTime(previewAsset.publishedAt,previewAsset.updatedAt)},{key:"runAt",label:"注入时机",children:previewAsset.assetType==="style"?styleRunAtLabel(previewAsset.runAt):"跟随脚本"},{key:"priority",label:"注入优先级",children:previewAsset.assetType==="style"?String(previewAsset.priority):"跟随脚本"},{key:"enabled",label:"是否启用",children:previewAsset.assetType==="style"?(previewAsset.enabled?"启用":"停用"):"跟随脚本"},{key:"chars",label:"字符数",children:`${previewAsset.sourceChars} 字符`},{key:"bytes",label:"大小",children:`${previewAsset.sourceBytes} B`},{key:"sha",label:"SHA-256",children:previewAsset.sourceSha256||"—"},{key:"updated",label:"更新时间",children:formatTime(previewAsset.updatedAt)},{key:"actor",label:"更新者",children:actorLabel(previewAsset)}]}/>}</div><div className="script-asset-preview-body" style={{display:"flex",flex:1,minHeight:0,overflow:"hidden"}}>{previewLoading?<Typography.Text style={{padding:16}}>正在加载源码…</Typography.Text>:previewAsset?<MonacoSourceEditor value={previewContent} onChange={()=>undefined} language={previewAsset.assetType==="script"?"JavaScript":"CSS"} version={previewAsset.version} scriptName={selected?.name} editable={false} completionItems={previewAsset.assetType==="script"?jsCompletionItems:cssCompletionItems} contextSnippets={monacoContextSnippets} shortcuts={editorPrefsShortcuts(editorPrefs[previewAsset.assetType])}/>:null}</div></Drawer>
 <Drawer title="样式属性设置" open={stylePropertiesOpen} onClose={()=>setStylePropertiesOpen(false)} width="min(520px, 100vw)" extra={<Space><Button onClick={()=>setStylePropertiesOpen(false)}>取消</Button><Button type="primary" onClick={()=>void saveStyleProperties()}>保存</Button></Space>}><Form form={stylePropertiesForm} layout="vertical"><Form.Item name="runAt" label="注入时机" rules={[{required:true,message:"请选择注入时机"}]}><Radio.Group options={styleRunAtOptions}/></Form.Item><Form.Item name="priority" label="注入优先级" extra="数值越小越早，范围为 -10000 至 10000。"><InputNumber min={-10000} max={10000} precision={0} style={{width:"100%"}}/></Form.Item><Form.Item name="enabled" label="是否启用" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用"/></Form.Item><Typography.Text type="secondary">仅编辑中的样式草稿可修改；已发布版本请先复制为草稿。</Typography.Text></Form></Drawer>
 <Drawer title="脚本属性设置" open={scriptPropertiesOpen} onClose={()=>setScriptPropertiesOpen(false)} width="min(760px, 100vw)" extra={<Space><Button onClick={()=>setScriptPropertiesOpen(false)}>取消</Button><Button type="primary" onClick={()=>void saveScriptProperties()}>保存</Button></Space>}><Form form={scriptPropertiesForm} layout="vertical"><Form.Item name="identifier" label="标识符"><Input disabled /></Form.Item><Form.Item name="platform" label="平台"><Input disabled addonAfter="由脚本管理模块决定" /></Form.Item><Form.Item label="类型"><Input value="业务脚本" disabled /></Form.Item><Form.Item name="name" label="名称" rules={[{required:true,message:"请输入名称"}]}><Input /></Form.Item><Form.Item label="URL 匹配规则" required><Form.List name="matchRules">{(fields,{add,remove,move})=><Space direction="vertical" style={{width:"100%"}}>{fields.map((field,index)=><div key={field.key} style={{display:"grid",gridTemplateColumns:"minmax(108px,0.32fr) minmax(0,1fr) auto auto auto",gap:8,alignItems:"start",width:"100%"}}><Form.Item {...field} name={[field.name,"matchType"]} rules={[{required:true,message:"请选择匹配方式"}]} style={{minWidth:0}}><Select style={{width:"100%"}} options={[{value:"exact",label:"精确匹配"},{value:"prefix",label:"URL 前缀"},{value:"wildcard",label:"通配匹配"}]}/></Form.Item><Form.Item {...field} name={[field.name,"pattern"]} rules={[{required:true,message:"请输入匹配内容"}]} style={{minWidth:0}}><Input placeholder="https://example.com/*" style={{width:"100%"}} /></Form.Item><Form.Item {...field} name={[field.name,"ignoreQuery"]} valuePropName="checked" style={{whiteSpace:"nowrap"}}><Tooltip title="启用后，匹配时会忽略 URL 中 ? 之后的查询参数。例如同一路径的不同 channel 参数会视为同一条规则。"><Checkbox>忽略查询</Checkbox></Tooltip></Form.Item><Form.Item {...field} name={[field.name,"enabled"]} valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用"/></Form.Item><Button type="text" danger icon={<DeleteOutlined />} aria-label="删除 URL 规则" onClick={()=>remove(field.name)} disabled={fields.length<=1}/></div>)}<Button type="dashed" block icon={<PlusOutlined />} onClick={()=>add({matchType:"wildcard",pattern:"",ignoreQuery:true,enabled:true,remark:""})}>新增匹配规则</Button><Typography.Text type="secondary">任意一条启用规则命中当前 URL 即会匹配脚本；规则顺序用于稳定执行。</Typography.Text></Space>}</Form.List></Form.Item><Form.Item name="priority" label="注入优先级" extra="数值越小越早注入，范围为 -10000 至 10000。"><InputNumber min={-10000} max={10000} precision={0} style={{width:"100%"}}/></Form.Item><Form.Item name="enabled" label="脚本状态" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用" disabled={selected?.status==="archived"}/></Form.Item></Form></Drawer>
 <Drawer className={`script-writing-help-drawer${helpFullscreen?" is-fullscreen":""}${helpDragging?" is-resizing":""}`} title={helpTitle} open={helpOpen} onClose={closeHelp} width={helpFullscreen?"100vw":helpWidthForViewport(helpWidth)} styles={{content:{position:"relative",transition:helpDragging?"none":undefined},body:{padding:16,position:"relative"}}}>
  <div className="script-writing-help-resize-handle" aria-label="拖动调整帮助窗口宽度" role="separator" aria-orientation="vertical" tabIndex={0} aria-valuemin={helpWidthForViewport(560)} aria-valuemax={helpWidthForViewport(1600)} aria-valuenow={helpWidthForViewport(helpWidth)} aria-valuetext={`${helpWidthForViewport(helpWidth)} 像素`} onPointerDown={startHelpResize} onKeyDown={onHelpResizeKeyDown} />
  <div className="script-writing-help">
   <nav className="script-writing-help-outline" aria-label="脚本编写帮助目录">{helpSections.map(item=><button key={item.key} type="button" className={item.key===helpContent.key?"is-active":""} onClick={()=>setHelpSection(item.key)}>{item.label}</button>)}</nav>
   <main className="script-writing-help-content">{helpContent.content}</main>
  </div>
 </Drawer></>;
}
