import { Timeline, Empty } from "antd";
export default function Example({ label = "处理记录", state = "default" }: { label?: string; state?: string } = {}) {
  if (state === "empty") return <Empty description="暂无时间轴记录"/>;
  return <section aria-label={label}><Timeline items={[
    { key: "created", title: "2026-01-01 09:00", content: "已创建演示申请" },
    { key: "reviewed", title: "2026-01-01 09:10", content: "审核完成", color: "green" },
    state === "processing" ? { key: "processing", title: "处理中", content: "等待模拟处理结果", loading: true } : { key: "completed", title: "2026-01-01 09:20", content: "流程完成", color: "green" }
  ]}/><p>虚构时间与记录，仅展示流程顺序，不代表真实业务进度。</p></section>;
}
