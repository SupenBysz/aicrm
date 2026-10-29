import { useLayoutEffect, useState } from "react";
import { Alert, App, Button, Drawer, Space, Spin, Switch, Tooltip, Typography } from "antd";
import { AppearanceControls, drawerWidths, useAppearance } from "@ky/admin-core";

/** Account settings live in the root provider; this view owns visibility only. */
export function PersonalPreferencesDrawer({open,onClose}:{open:boolean;onClose:()=>void}) {
  const appearance=useAppearance();
  const {modal}=App.useApp();
  const [bounds,setBounds]=useState({top:0,bottom:0});
  useLayoutEffect(()=>{
    if(!open)return;
    const header=document.querySelector(".app-header");
    const footer=document.querySelector(".desktop-status-bar");
    const measure=()=>{
      const height=window.innerHeight;
      const top=Math.min(height,Math.max(0,header?.getBoundingClientRect().bottom??0));
      const bottom=footer?Math.min(height-top,Math.max(0,height-footer.getBoundingClientRect().top)):0;
      setBounds({top,bottom});
    };
    const observer=new ResizeObserver(measure);
    if(header)observer.observe(header);if(footer)observer.observe(footer);
    measure();window.addEventListener("resize",measure);window.visualViewport?.addEventListener("resize",measure);
    return()=>{observer.disconnect();window.removeEventListener("resize",measure);window.visualViewport?.removeEventListener("resize",measure);};
  },[open]);
  const following=appearance.preference.source==="platform";
  const busy=appearance.loading||appearance.syncState==="reading";
  function reload(){
    if(!appearance.canReload)return;
    if(appearance.dirty){modal.confirm({title:"重新读取服务器设置？",content:"这会替换本机尚未同步的外观选择。",okText:"重新读取",cancelText:"保留本机选择",onOk:()=>appearance.refresh()});}
    else void appearance.refresh();
  }
  return <Drawer title="个人偏好" open={open} onClose={onClose} width={drawerWidths.standardForm}
    rootClassName="personal-preferences-drawer" rootStyle={{top:bounds.top,bottom:bounds.bottom,height:"auto"}}
    styles={{section:{height:"100%",display:"flex",flexDirection:"column",minHeight:0},header:{flexShrink:0},body:{flex:1,minHeight:0,overflowY:"auto"}}}>
    {!appearance.enabled?<Alert type="info" showIcon title="外观主题已临时停用" description="当前使用经典金并跟随系统，已保存的个人偏好会保留。"/>:
    <Space orientation="vertical" size={24} style={{width:"100%"}}>
      <div><Typography.Title level={5} style={{marginTop:0}}>外观</Typography.Title><Typography.Paragraph type="secondary">只影响当前账号。选择后立即生效并自动保存，关闭窗口不会撤销修改。</Typography.Paragraph></div>
      {appearance.loading&&<Space role="status"><Spin size="small"/><Typography.Text>正在读取个人偏好…</Typography.Text></Space>}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:16}}>
        <Typography.Text strong>使用平台默认</Typography.Text>
        <Switch aria-label="使用平台默认" checked={following} disabled={busy} onChange={checked=>checked?appearance.followPlatform():appearance.choose(appearance.themeId,appearance.mode)}/>
      </div>
      <Typography.Text type="secondary">{following?"当前跟随平台默认。关闭后可自定义配色与明暗模式。":appearance.origin==="legacy"?"沿用本机旧版外观，尚未设为账号偏好。":"当前使用个人设置，不随平台默认变更。"}</Typography.Text>
      <AppearanceControls label="个人偏好" themeId={appearance.themeId} mode={appearance.mode} onChange={appearance.choose} disabled={following||busy}/>
      <div role="status" aria-live="polite"><Typography.Text>{appearance.status||(!appearance.loading?"已读取个人偏好":"")}</Typography.Text></div>
      <Space wrap>
        {appearance.dirty&&<Button disabled={busy||appearance.syncState==="saving"} onClick={appearance.retry}>重试同步</Button>}
        <Tooltip title={!appearance.canReload?"请等待同步完成，或先重试确认上次保存结果":undefined}><Button disabled={!appearance.canReload} onClick={reload}>重新读取服务器设置</Button></Tooltip>
      </Space>
    </Space>}
  </Drawer>;
}
