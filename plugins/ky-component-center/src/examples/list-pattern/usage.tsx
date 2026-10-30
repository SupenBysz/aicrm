import { ListPageCard, ListOverview, readListQueryState, writeListQueryState, type ListOverviewResult } from "@ky/admin-core";
import { Input, Table } from "antd";
import { useSearchParams } from "react-router-dom";
import { useState } from "react";
export default function Example({ label = "搜索＋概览＋表格", disabled = false, count = 12 }: { label?: string; disabled?: boolean; count?: number } = {}) {
const [params,setParams]=useSearchParams();const q=readListQueryState(params),[keyword,setKeyword]=useState("");const rows=[{id:1,name:"示例甲",status:"normal"},{id:2,name:"示例乙",status:"disabled"}].filter(r=>r.name.includes(q.keyword||""));
const data:ListOverviewResult={schemaVersion:1,total:rows.length,asOf:"2026-01-01T00:00:00Z",scope:{basis:"search_without_status",ignoredFilters:["status"],filters:{keyword:q.keyword||""},timezone:"Asia/Shanghai",start:null,end:null},metrics:[{key:"normal",count:rows.filter(r=>r.status==="normal").length},{key:"disabled",count:rows.filter(r=>r.status==="disabled").length}]};
const select=(key:string)=>setParams(writeListQueryState({...q,page:1,status:key==="total"?undefined:key}));
return <ListPageCard title={label} toolbar={<Input.Search value={keyword} onChange={e=>setKeyword(e.target.value)} onSearch={()=>setParams(writeListQueryState({...q,page:1,keyword}))} placeholder="搜索后统计授权集合"/>} overview={<ListOverview data={data} loading={false} onRetry={()=>{}} selectedKey={q.status||"total"} onSelect={select} metrics={[{key:"total",label:"全部"},{key:"normal",label:"正常"},{key:"disabled",label:"已停用"}]}/>}><Table rowKey="id" columns={[{title:"名称",dataIndex:"name"},{title:"状态",dataIndex:"status"}]} dataSource={rows.filter(r=>!q.status||r.status===q.status)} pagination={false}/><p>本例的Router属于独立预览，筛选不改变后台URL。</p></ListPageCard>;
}
