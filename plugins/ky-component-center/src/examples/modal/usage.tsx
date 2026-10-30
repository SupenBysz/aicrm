import { Modal, Button } from "antd";
import { useState } from "react";
export default function Example({ label = "确认弹窗", disabled = false }: { label?: string; disabled?: boolean } = {}) {
const [open,setOpen]=useState(false);return <><Button onClick={()=>setOpen(true)} disabled={disabled}>打开确认弹窗</Button><Modal title={label} open={open} getContainer={false} onCancel={()=>setOpen(false)} onOk={()=>setOpen(false)}><p>确定只关闭示例弹窗，不执行真实操作。</p></Modal></>;
}
