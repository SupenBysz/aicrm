import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography
} from "antd";
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
  listAiExecutors,
  updateAiExecutor,
  type AiExecutorConfig,
  type AiExecutorConfigInput,
  type AiExecutorRuntimeType
} from "../api";

const RUNTIME_META: Record<AiExecutorRuntimeType, { label: string; color: string }> = {
  desktop: { label: "客户端", color: "blue" },
  server: { label: "服务端", color: "purple" },
  remote: { label: "远程执行机", color: "cyan" }
};

const AUTH_META: Record<string, { label: string; color: string }> = {
  not_authorized: { label: "未授权", color: "default" },
  authorizing: { label: "授权中", color: "processing" },
  authorized: { label: "历史已授权（待复核）", color: "orange" },
  expired: { label: "已过期", color: "orange" },
  error: { label: "授权异常", color: "red" }
};

type DrawerMode = "create" | "view" | "edit";

const defaultValues: AiExecutorConfigInput = {
  name: "客户端 Codex",
  executorType: "codex",
  runtimeType: "desktop",
  status: "enabled",
  isDefault: false,
  priority: 100,
  autoRepairEnabled: true,
  triggerFailureCount: 1,
  maxAttempts: 2,
  taskTimeoutSeconds: 180,
  maxConcurrency: 1,
  allowPageActions: true,
  allowStorageRead: true,
  allowCdpRuntime: true,
  allowScriptSave: true,
  allowAutoActivate: false,
  remark: ""
};

export function ExecutorsPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [form] = Form.useForm<AiExecutorConfigInput>();
  const [drawerMode, setDrawerMode] = useState<DrawerMode>("view");
  const [active, setActive] = useState<AiExecutorConfig | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const canCreate = permissions.can("platform.ai_executors.create");
  const canUpdate = permissions.can("platform.ai_executors.update");
  const canAuthorize = permissions.can("platform.ai_executors.authorize");

  const query = useQuery({
    queryKey: ["ai-executors", queryState.page, queryState.pageSize, queryState.status, queryState.type],
    queryFn: () =>
      listAiExecutors(client, {
        page: queryState.page,
        pageSize: queryState.pageSize,
        status: queryState.status,
        runtimeType: queryState.type
      })
  });

  useEffect(() => {
    if (!drawerOpen) return;
    if (drawerMode === "create") {
      form.setFieldsValue(defaultValues);
      return;
    }
    if (active) {
      form.setFieldsValue(toInput(active));
    }
  }, [active, drawerMode, drawerOpen, form]);

  const drawerTitle = useMemo(() => {
    if (drawerMode === "create") return "添加执行器";
    if (drawerMode === "edit") return "编辑执行器";
    return "查看执行器";
  }, [drawerMode]);

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

  const saveMutation = useMutation({
    mutationFn: (values: AiExecutorConfigInput) =>
      drawerMode === "create" ? createAiExecutor(client, values) : updateAiExecutor(client, active!.id, values),
    onSuccess: (item) => {
      const created = drawerMode === "create";
      void message.success(created ? "执行器已添加" : "执行器已保存");
      setActive(item);
      setDrawerMode("view");
      if (created) {
        setSearchParams(writeListQueryState({ page: 1, pageSize: queryState.pageSize }));
      }
      void queryClient.invalidateQueries({ queryKey: ["ai-executors"] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  const columns: ColumnsType<AiExecutorConfig> = [
    {
      title: "执行器",
      dataIndex: "name",
      width: 240,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Typography.Text strong>{record.name}</Typography.Text>
            {record.isDefault ? <Tag color="gold">默认</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.id}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: "运行时",
      dataIndex: "runtimeType",
      width: 130,
      render: (value: AiExecutorRuntimeType) => <Tag color={RUNTIME_META[value]?.color}>{RUNTIME_META[value]?.label ?? value}</Tag>
    },
    {
      title: "授权",
      dataIndex: "authStatus",
      width: 120,
      render: (value: string) => <Tag color={AUTH_META[value]?.color}>{AUTH_META[value]?.label ?? value}</Tag>
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (value: string) => <Tag color={value === "enabled" ? "green" : "default"}>{value === "enabled" ? "启用" : "停用"}</Tag>
    },
    {
      title: "优先级",
      dataIndex: "priority",
      width: 100
    },
    {
      title: "最近心跳",
      dataIndex: "lastHeartbeatAt",
      width: 180,
      render: formatTime
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      width: 180,
      render: formatTime
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 170,
      className: "table-action-column",
      render: (_, record) => (
        <div className="table-action-grid">
          <Button size="small" type="link" onClick={() => openView(record)}>
            查看
          </Button>
          {canUpdate ? (
            <Button size="small" type="link" onClick={() => openEdit(record)}>
              编辑
            </Button>
          ) : null}
          {canAuthorize ? (
            <Button disabled size="small" type="link" title="可信授权桥升级完成后开放">
              可信授权升级中
            </Button>
          ) : null}
        </div>
      )
    }
  ];

  return (
    <>
      <ListPageCard
        title="AI 执行器"
        subtitle="管理 Codex 执行器、运行位置、授权状态和任务调度能力。"
        toolbar={
          <Space wrap>
            <Segmented
              className="list-status-segmented"
              value={queryState.status ?? ""}
              onChange={(value) => applyState({ status: String(value) || undefined, page: 1 })}
              options={[
                { label: "全部", value: "" },
                { label: "启用", value: "enabled" },
                { label: "停用", value: "disabled" }
              ]}
            />
            <Select
              allowClear
              placeholder="运行时"
              style={{ width: 150 }}
              value={queryState.type}
              onChange={(value) => applyState({ type: value, page: 1 })}
              options={[
                { value: "desktop", label: "客户端" },
                { value: "server", label: "服务端" },
                { value: "remote", label: "远程执行机" }
              ]}
            />
          </Space>
        }
        extra={
          canCreate ? (
            <Button type="primary" onClick={openCreate}>
              添加执行器
            </Button>
          ) : null
        }
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            showIcon
            type="warning"
            message="可信授权升级中"
            description="当前授权状态仅为历史记录，不代表执行器已通过可信凭据和 readiness 校验；新授权和状态同步暂时关闭。"
          />
          <Table<AiExecutorConfig>
            rowKey="id"
            columns={columns}
            dataSource={query.data?.items ?? []}
            loading={query.isFetching}
            scroll={{ x: 1200 }}
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
        width={drawerWidths.standardForm}
        open={drawerOpen}
        title={drawerTitle}
        onClose={() => setDrawerOpen(false)}
        extra={
          <Space>
            {drawerMode === "view" && active && canAuthorize ? (
              <Button disabled title="可信授权桥升级完成后开放">
                可信授权升级中
              </Button>
            ) : null}
            {drawerMode === "view" && active && canUpdate ? <Button onClick={() => setDrawerMode("edit")}>编辑</Button> : null}
            {drawerMode !== "view" ? (
              <Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>
                保存
              </Button>
            ) : null}
          </Space>
        }
      >
        {drawerMode === "view" && active ? (
          <ExecutorDetail item={active} />
        ) : (
          <ExecutorForm form={form} onFinish={(values) => saveMutation.mutate(values)} />
        )}
      </Drawer>
    </>
  );
}

function ExecutorDetail({ item }: { item: AiExecutorConfig }) {
  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Descriptions size="small" bordered column={1}>
        <Descriptions.Item label="名称">{item.name}</Descriptions.Item>
        <Descriptions.Item label="类型">Codex</Descriptions.Item>
        <Descriptions.Item label="运行时">{RUNTIME_META[item.runtimeType]?.label ?? item.runtimeType}</Descriptions.Item>
        <Descriptions.Item label="状态">{item.status === "enabled" ? "启用" : "停用"}</Descriptions.Item>
        <Descriptions.Item label="授权状态">{AUTH_META[item.authStatus]?.label ?? item.authStatus}</Descriptions.Item>
        <Descriptions.Item label="授权方式">{item.authMethod || "-"}</Descriptions.Item>
        <Descriptions.Item label="Codex 版本">{item.codexVersion || "-"}</Descriptions.Item>
        <Descriptions.Item label="优先级">{item.priority}</Descriptions.Item>
        <Descriptions.Item label="最大并发">{item.maxConcurrency}</Descriptions.Item>
        <Descriptions.Item label="最近心跳">{formatTime(item.lastHeartbeatAt)}</Descriptions.Item>
        <Descriptions.Item label="最近授权校验">{formatTime(item.lastAuthCheckedAt)}</Descriptions.Item>
        <Descriptions.Item label="备注">{item.remark || "-"}</Descriptions.Item>
      </Descriptions>
      <Alert
        showIcon
        type="warning"
        message="可信授权升级中"
        description="此处显示的授权字段仅用于历史审计；可信授权会话、设备证明和 readiness 上线前不能据此执行脚本维护任务。"
      />
    </Space>
  );
}

function ExecutorForm({
  form,
  onFinish
}: {
  form: ReturnType<typeof Form.useForm<AiExecutorConfigInput>>[0];
  onFinish: (values: AiExecutorConfigInput) => void;
}) {
  return (
    <Form<AiExecutorConfigInput> form={form} layout="vertical" onFinish={onFinish}>
      <Form.Item label="名称" name="name" rules={[{ required: true, message: "请输入执行器名称" }]}>
        <Input placeholder="例如：客户端 Codex / 服务端 Codex" />
      </Form.Item>
      <Form.Item label="执行器类型" name="executorType" rules={[{ required: true }]}>
        <Select options={[{ value: "codex", label: "Codex" }]} />
      </Form.Item>
      <Form.Item label="运行时类型" name="runtimeType" rules={[{ required: true, message: "请选择运行时类型" }]}>
        <Select
          options={[
            { value: "desktop", label: "客户端" },
            { value: "server", label: "服务端" },
            { value: "remote", label: "远程执行机" }
          ]}
        />
      </Form.Item>
      <Space size={16} wrap>
        <Form.Item label="状态" name="status" rules={[{ required: true }]}>
          <Select
            style={{ width: 140 }}
            options={[
              { value: "enabled", label: "启用" },
              { value: "disabled", label: "停用" }
            ]}
          />
        </Form.Item>
        <Form.Item label="优先级" name="priority" rules={[{ required: true }]}>
          <InputNumber min={1} max={9999} />
        </Form.Item>
        <Form.Item label="最大并发" name="maxConcurrency" rules={[{ required: true }]}>
          <InputNumber min={1} max={20} />
        </Form.Item>
      </Space>
      <Space size={24} wrap>
        <Form.Item label="默认执行器" name="isDefault" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="自动修复" name="autoRepairEnabled" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Space>
      <Space size={16} wrap>
        <Form.Item label="触发失败次数" name="triggerFailureCount" rules={[{ required: true }]}>
          <InputNumber min={1} max={10} />
        </Form.Item>
        <Form.Item label="最大修复轮次" name="maxAttempts" rules={[{ required: true }]}>
          <InputNumber min={1} max={10} />
        </Form.Item>
        <Form.Item label="任务超时秒数" name="taskTimeoutSeconds" rules={[{ required: true }]}>
          <InputNumber min={30} max={3600} />
        </Form.Item>
      </Space>
      <Space size={24} wrap>
        <Form.Item label="允许页面操作" name="allowPageActions" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="允许读取 Storage" name="allowStorageRead" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="允许 CDP Runtime" name="allowCdpRuntime" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="允许保存脚本" name="allowScriptSave" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="允许自动激活" name="allowAutoActivate" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Space>
      <Form.Item label="备注" name="remark">
        <Input.TextArea rows={3} placeholder="执行器部署、限制或运维备注" />
      </Form.Item>
    </Form>
  );
}

function toInput(item: AiExecutorConfig): AiExecutorConfigInput {
  return {
    name: item.name,
    executorType: item.executorType,
    runtimeType: item.runtimeType,
    status: item.status,
    isDefault: item.isDefault,
    priority: item.priority,
    autoRepairEnabled: item.autoRepairEnabled,
    triggerFailureCount: item.triggerFailureCount,
    maxAttempts: item.maxAttempts,
    taskTimeoutSeconds: item.taskTimeoutSeconds,
    maxConcurrency: item.maxConcurrency,
    allowPageActions: item.allowPageActions,
    allowStorageRead: item.allowStorageRead,
    allowCdpRuntime: item.allowCdpRuntime,
    allowScriptSave: item.allowScriptSave,
    allowAutoActivate: item.allowAutoActivate,
    remark: item.remark
  };
}

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
