import { Table } from "antd";
export default function Example({ count = 12, state = "default" }: { count?: number; state?: string } = {}) {
return <Table rowKey="id" size="small" loading={state === "loading"} dataSource={state === "empty" ? [] : Array.from({length:count},(_,i)=>({id:i,name:`演示项目 ${i+1}`,status:i%2?"已停用":"正常"}))} columns={[{title:"名称",dataIndex:"name"},{title:"状态",dataIndex:"status"}]} pagination={{pageSize:5}} scroll={{x:320}} />;
}
