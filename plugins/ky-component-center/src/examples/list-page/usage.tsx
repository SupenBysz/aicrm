import { ListPageCard } from "@ky/admin-core";
import { Button, Input, Table } from "antd";
export default function Example({ label = "列表页面", disabled = false }: { label?: string; disabled?: boolean } = {}) {
return <ListPageCard title={label} subtitle="页面标题在卡片外，搜索在toolbar，新增在页面右侧。" extra={<Button type="primary" disabled={disabled}>新增</Button>} toolbar={<Input.Search placeholder="搜索示例"/>}><Table rowKey="id" columns={[{title:"名称",dataIndex:"name"}]} dataSource={[{id:1,name:"演示记录"}]} pagination={false}/></ListPageCard>;
}
