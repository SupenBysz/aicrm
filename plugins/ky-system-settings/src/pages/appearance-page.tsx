import { useEffect, useState, type CSSProperties } from "react";
import { Alert, App, Button, Card, Empty, Space } from "antd";
import { AppearanceControls, DEFAULT_APPEARANCE, ListPageCard, themeColors, themeVariables, useAppearance, useCurrentUser, validAppearance, usePermissions, useRequestClient, type AppearanceValue, type AppearanceMode, type ThemeId } from "@ky/admin-core";

/** Platform defaults only. Personal choices live in the account menu. */
export function AppearancePage() {
  const appearance=useAppearance();const client=useRequestClient();const permission=usePermissions();
  const {message,modal}=App.useApp();const user=useCurrentUser();
  const draftKey="ky.appearance.platform-draft.v1:"+(user?.id??"anonymous");
  const [initial]=useState(()=>{try{const value=JSON.parse(sessionStorage.getItem(draftKey)??"null");return validAppearance(value)?value:null}catch{return null}});
  const [draft,setDraft]=useState<AppearanceValue>(initial??appearance.platform);
  const [edited,setEdited]=useState(!!initial);const [saving,setSaving]=useState(false);const [error,setError]=useState("");
  const canUpdate=permission.can("platform.appearance.update");
  useEffect(()=>{if(!edited)setDraft(appearance.platform)},[appearance.platform,edited]);
  useEffect(()=>{
    try{if(edited)sessionStorage.setItem(draftKey,JSON.stringify(draft));else sessionStorage.removeItem(draftKey)}catch{/* In-memory draft remains available. */}
    const guard=(event:BeforeUnloadEvent)=>{if(edited){event.preventDefault();event.returnValue=""}};
    window.addEventListener("beforeunload",guard);return()=>window.removeEventListener("beforeunload",guard);
  },[draftKey,draft,edited]);
  async function save(){
    if(!canUpdate||saving)return;setSaving(true);setError("");
    try{const saved=await client.request<AppearanceValue>("/api/v1/platform/appearance",{method:"PUT",body:draft});await appearance.reloadPlatform(saved);setDraft(saved);setEdited(false);void message.success("平台默认外观已保存");}
    catch{setError("保存失败，可能已被其他管理员更新。草稿已保留，请重新读取后重试。");}
    finally{setSaving(false)}
  }
  async function reload(){
    if(saving)return;
    setSaving(true);
    try{const latest=await client.request<AppearanceValue>("/api/v1/platform/appearance");setDraft(latest);setEdited(false);setError("");await appearance.reloadPlatform(latest)}
    catch{setError("重新读取失败，当前草稿已保留")}
    finally{setSaving(false)}
  }
  if(!permission.can("platform.appearance.view"))return <Empty description="暂无平台外观查看权限"/>;
  if(!appearance.enabled)return <Alert type="info" title="外观主题已临时停用，当前使用经典金并跟随系统。"/>;
  return <ListPageCard title="外观主题" subtitle="维护平台默认配色与明暗模式；本人外观请在用户菜单的个人偏好中设置。">
    <Card title="平台默认"><Space orientation="vertical" size={16} style={{width:"100%"}}>
      <Alert type="info" showIcon title="仅影响跟随平台默认的用户及未登录页面；个人覆盖保持不变。其他在线用户在重新聚焦或重新登录时更新。"/>
      <AppearanceControls label="平台默认" disabled={!canUpdate||saving} themeId={(draft.themeId||"classic-gold") as ThemeId} mode={(draft.mode||"system") as AppearanceMode} onChange={(themeId,mode)=>{setDraft({...draft,themeId,mode});setEdited(true)}}/>
      <div style={{display:"flex",flexWrap:"wrap",gap:16}}>{[false,true].map(dark=>{
        const colors=themeColors(draft.themeId,dark);
        return <div key={String(dark)} style={{...themeVariables(draft.themeId,dark),background:colors.bg,color:colors.text,padding:16,borderRadius:10,minWidth:0,maxWidth:"100%",flex:"1 1 240px"} as CSSProperties}>
          <strong>{dark?"暗色预览":"亮色预览"}</strong>
          <div style={{display:"flex",marginTop:12,border:`1px solid ${colors.primary}`,borderRadius:6,overflow:"hidden"}}><div style={{background:colors.nav,padding:12,color:colors.primary}}>导航</div><div style={{background:colors.surface,padding:12,flex:1}}>页面内容 <span style={{color:colors.primary}}>主要操作</span></div></div>
        </div>;
      })}</div>
      {error&&<Alert type="error" showIcon title={error}/>}
      <Space wrap>{canUpdate&&<><Button type="primary" loading={saving} disabled={!edited} onClick={()=>void save()}>保存平台默认</Button><Button disabled={saving} onClick={()=>{setDraft({...DEFAULT_APPEARANCE,revision:draft.revision});setEdited(true)}}>恢复出厂配置（待保存）</Button></>}
        <Button disabled={saving} onClick={()=>edited?modal.confirm({title:"重新读取平台默认？",content:"这会替换当前未保存的平台配置草稿。",okText:"重新读取",cancelText:"保留草稿",onOk:reload}):void reload()}>重新读取平台默认</Button>
      </Space>
    </Space></Card>
  </ListPageCard>;
}
