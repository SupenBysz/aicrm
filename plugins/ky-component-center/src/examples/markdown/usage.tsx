import { useState } from "react";
import { MarkdownReader } from "@ky/markdown";
import { MarkdownEditor } from "@ky/markdown/editor";
export default function Example({disabled=false,state="default"}:{disabled?:boolean;state?:string}={}){
 const [value,setValue]=useState(state==="empty"?"":"# 虚构文档\n\n仅用于组件演示，**不是真实协议**。\n\n| 项目 | 内容 |\n| --- | --- |\n| 状态 | 草稿 |\n\n> 内容只保留在当前预览。\n\n```text\n示例代码\n```\n");
 return state==="readonly"?<MarkdownReader markdown={value}/>:<MarkdownEditor value={value} onChange={setValue} disabled={disabled} fileActions={false}/>;
}
