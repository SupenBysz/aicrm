import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Segmented, Select, Space, Switch, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ListPageCard,
  drawerWidths,
  readListQueryState,
  usePermissions,
  useRequestClient,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import { useSearchParams } from "react-router-dom";
import {
  createAiExecutor,
  getAiExecutor,
  listAiExecutors,
  updateAiExecutor,
  type AiExecutorConfig,
  type AiExecutorCreateInput,
  type AiExecutorPatchInput,
  type AiExecutorRuntimeType
} from "../api";
import { ExecutorControlPanel, CredentialTag, ReadinessTag } from "../components/executor-control-panel";
import { AI_EXECUTOR_PERMISSIONS } from "../permissions";

const RUNTIME_META: Record<AiExecutorRuntimeType, { label: string; color: string }> = {
  desktop: { label: "客户端", color: "blue" },
  server: { label: "服务端", color: "purple" }
};

type DrawerMode = "create" | "view" | "edit";
type ExecutorFormValues = AiExecutorCreateInput;

const defaultValues: ExecutorFormValues = {
  name: "服务端 Codex",
  runtimeType: "server",
  status: "enabled",
  isDefault: true,
  autoRepairEnabled: true,
  triggerFailureCount: 1,
  maxAttempts: 2,
  taskTimeoutSeconds: 180,
  allowScriptSave: true
};

export function ExecutorsPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [form] = Form.useForm<ExecutorFormValues>();
  const [drawerMode, setDrawerMode] = useState<DrawerMode>("view");
  const [active, setActive] = useState<AiExecutorConfig | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const canCreate = permissions.can(AI_EXECUTOR_PERMISSIONS.create);
  const canUpdate = permissions.can(AI_EXECUTOR_PERMISSIONS.update);

  const query = useQuery({
    queryKey: ["ai-executors", queryState.page, queryState.pageSize, queryState.status, queryState.type],
    queryFn: () =>
      listAiExecutors(client, {
        page: queryState.page,
        pageSize: queryState.pageSize,
        status: queryState.status,
        runtimeType: queryState.type
      }),
    retry: false
  });

  useEffect(() => {
    if (!drawerOpen) return;
    form.setFieldsValue(drawerMode === "create" ? defaultValues : active ? toFormValues(active) : defaultValues);
  }, [active, drawerMode, drawerOpen, form]);

  const drawerTitle = useMemo(() => {
    if (drawerMode === "create") return "添加 AI 执行器";
    if (drawerMode === "edit") return "编辑 AI 执行器";
    return active?.name || "执行器详情";
  }, [active?.name, drawerMode]);

  function applyState(next: Partial<ListQueryState>) {
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }

  function openCreate() {
    setActive(null);
    setDrawerMode("create");
    setDrawerOpen(true);
  }

  function openView(record: AiExecutorConfig) {
    setActive(record);
    setDrawerMode("view");
    setDrawerOpen(true);
  }

  function openEdit(record: AiExecutorConfig) {
    setActive(record);
    setDrawerMode("edit");
    setDrawerOpen(true);
  }

  async function refreshActive() {
    if (!active) return;
    try {
      const latest = await getAiExecutor(client, active.id);
      setActive(latest);
      void queryClient.invalidateQueries({ queryKey: ["ai-executors"] });
    } catch {
      void queryClient.invalidateQueries({ queryKey: ["ai-executors"] });
    }
  }

  const saveMutation = useMutation({
    mutationFn: (values: ExecutorFormValues) =>
      drawerMode === "create"
        ? createAiExecutor(client, values)
        : updateAiExecutor(client, active!.id, toPatch(active!, values)),
    onSuccess: (item) => {
      const created = drawerMode === "create";
      void message.success(created ? "执行器已添加" : "执行器已保存");
      setActive(item);
      setDrawerMode("view");
      if (created) setSearchParams(writeListQueryState({ page: 1, pageSize: queryState.pageSize }));
      void queryClient.invalidateQueries({ queryKey: ["ai-executors"] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  const columns: ColumnsType<AiExecutorConfig> = [
    {
      title: "执行器",
      dataIndex: "name",
      width: 250,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Typography.Text strong>{record.name}</Typography.Text>
            {record.isDefault ? <Tag color="gold">平台默认</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{record.id}</Typography.Text>
        </Space>
      )
    },
    {
      title: "运行时",
      dataIndex: "runtimeType",
      width: 110,
      render: (value: AiExecutorRuntimeType) => <Tag color={RUNTIME_META[value]?.color}>{RUNTIME_META[value]?.label ?? value}</Tag>
    },
    { title: "凭据", dataIndex: "credentialStatus", width: 110, render: (value: string) => <CredentialTag value={value} /> },
    { title: "Readiness", dataIndex: "readinessStatus", width: 110, render: (value: string) => <ReadinessTag value={value} /> },
    {
      title: "脚本维护",
      dataIndex: "scriptMaintenanceReady",
      width: 110,
      render: (value: boolean) => value ? <Tag color="green">可用</Tag> : <Tag color="red">阻断</Tag>
    },
    { title: "默认模型", dataIndex: "defaultModelKey", width: 180, ellipsis: true, render: (value: string | null) => value || "未设置" },
    {
      title: "状态",
      dataIndex: "status",
      width: 90,
      render: (value: string) => <Tag color={value === "enabled" ? "green" : "default"}>{value === "enabled" ? "启用" : "停用"}</Tag>
    },
    { title: "更新时间", dataIndex: "updatedAt", width: 180, render: formatTime },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 140,
      className: "table-action-column",
      render: (_, record) => (
        <div className="table-action-grid">
          <Button size="small" type="link" onClick={() => openView(record)}>管理</Button>
          {canUpdate ? <Button size="small" type="link" onClick={() => openEdit(record)}>编辑</Button> : null}
        </div>
      )
    }
  ];

  const controlPlaneDisabled = errorCode(query.error) === "control_plane_disabled";
  return (
    <>
      <ListPageCard
        title="AI 执行器"
        subtitle="管理 Codex 执行器、协助授权、默认模型、Readiness 与 Workspace 发布范围。"
        toolbar={
          <Space wrap>
            <Segmented
              className="list-status-segmented"
              value={queryState.status ?? ""}
              onChange={(value) => applyState({ status: String(value) || undefined, page: 1 })}
              options={[{ label: "全部", value: "" }, { label: "启用", value: "enabled" }, { label: "停用", value: "disabled" }]}
            />
            <Select
              allowClear
              placeholder="运行时"
              style={{ width: 150 }}
              value={queryState.type}
              onChange={(value) => applyState({ type: value, page: 1 })}
              options={[{ value: "desktop", label: "客户端" }, { value: "server", label: "服务端" }]}
            />
          </Space>
        }
        extra={canCreate ? <Button type="primary" disabled={controlPlaneDisabled} onClick={openCreate}>添加执行器</Button> : null}
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          {query.isError ? (
            <Alert
              showIcon
              type={controlPlaneDisabled ? "warning" : "error"}
              message={controlPlaneDisabled ? "Agent Executor 控制面尚未启用" : "执行器数据加载失败"}
              description={controlPlaneDisabled ? "当前环境保持 fail-closed；不会回退到旧 AI Model Service 的执行器写入口。" : (query.error as Error).message}
            />
          ) : null}
          <Table<AiExecutorConfig>
            rowKey="id"
            columns={columns}
            dataSource={query.data?.items ?? []}
            loading={query.isFetching}
            scroll={{ x: 1300 }}
            pagination={{
              current: queryState.page,
              pageSize: queryState.pageSize,
              total: query.data?.pagination.total ?? 0,
              showSizeChanger: true,
              showTotal: (total) => `共 ${total} 条`,
              onChange: (page, pageSize) => applyState({ page, pageSize })
            }}
          />
        </Space>
      </ListPageCard>

      <Drawer
        width={drawerMode === "view" ? drawerWidths.complexDetail : drawerWidths.standardForm}
        open={drawerOpen}
        title={drawerTitle}
        onClose={() => setDrawerOpen(false)}
        extra={
          <Space>
            {drawerMode === "view" && active && canUpdate ? <Button onClick={() => setDrawerMode("edit")}>编辑配置</Button> : null}
            {drawerMode !== "view" ? <Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>保存</Button> : null}
          </Space>
        }
      >
        {drawerMode === "view" && active ? (
          <ExecutorControlPanel executor={active} onExecutorChanged={() => void refreshActive()} />
        ) : (
          <ExecutorForm form={form} editing={drawerMode === "edit"} onFinish={(values) => saveMutation.mutate(values)} />
        )}
      </Drawer>
    </>
  );
}

function ExecutorForm({
  form,
  editing,
  onFinish
}: {
  form: ReturnType<typeof Form.useForm<ExecutorFormValues>>[0];
  editing: boolean;
  onFinish: (values: ExecutorFormValues) => void;
}) {
  return (
    <Form<ExecutorFormValues> form={form} layout="vertical" onFinish={onFinish}>
      <Form.Item label="名称" name="name" rules={[{ required: true, message: "请输入执行器名称" }, { max: 120 }]}>
        <Input placeholder="例如：服务端 Codex" />
      </Form.Item>
      <Form.Item label="运行时类型" name="runtimeType" rules={[{ required: true }]}>
        <Select disabled={editing} options={[{ value: "server", label: "服务端" }, { value: "desktop", label: "客户端" }]} />
      </Form.Item>
      {editing ? <Alert showIcon type="info" message="运行时类型创建后不可通过 PATCH 修改" style={{ marginBottom: 16 }} /> : null}
      <Space size={20} wrap>
        <Form.Item label="状态" name="status" rules={[{ required: true }]}>
          <Select style={{ width: 140 }} options={[{ value: "enabled", label: "启用" }, { value: "disabled", label: "停用" }]} />
        </Form.Item>
        <Form.Item label="平台默认执行器" name="isDefault" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item label="允许保存脚本" name="allowScriptSave" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item label="自动修复" name="autoRepairEnabled" valuePropName="checked"><Switch /></Form.Item>
      </Space>
      <Space size={16} wrap>
        <Form.Item label="触发失败次数" name="triggerFailureCount" rules={[{ required: true }]}><InputNumber min={1} max={10} /></Form.Item>
        <Form.Item label="最大修复轮次" name="maxAttempts" rules={[{ required: true }]}><InputNumber min={1} max={10} /></Form.Item>
        <Form.Item label="任务超时秒数" name="taskTimeoutSeconds" rules={[{ required: true }]}><InputNumber min={30} max={3600} /></Form.Item>
      </Space>
      <Alert
        showIcon
        type="info"
        message="默认模型在执行器详情的 Codex 模型页签维护"
        description="只有当前目录中的非隐藏可用 modelKey 可保存；配置不会回退到全局 API 模型。"
      />
    </Form>
  );
}

function toFormValues(item: AiExecutorConfig): ExecutorFormValues {
  return {
    name: item.name,
    runtimeType: item.runtimeType,
    status: item.status,
    isDefault: item.isDefault,
    allowScriptSave: item.allowScriptSave,
    autoRepairEnabled: item.autoRepairEnabled,
    triggerFailureCount: item.triggerFailureCount,
    maxAttempts: item.maxAttempts,
    taskTimeoutSeconds: item.taskTimeoutSeconds
  };
}

function toPatch(item: AiExecutorConfig, values: ExecutorFormValues): AiExecutorPatchInput {
  return {
    expectedRevision: item.configRevision,
    name: values.name,
    status: values.status,
    isDefault: values.isDefault,
    allowScriptSave: values.allowScriptSave,
    autoRepairEnabled: values.autoRepairEnabled,
    triggerFailureCount: values.triggerFailureCount,
    maxAttempts: values.maxAttempts,
    taskTimeoutSeconds: values.taskTimeoutSeconds
  };
}

function errorCode(error: unknown) {
  return typeof error === "object" && error != null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
}

function formatTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
}
