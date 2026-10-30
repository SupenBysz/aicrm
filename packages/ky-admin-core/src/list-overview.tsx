import { Alert, Button, Skeleton, Tooltip, Typography } from "antd";
import type { CSSProperties } from "react";
import { useCurrentUser } from "./user-context";
import { useCurrentWorkspace } from "./workspace-context";

export interface ListOverviewResult {
  schemaVersion: 1;
  total: number;
  asOf: string;
  scope: { basis: "search_without_status"; ignoredFilters: string[]; filters: Record<string,string>; timezone: string; start: string|null; end: string|null };
  metrics: Array<{key:string;count:number}>;
}
export interface OverviewMetricDefinition {key:string;label:string;description?:string;tone?:"danger"|"warning";interactive?:boolean}
/** No token is part of the key. Authorization changes create a new empty query. */
export function useOverviewIdentity(): string | null {
  const user=useCurrentUser(),workspace=useCurrentWorkspace();
  if(!user||!workspace)return null;
  return JSON.stringify([user.id,workspace.type,workspace.id,workspace.membershipId,workspace.permissions,workspace.actionPermissions,workspace.dataScopes]);
}
export function ListOverview({data,loading,error,onRetry,metrics,selectedKey,onSelect,title="列表概览",description}: {
 data?:ListOverviewResult;loading:boolean;error?:unknown;onRetry:()=>void;metrics:OverviewMetricDefinition[];
 selectedKey?:string;onSelect?:(key:string)=>void;title?:string;description?:string;
}) {
 const status=(error as {status?:number}|undefined)?.status;
 const usable=(status===401||status===403)?undefined:data;
 const stale=!!error&&!!usable;
 const count=(key:string)=>key==="total"?usable?.total:usable?.metrics.find(m=>m.key===key)?.count;
 const time=usable?.asOf&&new Date(usable.asOf);
 const stamp=time&&Number.isFinite(time.getTime())?new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",dateStyle:"short",timeStyle:"medium"}).format(time):undefined;
 const style:CSSProperties={padding:12,borderBottom:"1px solid var(--admin-divider)",background:"var(--admin-content-bg)"};
 return <section aria-label={title} aria-busy={loading} style={style}>
  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:8}}>
   <Typography.Text strong>{title}</Typography.Text>
   <Typography.Text type="secondary">当前搜索范围，状态分布不随状态筛选变化</Typography.Text>
   <Tooltip trigger={["hover","focus","click"]} title={description||"统计全部匹配记录，不是当前页。点击状态只筛选下方明细；再次点击恢复全部。"}><Button type="link" size="small">统计说明</Button></Tooltip>
   <span style={{marginLeft:"auto",fontSize:12,color:"var(--admin-text-muted)"}}>{stamp?`更新于 ${stamp}（北京时间）`:""}{loading&&usable?" · 更新中":""}</span>
   <Button size="small" disabled={loading} onClick={onRetry}>刷新概览</Button>
   {onSelect&&<Button size="small" onClick={()=>onSelect("total")}>全部记录</Button>}
  </div>
  {!!error&&<Alert style={{marginBottom:8}} type="warning" showIcon title={status===404?"概览功能待升级":status===403?"无权查看概览":stale?"更新失败，显示旧数据":"概览暂不可用"} action={<Button size="small" onClick={onRetry}>重试</Button>}/>}
  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(min(100%, 190px), 1fr))",gap:10}}>
   {metrics.map(metric=>{
    const value=count(metric.key);const interactive=!!onSelect&&metric.interactive!==false&&!!usable;
    const cardStyle:CSSProperties={textAlign:"left",padding:14,minWidth:0,borderRadius:8,border:`1px solid ${selectedKey===metric.key?"var(--admin-accent)":"var(--admin-stroke)"}`,background:"var(--admin-surface)",color:"var(--admin-text)",font:"inherit",outlineColor:"var(--admin-focus-ring)",cursor:interactive?"pointer":"default"};
    const content=<><span style={{display:"block",fontSize:12,color:"var(--admin-text-muted)"}}>{metric.label}</span>{loading&&!usable?<Skeleton.Input active size="small" style={{marginTop:6,width:80}}/>:<strong style={{display:"block",fontSize:24,marginTop:4,color:metric.tone==="danger"?"var(--ant-color-error-text)":metric.tone==="warning"?"var(--ant-color-warning-text)":undefined}}>{value===undefined?"—":new Intl.NumberFormat("zh-CN").format(value)}</strong>}{metric.description&&usable&&<span style={{display:"block",marginTop:4,fontSize:12,color:"var(--admin-text-muted)"}}>{metric.description}</span>}</>;
    return interactive?<button key={metric.key} type="button" aria-label={metric.label} aria-pressed={selectedKey===metric.key} style={cardStyle} onClick={()=>onSelect(metric.key)}>{content}</button>:<div key={metric.key} style={cardStyle}>{content}</div>;
   })}
  </div>
  {!!usable?.metrics.find(m=>m.key==="unclassified"&&m.count>0)&&<Typography.Text type="warning">存在未分类状态，未计入以上状态分组；总数仍包含这些记录。</Typography.Text>}
 </section>;
}
