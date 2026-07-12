import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePermissions, useRequestClient } from "@ky/admin-core";
import {
  AI_EXECUTOR_COMMAND_ROUTES_READY,
  checkAiExecutorReadiness,
  deleteAiExecutorWorkspaceGrant,
  listAiExecutorModels,
  listAiExecutorWorkspaceGrants,
  putAiExecutorWorkspaceGrant,
  refreshAiExecutorModelCatalog,
  revokeAiExecutorCredential,
  updateAiExecutor,
  verifyAiExecutorCredential,
  type AiExecutorConfig,
  type AiExecutorModelCatalogItem,
  type AiExecutorWorkspaceGrant
} from "../api";
import { AI_EXECUTOR_PERMISSIONS } from "../permissions";
import { ExecutorAuthorizationPanel } from "./executor-authorization-panel";

export function ExecutorControlPanel({ executor, onExecutorChanged }: { executor: AiExecutorConfig; onExecutorChanged: () => void }) {
  return (
    <Tabs
      destroyInactiveTabPane={false}
      items={[
        { key: "overview", label: "运行状态", children: <ExecutorOverview executor={executor} onExecutorChanged={onExecutorChanged} /> },
        { key: "authorization", label: "协助授权", children: <ExecutorAuthorizationPanel executor={executor} onExecutorChanged={onExecutorChanged} /> },
        { key: "models", label: "Codex 模型", children: <ExecutorModels executor={executor} onExecutorChanged={onExecutorChanged} /> },
        { key: "grants", label: "发布范围", children: <ExecutorWorkspaceGrants executor={executor} /> }
      ]}
    />
  );
}

function ExecutorOverview({ executor, onExecutorChanged }: { executor: AiExecutorConfig; onExecutorChanged: () => void }) {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const canUpdate = permissions.can(AI_EXECUTOR_PERMISSIONS.update);
  const canChangeAccount = permissions.can(AI_EXECUTOR_PERMISSIONS.authorize) && permissions.can(AI_EXECUTOR_PERMISSIONS.changeAccount);

  const commandMutation = useMutation({
    mutationFn: (action: "readiness" | "verify" | "revoke") => {
      if (action === "readiness") return checkAiExecutorReadiness(client, executor);
      if (action === "verify") return verifyAiExecutorCredential(client, executor);
      return revokeAiExecutorCredential(client, executor, { force: false });
    },
    onSuccess: () => {
      void message.success("命令已提交，可在执行器任务中查看进度");
      onExecutorChanged();
      void queryClient.invalidateQueries({ queryKey: ["ai-executor-tasks"] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      {!AI_EXECUTOR_COMMAND_ROUTES_READY ? (
        <Alert
          showIcon
          type="warning"
          message="运行命令保持关闭"
          description="当前服务尚未注册目录刷新、凭据复核、readiness 与注销路由。页面只展示数据库安全投影，不会回退调用旧服务。"
        />
      ) : null}
      <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="执行器 ID">{executor.id}</Descriptions.Item>
        <Descriptions.Item label="运行时">{executor.runtimeType === "server" ? "服务端" : "客户端"}</Descriptions.Item>
        <Descriptions.Item label="配置修订">{executor.configRevision}</Descriptions.Item>
        <Descriptions.Item label="凭据状态"><CredentialTag value={executor.credentialStatus} /></Descriptions.Item>
        <Descriptions.Item label="凭据修订">{executor.currentCredentialRevision ?? "-"}</Descriptions.Item>
        <Descriptions.Item label="Readiness"><ReadinessTag value={executor.readinessStatus} /></Descriptions.Item>
        <Descriptions.Item label="Readiness 原因">{readinessReason(executor.readinessReasonCode)}</Descriptions.Item>
        <Descriptions.Item label="脚本维护可用">{executor.scriptMaintenanceReady ? <Tag color="green">可用</Tag> : <Tag color="red">阻断</Tag>}</Descriptions.Item>
        <Descriptions.Item label="默认 Codex 模型">{executor.defaultModelKey || "未设置"}</Descriptions.Item>
        <Descriptions.Item label="目录修订">{executor.catalogRevision}</Descriptions.Item>
        <Descriptions.Item label="最后观测">{formatTime(executor.readinessObservedAt)}</Descriptions.Item>
      </Descriptions>
      <Space wrap>
        <Button
          disabled={!AI_EXECUTOR_COMMAND_ROUTES_READY || !canUpdate || executor.currentCredentialRevision == null}
          loading={commandMutation.isPending}
          onClick={() => commandMutation.mutate("verify")}
        >
          复核凭据
        </Button>
        <Button
          disabled={!AI_EXECUTOR_COMMAND_ROUTES_READY || !canUpdate || executor.currentCredentialRevision == null}
          loading={commandMutation.isPending}
          onClick={() => commandMutation.mutate("readiness")}
        >
          检查 Readiness
        </Button>
        {executor.credentialStatus === "authorized" ? (
          <Popconfirm
            title="确认注销当前凭据？"
            description="存在活动任务时服务端会拒绝普通注销。"
            onConfirm={() => commandMutation.mutate("revoke")}
          >
            <Button danger disabled={!AI_EXECUTOR_COMMAND_ROUTES_READY || !canChangeAccount} loading={commandMutation.isPending}>
              注销凭据
            </Button>
          </Popconfirm>
        ) : null}
      </Space>
    </Space>
  );
}

function ExecutorModels({ executor, onExecutorChanged }: { executor: AiExecutorConfig; onExecutorChanged: () => void }) {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [selectedModel, setSelectedModel] = useState<string | null>(executor.defaultModelKey);
  const canUpdate = permissions.can(AI_EXECUTOR_PERMISSIONS.update);
  const query = useQuery({
    queryKey: ["ai-executor-models", executor.id, executor.catalogRevision],
    queryFn: () => listAiExecutorModels(client, executor.id)
  });

  useEffect(() => setSelectedModel(executor.defaultModelKey), [executor.defaultModelKey, executor.id]);

  const saveMutation = useMutation({
    mutationFn: () => updateAiExecutor(client, executor.id, { expectedRevision: executor.configRevision, defaultModelKey: selectedModel }),
    onSuccess: () => {
      void message.success("执行器默认模型已保存");
      onExecutorChanged();
      void queryClient.invalidateQueries({ queryKey: ["ai-executors"] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  const refreshMutation = useMutation({
    mutationFn: () => refreshAiExecutorModelCatalog(client, executor),
    onSuccess: () => {
      void message.success("模型目录刷新任务已提交");
      void queryClient.invalidateQueries({ queryKey: ["ai-executor-tasks"] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  const models = query.data?.items ?? [];
  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card size="small" title="默认模型">
        <Space wrap>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ minWidth: 280 }}
            placeholder="请选择当前目录中的可用模型"
            value={selectedModel}
            onChange={(value) => setSelectedModel(value ?? null)}
            options={models
              .filter((item) => !item.hidden && item.status === "available")
              .map((item) => ({ value: item.modelKey, label: `${item.displayName || item.modelKey} (${item.modelKey})` }))}
          />
          <Button type="primary" disabled={!canUpdate || selectedModel === executor.defaultModelKey} loading={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            保存默认模型
          </Button>
          <Button disabled={!AI_EXECUTOR_COMMAND_ROUTES_READY || !canUpdate} loading={refreshMutation.isPending} onClick={() => refreshMutation.mutate()}>
            刷新目录
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12 }}>
          脚本未指定 modelKeyOverride 时继承此值；不会回退到平台 API Provider 默认模型。
        </Typography.Paragraph>
      </Card>
      <Table<AiExecutorModelCatalogItem>
        rowKey="catalogItemId"
        size="small"
        loading={query.isFetching}
        dataSource={models}
        pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前目录暂无模型" /> }}
        columns={[
          { title: "模型", key: "model", render: (_, item) => <Space direction="vertical" size={0}><Typography.Text strong>{item.displayName || item.modelKey}</Typography.Text><Typography.Text type="secondary">{item.modelKey}</Typography.Text></Space> },
          { title: "输入模态", dataIndex: "inputModalities", render: (value: string[]) => value?.join(" / ") || "-" },
          { title: "状态", key: "status", render: (_, item) => item.hidden ? <Tag>隐藏</Tag> : <Tag color={item.status === "available" ? "green" : "orange"}>{item.status}</Tag> },
          { title: "Codex 版本", dataIndex: "codexVersion" },
          { title: "最后发现", dataIndex: "lastSeenAt", render: formatTime }
        ]}
      />
    </Space>
  );
}

function ExecutorWorkspaceGrants({ executor }: { executor: AiExecutorConfig }) {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ workspaceType: AiExecutorWorkspaceGrant["workspaceType"]; workspaceId: string }>();
  const canUpdate = permissions.can(AI_EXECUTOR_PERMISSIONS.update);
  const query = useQuery({
    queryKey: ["ai-executor-workspace-grants", executor.id],
    queryFn: () => listAiExecutorWorkspaceGrants(client, executor.id)
  });
  const grants = query.data?.items ?? [];

  const putMutation = useMutation({
    mutationFn: (input: { workspaceType: AiExecutorWorkspaceGrant["workspaceType"]; workspaceId: string }) => {
      const workspaceId = input.workspaceId.trim();
      const current = grants.find((item) => item.workspaceType === input.workspaceType && item.workspaceId === workspaceId);
      return putAiExecutorWorkspaceGrant(client, executor.id, input.workspaceType, workspaceId, current?.revision ?? 0);
    },
    onSuccess: () => {
      form.resetFields();
      void message.success("执行器发布范围已保存");
      void queryClient.invalidateQueries({ queryKey: ["ai-executor-workspace-grants", executor.id] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  const deleteMutation = useMutation({
    mutationFn: (grant: AiExecutorWorkspaceGrant) => deleteAiExecutorWorkspaceGrant(client, grant),
    onSuccess: () => {
      void message.success("执行器发布范围已撤销");
      void queryClient.invalidateQueries({ queryKey: ["ai-executor-workspace-grants", executor.id] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Alert showIcon type="info" message="Workspace grant 与操作者权限是独立条件" description="下级工作区只会读取 ID、名称、runtime、readiness 和脚本维护能力安全摘要。" />
      {canUpdate ? (
        <Form form={form} layout="inline" initialValues={{ workspaceType: "enterprise" }} onFinish={(values) => putMutation.mutate(values)}>
          <Form.Item name="workspaceType" rules={[{ required: true }]}>
            <Select style={{ width: 140 }} options={[{ value: "platform", label: "平台" }, { value: "agency", label: "机构" }, { value: "enterprise", label: "企业" }]} />
          </Form.Item>
          <Form.Item name="workspaceId" rules={[{ required: true, message: "请输入 Workspace ID" }]}>
            <Input style={{ width: 260 }} placeholder="Workspace ID" autoComplete="off" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={putMutation.isPending}>发布/恢复</Button>
          </Form.Item>
        </Form>
      ) : null}
      <Table<AiExecutorWorkspaceGrant>
        rowKey="id"
        size="small"
        loading={query.isFetching}
        dataSource={grants}
        pagination={false}
        columns={[
          { title: "Workspace 类型", dataIndex: "workspaceType" },
          { title: "Workspace ID", dataIndex: "workspaceId" },
          { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={value === "enabled" ? "green" : "default"}>{value}</Tag> },
          { title: "Revision", dataIndex: "revision" },
          { title: "更新时间", dataIndex: "updatedAt", render: formatTime },
          { title: "操作", key: "action", render: (_, grant) => canUpdate && grant.status === "enabled" ? <Popconfirm title="确认撤销该发布范围？" onConfirm={() => deleteMutation.mutate(grant)}><Button danger type="link" size="small">撤销</Button></Popconfirm> : null }
        ]}
      />
    </Space>
  );
}

export function CredentialTag({ value }: { value: string }) {
  const meta: Record<string, { label: string; color: string }> = {
    unknown: { label: "未知", color: "default" },
    not_authorized: { label: "未授权", color: "default" },
    authorized: { label: "已授权", color: "green" },
    expired: { label: "已过期", color: "orange" },
    revoked: { label: "已注销", color: "red" }
  };
  const item = meta[value] ?? { label: value, color: "default" };
  return <Tag color={item.color}>{item.label}</Tag>;
}

export function ReadinessTag({ value }: { value: string }) {
  const color = value === "ready" ? "green" : value === "degraded" ? "orange" : value === "unavailable" ? "red" : "default";
  return <Tag color={color}>{value}</Tag>;
}

function readinessReason(value: string) {
  const labels: Record<string, string> = {
    network_error: "网络异常",
    model_unavailable: "模型不可用",
    default_model_missing: "未设置默认模型",
    quota_exceeded: "额度不足",
    runtime_error: "运行时异常",
    desktop_offline: "客户端离线",
    credential_expired: "凭据已过期"
  };
  return labels[value] ?? (value || "-");
}

function formatTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
}
