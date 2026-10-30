import { Button, Space } from "antd";
export default function Example({ label = "按钮", disabled = false, state = "default" }: { label?: string; disabled?: boolean; state?: string } = {}) {
return <Space wrap><Button type="primary" disabled={disabled || state === "disabled"} loading={state === "loading"}>{label}</Button><Button>次要操作</Button><Button danger>危险操作</Button></Space>;
}
