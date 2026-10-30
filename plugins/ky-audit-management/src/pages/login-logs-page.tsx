import { useEffect,useState } from "react";
import { Alert,Button,Input,Select,Space,Table,Tag,Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ListPageCard,ListOverview,readListQueryState,useRequestClient,useOverviewIdentity,type ListQueryState,type ListOverviewResult } from "@ky/admin-core";
import { listLoginLogs,type LoginLog } from "../api";
import {recentLogWindow,validLogWindow,shanghaiInput,inputToTimestamp} from "./login-log-query";

export function LoginLogsPage(){
 const client=useRequestClient(),identity=useOverviewIdentity();const [searchParams,setSearchParams]=useSearchParams();const state=readListQueryState(searchParams);
 const [initialWindow]=useState(()=>recentLogWindow());
 const hasWindow=searchParams.has("startAt")||searchParams.has("endBefore");
 const startAt=hasWindow?searchParams.get("startAt")??"":initialWindow.startAt;
 const endBefore=hasWindow?searchParams.get("endBefore")??"":initialWindow.endBefore;
 const account=searchParams.get("account")||undefined,userId=searchParams.get("userId")||undefined,result=searchParams.get("result")||undefined;
 const [draft,setDraft]=useState({start:shanghaiInput(startAt),end:shanghaiInput(endBefore),account:account??""});const [formError,setFormError]=useState("");
 useEffect(()=>{if(!hasWindow){const p=new URLSearchParams(searchParams);p.set("startAt",initialWindow.startAt);p.set("endBefore",initialWindow.endBefore);p.set("window","24h");setSearchParams(p,{replace:true})}},[hasWindow,initialWindow,searchParams,setSearchParams]);
 useEffect(()=>setDraft({start:shanghaiInput(startAt),end:shanghaiInput(endBefore),account:account??""}),[startAt,endBefore,account]);
 const valid=validLogWindow({startAt,endBefore})&&(!result||["success","failed"].includes(result))&&(account?.length??0)<=256&&(userId?.length??0)<=256;
 const baseQuery=new URLSearchParams({startAt,endBefore,...account?{account}:{},...userId?{userId}:{}});
 const overview=useQuery({meta:{listOverview:true},queryKey:["login-logs","summary",identity,startAt,endBefore,account,userId],enabled:!!identity&&valid,retry:false,
  queryFn:({signal})=>client.request<ListOverviewResult>(`/api/v1/login-logs/summary?${baseQuery}`,{signal})});
 const list=useQuery({queryKey:["login-logs","v2",identity,startAt,endBefore,account,userId,result,state.page,state.pageSize],enabled:!!identity&&valid,retry:false,
  queryFn:()=>listLoginLogs(client,{page:state.page,pageSize:state.pageSize,startAt,endBefore,account,userId,result})});
 function applyState(next:Partial<ListQueryState>){const p=new URLSearchParams(searchParams);if(next.page!==undefined)p.set("page",String(next.page));if(next.pageSize!==undefined)p.set("pageSize",String(next.pageSize));setSearchParams(p)}
 function changeResult(key:string){const p=new URLSearchParams(searchParams);if(key==="total"||key===result)p.delete("result");else p.set("result",key);p.set("page","1");setSearchParams(p)}
 function submit(){
  const changed=draft.start!==shanghaiInput(startAt)||draft.end!==shanghaiInput(endBefore);
  const range=!changed?(searchParams.get("window")==="24h"?recentLogWindow():{startAt,endBefore}):{startAt:inputToTimestamp(draft.start),endBefore:inputToTimestamp(draft.end)};
  if(!validLogWindow(range)||draft.account.trim().length>256){setFormError("请提供有效的北京时间范围，起始时间早于结束时间且不超过31天；账号最多256字符。");return}
  setFormError("");const p=new URLSearchParams(searchParams);p.set("startAt",range.startAt);p.set("endBefore",range.endBefore);p.set("window",!changed&&searchParams.get("window")==="24h"?"24h":"custom");p.set("page","1");if(draft.account.trim())p.set("account",draft.account.trim());else p.delete("account");setSearchParams(p);
  if(range.startAt===startAt&&range.endBefore===endBefore&&draft.account.trim()===(account??"")){void overview.refetch();void list.refetch()}
 }
 function refresh(){if(searchParams.get("window")==="24h"){const p=new URLSearchParams(searchParams),range=recentLogWindow();p.set("startAt",range.startAt);p.set("endBefore",range.endBefore);p.set("page","1");setSearchParams(p)}else if(valid){void overview.refetch();void list.refetch()}}
 function reset(){const range=recentLogWindow();setSearchParams({startAt:range.startAt,endBefore:range.endBefore,window:"24h",page:"1",pageSize:String(state.pageSize)});setFormError("")}
 const columns:ColumnsType<LoginLog>=[
  {title:"登录账号",dataIndex:"loginAccount",width:200},
  {title:"结果",dataIndex:"result",width:100,render:(value:string)=><Tag color={value==="success"?"green":value==="failed"?"red":"default"}>{value==="success"?"成功":value==="failed"?"失败":"其他结果"}</Tag>},
  {title:"失败原因",dataIndex:"failReason",render:(value:string)=>value||<Typography.Text type="secondary">—</Typography.Text>},
  {title:"IP地址",dataIndex:"ipAddress",width:160},
  {title:"时间（北京时间）",dataIndex:"createdAt",width:190,render:(value:string)=>new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}
 ];
 return <ListPageCard title="登录日志" subtitle="平台账号已持久化的认证日志；默认最近24小时，仅平台后台可见。" toolbar={<Space wrap>
  <Input aria-label="登录账号精确匹配" placeholder="登录账号（精确匹配）" value={draft.account} onChange={e=>setDraft({...draft,account:e.target.value})} allowClear style={{width:210}}/>
  <label>开始（北京时间）<Input aria-label="开始时间（北京时间）" type="datetime-local" step={1} value={draft.start} onChange={e=>setDraft({...draft,start:e.target.value})}/></label>
  <label>结束（不含，北京时间）<Input aria-label="结束时间（不含，北京时间）" type="datetime-local" step={1} value={draft.end} onChange={e=>setDraft({...draft,end:e.target.value})}/></label>
  <Select aria-label="登录结果" style={{width:100}} value={result??"total"} options={[{value:"total",label:"全部结果"},{value:"success",label:"成功"},{value:"failed",label:"失败"}]} onChange={key=>{if(key!==result)changeResult(key)}}/>
  <Button type="primary" onClick={submit}>查询</Button><Button onClick={reset}>重置</Button>
 </Space>} overview={<ListOverview title="登录概览" data={valid?overview.data:undefined} loading={overview.isFetching} error={overview.error} onRetry={refresh}
   metrics={[{key:"total",label:"登录记录数"},{key:"success",label:"成功记录数"},{key:"failed",label:"失败记录数",tone:"danger"},{key:"failedAccounts",label:"失败账号数",interactive:false,description:"非空账号精确去重，保留大小写"}]}
   selectedKey={result??"total"} onSelect={changeResult} description={`当前时间范围：${shanghaiInput(startAt)} 至 ${shanghaiInput(endBefore)}（不含结束，北京时间）。成功/失败按日志记录计数，失败账号是只读去重指标；状态分布不随结果筛选变化。`}/>}>
  {(!valid||formError)&&<Alert type="warning" title={formError||"URL中的查询条件无效，请重置；时间范围最多31天。"}/>}

  {list.error&&<Alert type="error" showIcon title={(list.error as Error).message} action={<Button onClick={()=>void list.refetch()}>重试</Button>}/>}
  <Table<LoginLog> rowKey="id" columns={columns} dataSource={valid?list.data?.items??[]:[]} loading={list.isFetching} pagination={{current:state.page,pageSize:state.pageSize,total:list.data?.pagination.total??0,showSizeChanger:true,showTotal:total=>`共 ${total} 条`,onChange:(page,pageSize)=>applyState({page,pageSize})}}/>
 </ListPageCard>
}
