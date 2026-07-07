import { useEffect } from "react";
import { Button, Form, Input, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, useRequestClient, usePermissions } from "@ky/admin-core";
import { getPlatformProfile, updatePlatformProfile, type PlatformProfile } from "../api";

export function BasicInfoPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<PlatformProfile>();

  const canUpdate = permissions.can("platform.basic_info.update");

  const { data, isFetching } = useQuery({
    queryKey: ["platform-profile"],
    queryFn: () => getPlatformProfile(client)
  });

  useEffect(() => {
    if (data) form.setFieldsValue(data);
  }, [data, form]);

  const saveMutation = useMutation({
    mutationFn: (values: PlatformProfile) => updatePlatformProfile(client, values),
    onSuccess: () => {
      void message.success("基础信息已保存。");
      queryClient.invalidateQueries({ queryKey: ["platform-profile"] });
      // Tell the host to refresh the brand (header title, tab title, login footer).
      window.dispatchEvent(new Event("ky:platform-profile-updated"));
    },
    onError: (error: Error) => message.error(error.message)
  });

  return (
    <ListPageCard title="基础信息" subtitle="维护平台品牌信息、公司主体信息与备案展示。">
      <div style={{ maxWidth: 640, padding: 16 }}>
        <Form<PlatformProfile> form={form} layout="vertical" disabled={isFetching} onFinish={(v) => saveMutation.mutate(v)}>
          <Typography.Title level={5} style={{ margin: "0 0 12px" }}>
            品牌信息
          </Typography.Title>
          <Form.Item
            extra="用于导航展开态、登录页主品牌与浏览器标题。为空时使用公司 / 平台主体名称。"
            label="长文字 LOGO"
            name="brandLogoTextLong"
            rules={[{ max: 20, message: "长文字 LOGO 最多 20 个字符" }]}
          >
            <Input maxLength={20} placeholder="如 AI 智能 CRM / AiCRM" showCount />
          </Form.Item>
          <Form.Item
            extra="用于导航收起态，建议中文 1-2 个字或英文 2-6 个字符。为空时自动从长文字 LOGO 生成。"
            label="短文字 LOGO"
            name="brandLogoTextShort"
            rules={[{ max: 6, message: "短文字 LOGO 最多 6 个字符" }]}
          >
            <Input maxLength={6} placeholder="如 AI / CRM / AiCRM" showCount />
          </Form.Item>

          <Typography.Title level={5} style={{ margin: "20px 0 12px" }}>
            主体信息
          </Typography.Title>
          <Form.Item label="公司 / 平台主体名称" name="companyName" rules={[{ required: true, message: "请输入名称" }]}>
            <Input placeholder="如 凯翼科技" />
          </Form.Item>
          <Form.Item label="ICP 备案号" name="icpRecord">
            <Input placeholder="如 京ICP备2026000001号" />
          </Form.Item>
          {data?.updatedAt ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              最后更新:{new Date(data.updatedAt).toLocaleString("zh-CN")}
            </Typography.Text>
          ) : null}
          {canUpdate ? (
            <Form.Item style={{ marginTop: 16 }}>
              <Space>
                <Button type="primary" htmlType="submit" loading={saveMutation.isPending}>
                  保存
                </Button>
              </Space>
            </Form.Item>
          ) : null}
        </Form>
      </div>
    </ListPageCard>
  );
}
