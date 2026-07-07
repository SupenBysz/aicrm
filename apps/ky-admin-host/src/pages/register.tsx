import { Button, Card, Form, Input, Space, Typography, message } from "antd";
import { Link, useNavigate } from "react-router-dom";
import { bootstrap, pickRecommendedWorkspace, register } from "../remote-api";
import { saveSession, setBootstrap, selectWorkspace, workspaceWorkbenchPath } from "../app-store";
import { usePlatformProfile } from "../platform-profile";

export function RegisterPage() {
  const navigate = useNavigate();
  const { logoTextLong } = usePlatformProfile();

  async function handleFinish(values: { displayName: string; email?: string; phone?: string; password: string }) {
    try {
      const result = await register(values);
      saveSession({ token: result.token, expiresAt: result.expiresAt });
      const state = await bootstrap();
      setBootstrap(state);
      if (state.workspaces.length === 0) {
        navigate("/no-workspace");
        return;
      }
      if (state.workspaces.length === 1) {
        const workspace = pickRecommendedWorkspace(state);
        if (workspace) {
          selectWorkspace(workspace);
          navigate(workspaceWorkbenchPath(workspace));
          return;
        }
      }
      navigate("/workspace/select");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "注册失败");
    }
  }

  return (
    <Card style={{ maxWidth: 420, margin: "96px auto" }}>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Typography.Title level={3}>注册 {logoTextLong}</Typography.Title>
        <Form layout="vertical" onFinish={handleFinish}>
          <Form.Item name="displayName" label="显示名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="email" label="邮箱">
            <Input autoComplete="email" />
          </Form.Item>
          <Form.Item name="phone" label="手机号">
            <Input />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            注册
          </Button>
        </Form>
        <Link to="/login">已有账号，去登录</Link>
      </Space>
    </Card>
  );
}
