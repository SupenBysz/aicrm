import { LockOutlined, SafetyCertificateOutlined, UserOutlined } from "@ant-design/icons";
import { Button, Card, Col, Form, Input, Row, Space, Typography, message } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { bootstrap, login, pickRecommendedWorkspace } from "../remote-api";
import { saveSession, setBootstrap, selectWorkspace, workspaceWorkbenchPath } from "../app-store";

const PASSWORD_MIN_LENGTH = 6;
const COMPANY_NAME = "KyaiCRM";
const ICP_RECORD = "";

export function LoginPage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const currentYear = new Date().getFullYear();

  async function handleFinish(values: { username: string; password: string }) {
    setSubmitting(true);
    try {
      const result = await login({ account: values.username, password: values.password });
      saveSession({ token: result.token, expiresAt: result.expiresAt });
      const state = await bootstrap();
      setBootstrap(state);
      message.success("登录成功。");
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
      message.error(error instanceof Error ? error.message : "登录失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-frame">
        <Card className="login-card" styles={{ body: { padding: 0 } }}>
          <Row gutter={0}>
            <Col md={10} xs={24}>
              <div className="login-hero">
                <div>
                  <Typography.Text className="login-eyebrow" type="secondary">
                    KyaiCRM Console
                  </Typography.Text>
                  <Typography.Title className="login-title" level={1}>
                    后台登录
                  </Typography.Title>
                  <Typography.Paragraph className="login-description" type="secondary">
                    平台管理员入口，处理机构管理、模型接入与基础治理。
                  </Typography.Paragraph>
                </div>

                <Space size={16} wrap>
                  <Typography.Link
                    href="https://kyaicrm.entai.im/privacy"
                    rel="noreferrer"
                    style={{ fontSize: 12 }}
                    target="_blank"
                  >
                    隐私政策
                  </Typography.Link>
                  <Typography.Link
                    href="https://kyaicrm.entai.im/terms"
                    rel="noreferrer"
                    style={{ fontSize: 12 }}
                    target="_blank"
                  >
                    服务条款
                  </Typography.Link>
                </Space>
              </div>
            </Col>

            <Col md={14} xs={24}>
              <div className="login-panel">
                <Form
                  className="login-form login-form--platform"
                  disabled={submitting}
                  layout="vertical"
                  requiredMark={false}
                  onFinish={handleFinish}
                >
                  <Space direction="vertical" size={16} style={{ width: "100%" }}>
                    <Space align="start" size={12}>
                      <div className="login-panel-icon">
                        <SafetyCertificateOutlined />
                      </div>
                      <div>
                        <Typography.Title level={3} style={{ margin: 0 }}>
                          平台后台
                        </Typography.Title>
                        <Typography.Text type="secondary">使用用户名与密码登录</Typography.Text>
                      </div>
                    </Space>

                    <Form.Item
                      label="用户名"
                      name="username"
                      rules={[{ message: "请输入用户名", required: true }]}
                    >
                      <Input
                        autoComplete="username"
                        placeholder="输入用户名"
                        prefix={<UserOutlined />}
                        size="large"
                      />
                    </Form.Item>

                    <Form.Item
                      label="密码"
                      name="password"
                      rules={[
                        { message: "请输入密码", required: true },
                        { min: PASSWORD_MIN_LENGTH, message: "密码至少 6 位" }
                      ]}
                    >
                      <Input.Password
                        autoComplete="current-password"
                        placeholder="输入密码"
                        prefix={<LockOutlined />}
                        size="large"
                      />
                    </Form.Item>

                    <Button
                      block
                      className="login-submit"
                      htmlType="submit"
                      loading={submitting}
                      size="large"
                      type="primary"
                    >
                      登录平台后台
                    </Button>
                  </Space>
                </Form>
              </div>
            </Col>
          </Row>
        </Card>

        <Space className="login-footer" direction="vertical" size={2}>
          <Typography.Text type="secondary">
            © {currentYear} {COMPANY_NAME}
          </Typography.Text>
          {ICP_RECORD ? <Typography.Text type="secondary">{ICP_RECORD}</Typography.Text> : null}
        </Space>
      </div>
    </div>
  );
}
