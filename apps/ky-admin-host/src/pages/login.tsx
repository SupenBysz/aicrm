import {useQuery} from "@tanstack/react-query";
import {requestClient} from "../remote-api";
import type {CopyrightStyle} from "@ky/admin-core";
import { LockOutlined, SafetyCertificateOutlined, UserOutlined } from "@ant-design/icons";
import { Button, Card, Col, Form, Input, Row, Space, Typography, message } from "antd";
import { useState,useLayoutEffect } from "react";
import { useNavigate } from "react-router-dom";
import { bootstrap, login, pickRecommendedWorkspace } from "../remote-api";
import { saveSession, setBootstrap, selectWorkspace, workspaceWorkbenchPath } from "../app-store";
import { usePlatformProfile } from "../platform-profile";

import { formatCopyright } from "@ky/admin-core";

const PASSWORD_MIN_LENGTH = 6;

export function LoginPage() {
  const navigate = useNavigate();
  const profile=usePlatformProfile();
 const entry=useQuery({queryKey:["public-entry",window.location.host],retry:false,queryFn:()=>requestClient.request<{institution:boolean;brand?:{name:string;applicationName:string;copyrightHolder:string;copyrightStyle:CopyrightStyle;wordmarkGenerated?:boolean;wordmark?:{url:string}}}>("/api/v1/public/entry",{skipAuthRedirect:true})});
 const brand=entry.data?.institution?entry.data.brand:undefined;
 const {icpRecord,refresh}=profile;const logoTextLong=brand?.name??profile.logoTextLong,companyName=brand?.copyrightHolder??profile.name,copyrightStyle=brand?.copyrightStyle??profile.copyrightStyle,ready=profile.ready&&entry.isSuccess&&(!entry.data.institution||!!brand),error=profile.error||entry.isError;
  const [submitting, setSubmitting] = useState(false);
 const [imageBroken,setImageBroken]=useState(false);
 useLayoutEffect(()=>{document.title=ready?`${logoTextLong} 后台`:"管理后台";return()=>{document.title="管理后台"}},[ready,logoTextLong]);
 if(!ready)return <div role="status" className="auth-page">{error?<Button onClick={()=>{refresh();void entry.refetch()}}>品牌加载失败，重试</Button>:"正在加载…"}</div>;

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
                    {entry.data?.institution&&brand?.wordmark?.url&&!imageBroken?<img src={brand.wordmark.url} alt={logoTextLong} style={{maxWidth:240,maxHeight:48,filter:brand.wordmarkGenerated?"var(--brand-generated-filter,none)":undefined}} onError={()=>setImageBroken(true)}/>:`${logoTextLong} Console`}
                  </Typography.Text>
                  <Typography.Title className="login-title" level={1}>
                    后台登录
                  </Typography.Title>
                  <Typography.Paragraph className="login-description" type="secondary">
                    AI 智能 CRM，自动化搞定直播电商全域运营
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
            {formatCopyright(companyName, copyrightStyle)}
          </Typography.Text>
          {icpRecord ? <Typography.Text type="secondary">{icpRecord}</Typography.Text> : null}
        </Space>
      </div>
    </div>
  );
}
