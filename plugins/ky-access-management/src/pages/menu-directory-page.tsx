import { useMemo, useState } from "react";
import { Alert, Button, Drawer, Form, Input, InputNumber, Popconfirm, Select, Segmented, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, drawerWidths, useCurrentWorkspace, usePermissions, useRequestClient } from "@ky/admin-core";
import { listPermissions, listMenuDirectory, saveMenuDirectoryEntry, updateMenuDirectoryStatus, getMenuWebViewConfig, saveMenuWebViewConfig, type MenuDirectoryEntry, type MenuDirectoryType, type MenuWebViewConfig } from "../api";

type EntryForm = Partial<MenuDirectoryEntry>;
type WebConfigForm = { configScope:"common"|"workspace"; platform:string; defaultUrl:string; openMode:"embedded"|"window"; navigationProtocolsText:string; scriptsText:string; stylesText:string; scheduleMode:"page_first"|"strict_document_start" };

export function MenuDirectoryPage() {
  const client=useRequestClient();const workspace=useCurrentWorkspace();const permission=usePermissions();const queryClient=useQueryClient();
  const [directory,setDirectory]=useState<MenuDirectoryType>("management");const [entryDrawer,setEntryDrawer]=useState(false);const [editing,setEditing]=useState<MenuDirectoryEntry|null>(null);const [form]=Form.useForm<EntryForm>();
  const [configMenu,setConfigMenu]=useState<MenuDirectoryEntry|null>(null);const [configValue,setConfigValue]=useState<MenuWebViewConfig|null>(null);const [configForm]=Form.useForm<WebConfigForm>();
  const canManage=permission.canAny(["platform.menu_catalog.manage"]);const queryKey=["menu-directory",directory,workspace?.type,workspace?.id];
  const query=useQuery({queryKey,enabled:!!workspace,queryFn:()=>listMenuDirectory(client,directory,canManage)});
  const permissionsQuery=useQuery({queryKey:["permissions","catalog","menu",workspace?.type],enabled:!!workspace,queryFn:()=>listPermissions(client,{workspaceType:workspace?.type,category:"menu"})});
  const invalidate=()=>queryClient.invalidateQueries({queryKey:["menu-directory"]});
  const saveEntry=useMutation({mutationFn:(value:EntryForm)=>saveMenuDirectoryEntry(client,directory,String(value.menuKey??editing?.menuKey??""),{...value,directoryType:directory,expectedRevision:editing?.revision}),onSuccess:()=>{void message.success("菜单目录已保存");setEntryDrawer(false);setEditing(null);invalidate();},onError:(e:Error)=>message.error(e.message)});
  const status=useMutation({mutationFn:(item:MenuDirectoryEntry)=>updateMenuDirectoryStatus(client,directory,item.menuKey,item.status==="active"?"disabled":"active",item.revision),onSuccess:()=>{void message.success("菜单状态已更新");invalidate();},onError:(e:Error)=>message.error(e.message)});
  const openCreate=()=>{setEditing(null);form.resetFields();form.setFieldsValue({directoryType:directory,nodeType:"leaf",pageType:"internal",status:"active",sortOrder:0,workspaceTypes:[workspace?.type??"platform"]});setEntryDrawer(true);};
  const openEdit=(item:MenuDirectoryEntry)=>{setEditing(item);form.setFieldsValue(item);setEntryDrawer(true);};
  function applyConfig(value:MenuWebViewConfig){setConfigValue(value);configForm.setFieldsValue({configScope:value.configScope,platform:value.platform,defaultUrl:value.defaultUrl,openMode:value.openMode,navigationProtocolsText:JSON.stringify(value.navigationProtocols,null,2),scriptsText:JSON.stringify(value.scripts,null,2),stylesText:JSON.stringify(value.styles,null,2),scheduleMode:value.scheduleMode});}
  async function openConfig(item:MenuDirectoryEntry){setConfigMenu(item);try{const value=await getMenuWebViewConfig(client,directory,item.menuKey);applyConfig(value);}catch(error){setConfigValue(null);configForm.setFieldsValue({configScope:"workspace",platform:"web",defaultUrl:"",openMode:"embedded",navigationProtocolsText:'["https"]',scriptsText:"[]",stylesText:"[]",scheduleMode:"page_first"});if((error as {code?:string})?.code!=="not_found")message.error(error instanceof Error?error.message:"读取 WebView 配置失败");}}
  async function changeConfigScope(scope:"common"|"workspace"){configForm.setFieldValue("configScope",scope);if(!configMenu)return;try{const value=await getMenuWebViewConfig(client,directory,configMenu.menuKey,scope);applyConfig(value);}catch(error){setConfigValue(null);if((error as {code?:string})?.code!=="not_found")message.error(error instanceof Error?error.message:"读取 WebView 配置失败");}}
  const saveConfig=useMutation({mutationFn:(value:WebConfigForm)=>saveMenuWebViewConfig(client,directory,configMenu!.menuKey,{configScope:value.configScope,platform:value.platform,defaultUrl:value.defaultUrl,openMode:value.openMode,navigationProtocols:JSON.parse(value.navigationProtocolsText),scripts:JSON.parse(value.scriptsText),styles:JSON.parse(value.stylesText),scheduleMode:value.scheduleMode,expectedRevision:configValue?.configScope===value.configScope?configValue.revision:undefined}),onSuccess:(value)=>{setConfigValue(value);void message.success("WebView 配置已保存");},onError:(e:Error)=>message.error(e.message)});
  const groups=useMemo(()=>new Map((query.data?.items??[]).map(item=>[item.menuKey,item.name])),[query.data]);
  const columns:ColumnsType<MenuDirectoryEntry>=[
    {title:"菜单",key:"name",render:(_,item)=><Space direction="vertical" size={0}><Typography.Text strong>{item.name}</Typography.Text><Typography.Text type="secondary">{item.menuKey}</Typography.Text></Space>},
    {title:"层级",dataIndex:"nodeType",width:100,render:(v:string)=><Tag>{v==="group"?"分组":"页面"}</Tag>},
    {title:"父级",dataIndex:"parentKey",width:180,render:(v:string|undefined)=>v?groups.get(v)??v:"—"},
    {title:"类型",dataIndex:"pageType",width:100,render:(v:string)=><Tag color={v==="webview"?"blue":"default"}>{v==="webview"?"WebView":"内部页面"}</Tag>},
    {title:"授权键",dataIndex:"permissionCode",width:220},
    {title:"工作区",dataIndex:"workspaceTypes",width:160,render:(v:string[])=>v.join("、")},
    {title:"状态",dataIndex:"status",width:90,render:(v:string)=><Tag color={v==="active"?"green":"default"}>{v==="active"?"启用":"停用"}</Tag>},
    {title:"操作",key:"actions",width:220,render:(_,item)=><Space wrap>
      <Button size="small" type="link" onClick={()=>openEdit(item)} disabled={!canManage}>编辑</Button>
      {item.pageType==="webview"?<Button size="small" type="link" onClick={()=>void openConfig(item)} disabled={!canManage}>WebView 配置</Button>:null}
      {canManage?<Popconfirm title={`确认${item.status==="active"?"停用":"启用"}该菜单？`} onConfirm={()=>status.mutate(item)}><Button size="small" type="link" loading={status.isPending}>{item.status==="active"?"停用":"启用"}</Button></Popconfirm>:null}
    </Space>}
  ];
  return <>
    <ListPageCard title="菜单目录" subtitle="维护通用管理中心与工作台菜单结构、启停和 WebView 页面配置。" toolbar={<Space wrap><Segmented value={directory} options={[{value:"management",label:"管理中心"},{value:"workbench",label:"工作台"}]} onChange={v=>setDirectory(v as MenuDirectoryType)}/>{canManage?<Button type="primary" onClick={openCreate}>新建菜单</Button>:null}</Space>}>
      {query.isError?<Alert type="error" showIcon message="菜单目录读取失败" description="请确认数据库迁移已由部署流程执行，并检查当前权限。"/>:null}
      <Table rowKey="menuKey" columns={columns} dataSource={query.data?.items??[]} loading={query.isFetching} pagination={false}/>
    </ListPageCard>
    <Drawer title={editing?"编辑菜单":"新建菜单"} width={drawerWidths.standardForm} open={entryDrawer} onClose={()=>setEntryDrawer(false)} extra={<Space><Button onClick={()=>setEntryDrawer(false)}>取消</Button><Button type="primary" loading={saveEntry.isPending} onClick={()=>form.submit()}>保存</Button></Space>}>
      <Form form={form} layout="vertical" onFinish={value=>saveEntry.mutate(value)}>
        <Form.Item label="菜单键" name="menuKey" rules={[{required:true}]}><Input disabled={!!editing}/></Form.Item>
        <Form.Item label="名称" name="name" rules={[{required:true}]}><Input maxLength={80}/></Form.Item>
        <Form.Item label="节点类型" name="nodeType" rules={[{required:true}]}><Select options={[{value:"group",label:"分组"},{value:"leaf",label:"页面"}]}/></Form.Item>
        <Form.Item label="父级菜单键" name="parentKey"><Select allowClear showSearch options={(query.data?.items??[]).filter(x=>x.nodeType==="group").map(x=>({value:x.menuKey,label:x.name}))}/></Form.Item>
        <Form.Item label="图标名" name="icon"><Input maxLength={64}/></Form.Item>
        <Form.Item label="菜单权限键（需已存在于菜单权限目录）" name="permissionCode" rules={[{required:true}]}><Select showSearch options={(permissionsQuery.data??[]).map(item=>({value:item.code,label:`${item.name} · ${item.code}`}))}/></Form.Item>
        <Form.Item label="适用工作区" name="workspaceTypes" rules={[{required:true}]}><Select mode="multiple" options={[{value:"platform",label:"平台"},{value:"agency",label:"机构"},{value:"enterprise",label:"企业"}]}/></Form.Item>
        <Form.Item label="页面类型" name="pageType"><Select options={[{value:"internal",label:"内部页面"},{value:"webview",label:"WebView"}]}/></Form.Item>
        <Form.Item label="内部路由键" name="routeKey"><Input placeholder="例如 access.roles"/></Form.Item>
        <Form.Item label="排序" name="sortOrder"><InputNumber min={-100000} max={100000} style={{width:"100%"}}/></Form.Item>
        <Form.Item label="状态" name="status"><Select options={[{value:"active",label:"启用"},{value:"disabled",label:"停用"}]}/></Form.Item>
        <Typography.Text type="secondary">WebView 菜单配置单独保存 URL、协议、资源版本引用和调度模式；不接收 Cookie、Token 或代理凭据。</Typography.Text>
      </Form>
    </Drawer>
    <Drawer title={`WebView 配置${configMenu?`：${configMenu.name}`:""}`} width={drawerWidths.standardForm} open={!!configMenu} onClose={()=>setConfigMenu(null)} extra={<Space><Button onClick={()=>setConfigMenu(null)}>关闭</Button><Button type="primary" loading={saveConfig.isPending} onClick={()=>configForm.submit()}>保存</Button></Space>}>
      <Form form={configForm} layout="vertical" onFinish={value=>saveConfig.mutate(value)}>
        <Form.Item label="配置范围" name="configScope" rules={[{required:true}]}><Select onChange={(value)=>void changeConfigScope(value)} options={[{value:"common",label:"通用配置"},{value:"workspace",label:"当前工作区覆盖"}]}/></Form.Item>
        <Form.Item label="脚本资源平台" name="platform" rules={[{required:true,pattern:/^[a-z0-9][a-z0-9_-]{0,31}$/}]}><Input maxLength={32} placeholder="例如 web 或 douyin"/></Form.Item>
        {configValue?.inherited?<Alert type="info" showIcon message="当前工作区继承通用配置" style={{marginBottom:12}}/>:null}
        <Form.Item label="默认 URL" name="defaultUrl" rules={[{required:true}]}><Input/></Form.Item>
        <Form.Item label="打开方式" name="openMode"><Select options={[{value:"embedded",label:"嵌入工作区"},{value:"window",label:"独立窗口"}]}/></Form.Item>
        <Form.Item label="允许的导航协议（JSON 数组，仅 http/https）" name="navigationProtocolsText"><Input.TextArea rows={2}/></Form.Item>
        <Form.Item label="脚本绑定（JSON，固定版本或最新已发布）" name="scriptsText"><Input.TextArea rows={5}/></Form.Item>
        <Form.Item label="样式绑定（JSON，固定版本或最新已发布）" name="stylesText"><Input.TextArea rows={5}/></Form.Item>
        <Form.Item label="调度策略" name="scheduleMode"><Select options={[{value:"page_first",label:"页面优先"},{value:"strict_document_start",label:"严格 document_start"}]}/></Form.Item>
      </Form>
      <Alert type="warning" showIcon message="配置只保存菜单 URL 与资源版本引用；运行时仍须由服务端核验菜单权限、工作区、启停和资源版本。页面跳转默认限制为相同来源。"/>
    </Drawer>
  </>;
}
