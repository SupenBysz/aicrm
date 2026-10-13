import { useEffect, useMemo, useRef, useState } from "react";
import { App as AntdApp, Alert, Button, Form, Input, Modal, Radio, Space, Tabs, Tag, type FormInstance } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, usePermissions, useRequestClient } from "@ky/admin-core";
import { activateStorageProvider, getStorageSetting, testStorageSetting, updateStorageSetting, type StorageSetting, type StorageSettings } from "../api";

type ProviderKey = "local" | "minio" | "oss";
const providerLabels: Record<ProviderKey, string> = { local: "本地存储", minio: "MinIO", oss: "阿里云 OSS" };

function providerDefaults(key: ProviderKey): StorageSetting {
  return { providerKey: key, localDirectory: "./storage", endpoint: "", region: "", bucket: "", bucketPrivate: true, forcePathStyle: key === "minio", prefix: "", publicDomain: "", accessKeyId: "", hasSecret: false, lastTestStatus: "" };
}

function storageFormSnapshot(values: Partial<StorageSetting>): string {
  return JSON.stringify({
    localDirectory: String(values.localDirectory ?? "").trim(),
    endpoint: String(values.endpoint ?? "").trim(),
    region: String(values.region ?? "").trim(),
    bucket: String(values.bucket ?? "").trim(),
    bucketPrivate: Boolean(values.bucketPrivate),
    forcePathStyle: Boolean(values.forcePathStyle),
    prefix: String(values.prefix ?? "").trim(),
    publicDomain: String(values.publicDomain ?? "").trim(),
    accessKeyId: String(values.accessKeyId ?? "").trim(),
    secretAccessKey: String(values.secretAccessKey ?? "")
  });
}

export function StoragePage() {
  const { message } = AntdApp.useApp();
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<StorageSetting>();
  const [activeProvider, setActiveProvider] = useState<ProviderKey>("local");
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; errorCode?: string; errorMessage?: string } | null>(null);
  const providerSnapshots = useRef<Partial<Record<ProviderKey, string>>>({});
  const canUpdate = permissions.can("platform.storage.update");
  const canTest = permissions.can("platform.storage.test");
  const { data, isFetching } = useQuery<StorageSettings>({ queryKey: ["storage-settings"], queryFn: () => getStorageSetting(client) });
  const current = useMemo(() => data?.providers?.[activeProvider] ?? providerDefaults(activeProvider), [activeProvider, data]);

  useEffect(() => {
    if (!data) return;
    setActiveProvider(data.activeStorageProvider || "local");
  }, [data]);
  useEffect(() => {
    form.setFieldsValue({ ...current, secretAccessKey: "" });
    providerSnapshots.current[activeProvider] = storageFormSnapshot({ ...current, secretAccessKey: "" });
    setTestResult(null);
  }, [activeProvider, current, form]);

  const saveMutation = useMutation({
    mutationFn: (input: { provider: ProviderKey; values: StorageSetting }) => updateStorageSetting(client, { ...input.values, providerKey: input.provider, secretAccessKey: input.values.secretAccessKey }),
    onSuccess: (_result, input) => { providerSnapshots.current[input.provider] = storageFormSnapshot(input.values); void message.success(`${providerLabels[input.provider]}配置已保存。`); void queryClient.invalidateQueries({ queryKey: ["storage-settings"] }); form.resetFields(); },
    onError: (error: Error) => message.error(error.message)
  });
  const activateMutation = useMutation({
    mutationFn: () => activateStorageProvider(client, activeProvider),
    onSuccess: () => { void message.success("当前存储已切换。"); void queryClient.invalidateQueries({ queryKey: ["storage-settings"] }); },
    onError: (error: Error) => message.error(error.message)
  });
  const testMutation = useMutation({
    mutationFn: () => testStorageSetting(client, activeProvider),
    onSuccess: (result) => setTestResult(result),
    onError: (error: Error) => message.error(error.message)
  });

  const switchProvider = (next: ProviderKey) => {
    if (next === activeProvider) return;
    const snapshot = providerSnapshots.current[activeProvider];
    const dirty = snapshot !== undefined && storageFormSnapshot(form.getFieldsValue(true)) !== snapshot;
    if (!dirty) { setActiveProvider(next); return; }
    Modal.confirm({ title: "放弃未保存修改？", content: "切换存储类型将放弃当前未保存内容。", okText: "放弃并切换", cancelText: "继续编辑", onOk: () => { form.resetFields(); setActiveProvider(next); } });
  };
  const providerTab = (key: ProviderKey) => ({ key, label: <Space size={8}>{providerLabels[key]} {data?.activeStorageProvider === key ? <Tag color="green">当前使用</Tag> : null}</Space>, forceRender: true, children: <ProviderForm provider={key} current={data?.providers?.[key] ?? providerDefaults(key)} form={form} canUpdate={canUpdate} canTest={canTest} isFetching={isFetching} testResult={testResult} saving={saveMutation.isPending} activating={activateMutation.isPending} onSave={(values) => saveMutation.mutate({ provider: key, values })} onActivate={() => activateMutation.mutate()} onTest={() => testMutation.mutate()} /> });

  return <ListPageCard title="存储设置" subtitle="配置平台文件、图片等资源的存储方式。">
    <div style={{ padding: 16 }}>
      <Tabs className="system-settings-tabs" tabPosition={window.matchMedia("(max-width: 640px)").matches ? "top" : "left"} activeKey={activeProvider} onChange={(key) => switchProvider(key as ProviderKey)} items={(["local", "minio", "oss"] as ProviderKey[]).map(providerTab)} />
    </div>
  </ListPageCard>;
}

function ProviderForm(props: { provider: ProviderKey; current: StorageSetting; form: FormInstance<StorageSetting>; canUpdate: boolean; canTest: boolean; isFetching: boolean; testResult: { ok: boolean; latencyMs: number; errorCode?: string; errorMessage?: string } | null; saving: boolean; activating: boolean; onSave: (values: StorageSetting) => void; onActivate: () => void; onTest: () => void }) {
  const { provider, current, form, canUpdate, canTest, isFetching, testResult, saving, activating, onSave, onActivate, onTest } = props;
  const isLocal = provider === "local";
  return <div style={{ maxWidth: 720, padding: "0 16px" }}>
    <Form form={form} layout="vertical" disabled={isFetching} onFinish={onSave}>
      {isLocal ? <Form.Item label="存储目录" name="localDirectory" extra="默认使用项目目录下的 storage；迁移项目时请一并迁移该目录，也可填写绝对路径覆盖默认值。" rules={[{ required: true, message: "请输入存储目录" }]}><Input placeholder="./storage（项目目录下）" /></Form.Item> : <>
        <Form.Item label="Endpoint" name="endpoint" rules={[{ required: true, message: "请输入 Endpoint" }]}><Input placeholder="https://..." /></Form.Item>
        <Form.Item label="Region" name="region"><Input placeholder="cn-hangzhou" /></Form.Item>
        <Form.Item label="Bucket" name="bucket" rules={[{ required: true, message: "请输入 Bucket" }]}><Input placeholder="my-bucket" /></Form.Item>
        <Form.Item label="Access Key ID" name="accessKeyId"><Input placeholder="AccessKey ID" /></Form.Item>
        <Form.Item label="Secret Access Key" name="secretAccessKey" extra="已配置密钥时留空表示保持原密钥；填写新密钥后保存即可完成替换。"><Input.Password placeholder={current.hasSecret ? "留空保持原密钥" : "请输入密钥"} /></Form.Item>
      </>}
      <Form.Item label="路径前缀" name="prefix"><Input placeholder="可选，例如 uploads/" /></Form.Item>
      <Form.Item label="公网访问域名" name="publicDomain"><Input placeholder="可选，例如 https://cdn.example.com" /></Form.Item>
      <Form.Item label="访问权限" name="bucketPrivate" extra="私有存储需要授权访问；公共读可通过公网地址直接访问。"><Radio.Group options={[{ label: "私有（推荐）", value: true }, { label: "公共读", value: false }]} /></Form.Item>
      {provider === "minio" ? <Form.Item label="路径访问方式" name="forcePathStyle" extra="部分 MinIO 服务需要启用路径模式才能正常访问 Bucket。"><Radio.Group options={[{ label: "路径模式", value: true }, { label: "虚拟主机模式", value: false }]} /></Form.Item> : null}
      {testResult ? <Alert type={testResult.ok ? "success" : "error"} showIcon style={{ marginBottom: 16 }} message={testResult.ok ? `测试成功 · ${testResult.latencyMs} ms` : (testResult.errorCode === "bucket_missing" ? "Bucket 不存在" : testResult.errorCode === "write_failed" ? "写入失败" : "连接失败或无权限")} description={testResult.ok ? undefined : testResult.errorMessage} /> : null}
      {canUpdate ? <Space wrap><Button type="primary" onClick={() => form.submit()} loading={saving}>保存</Button><Button onClick={onActivate} loading={activating}>设为当前存储</Button>{canTest ? <Button onClick={onTest}>测试{isLocal ? "写入" : "连接"}</Button> : null}</Space> : null}
    </Form>
  </div>;
}
