import { useState } from "react";
import { Button, Popover, Space, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUser, useCurrentWorkspace, useRequestClient } from "@ky/admin-core";
export interface AgencyStatistics { users: {online:number; employed:number; left:number; total:number}; enterpriseCount:number; terminalsSupported:false }
export function useAgencyStatistics(ids:string[],scope:"agencies"|"enterprises"="agencies") {
 const client=useRequestClient(),ws=useCurrentWorkspace(),user=useCurrentUser();
 return useQuery({queryKey:["agency-statistics",user?.id,ws?.type,ws?.id,ws?.membershipId,scope,ids],enabled:ids.length>0,staleTime:15000,retry:false,queryFn:()=>client.request<Record<string,AgencyStatistics>>(`/api/v1/platform/${scope}/statistics`,{method:"POST",body:{ids}})});
}
export function AgencyStatisticsCell({id,summary,loading,scope="agencies",retry}:{id:string;summary?:AgencyStatistics;loading:boolean;scope?:"agencies"|"enterprises";retry:()=>void}) {
 const [open,setOpen]=useState(false);const detail=useAgencyStatistics(open?[id]:[],scope);const value=detail.data?.[id]??summary;
 return <Space direction="vertical" size={2}>
 {scope==="agencies"&&<span>企业：{summary?.enterpriseCount??(loading?"加载中…":"暂不可用")}</span>}
 <Popover trigger={["hover","focus","click"]} open={open} onOpenChange={setOpen} title="用户统计" content={detail.isFetching?"正在加载最新统计…":detail.isError?<Button onClick={()=>void detail.refetch()}>暂不可用，重试</Button>:value?<Space direction="vertical" size={2}><span>在线：{value.users.online}</span><span>在职：{value.users.employed}</span><span>离职：{value.users.left}</span><span>累计：{value.users.total}</span><Typography.Text type="secondary">在线依据有效成员、账号和90秒内心跳</Typography.Text></Space>:"暂无统计"}>
 <Button type="text" size="small">用户：{value?`${value.users.online} / ${value.users.employed} / ${value.users.total}`:loading?"加载中…":"暂不可用"}</Button></Popover>
 {!summary&&!loading&&<Button type="link" size="small" onClick={retry}>重试统计</Button>}
 <Typography.Text type="secondary">终端：未接入</Typography.Text>
 </Space>;
}
