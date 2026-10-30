import { readDocumentDraft, rememberDocumentDraft } from "../document-draft-cache";
import "./documents-page.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Drawer, Empty, Form, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { ListPageCard, usePermissions, useRequestClient, useCurrentUser, useCurrentWorkspace } from "@ky/admin-core";
import { MarkdownReader } from "@ky/markdown";
import { documentAPI, type DocumentDraft, type DocumentVersion, type DocumentBinding } from "../documents-api";
import { MarkdownEditor } from "@ky/markdown/editor";
const categories=[{value:"agreement",label:"协议"},{value:"privacy",label:"隐私"},{value:"notice",label:"说明"},{value:"other",label:"其他"}];
const statuses=[{value:"unpublished",label:"未发布"},{value:"published",label:"已发布"},{value:"offline",label:"已下线"}];
const empty:DocumentDraft={id:"",slug:"",title:"",category:"agreement",status:"unpublished",version:0,revision:0,markdown:"",note:"",dirty:true,updatedAt:"",updatedBy:""};
export function DocumentsPage(){
 const user=useCurrentUser();const workspace=useCurrentWorkspace();
 const draftKey=user&&workspace?JSON.stringify([user.id,workspace.type,workspace.id,workspace.membershipId]):"";
 const client=useRequestClient();
 const api=useMemo(()=>documentAPI(client),[client]);
 return <DocumentsContent key={draftKey} api={api} draftKey={draftKey}/>;
}
function DocumentsContent({api,draftKey}:{api:ReturnType<typeof documentAPI>;draftKey:string}){
 const permission=usePermissions();const {message,modal}=App.useApp();const can=(action:string)=>permission.can(`platform.documents.${action}`);
 const [items,setItems]=useState<DocumentDraft[]>([]),[total,setTotal]=useState(0),[page,setPage]=useState(1),[q,setQ]=useState(""),[search,setSearch]=useState(""),[category,setCategory]=useState(""),[status,setStatus]=useState("");
 const [loading,setLoading]=useState(false),[error,setError]=useState(""),[busy,setBusy]=useState(false),[draft,setDraft]=useState<DocumentDraft|null>(()=>readDocumentDraft(draftKey)),[edited,setEdited]=useState(()=>!!readDocumentDraft(draftKey)),[preview,setPreview]=useState(false);
 const [compareVersions,setCompareVersions]=useState<number[]>([]),[comparison,setComparison]=useState<DocumentVersion[]|null>(null);
 const [history,setHistory]=useState<{id:string;revision:number;items:DocumentVersion[]}|null>(null),[historical,setHistorical]=useState<DocumentVersion|null>(null);
 const [bindings,setBindings]=useState<DocumentBinding[]|null>(null),[bindingOptions,setBindingOptions]=useState<DocumentDraft[]>([]),[bindingSearch,setBindingSearch]=useState("");
 const dirtyRef=useRef(edited);dirtyRef.current=edited;
 const [form]=Form.useForm();
 useEffect(()=>{const recovered=readDocumentDraft(draftKey);if(recovered)form.setFieldsValue(recovered)},[draftKey,form]);
 useEffect(()=>{rememberDocumentDraft(draftKey,edited?draft:null)},[draftKey,edited,draft]);const pendingPublish=useRef<{revision:number;key:string}|null>(null);
 const load=useCallback(async()=>{setLoading(true);try{const v=await api.list(new URLSearchParams({q:search,category,status,page:String(page),pageSize:"20"}).toString());setItems(v.items);setTotal(v.pagination.total);setError("")}catch{setError("读取文档失败，请重试")}finally{setLoading(false)}},[api,search,category,status,page]);
 useEffect(()=>{void load()},[load]);
 useEffect(()=>{const guard=(event:BeforeUnloadEvent)=>{if(dirtyRef.current){event.preventDefault();event.returnValue=""}};window.addEventListener("beforeunload",guard);return()=>window.removeEventListener("beforeunload",guard)},[]);
 // Guard visible navigation before the active system tab can unmount.
 useEffect(()=>{const guard=(event:MouseEvent)=>{if(!dirtyRef.current)return;const el=event.target as HTMLElement;const tab=el.closest('[role="tab"], [role="menuitem"], a[href]');if(tab&&tab.getAttribute('aria-selected')!=="true"){event.preventDefault();event.stopPropagation();modal.confirm({title:"离开前请保存草稿",content:"当前文档仍有未保存修改。请先保存，或关闭编辑窗口并放弃修改。",okText:"继续编辑",cancelButtonProps:{style:{display:"none"}}})}};document.addEventListener("click",guard,true);return()=>document.removeEventListener("click",guard,true)},[modal]);
 async function action(fn:()=>Promise<void>){if(busy)return;setBusy(true);try{await fn()}catch{void message.error("操作失败，可能存在修订冲突、入口绑定或权限限制；本地内容已保留，请重新读取后重试。")}finally{setBusy(false)}}
 function apply(v:DocumentDraft){setDraft(v);form.setFieldsValue(v);setEdited(false);setPreview(false)}
 function close(){const done=()=>{setDraft(null);setEdited(false);setPreview(false)};if(edited)modal.confirm({title:"放弃未保存修改？",okText:"放弃修改",cancelText:"继续编辑",onOk:done});else done()}
 async function save():Promise<DocumentDraft>{if(!draft)throw Error();const fields=await form.validateFields();const body={...fields,markdown:draft.markdown,expectedRevision:draft.revision};const v=draft.id?await api.change(draft.id,"draft",body):await api.create(body);apply(v);await load();void message.success("草稿已保存，公开正文未改变");return v}
 function publish(){if(!draft||edited||!draft.id){void message.info("请先保存草稿再发布");return}const current=draft;modal.confirm({title:"发布后任何人均可访问",content:`发布“${current.title}”为v${current.version+1}，请确认不包含内部或敏感内容。`,okText:"确认发布",cancelText:"取消",onOk:()=>action(async()=>{if(!pendingPublish.current||pendingPublish.current.revision!==current.revision)pendingPublish.current={revision:current.revision,key:crypto.randomUUID()};const v=await api.change(current.id,"publish",{expectedRevision:current.revision,publishKey:pendingPublish.current.key});apply(v);pendingPublish.current=null;await load();if(v.status==="published"&&v.version===v.publicationVersion)void message.success("版本已发布");else void message.info("发布请求已处理，当前状态已重新读取")})})}
 async function openHistory(d:DocumentDraft){await action(async()=>{const v=await api.versions(d.id);setCompareVersions([]);setComparison(null);setHistory({id:d.id,revision:d.revision,items:v.items})})}
 async function openBindings(){setBindingSearch("");await action(async()=>{const [v,list]=await Promise.all([api.bindings(),api.list("status=published&pageSize=100")]);const selected=await Promise.all(v.items.filter(b=>b.documentId&&!list.items.some(d=>d.id===b.documentId)).map(b=>api.get(b.documentId!)));setBindings(v.items);setBindingOptions([...list.items,...selected])})}
 useEffect(()=>{if(!bindings)return;let alive=true;void api.list(new URLSearchParams({status:"published",pageSize:"100",q:bindingSearch}).toString()).then(v=>{if(alive)setBindingOptions(old=>[...old.filter(d=>bindings.some(b=>b.documentId===d.id)&&!v.items.some(n=>n.id===d.id)),...v.items])}).catch(()=>void message.error("搜索文档失败"));return()=>{alive=false}},[api,bindingSearch,!!bindings]);
 if(!can("view"))return <Empty description="暂无文档查看权限"/>;
 return <ListPageCard title="协议与文档" subtitle="维护Markdown协议与公开说明。草稿不影响线上，发布后无需登录即可阅读。" toolbar={<Space wrap><Input aria-label="搜索文档" placeholder="名称或标识" value={q} onChange={e=>setQ(e.target.value)} onPressEnter={()=>{setSearch(q);setPage(1)}}/><Select aria-label="文档分类" placeholder="全部分类" allowClear options={categories} value={category||undefined} onChange={v=>{setCategory(v??"");setPage(1)}}/><Select aria-label="发布状态" placeholder="全部状态" allowClear options={statuses} value={status||undefined} onChange={v=>{setStatus(v??"");setPage(1)}}/><Button onClick={()=>{setSearch(q);setPage(1)}}>查询</Button><Button onClick={()=>void load()}>刷新</Button><Button onClick={()=>void openBindings()}>登录入口绑定</Button>{can("create")&&<Button type="primary" onClick={()=>apply({...empty})}>新建文档</Button>}</Space>}>
 {error&&<Alert type="error" title={error}/>}
 <Table rowKey="id" loading={loading} dataSource={items} scroll={{x:1000}} pagination={{current:page,pageSize:20,total,onChange:setPage,showSizeChanger:false}} columns={[
 {title:"名称 / 标识",render:(_,d:DocumentDraft)=><><strong>{d.title}</strong><div>{d.slug}</div></>},
 {title:"分类",dataIndex:"category",render:v=>categories.find(c=>c.value===v)?.label},
 {title:"发布状态",dataIndex:"status",render:v=><Tag>{statuses.find(s=>s.value===v)?.label}</Tag>},
 {title:"草稿",dataIndex:"dirty",render:v=>v?"有未发布修改":"无修改"},
 {title:"当前版本",dataIndex:"version",render:v=>v?`v${v}`:"—"},
 {title:"当前版本生效时间",dataIndex:"publishedAt",render:v=>v?new Date(v).toLocaleString():"—"},
 {title:"最近更新",dataIndex:"updatedAt",render:v=>new Date(v).toLocaleString()},
 {title:"更新人",dataIndex:"updatedBy"},
 {title:"操作",render:(_,d:DocumentDraft)=><Space wrap><Button size="small" onClick={()=>void action(async()=>apply(await api.get(d.id)))}>{can("update")?"编辑":"查看"}</Button><Button size="small" onClick={()=>void openHistory(d)}>版本记录</Button>{d.status==="published"&&<Button size="small" onClick={()=>void navigator.clipboard.writeText(new URL(`/legal/${d.slug}`,location.origin).href).then(()=>message.success("公开链接已复制")).catch(()=>message.error("复制失败"))}>复制链接</Button>}{d.status==="published"&&can("unpublish")&&<Button size="small" danger onClick={()=>modal.confirm({title:"下线后当前及历史链接均不可访问",content:"已绑定登录入口时，请先更换或解除绑定。",onOk:()=>action(async()=>{await api.change(d.id,"unpublish",{expectedRevision:d.revision});await load()})})}>下线</Button>}{!d.version&&can("delete")&&<Button size="small" danger onClick={()=>modal.confirm({title:"删除未发布草稿？",onOk:()=>action(async()=>{await api.change(d.id,"delete",{expectedRevision:d.revision});await load()})})}>删除</Button>}</Space>}
 ]}/>
 <Drawer rootClassName="documents-editor-drawer" title={draft?.id?"编辑协议与文档":"新建协议与文档"} open={!!draft} size={1100} styles={{wrapper:{maxWidth:"100vw"}}} onClose={close} maskClosable={false} rootStyle={{top:"var(--admin-header-height, 72px)",bottom:0}} extra={<Space wrap><Button disabled={busy} onClick={()=>setPreview(!preview)}>{preview?"返回编辑":"预览"}</Button>{(draft?.id?can("update"):can("create"))&&<Button loading={busy} disabled={!!draft?.id&&!edited} onClick={()=>void action(async()=>{await save()})}>保存草稿</Button>}{can("publish")&&<Button type="primary" disabled={!draft?.id||edited||busy||(!draft.dirty&&draft.status==="published")} onClick={publish}>发布</Button>}</Space>}>
 {draft&&<><Alert type="info" showIcon title={edited?"有未保存修改":"草稿预览 · 不影响公开版本"}/><Button size="small" disabled={busy||!draft.id} onClick={()=>{if(edited)modal.confirm({title:"重新读取会替换当前未保存修改",onOk:()=>action(async()=>apply(await api.get(draft.id)))});else void action(async()=>apply(await api.get(draft.id)))}}>重新读取</Button>
 <Form form={form} layout="vertical" disabled={busy||!!draft.id&&!can("update")} onValuesChange={(_,all)=>{setDraft({...draft,...all});setEdited(true)}}>
 <Form.Item name="title" label="名称" rules={[{required:true,whitespace:true},{max:120}]}><Input maxLength={120}/></Form.Item>
 <Form.Item name="slug" label="公开标识（首次发布后固定）" rules={[{required:true},{pattern:/^[a-z0-9]+(-[a-z0-9]+)*$/,message:"使用小写英文、数字和连字符"},{max:80}]}><Input disabled={draft.version>0} maxLength={80}/></Form.Item>
 <Form.Item name="category" label="分类" rules={[{required:true}]}><Select options={categories}/></Form.Item>
 <Form.Item name="note" label="版本说明（随版本公开）" rules={[{max:500}]}><Input.TextArea maxLength={500}/></Form.Item>
 </Form>
 {preview?<MarkdownReader markdown={draft.markdown}/>:<MarkdownEditor value={draft.markdown} disabled={busy||!!draft.id&&!can("update")} onChange={value=>{setDraft({...draft,markdown:value});setEdited(true)}}/>}</>}
 </Drawer>
 <Drawer title="发布版本记录" open={!!history} size="large" rootStyle={{top:"var(--admin-header-height, 72px)",bottom:0}} onClose={()=>{setHistory(null);setHistorical(null)}}>
 {history&&<><Space wrap style={{marginBottom:16}}><Select aria-label="选择两个历史版本" mode="multiple" maxCount={2} style={{minWidth:240}} placeholder="选择两个版本进行对照" value={compareVersions} options={history.items.map(v=>({value:v.version,label:`v${v.version}`}))} onChange={setCompareVersions}/><Button disabled={compareVersions.length!==2||busy} onClick={()=>void action(async()=>setComparison(await Promise.all(compareVersions.map(n=>api.version(history.id,n)))))}>并排对照</Button></Space>{comparison&&<div className="document-editor-grid document-editor-split">{comparison.map(v=><section key={v.version} style={{minWidth:0,border:"1px solid var(--admin-stroke)",padding:12}}><Typography.Title level={5}>{v.title} · v{v.version}</Typography.Title><MarkdownReader markdown={v.markdown}/></section>)}</div>}<Table rowKey="version" dataSource={history.items} pagination={false} columns={[{title:"版本",dataIndex:"version",render:v=>`v${v}`},{title:"发布时间",dataIndex:"publishedAt",render:v=>new Date(v).toLocaleString()},{title:"发布人",dataIndex:"publishedBy"},{title:"说明",dataIndex:"note"},{title:"操作",render:(_,v:DocumentVersion)=><Space><Button onClick={()=>void action(async()=>setHistorical(await api.version(history.id,v.version)))}>查看</Button>{can("update")&&<Button onClick={()=>modal.confirm({title:"恢复为新草稿？",content:"会替换服务端草稿，不改变公开版本。",onOk:()=>action(async()=>{const restored=await api.change(history.id,"restore",{expectedRevision:history.revision,version:v.version});setHistory(null);apply(restored);await load()})})}>恢复为草稿</Button>}</Space>}]}/>{historical&&<><Typography.Title level={4}>{historical.title} · v{historical.version}</Typography.Title><MarkdownReader markdown={historical.markdown}/></>}</>}
 </Drawer>
 <Modal title="登录页协议入口绑定" open={!!bindings} footer={null} onCancel={()=>setBindings(null)} destroyOnHidden>
 <Alert type="info" title="仅可选择已发布文档；清空即解除入口。可搜索名称或标识。"/>
 {bindings?.map(b=><div key={b.purpose} style={{marginTop:16}}><Typography.Text>{b.purpose==="privacy_policy"?"隐私政策":"服务协议"}</Typography.Text><Select style={{width:"100%"}} showSearch filterOption={false} onSearch={setBindingSearch} allowClear disabled={!can("bind")||busy} value={b.documentId??undefined} placeholder="选择文档或清空绑定" options={bindingOptions.map(d=>({value:d.id,label:`${d.title} · ${d.slug}`}))} onChange={v=>modal.confirm({title:"更新登录页公开入口？",onOk:()=>action(async()=>{const out=await api.bind({...b,documentId:v??null});setBindings(out.items);void message.success("入口绑定已更新")})})}/></div>)}
 </Modal>
 </ListPageCard>
}
