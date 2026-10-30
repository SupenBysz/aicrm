import { Segmented, Space, Typography } from "antd";
import { useState } from "react";
export default function Example({ disabled = false, state = "default" }: { disabled?: boolean; state?: string } = {}) {
  const [headerValue, setHeaderValue] = useState("management");
  const [listValue, setListValue] = useState("management");
  const inactive = disabled || state === "disabled";
  return <Space orientation="vertical" size={24} style={{ width: "100%" }}>
    <section aria-label="顶部胶囊切换">
      <Typography.Title level={5}>顶部胶囊切换</Typography.Title>
      <p><Typography.Text type="secondary">复用主窗口顶部的圆角轮廓、胶囊滑块和主题高亮。</Typography.Text></p>
      <Segmented aria-label="顶部模式切换示例" className="app-mode-segmented" value={headerValue} disabled={inactive} options={[{ value: "workbench", label: "工作台" }, { value: "management", label: "管理中心" }]} onChange={setHeaderValue}/>
    </section>
    {state !== "header" && <section aria-label="列表工具栏切换">
      <Typography.Title level={5}>列表工具栏切换</Typography.Title>
      <p><Typography.Text type="secondary">复用菜单管理工具栏的紧凑圆角形态与内嵌选中块。</Typography.Text></p>
      <Segmented className="list-toolbar-segmented" aria-label="列表分段切换示例" value={listValue} disabled={inactive} options={[{ value: "management", label: "管理中心" }, { value: "workbench", label: "工作台" }]} onChange={setListValue}/>
    </section>}
    <Typography.Text type="secondary">两组独立切换，仅改变示例状态，不切换真实工作区；默认跟随当前配色和亮暗模式。</Typography.Text>
  </Space>;
}
