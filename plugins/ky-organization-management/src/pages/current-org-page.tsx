import { useEffect } from "react";
import { Button, Card, Form, Input, Skeleton, Space, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DetailPagePanel, useRequestClient, usePermissions } from "@ky/admin-core";
import {
  getCurrentOrganization,
  updateCurrentOrganization,
  type CurrentOrganizationInput
} from "../api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  normal: { label: "正常", color: "green" },
  disabled: { label: "已停用", color: "red" },
  frozen: { label: "已冻结", color: "orange" }
};

export function CurrentOrgPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<CurrentOrganizationInput>();

  const canUpdate = permissions.canAny(["agency.profile.update", "enterprise.profile.update"]);

  const { data, isLoading } = useQuery({
    queryKey: ["org", "current-organization"],
    queryFn: () => getCurrentOrganization(client)
  });

  useEffect(() => {
    if (data) {
      form.setFieldsValue({
        name: data.name,
        logoUrl: data.logoUrl,
        description: data.description,
        contactName: data.contactName,
        contactPhone: data.contactPhone,
        contactEmail: data.contactEmail
      });
    }
  }, [data, form]);

  const saveMutation = useMutation({
    mutationFn: (values: CurrentOrganizationInput) => updateCurrentOrganization(client, values),
    onSuccess: () => {
      void message.success("组织资料已更新。");
      queryClient.invalidateQueries({ queryKey: ["org", "current-organization"] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  const statusMeta = data ? STATUS_META[data.status] ?? { label: data.status, color: "default" } : null;

  return (
    <DetailPagePanel
      title="当前组织资料"
      extra={
        canUpdate ? (
          <Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>
            保存
          </Button>
        ) : null
      }
    >
      {isLoading ? (
        <Skeleton active />
      ) : (
        <>
          <Space size={16} wrap style={{ marginBottom: 16 }}>
            <Typography.Text type="secondary">
              编码：<Typography.Text strong>{data?.code}</Typography.Text>
            </Typography.Text>
            {statusMeta ? <Tag color={statusMeta.color}>{statusMeta.label}</Tag> : null}
          </Space>
          <Form<CurrentOrganizationInput>
            form={form}
            layout="vertical"
            disabled={!canUpdate}
            onFinish={(values) => saveMutation.mutate(values)}
            style={{ maxWidth: 560 }}
          >
            <Form.Item label="名称" name="name" rules={[{ required: true, message: "请输入名称" }]}>
              <Input placeholder="请输入名称" />
            </Form.Item>
            <Form.Item label="联系人" name="contactName">
              <Input placeholder="请输入联系人姓名" />
            </Form.Item>
            <Form.Item label="联系电话" name="contactPhone">
              <Input placeholder="请输入联系电话" />
            </Form.Item>
            <Form.Item label="联系邮箱" name="contactEmail">
              <Input placeholder="请输入联系邮箱" />
            </Form.Item>
            <Form.Item label="Logo URL" name="logoUrl">
              <Input placeholder="https://..." />
            </Form.Item>
            <Form.Item label="描述" name="description">
              <Input.TextArea rows={3} placeholder="组织描述" />
            </Form.Item>
          </Form>
        </>
      )}
    </DetailPagePanel>
  );
}
