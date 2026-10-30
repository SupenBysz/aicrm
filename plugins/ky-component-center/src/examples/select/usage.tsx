import { Select } from "antd";
export default function Example({ label = "选择", disabled = false, state = "default" }: { label?: string; disabled?: boolean; state?: string } = {}) {
return <Select aria-label="演示选择" style={{minWidth:180}} placeholder={label} disabled={disabled || state === "disabled"} loading={state === "loading"} options={[{value:"one",label:"选项一"},{value:"two",label:"选项二"}]} allowClear />;
}
