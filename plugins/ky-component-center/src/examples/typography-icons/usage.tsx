import { Typography, Space } from "antd";
import { SettingOutlined, UserOutlined, CheckCircleOutlined } from "@ant-design/icons";
export default function Example({ label = "文字与图标" }: { label?: string } = {}) {
return <><Typography.Title level={3}>{label}</Typography.Title><Typography.Paragraph>正文内容</Typography.Paragraph><Typography.Text type="secondary">次要说明</Typography.Text><Space size={16} style={{display:"flex",marginTop:16}}><SettingOutlined aria-label="设置"/><UserOutlined aria-label="用户"/><CheckCircleOutlined aria-label="完成"/></Space></>;
}
