import { Tag, Space } from "antd";
export default function Example({ label = "状态标签" }: { label?: string } = {}) {
return <Space wrap>{["success","warning","error","processing","default"].map(color=><Tag key={color} color={color}>{label} · {color}</Tag>)}</Space>;
}
