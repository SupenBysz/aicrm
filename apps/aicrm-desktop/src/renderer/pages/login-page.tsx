import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { App as AntdApp, Button, Form, Input, Typography } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { DESKTOP_APPLICATION_NAME } from "../../shared/constants";
import type { LoginInput } from "../../shared/types";
import { useSessionStore } from "../stores/session-store";
import { useWorkspaceStore } from "../stores/workspace-store";

export function LoginPage() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const signIn = useSessionStore((state) => state.signIn);
  const programTitle = useSessionStore((state) => state.config?.programTitle);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const [submitting, setSubmitting] = useState(false);

  async function handleFinish(values: LoginInput) {
    setSubmitting(true);
    try {
      const state = await signIn(values);
      void message.success("登录成功。");
      if (state.workspaces.length === 1) {
        selectWorkspace(state.workspaces[0]);
        navigate("/dashboard", { replace: true });
      } else {
        navigate("/workspaces", { replace: true });
      }
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="desktop-login">
      <div className="desktop-login-panel">
        <div className="desktop-login-copy">
          <Typography.Text className="login-eyebrow">
            {programTitle?.trim() || DESKTOP_APPLICATION_NAME}
          </Typography.Text>
          <Typography.Title level={1}>桌面工作台</Typography.Title>
          <Typography.Paragraph>
            使用现有 AiCRM 账号登录后，桌面客户端会读取你的后台身份与工作区权限。
          </Typography.Paragraph>
        </div>
        <div className="desktop-login-form">
          <Typography.Title level={3}>账号登录</Typography.Title>
          <Form<LoginInput> layout="vertical" onFinish={handleFinish}>
            <Form.Item label="用户名" name="account" rules={[{ required: true, message: "请输入用户名" }]}>
              <Input prefix={<UserOutlined />} autoComplete="username" placeholder="Super.Admin" />
            </Form.Item>
            <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
              <Input.Password prefix={<LockOutlined />} autoComplete="current-password" placeholder="请输入密码" />
            </Form.Item>
            <Button block type="primary" htmlType="submit" loading={submitting}>
              登录
            </Button>
          </Form>
        </div>
      </div>
    </div>
  );
}
