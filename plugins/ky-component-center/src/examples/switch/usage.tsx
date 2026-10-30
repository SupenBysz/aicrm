import { Switch, Space } from "antd";
export default function Example({ label = "开关", disabled = false, state = "default" }: { label?: string; disabled?: boolean; state?: string } = {}) {
return <Space><Switch aria-label="演示开关" disabled={disabled} loading={state === "loading"}/>{label}</Space>;
}
