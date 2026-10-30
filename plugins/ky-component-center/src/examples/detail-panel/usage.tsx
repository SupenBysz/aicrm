import { DetailPagePanel } from "@ky/admin-core";
import { Descriptions, Button } from "antd";
export default function Example({ label = "详情面板", disabled = false }: { label?: string; disabled?: boolean } = {}) {
return <DetailPagePanel title={label} extra={<Button disabled={disabled}>编辑</Button>}><Descriptions column={1} items={[{key:"name",label:"名称",children:"虚构示例"},{key:"status",label:"状态",children:"正常"}]}/></DetailPagePanel>;
}
