import { Segmented, Typography } from "antd";
import { useState } from "react";
export default function Example({ disabled = false, state = "default" }: { disabled?: boolean; state?: string } = {}) {
  const [value, setValue] = useState("management");
  const header = state === "header";
  return <><Segmented aria-label={header ? "顶部模式切换示例" : "列表分段切换示例"} className={header ? "app-mode-segmented" : undefined} value={value} disabled={disabled || state === "disabled"} options={header ? [{ value: "workbench", label: "工作台" }, { value: "management", label: "管理中心" }] : [{ value: "management", label: "管理中心" }, { value: "workbench", label: "工作台" }]} onChange={setValue}/><p><Typography.Text type="secondary">当前选择：{value === "management" ? "管理中心" : "工作台"}。仅改变示例状态，不切换真实工作区。</Typography.Text></p></>;
}
