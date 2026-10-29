import { MenuResourcePicker } from "./menu-resource-picker";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Drawer, Form, Input, InputNumber, Popconfirm, Select, Segmented, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, drawerWidths, useCurrentWorkspace, usePermissions, useRequestClient } from "@ky/admin-core";
import { listMenuDirectory, saveMenuDirectoryEntry, updateMenuDirectoryStatus, getMenuConfigEditor, resetMenuWorkspaceConfig, saveMenuWebViewConfig, type MenuDirectoryEntry, type MenuDirectoryType, type MenuWebViewConfig } from "../api";

import { ConfigRequestGuard } from "./config-request-guard";

type EntryForm = Partial<MenuDirectoryEntry>;
type WebConfigForm = { configScope:"common"|"workspace"; platform:string; defaultUrl:string; openMode:"embedded"|"window"; navigationProtocols:string[]; scripts:MenuWebViewConfig["scripts"]; styles:MenuWebViewConfig["styles"]; scheduleMode:"page_first"|"strict_document_start" };

export function MenuDirectoryPage() {
  const client=useRequestClient();const workspace=useCurrentWorkspace();const permission=usePermissions();const queryClient=useQueryClient();
  const [directory,setDirectory]=useState<MenuDirectoryType>("management");const [entryDrawer,setEntryDrawer]=useState(false);const [editing,setEditing]=useState<MenuDirectoryEntry|null>(null);const [form]=Form.useForm<EntryForm>();
  const [configMenu,setConfigMenu]=useState<MenuDirectoryEntry|null>(null);const [configValue,setConfigValue]=useState<MenuWebViewConfig|null>(null);const [configForm]=Form.useForm<WebConfigForm>();
  const entrySession=useRef(0);
  const guard = useRef(new ConfigRequestGuard());
  const [scopeRevision,setScopeRevision]=useState(0);
  const [hasOverride,setHasOverride]=useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [configReady, setConfigReady] = useState(false);
  const [configError, setConfigError] = useState("");
  const configTarget = useRef<{ directory: MenuDirectoryType; menuKey: string; context: string; ticket: {target:string;generation:number} } | null>(null);
  const context = JSON.stringify([directory, workspace?.type, workspace?.id]);
  const contextRef = useRef(context); contextRef.current = context;
  function closeConfig() { guard.current.invalidate(); configTarget.current = null; setConfigMenu(null); setConfigReady(false); }
  useEffect(() => { closeConfig(); setEntryDrawer(false); entrySession.current++; return () => guard.current.invalidate(); }, [context]);
  const entryNodeType=Form.useWatch("nodeType",form);const entryPageType=Form.useWatch("pageType",form);const entryWorkspaceTypes: string[]=Form.useWatch("workspaceTypes",form)??[];
  const resourcePlatform=Form.useWatch("platform",configForm)??"web";
  const canManage=permission.canAny(["platform.menu_catalog.manage"]);const queryKey=["menu-directory",directory,workspace?.type,workspace?.id];
  const query=useQuery({queryKey,enabled:!!workspace,queryFn:()=>listMenuDirectory(client,directory,canManage)});
  const permissionsQuery={data:query.data?.menuPermissions,isFetching:query.isFetching};
  const invalidate=()=>queryClient.invalidateQueries({queryKey:["menu-directory"]});
  const saveEntry=useMutation({mutationFn:(request:{value:EntryForm;directory:MenuDirectoryType;revision?:number;session:number;context:string})=>saveMenuDirectoryEntry(client,request.directory,String(request.value.menuKey??""),{...request.value,directoryType:request.directory,expectedRevision:request.revision}),onSuccess:(_,request)=>{void message.success("菜单管理已保存");if(contextRef.current===request.context&&entrySession.current===request.session){setEntryDrawer(false);setEditing(null);}invalidate();},onError:(e:Error)=>message.error(e.message)});
  const status=useMutation({mutationFn:(item:MenuDirectoryEntry)=>updateMenuDirectoryStatus(client,directory,item.menuKey,item.status==="active"?"disabled":"active",item.revision),onSuccess:()=>{void message.success("菜单状态已更新");invalidate();},onError:(e:Error)=>message.error(e.message)});
  const openCreate=()=>{entrySession.current++;setEditing(null);form.resetFields();form.setFieldsValue({directoryType:directory,nodeType:"leaf",pageType:"internal",status:"active",sortOrder:0,workspaceTypes:[workspace?.type??"platform"]});setEntryDrawer(true);};
  const openEdit=(item:MenuDirectoryEntry)=>{entrySession.current++;setEditing(item);form.setFieldsValue({...item,permissionBindings:item.permissionBindings&&Object.keys(item.permissionBindings).length?item.permissionBindings:Object.fromEntries(item.workspaceTypes.map(type=>[type,item.permissionCode?[item.permissionCode]:[]]))});setEntryDrawer(true);};
  function applyConfig(value:MenuWebViewConfig){setConfigValue(value);configForm.setFieldsValue({configScope:value.configScope,platform:value.platform,defaultUrl:value.defaultUrl,openMode:value.openMode,navigationProtocols:value.navigationProtocols,scripts:value.scripts,styles:value.styles,scheduleMode:value.scheduleMode});}
  function emptyConfig(scope: "common" | "workspace") {
    configForm.resetFields();
    configForm.setFieldsValue({configScope:scope,platform:"web",defaultUrl:"",openMode:"embedded",navigationProtocols:["https"],scripts:[],styles:[],scheduleMode:"page_first"});
  }
  async function readConfig(item:MenuDirectoryEntry, scope?:"common"|"workspace") {
    const targetContext = context;
    const ticket = guard.current.begin(JSON.stringify([targetContext,item.menuKey,scope ?? "effective"]));
    configTarget.current = { directory, menuKey:item.menuKey, context:targetContext, ticket };
    setConfigLoading(true); setConfigReady(false); setConfigValue(null); setConfigError(""); emptyConfig(scope ?? "workspace");
    const isCurrent = () => guard.current.current(ticket) && contextRef.current === targetContext;
    try {
      const editor = await getMenuConfigEditor(client,directory,item.menuKey,scope);
      if (!isCurrent()) return;
      setScopeRevision(editor.scopeRevision); setHasOverride(editor.hasOverride);
      if (editor.config) { applyConfig(editor.config); configForm.setFieldValue("configScope",editor.scope); } else emptyConfig(editor.scope);
      setConfigReady(true);
    } catch (error) {
      if (!isCurrent()) return;
      setConfigError(error instanceof Error ? error.message : "读取 WebView 配置失败，请重试");
    } finally { if (isCurrent()) setConfigLoading(false); }
  }
  async function openConfig(item:MenuDirectoryEntry) { if (saveConfig.isPending) return; setConfigMenu(item); await readConfig(item); }
  async function changeConfigScope(scope:"common"|"workspace") { if (!configMenu || saveConfig.isPending) return; await readConfig(configMenu,scope); }
  type ConfigSave = { target: NonNullable<typeof configTarget.current>; input: Parameters<typeof saveMenuWebViewConfig>[3] & {expectedScopeRevision:number} };
  const saveConfig=useMutation({
    mutationFn:({target,input}:ConfigSave) => saveMenuWebViewConfig(client,target.directory,target.menuKey,input),
    onSuccess:(value,request) => { void message.success("WebView 配置已保存"); if (contextRef.current === request.target.context && guard.current.current(request.target.ticket)) { applyConfig(value); setScopeRevision(request.input.expectedScopeRevision+1); setHasOverride(true); } },
    onError:(e:Error,request) => { if (contextRef.current === request.target.context && guard.current.current(request.target.ticket)) message.error(e.message); }
  });
  function submitConfig(value:WebConfigForm) {
    const target = configTarget.current;
    if (!target || !configReady || configLoading || saveConfig.isPending || contextRef.current !== target.context || !guard.current.current(target.ticket)) return;
    try {
      saveConfig.mutate({target:{...target},input:{expectedScopeRevision:scopeRevision,configScope:value.configScope,platform:value.platform,defaultUrl:value.defaultUrl,openMode:value.openMode,navigationProtocols:value.navigationProtocols,scripts:value.scripts,styles:value.styles,scheduleMode:value.scheduleMode,expectedRevision:configValue?.configScope===value.configScope?configValue.revision:undefined}});
    } catch { void message.error("协议和资源绑定无效，请检查配置"); }
  }
  const resetConfig = useMutation({
    mutationFn:({target,revision}:{target:NonNullable<typeof configTarget.current>;revision:number})=>resetMenuWorkspaceConfig(client,target.directory,target.menuKey,revision),
    onSuccess:(_,request)=>{void message.success("已恢复继承通用配置");if(contextRef.current===request.target.context && guard.current.current(request.target.ticket) && configMenu) void readConfig(configMenu,"workspace");},
    onError:(error:Error)=>message.error(error.message)
  });
  const registeredRoutes=(query.data?.registeredRoutes??[]).filter(item=>item.directoryType===directory && item.nodeType==="leaf");
  const treeRows=useMemo(()=>{
    const all=query.data?.items??[];
    type Row=MenuDirectoryEntry & {children?:Row[]};
    const rows=new Map<string,Row>(all.map(item=>[item.menuKey,{...item}]));
    const roots:Row[]=[];
    for(const item of rows.values()) {const parent=item.parentKey?rows.get(item.parentKey):null;if(parent){parent.children??=[];parent.children.push(item);}else roots.push(item);}
    const sort=(items:Row[])=>{items.sort((a,b)=>a.sortOrder-b.sortOrder||a.menuKey.localeCompare(b.menuKey));for(const item of items)if(item.children)sort(item.children);};sort(roots);return roots;
  },[query.data]);
  const groups=useMemo(()=>new Map((query.data?.items??[]).map(item=>[item.menuKey,item.name])),[query.data]);
  const columns:ColumnsType<MenuDirectoryEntry>=[
    {title:"菜单",key:"name",render:(_,item)=><Space direction="vertical" size={0}><Typography.Text strong>{item.name}</Typography.Text><Typography.Text type="secondary">{item.menuKey}</Typography.Text></Space>},
    {title:"层级",dataIndex:"nodeType",width:100,render:(v:string)=><Tag>{v==="group"?"分组":"页面"}</Tag>},
    {title:"父级",dataIndex:"parentKey",width:180,render:(v:string|undefined)=>v?groups.get(v)??v:"—"},
    {title:"类型",dataIndex:"pageType",width:100,render:(v:string)=><Tag color={v==="webview"?"blue":"default"}>{v==="webview"?"WebView":"内部页面"}</Tag>},
    {title:"可用终端",key:"usageScope",width:130,render:(_,item)=>item.pageType==="webview"?"仅桌面客户端":"浏览器、客户端"},
    {title:"授权规则",key:"permissionCode",width:220,render:(_,item)=>item.pageType==="internal"?"按注册模块权限":Object.values(item.permissionBindings??{}).flat().join("、")||item.permissionCode},
    {title:"工作区",dataIndex:"workspaceTypes",width:160,render:(v:string[])=>v.map(value=>({platform:"平台",agency:"机构",enterprise:"企业"}[value]??value)).join("、")},
    {title:"状态",dataIndex:"status",width:90,render:(v:string)=><Tag color={v==="active"?"green":"default"}>{v==="active"?"启用":"停用"}</Tag>},
    {title:"操作",key:"actions",width:220,render:(_,item)=><Space wrap>
      <Button size="small" type="link" onClick={()=>openEdit(item)} disabled={!canManage}>编辑</Button>
      {item.pageType==="webview"?<Button size="small" type="link" onClick={()=>void openConfig(item)} disabled={!canManage}>WebView 配置</Button>:null}
      {canManage?<Popconfirm title={`确认${item.status==="active"?"停用":"启用"}该菜单？`} onConfirm={()=>status.mutate(item)}><Button size="small" type="link" loading={status.isPending}>{item.status==="active"?"停用":"启用"}</Button></Popconfirm>:null}
    </Space>}
  ];
  return <>
    <ListPageCard title="菜单管理" subtitle="维护通用管理中心与工作台菜单结构、启停和 WebView 页面配置。" toolbar={<Space wrap><Segmented value={directory} options={[{value:"management",label:"管理中心"},{value:"workbench",label:"工作台"}]} onChange={v=>setDirectory(v as MenuDirectoryType)}/>{canManage?<Button type="primary" disabled={query.isFetching||query.isError||!query.data} onClick={openCreate}>新建菜单</Button>:null}</Space>}>
      {query.isError?<Alert type="error" showIcon message="菜单目录读取失败" description="请确认数据库迁移已由部署流程执行，并检查当前权限。"/>:null}
      <Table rowKey="menuKey" columns={columns} dataSource={treeRows} loading={query.isFetching} pagination={false}/>
    </ListPageCard>
    <Drawer title={editing?"编辑菜单":"新建菜单"} width={drawerWidths.standardForm} open={entryDrawer} onClose={()=>{entrySession.current++;setEntryDrawer(false);}} extra={<Space><Button onClick={()=>{entrySession.current++;setEntryDrawer(false);}}>取消</Button><Button type="primary" loading={saveEntry.isPending} onClick={()=>form.submit()}>保存</Button></Space>}>
      <Form form={form} layout="vertical" onFinish={value=>saveEntry.mutate({value:{...value,...(value.nodeType==="group"?{pageType:"internal",routeKey:undefined,routePath:undefined,permissionCode:"",permissionBindings:{}}:value.pageType==="webview"?{routeKey:undefined,routePath:undefined,permissionCode:"",permissionBindings:Object.fromEntries((value.workspaceTypes??[]).map(type=>[type,value.permissionBindings?.[type]??[]]))}:{permissionCode:"",permissionBindings:{}})},directory,revision:editing?.revision,session:entrySession.current,context})}>
        <Form.Item label="菜单键" name="menuKey" rules={[{required:true}]}><Input disabled={!!editing}/></Form.Item>
        <Form.Item label="名称" name="name" rules={[{required:true}]}><Input maxLength={80}/></Form.Item>
        <Form.Item label="节点类型" name="nodeType" rules={[{required:true}]}><Select options={[{value:"group",label:"分组"},{value:"leaf",label:"页面"}]}/></Form.Item>
        <Form.Item label="父级菜单键" name="parentKey"><Select allowClear showSearch options={(query.data?.items??[]).filter(x=>x.nodeType==="group").map(x=>({value:x.menuKey,label:x.name}))}/></Form.Item>
        <Form.Item label="图标名" name="icon"><Input maxLength={64}/></Form.Item>
        {entryNodeType==="leaf" && entryPageType==="webview" ? entryWorkspaceTypes.map(type=><Form.Item key={type} label={`${({platform:"平台",agency:"机构",enterprise:"企业"} as Record<string,string>)[type]}菜单权限`} name={["permissionBindings",type]} rules={[{required:true,message:"请选择至少一个已有菜单权限"}]}><Select mode="multiple" loading={permissionsQuery.isFetching} showSearch optionFilterProp="label" options={(permissionsQuery.data??[]).filter(item=>item.workspaceTypes.includes(type)).map(item=>({value:item.code,label:`${item.name} · ${item.code}`}))}/></Form.Item>) : null}
        <Form.Item label="适用工作区" name="workspaceTypes" rules={[{required:true}]}><Select mode="multiple" options={[{value:"platform",label:"平台"},{value:"agency",label:"机构"},{value:"enterprise",label:"企业"}]}/></Form.Item>
        <Form.Item label="页面类型" name="pageType"><Select options={[{value:"internal",label:"内部页面"},{value:"webview",label:"WebView"}]}/></Form.Item>
        <Form.Item label="内部路由键" name="routeKey"><Select allowClear showSearch optionFilterProp="label" options={registeredRoutes.map(item=>({value:item.routeKey!,label:`${item.name} · ${item.routeKey}`}))}/></Form.Item>
        <Form.Item label="排序" name="sortOrder"><InputNumber min={-100000} max={100000} style={{width:"100%"}}/></Form.Item>
        <Form.Item label="状态" name="status"><Select options={[{value:"active",label:"启用"},{value:"disabled",label:"停用"}]}/></Form.Item>
        <Typography.Text type="secondary">WebView 页面仅支持桌面客户端。菜单配置单独保存 URL、协议、资源版本引用和调度模式；不接收 Cookie、Token 或代理凭据。</Typography.Text>
      </Form>
    </Drawer>
    <Drawer title={`WebView 配置${configMenu?`：${configMenu.name}`:""}`} width={drawerWidths.standardForm} open={!!configMenu} onClose={closeConfig} extra={<Space><Button onClick={closeConfig}>关闭</Button><Button type="primary" loading={saveConfig.isPending} disabled={!configReady || configLoading || resetConfig.isPending} onClick={()=>configForm.submit()}>保存</Button></Space>}>
      {configError ? <Alert type="error" showIcon message={configError} action={<Button onClick={()=>configMenu && void readConfig(configMenu,configForm.getFieldValue("configScope"))}>重试</Button>}/> : null}
      <Form form={configForm} layout="vertical" disabled={configLoading || saveConfig.isPending || resetConfig.isPending || !configReady} onFinish={submitConfig}>
        <Form.Item label="配置范围" name="configScope" rules={[{required:true}]}><Select disabled={configLoading || saveConfig.isPending} onChange={(value)=>void changeConfigScope(value)} options={[{value:"common",label:"通用配置"},{value:"workspace",label:"当前工作区覆盖"}]}/></Form.Item>
        <Form.Item label="脚本资源平台" name="platform" rules={[{required:true,pattern:/^[a-z0-9][a-z0-9_-]{0,31}$/}]}><Input maxLength={32} placeholder="例如 web 或 douyin"/></Form.Item>
        {hasOverride && configForm.getFieldValue("configScope")==="workspace" ? <Popconfirm title="解除当前工作区覆盖，恢复继承通用配置？" onConfirm={()=>configTarget.current && resetConfig.mutate({target:{...configTarget.current},revision:scopeRevision})}><Button loading={resetConfig.isPending} disabled={saveConfig.isPending || configLoading} style={{marginBottom:12}}>恢复继承</Button></Popconfirm> : null}
        {configValue?.inherited?<Alert type="info" showIcon message="当前工作区继承通用配置" style={{marginBottom:12}}/>:null}
        <Form.Item label="默认 URL" name="defaultUrl" rules={[{required:true},{pattern:/^https?:\/\//i,message:"请输入 HTTP 或 HTTPS 地址"}]}><Input/></Form.Item>
        <Form.Item label="打开方式" name="openMode"><Select options={[{value:"embedded",label:"嵌入工作区"},{value:"window",label:"独立窗口"}]}/></Form.Item>
        <Form.Item label="允许的导航协议" name="navigationProtocols" rules={[{required:true}]}><Select mode="multiple" options={[{value:"https",label:"HTTPS（加密）"},{value:"http",label:"HTTP"}]}/></Form.Item>
        <Form.Item label="脚本资源" name="scripts" rules={[{validator:(_,refs:MenuWebViewConfig["scripts"]=[])=>refs.some(ref=>ref.versionPolicy==="pinned"&&(!ref.versionId||!ref.version))?Promise.reject(new Error("请选择固定版本")):Promise.resolve()}]}><MenuResourcePicker platform={resourcePlatform} assetType="script"/></Form.Item>
        <Form.Item label="样式资源" name="styles" rules={[{validator:(_,refs:MenuWebViewConfig["styles"]=[])=>refs.some(ref=>ref.versionPolicy==="pinned"&&(!ref.versionId||!ref.version))?Promise.reject(new Error("请选择固定版本")):Promise.resolve()}]}><MenuResourcePicker platform={resourcePlatform} assetType="style"/></Form.Item>
        <Form.Item label="调度策略" name="scheduleMode"><Select options={[{value:"page_first",label:"页面优先"},{value:"strict_document_start",label:"严格 document_start"}]}/></Form.Item>
      </Form>
      <Alert type="warning" showIcon message="配置只保存菜单 URL 与资源版本引用；运行时仍须由服务端核验菜单权限、工作区、启停和资源版本。页面跳转默认限制为相同来源。"/>
    </Drawer>
  </>;
}
