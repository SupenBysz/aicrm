import { Drawer, Button, Form, Input, Space, Alert } from "antd";
import { useEffect, useState } from "react";
import { drawerWidths } from "@ky/admin-core";
export default function Example({ label = "抽屉布局", disabled = false }: { label?: string; disabled?: boolean } = {}) {
const [open,setOpen]=useState(false),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false); const [form]=Form.useForm();
useEffect(()=>{if(!saving)return;const timer=setTimeout(()=>{setSaving(false);setOpen(false);setSaved(true)},700);return ()=>clearTimeout(timer)},[saving]);
return <section style={{position:"relative",height:520,overflow:"hidden",border:"1px solid var(--admin-stroke)",borderRadius:12}}>
<header style={{height:64,display:"flex",alignItems:"center",paddingInline:16,background:"var(--admin-surface-soft)"}}>模拟主窗口 Header（64px）</header>
<div style={{padding:16}}><Button onClick={()=>{setSaved(false);setOpen(true)}}>打开标准布局抽屉</Button>{saved && <Alert title="已在示例内模拟保存" type="success"/>}</div>
<Drawer title={<span title={label} style={{display:"block",maxWidth:"min(180px, 20vw)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</span>} open={open} onClose={()=>!saving&&setOpen(false)} width={drawerWidths.standardForm} getContainer={false} rootStyle={{position:"absolute",inset:"64px 0 0"}} styles={{body:{overflow:"auto",minHeight:0},header:{flexShrink:0}}} footer={null} extra={<Space><Button disabled={saving} onClick={()=>setOpen(false)}>取消</Button><Button type="primary" loading={saving} disabled={disabled} onClick={()=>form.submit()}>保存</Button></Space>}>
<Form form={form} layout="vertical" onFinish={()=>setSaving(true)}><Form.Item name="name" label="名称" rules={[{required:true,message:"请输入名称"}]}><Input/></Form.Item>{Array.from({length:24},(_,i)=><p key={i}>正文第 {i+1} 行：滚动时顶部标题和操作保持可见。</p>)}</Form></Drawer></section>;
}
