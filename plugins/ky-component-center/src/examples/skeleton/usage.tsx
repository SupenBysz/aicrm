import { Skeleton } from "antd";
export default function Example({ label = "骨架", state = "default" }: { label?: string; state?: string } = {}) {
return <Skeleton active loading={state !== "ready"}><p>{label}</p></Skeleton>;
}
