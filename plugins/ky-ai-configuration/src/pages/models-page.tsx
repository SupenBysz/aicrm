import { useMemo, useState } from "react";
import { Alert, Button, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  drawerWidths,
  readListQueryState,
  runBatchRequests,
  useRequestClient,
  usePermissions,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import {
  createModel,
  listAllProviders,
  listModels,
  testModel,
  updateModel,
  updateModelStatus,
  type AiModel,
  type ModelInput,
  type ModelTestResult
} from "../api";

const DEFAULT_TEST_PROMPT = "你好，请用一句话介绍你自己。";

const STATUS_META: Record<string, { label: string; color: string }> = {
  enabled: { label: "启用", color: "green" },
  disabled: { label: "停用", color: "red" }
};

const MODEL_TYPE_OPTIONS = [
  { value: "text_generation", label: "文本生成" },
  { value: "embedding", label: "向量嵌入" },
  { value: "vision", label: "多模态/视觉" }
];

export function ModelsPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [providerFilter, setProviderFilter] = useState<string | undefined>(undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<AiModel | null>(null);
  const [detail, setDetail] = useState<AiModel | null>(null);
  const [testTarget, setTestTarget] = useState<AiModel | null>(null);
  const [testPrompt, setTestPrompt] = useState(DEFAULT_TEST_PROMPT);
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);
  const [form] = Form.useForm<ModelInput>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);

  const canCreate = permissions.can("platform.ai_models.create");
  const canUpdate = permissions.can("platform.ai_models.update");
  const canStatus = permissions.can("platform.ai_models.update_status");
  const canTest = permissions.can("platform.ai_models.test");

  const providersQuery = useQuery({ queryKey: ["ai-providers", "options"], queryFn: () => listAllProviders(client) });
  const providerOptions = (providersQuery.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }));
  const enabledProviderOptions = (providersQuery.data?.items ?? [])
    .filter((p) => p.status === "enabled")
    .map((p) => ({ value: p.id, label: p.name }));
  const providerNameById = useMemo(() => {
    const map = new Map<string, string>();
    (providersQuery.data?.items ?? []).forEach((p) => map.set(p.id, p.name));
    return map;
  }, [providersQuery.data]);

  const { data, isFetching } = useQuery({
    queryKey: ["ai-models", queryState.page, queryState.pageSize, queryState.status, providerFilter],
    queryFn: () =>
      listModels(client, {
        page: queryState.page,
        pageSize: queryState.pageSize,
        status: queryState.status,
        providerId: providerFilter
      })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSelectedRowKeys([]);
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["ai-models"] });
  const selectedModels = useMemo(
    () => (data?.items ?? []).filter((model) => selectedRowKeys.includes(model.id)),
    [data?.items, selectedRowKeys]
  );
  const selectedEnabledModels = selectedModels.filter((model) => model.status === "enabled");
  const selectedDisabledModels = selectedModels.filter((model) => model.status === "disabled");

  const saveMutation = useMutation({
    mutationFn: (values: ModelInput) => (editing ? updateModel(client, editing.id, values) : createModel(client, values)),
    onSuccess: () => {
      void message.success(editing ? "模型已更新。" : "模型已创建。");
      setDrawerOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateModelStatus(client, id, status),
    onSuccess: () => {
      void message.success("模型状态已更新。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const bulkStatusMutation = useMutation({
    mutationFn: (status: string) => {
      const targets = status === "disabled" ? selectedEnabledModels : selectedDisabledModels;
      return runBatchRequests(targets, (model) => updateModelStatus(client, model.id, status), "批量更新模型状态失败");
    },
    onSuccess: () => {
      void message.success("模型状态已批量更新。");
      setSelectedRowKeys([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const testMutation = useMutation({
    mutationFn: (prompt: string) => testModel(client, testTarget!.id, prompt),
    onSuccess: (result) => setTestResult(result),
    onError: (error: Error) => message.error(error.message)
  });

  function openTest(model: AiModel) {
    setTestTarget(model);
    setTestPrompt(DEFAULT_TEST_PROMPT);
    setTestResult(null);
  }
  function closeTest() {
    setTestTarget(null);
    setTestResult(null);
    testMutation.reset();
  }

  function openCreate() {
    setEditing(null);
    form.resetFields();
    setDrawerOpen(true);
  }
  function openEdit(model: AiModel) {
    setEditing(model);
    form.setFieldsValue({
      providerId: model.providerId,
      name: model.name,
      modelKey: model.modelKey,
      modelType: model.modelType,
      contextLength: model.contextLength,
      remark: model.remark
    });
    setDrawerOpen(true);
  }

  const columns: ColumnsType<AiModel> = [
    {
      title: "模型",
      key: "name",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.modelKey}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: "供应商",
      key: "provider",
      render: (_, record) => providerNameById.get(record.providerId) ?? record.providerId
    },
    {
      title: "类型",
      dataIndex: "modelType",
      key: "modelType",
      width: 120,
      render: (value: string) => MODEL_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value
    },
    { title: "上下文", dataIndex: "contextLength", key: "contextLength", width: 100 },
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
      className: "table-action-column",
      width: 260,
      render: (_, record) => (
        <Space className="table-action-grid" size={4} wrap>
          <Button size="small" type="link" onClick={() => setDetail(record)}>
            详情
          </Button>
          {canUpdate ? (
            <Button size="small" type="link" onClick={() => openEdit(record)}>
              编辑
            </Button>
          ) : null}
          {canTest ? (
            <Button size="small" type="link" onClick={() => openTest(record)}>
              测试
            </Button>
          ) : null}
          {canStatus ? (
            record.status === "enabled" ? (
              <Popconfirm
                title="确认停用该模型？"
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
        title="AI 模型"
        subtitle={
          selectedRowKeys.length > 0 ? (
            <Space size={8}>
              <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 项</Typography.Text>
              <Button size="small" type="link" onClick={() => setSelectedRowKeys([])}>
                清空选择
              </Button>
            </Space>
          ) : (
            "管理各供应商下的模型（第一阶段支持文本生成 / 向量嵌入）。"
          )
        }
        toolbar={
          <div
            style={{
              alignItems: "center",
              columnGap: 12,
              display: "grid",
              gridTemplateColumns: "1fr auto 1fr",
              minWidth: 520,
              width: "100%"
            }}
          >
            <Select
              allowClear
              placeholder="供应商"
              style={{ width: 200 }}
              options={providerOptions}
              value={providerFilter}
              onChange={(value) => {
                setProviderFilter(value || undefined);
                applyState({ page: 1 });
              }}
            />
            <Segmented
              className="list-status-segmented"
              style={{ justifySelf: "center" }}
              value={queryState.status ?? ""}
              onChange={(value) => applyState({ status: String(value) || undefined, page: 1 })}
              options={[
                { value: "", label: "全部" },
                { value: "enabled", label: "启用" },
                { value: "disabled", label: "停用" }
              ]}
            />
            <span />
          </div>
        }
        extra={
          <Space wrap>
            {selectedModels.length > 0 && canStatus ? (
              <>
                {selectedEnabledModels.length > 0 ? (
                  <Popconfirm
                    title={`确认停用选中的 ${selectedEnabledModels.length} 个模型？`}
                    okText="停用"
                    cancelText="取消"
                    onConfirm={() => bulkStatusMutation.mutate("disabled")}
                  >
                    <Button danger loading={bulkStatusMutation.isPending}>
                      批量停用
                    </Button>
                  </Popconfirm>
                ) : null}
                {selectedDisabledModels.length > 0 ? (
                  <Button loading={bulkStatusMutation.isPending} onClick={() => bulkStatusMutation.mutate("enabled")}>
                    批量启用
                  </Button>
                ) : null}
              </>
            ) : null}
            {canCreate ? (
              <Button type="primary" onClick={openCreate}>
                新建模型
              </Button>
            ) : null}
          </Space>
        }
      >
        <Table<AiModel>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          rowSelection={
            canStatus
              ? {
                  selectedRowKeys,
                  onChange: (keys) => setSelectedRowKeys(keys.map(String))
                }
              : undefined
          }
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
        title={editing ? "编辑模型" : "新建模型"}
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
        <Form<ModelInput> form={form} layout="vertical" onFinish={(values) => saveMutation.mutate(values)}>
          <Form.Item label="供应商" name="providerId" rules={[{ required: !editing, message: "请选择供应商" }]}>
            <Select placeholder="选择启用中的供应商" options={enabledProviderOptions} disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item label="模型名称" name="name" rules={[{ required: true, message: "请输入模型名称" }]}>
            <Input placeholder="如 GPT-4o" />
          </Form.Item>
          <Form.Item label="模型 Key" name="modelKey" rules={[{ required: !editing, message: "请输入模型 Key" }]}>
            <Input placeholder="如 gpt-4o" disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item label="模型类型" name="modelType" rules={[{ required: !editing, message: "请选择模型类型" }]}>
            <Select options={MODEL_TYPE_OPTIONS} disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item label="上下文长度" name="contextLength" initialValue={0}>
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} placeholder="备注" />
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer title="模型详情" width={drawerWidths.simpleDetail} open={Boolean(detail)} onClose={() => setDetail(null)}>
        {detail ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="模型名称">{detail.name}</Descriptions.Item>
            <Descriptions.Item label="模型 Key">{detail.modelKey}</Descriptions.Item>
            <Descriptions.Item label="供应商">{providerNameById.get(detail.providerId) ?? detail.providerId}</Descriptions.Item>
            <Descriptions.Item label="类型">
              {MODEL_TYPE_OPTIONS.find((o) => o.value === detail.modelType)?.label ?? detail.modelType}
            </Descriptions.Item>
            <Descriptions.Item label="上下文长度">{detail.contextLength.toLocaleString("zh-CN")}</Descriptions.Item>
            <Descriptions.Item label="默认参数">
              {detail.defaultParameters && Object.keys(detail.defaultParameters).length > 0 ? (
                <Typography.Text code style={{ whiteSpace: "pre-wrap" }}>
                  {JSON.stringify(detail.defaultParameters, null, 2)}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
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
            <Descriptions.Item label="模型 ID">{detail.id}</Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>

      <Modal
        title={`模型测试${testTarget ? `：${testTarget.name}` : ""}`}
        open={Boolean(testTarget)}
        onCancel={closeTest}
        width={drawerWidths.standardForm}
        footer={[
          <Button key="close" onClick={closeTest}>
            关闭
          </Button>,
          <Button
            key="run"
            type="primary"
            loading={testMutation.isPending}
            disabled={!testPrompt.trim()}
            onClick={() => testMutation.mutate(testPrompt.trim())}
          >
            开始测试
          </Button>
        ]}
      >
        <Typography.Paragraph type="secondary">
          使用该模型所属供应商的真实密钥发送一次请求，验证「密钥 + Base URL + 模型 Key + 协议」是否可用。请求与响应不会被保存。
        </Typography.Paragraph>
        <Form layout="vertical">
          <Form.Item label="测试 Prompt">
            <Input.TextArea
              rows={3}
              value={testPrompt}
              onChange={(event) => setTestPrompt(event.target.value)}
              placeholder="输入要发送给模型的测试内容"
            />
          </Form.Item>
        </Form>
        {testResult ? (
          <>
            <Alert
              style={{ marginBottom: 12 }}
              type={testResult.ok ? "success" : "error"}
              showIcon
              message={
                testResult.ok
                  ? `测试通过 · 延迟 ${testResult.latencyMs} ms`
                  : `测试失败${testResult.httpStatus ? ` · HTTP ${testResult.httpStatus}` : ""}`
              }
              description={testResult.ok ? undefined : testResult.errorMessage}
            />
            {testResult.ok ? (
              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label="模型响应">
                  <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                    {testResult.sampleOutput || "（空）"}
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="延迟">{testResult.latencyMs} ms</Descriptions.Item>
                <Descriptions.Item label="Token 用量">
                  {testResult.totalTokens > 0
                    ? `提示 ${testResult.promptTokens} / 合计 ${testResult.totalTokens}`
                    : "—"}
                </Descriptions.Item>
              </Descriptions>
            ) : null}
          </>
        ) : null}
      </Modal>
    </>
  );
}
