import { runBatchRequests } from "@ky/admin-core";
import { Button, Alert } from "antd";
import { useState } from "react";
export default function Example({ disabled = false, state = "default" }: { disabled?: boolean; state?: string } = {}) {
const [result,setResult]=useState("");async function run(){try{await runBatchRequests([1,2,3],async i=>{if(i===2&&state==="error")throw new Error("模拟失败")});setResult("3项模拟操作完成")}catch(e){setResult((e as Error).message)}}return <><Button onClick={()=>void run()} disabled={disabled}>运行模拟批量操作</Button>{result&&<Alert style={{marginTop:12}} title={result}/>}</>;
}
