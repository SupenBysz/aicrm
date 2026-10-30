import { PermissionContextProvider, usePermissions } from "@ky/admin-core";
import { Button, Space, Alert } from "antd";
export default function Example({ disabled = false, state = "default" }: { disabled?: boolean; state?: string } = {}) {
function Actions(){const permissions=usePermissions();return <Space><Button disabled={!permissions.canAction("demo.save")}>保存（无权限禁用）</Button>{permissions.canAction("demo.delete")&&<Button danger>删除</Button>}</Space>}
return <PermissionContextProvider value={{permissions:[],actionPermissions:state==="allowed"?["demo.save","demo.delete"]:[]}}><Actions/><Alert style={{marginTop:12}} title="示例权限只影响当前预览，不修改真实角色。前端隐藏不能替代后端鉴权。" type="info"/></PermissionContextProvider>;
}
