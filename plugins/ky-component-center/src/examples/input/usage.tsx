import { Input } from "antd";
export default function Example({ label = "输入", disabled = false, state = "default" }: { label?: string; disabled?: boolean; state?: string } = {}) {
return <Input aria-label="演示输入" placeholder={label} disabled={disabled || state === "disabled"} status={state === "error" ? "error" : undefined} allowClear />;
}
