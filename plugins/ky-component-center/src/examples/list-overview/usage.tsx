import { ListOverview, type ListOverviewResult } from "@ky/admin-core";
import { useState } from "react";
export default function Example({ label = "列表概览", disabled = false, count = 12, state = "default" }: { label?: string; disabled?: boolean; count?: number; state?: string } = {}) {
const [selected,setSelected]=useState("total");const data:ListOverviewResult={schemaVersion:1,total:count,asOf:"2026-01-01T00:00:00Z",scope:{basis:"search_without_status",ignoredFilters:["status"],filters:{},timezone:"Asia/Shanghai",start:null,end:null},metrics:[{key:"normal",count:Math.max(0,count-2)},{key:"disabled",count:Math.min(count,2)},...(state==="unknown"?[{key:"unclassified",count:1}]:[])]};
const error=state==="forbidden"?{status:403}:state==="error"?new Error("模拟统计失败"):undefined;
return <ListOverview title={label} data={state==="loading"?undefined:data} loading={state==="loading"||state==="refreshing"} error={error} onRetry={()=>setSelected("total")} selectedKey={selected} onSelect={setSelected} metrics={[{key:"total",label:"总数"},{key:"normal",label:"正常"},{key:"disabled",label:"已停用",tone:"warning"}]} />;
}
