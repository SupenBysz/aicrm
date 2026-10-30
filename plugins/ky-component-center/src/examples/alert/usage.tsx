import { Alert } from "antd";
export default function Example({ label = "提示", state = "default" }: { label?: string; state?: string } = {}) {
return <Alert title={label} description="错误应给出可理解的原因与重试入口，不泄漏服务内部信息。" type={state === "error"?"error":state === "warning"?"warning":"info"} showIcon/>;
}
