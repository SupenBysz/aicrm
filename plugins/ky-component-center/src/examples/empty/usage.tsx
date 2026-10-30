import { Empty } from "antd";
export default function Example({ label = "空状态" }: { label?: string } = {}) {
return <Empty description={label}/>;
}
