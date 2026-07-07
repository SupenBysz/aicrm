import { useState } from "react";
import { Button, Drawer, Form, Input, InputNumber, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, drawerWidths, useRequestClient, usePermissions } from "@ky/admin-core";
import {
  createAppVersionRule,
  deleteAppVersionRule,
  listAppVersionRules,
  updateAppVersionRule,
  type AppVersionRule,
  type AppVersionRuleInput
} from "../api";

const PLATFORM_LABELS: Record<string, string> = { ios: "iOS", android: "Android" };

export function AppVersionPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<AppVersionRule | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<AppVersionRuleInput>();

  const canCreate = permissions.can("platform.app_version.create");
  const canUpdate = permissions.can("platform.app_version.update");
  const canDelete = permissions.can("platform.app_version.delete");

  const { data, isFetching } = useQuery({ queryKey: ["app-version-rules"], queryFn: () => listAppVersionRules(client) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["app-version-rules"] });

  const saveMutation = useMutation({
    mutationFn: (values: AppVersionRuleInput) =>
      editing ? updateAppVersionRule(client, editing.id, values) : createAppVersionRule(client, values),
    onSuccess: () => {
      void message.success(editing ? "规则已更新。" : "规则已创建。");
      setOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAppVersionRule(client, id),
    onSuccess: () => {
      void message.success("规则已删除。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ platform: "android", channel: "default", forceUpdate: false, enabled: true } as AppVersionRuleInput);
    setOpen(true);
  }
  function openEdit(rule: AppVersionRule) {
    setEditing(rule);
    form.setFieldsValue(rule);
    setOpen(true);
  }

  const columns: ColumnsType<AppVersionRule> = [
    {
      title: "平台 / 渠道",
      key: "platform",
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Tag color={r.platform === "ios" ? "blue" : "green"}>{PLATFORM_LABELS[r.platform] ?? r.platform}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            渠道:{r.channel}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: "最新版本",
      key: "latest",
      render: (_, r) => `${r.latestVersionName}（${r.latestVersionCode}）`
    },
    { title: "最低支持", dataIndex: "minSupportedVersionCode", key: "min", width: 100 },
    {
      title: "强制更新",
      dataIndex: "forceUpdate",
      key: "force",
      width: 90,
      render: (v: boolean) => (v ? <Tag color="red">强制</Tag> : <Tag>可选</Tag>)
    },
    {
      title: "状态",
      dataIndex: "enabled",
      key: "enabled",
      width: 80,
      render: (v: boolean) => <Tag color={v ? "green" : "default"}>{v ? "启用" : "停用"}</Tag>
    },
    {
      title: "操作",
      key: "actions",
      className: "table-action-column",
      width: 180,
      render: (_, r) => (
        <Space className="table-action-grid" size={4} wrap>
          {canUpdate ? (
            <Button size="small" type="link" onClick={() => openEdit(r)}>
              编辑
            </Button>
          ) : null}
          {canDelete ? (
            <Popconfirm title="确认删除该版本规则？" okText="删除" cancelText="取消" onConfirm={() => deleteMutation.mutate(r.id)}>
              <Button size="small" type="link" danger>
                删除
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      )
    }
  ];

  return (
    <>
      <ListPageCard
        title="App 版本设置"
        subtitle="按平台与渠道维护移动端版本规则,供 App 检查更新(支持强制更新)。"
        extra={canCreate ? <Button type="primary" onClick={openCreate}>新建规则</Button> : null}
      >
        <Table<AppVersionRule> rowKey="id" columns={columns} dataSource={data?.items ?? []} loading={isFetching} pagination={false} />
      </ListPageCard>

      <Drawer
        title={editing ? "编辑版本规则" : "新建版本规则"}
        width={drawerWidths.standardForm}
        open={open}
        onClose={() => setOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form<AppVersionRuleInput> form={form} layout="vertical" onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item label="平台" name="platform" rules={[{ required: true }]}>
            <Select
              disabled={Boolean(editing)}
              options={[
                { value: "android", label: "Android" },
                { value: "ios", label: "iOS" }
              ]}
            />
          </Form.Item>
          <Form.Item label="渠道" name="channel" initialValue="default">
            <Input placeholder="如 default / appstore / huawei" disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item label="最新版本号(versionName)" name="latestVersionName" rules={[{ required: true, message: "请输入版本名" }]}>
            <Input placeholder="如 1.2.0" />
          </Form.Item>
          <Form.Item label="最新版本码(versionCode)" name="latestVersionCode" rules={[{ required: true, message: "请输入版本码" }]}>
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="最低支持版本码" name="minSupportedVersionCode" initialValue={0}>
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="强制更新" name="forceUpdate" valuePropName="checked" initialValue={false}>
            <Switch />
          </Form.Item>
          <Form.Item label="更新标题" name="updateTitle">
            <Input placeholder="如 发现新版本" />
          </Form.Item>
          <Form.Item label="更新说明" name="updateNotes">
            <Input.TextArea rows={3} placeholder="更新内容" />
          </Form.Item>
          <Form.Item label="下载地址" name="updateUrl">
            <Input placeholder="https://..." />
          </Form.Item>
          <Form.Item label="内部备注" name="internalRemark">
            <Input placeholder="仅内部可见" />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </>
  );
}
