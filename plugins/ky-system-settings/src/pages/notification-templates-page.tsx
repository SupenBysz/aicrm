import { useState } from "react";
import { Button, Drawer, Form, Input, Popconfirm, Space, Switch, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, drawerWidths, useRequestClient, usePermissions } from "@ky/admin-core";
import {
  listNotificationTemplates,
  resetNotificationTemplate,
  updateNotificationTemplate,
  updateNotificationTemplateStatus,
  type NotificationTemplate
} from "../api";

type EditInput = { templateName: string; title: string; content: string; description: string };

export function NotificationTemplatesPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<NotificationTemplate | null>(null);
  const [form] = Form.useForm<EditInput>();

  const canUpdate = permissions.can("platform.notification_templates.update");

  const { data, isFetching } = useQuery({
    queryKey: ["notification-templates"],
    queryFn: () => listNotificationTemplates(client)
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["notification-templates"] });

  const saveMutation = useMutation({
    mutationFn: (values: EditInput) => updateNotificationTemplate(client, editing!.templateKey, values),
    onSuccess: () => {
      void message.success("模板已保存。");
      setEditing(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const statusMutation = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) => updateNotificationTemplateStatus(client, key, enabled),
    onSuccess: () => {
      void message.success("状态已更新。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const resetMutation = useMutation({
    mutationFn: (key: string) => resetNotificationTemplate(client, key),
    onSuccess: () => {
      void message.success("已恢复默认。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  function openEdit(t: NotificationTemplate) {
    setEditing(t);
    form.setFieldsValue({ templateName: t.templateName, title: t.title, content: t.content, description: t.description });
  }

  const columns: ColumnsType<NotificationTemplate> = [
    {
      title: "模板",
      key: "name",
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{r.templateName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.templateKey}
          </Typography.Text>
        </Space>
      )
    },
    { title: "标题", dataIndex: "title", key: "title" },
    {
      title: "说明",
      dataIndex: "description",
      key: "description",
      render: (v: string) => v || <Typography.Text type="secondary">—</Typography.Text>
    },
    {
      title: "启用",
      key: "enabled",
      width: 90,
      render: (_, r) =>
        canUpdate ? (
          <Switch
            checked={r.enabled}
            onChange={(checked) => statusMutation.mutate({ key: r.templateKey, enabled: checked })}
          />
        ) : (
          <Tag color={r.enabled ? "green" : "default"}>{r.enabled ? "启用" : "停用"}</Tag>
        )
    },
    {
      title: "操作",
      key: "actions",
      className: "table-action-column",
      width: 180,
      render: (_, r) =>
        canUpdate ? (
          <Space className="table-action-grid" size={4} wrap>
            <Button size="small" type="link" onClick={() => openEdit(r)}>
              编辑
            </Button>
            <Popconfirm title="恢复为系统默认内容？" okText="恢复" cancelText="取消" onConfirm={() => resetMutation.mutate(r.templateKey)}>
              <Button size="small" type="link">
                恢复默认
              </Button>
            </Popconfirm>
          </Space>
        ) : null
    }
  ];

  return (
    <>
      <ListPageCard title="通知模板" subtitle="维护系统通知模板的标题与内容,变量用 {{变量名}} 占位。发布通知时套用。">
        <Table<NotificationTemplate>
          rowKey="templateKey"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          pagination={false}
        />
      </ListPageCard>

      <Drawer
        title={editing ? `编辑模板:${editing.templateName}` : "编辑模板"}
        width={drawerWidths.standardForm}
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setEditing(null)}>取消</Button>
            <Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form<EditInput> form={form} layout="vertical" onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item label="模板名称" name="templateName" rules={[{ required: true, message: "请输入模板名称" }]}>
            <Input />
          </Form.Item>
          <Form.Item label="标题" name="title" rules={[{ required: true, message: "请输入标题" }]}>
            <Input placeholder="支持 {{变量名}} 占位" />
          </Form.Item>
          <Form.Item label="内容" name="content">
            <Input.TextArea rows={5} placeholder="支持 {{变量名}} 占位" />
          </Form.Item>
          <Form.Item label="说明" name="description">
            <Input placeholder="该模板的用途说明" />
          </Form.Item>
        </Form>
      </Drawer>
    </>
  );
}
