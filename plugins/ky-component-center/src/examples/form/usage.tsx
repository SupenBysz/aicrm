import { Form, Input, Button, Alert } from "antd";
import { useState } from "react";
export default function Example({ label = "表单", disabled = false }: { label?: string; disabled?: boolean } = {}) {
const [saved,setSaved]=useState(false); return <Form layout="vertical" onFinish={()=>setSaved(true)}><Form.Item label="名称" name="name" rules={[{required:true,message:"请输入名称"}]}><Input disabled={disabled} placeholder={label}/></Form.Item><Button type="primary" htmlType="submit" disabled={disabled}>校验并模拟保存</Button>{saved && <Alert style={{marginTop:12}} title="模拟保存成功，没有发送请求" type="success"/>}</Form>;
}
