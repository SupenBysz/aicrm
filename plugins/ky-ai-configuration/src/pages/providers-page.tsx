import { useState } from "react";
import { Button, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  drawerWidths,
  readListQueryState,
  useRequestClient,
  usePermissions,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import {
  createProvider,
  listProviders,
  rotateProviderApiKey,
  updateProvider,
  updateProviderStatus,
  type Provider,
  type ProviderInput
} from "../api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  enabled: { label: "启用", color: "green" },
  disabled: { label: "停用", color: "red" }
};

export function ProvidersPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [detail, setDetail] = useState<Provider | null>(null);
  const [form] = Form.useForm<ProviderInput>();
  const [rotateProvider, setRotateProvider] = useState<Provider | null>(null);
  const [rotateKey, setRotateKey] = useState("");

  const canCreate = permissions.can("platform.ai_providers.create");
  const canUpdate = permissions.can("platform.ai_providers.update");
  const canStatus = permissions.can("platform.ai_providers.update_status");
  const canRotate = permissions.can("platform.ai_providers.rotate_key");

  const { data, isFetching } = useQuery({
    queryKey: ["ai-providers", queryState.page, queryState.pageSize, queryState.status],
    queryFn: () => listProviders(client, { page: queryState.page, pageSize: queryState.pageSize, status: queryState.status })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["ai-providers"] });

  const saveMutation = useMutation({
    mutationFn: (values: ProviderInput) => (editing ? updateProvider(client, editing.id, values) : createProvider(client, values)),
    onSuccess: () => {
      void message.success(editing ? "供应商已更新。" : "供应商已创建。");
      setDrawerOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateProviderStatus(client, id, status),
    onSuccess: () => {
      void message.success("供应商状态已更新（停用会级联停用其模型）。");
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["ai-models"] });
    },
    onError: (error: Error) => message.error(error.message)
  });
  const rotateMutation = useMutation({
    mutationFn: (apiKey: string) => rotateProviderApiKey(client, rotateProvider!.id, apiKey),
    onSuccess: () => {
      void message.success("API 密钥已轮换。");
      setRotateProvider(null);
      setRotateKey("");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  function openCreate() {
    setEditing(null);
    form.resetFields();
    setDrawerOpen(true);
  }
  function openEdit(provider: Provider) {
    setEditing(provider);
    form.setFieldsValue({
      name: provider.name,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      remark: provider.remark,
      apiKey: ""
    });
    setDrawerOpen(true);
  }

  const columns: ColumnsType<Provider> = [
    {
      title: "供应商",
      key: "name",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.providerType}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: "Base URL",
      dataIndex: "baseUrl",
      key: "baseUrl",
      render: (value: string) => value || <Typography.Text type="secondary">默认</Typography.Text>
    },
    {
      title: "API Key",
      key: "apiKey",
      width: 140,
      render: (_, record) =>
        record.hasApiKey ? <Typography.Text code>{record.apiKeyMasked || "***"}</Typography.Text> : <Typography.Text type="secondary">未配置</Typography.Text>
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 90,
      render: (status: string) => {
        const meta = STATUS_META[status] ?? { label: status, color: "default" };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      }
    },
    {
      title: "操作",
      key: "actions",
      width: 220,
      render: (_, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" onClick={() => setDetail(record)}>
            详情
          </Button>
          {canUpdate ? (
            <Button size="small" type="link" onClick={() => openEdit(record)}>
              编辑
            </Button>
          ) : null}
          {canRotate ? (
            <Button size="small" type="link" onClick={() => { setRotateProvider(record); setRotateKey(""); }}>
              轮换密钥
            </Button>
          ) : null}
          {canStatus ? (
            record.status === "enabled" ? (
              <Popconfirm
                title="停用将级联停用其模型，确认？"
                okText="停用"
                cancelText="取消"
                onConfirm={() => statusMutation.mutate({ id: record.id, status: "disabled" })}
              >
                <Button size="small" type="link" danger>
                  停用
                </Button>
              </Popconfirm>
            ) : (
              <Button size="small" type="link" onClick={() => statusMutation.mutate({ id: record.id, status: "enabled" })}>
                启用
              </Button>
            )
          ) : null}
        </Space>
      )
    }
  ];

  return (
    <>
      <ListPageCard
        title="AI 供应商"
        subtitle="管理 AI 模型供应商及其 API 密钥（密钥加密存储，永不回显明文）。"
        extra={
          canCreate ? (
            <Button type="primary" onClick={openCreate}>
              新建供应商
            </Button>
          ) : null
        }
      >
        <Space style={{ padding: 16 }} wrap>
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 140 }}
            options={[
              { value: "enabled", label: "启用" },
              { value: "disabled", label: "停用" }
            ]}
            value={queryState.status}
            onChange={(value) => applyState({ status: value || undefined, page: 1 })}
          />
        </Space>
        <Table<Provider>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          pagination={{
            current: data?.pagination.page ?? queryState.page,
            pageSize: data?.pagination.pageSize ?? queryState.pageSize,
            total: data?.pagination.total ?? 0,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条`,
            onChange: (page, pageSize) => applyState({ page, pageSize })
          }}
        />
      </ListPageCard>

      <Drawer
        title={editing ? "编辑供应商" : "新建供应商"}
        width={drawerWidths.standardForm}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form<ProviderInput> form={form} layout="vertical" onFinish={(values) => saveMutation.mutate(values)}>
          <Form.Item label="名称" name="name" rules={[{ required: true, message: "请输入名称" }]}>
            <Input placeholder="如 OpenAI / Anthropic" />
          </Form.Item>
          <Form.Item label="供应商类型" name="providerType" rules={[{ required: !editing, message: "请输入供应商类型" }]}>
            <Input placeholder="如 openai / anthropic" disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item label="Base URL" name="baseUrl">
            <Input placeholder="留空使用默认地址" />
          </Form.Item>
          <Form.Item label="API Key" name="apiKey" extra={editing ? "留空则保留原密钥；如需更换请用「轮换密钥」。" : undefined}>
            <Input.Password placeholder={editing ? "留空保留原密钥" : "sk-..."} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} placeholder="备注" />
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer title="供应商详情" width={drawerWidths.simpleDetail} open={Boolean(detail)} onClose={() => setDetail(null)}>
        {detail ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="名称">{detail.name}</Descriptions.Item>
            <Descriptions.Item label="供应商类型">{detail.providerType}</Descriptions.Item>
            <Descriptions.Item label="Base URL">{detail.baseUrl || "默认"}</Descriptions.Item>
            <Descriptions.Item label="API Key">
              {detail.hasApiKey ? (
                <Typography.Text code>{detail.apiKeyMasked || "***"}</Typography.Text>
              ) : (
                <Typography.Text type="secondary">未配置</Typography.Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={STATUS_META[detail.status]?.color ?? "default"}>
                {STATUS_META[detail.status]?.label ?? detail.status}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="备注">{detail.remark || "—"}</Descriptions.Item>
            <Descriptions.Item label="创建时间">{new Date(detail.createdAt).toLocaleString("zh-CN")}</Descriptions.Item>
            <Descriptions.Item label="更新时间">{new Date(detail.updatedAt).toLocaleString("zh-CN")}</Descriptions.Item>
            <Descriptions.Item label="供应商 ID">{detail.id}</Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>

      <Modal
        title={`轮换 API 密钥${rotateProvider ? `：${rotateProvider.name}` : ""}`}
        open={Boolean(rotateProvider)}
        onCancel={() => setRotateProvider(null)}
        onOk={() => rotateMutation.mutate(rotateKey)}
        confirmLoading={rotateMutation.isPending}
        okButtonProps={{ disabled: !rotateKey.trim() }}
        okText="轮换"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary">输入新的 API 密钥，提交后立即加密存储，响应只返回脱敏值。</Typography.Paragraph>
        <Input.Password placeholder="新 API Key" value={rotateKey} onChange={(event) => setRotateKey(event.target.value)} />
      </Modal>
    </>
  );
}
