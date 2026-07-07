import { useEffect, useState } from "react";
import { Alert, Button, Form, Input, Modal, Space, Switch, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, useRequestClient, usePermissions } from "@ky/admin-core";
import {
  getStorageSetting,
  rotateStorageSecret,
  testStorageSetting,
  updateStorageSetting,
  type StorageSetting
} from "../api";

export function StoragePage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [form] = Form.useForm();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [newSecret, setNewSecret] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; errorMessage?: string } | null>(null);

  const canUpdate = permissions.can("platform.storage.update");
  const canTest = permissions.can("platform.storage.test");

  const { data, isFetching } = useQuery({ queryKey: ["storage-setting"], queryFn: () => getStorageSetting(client) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["storage-setting"] });

  useEffect(() => {
    if (data) form.setFieldsValue(data);
  }, [data, form]);

  const saveMutation = useMutation({
    mutationFn: (values: Partial<StorageSetting>) => updateStorageSetting(client, values),
    onSuccess: () => {
      void message.success("对象存储配置已保存。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const rotateMutation = useMutation({
    mutationFn: (secret: string) => rotateStorageSecret(client, secret),
    onSuccess: () => {
      void message.success("SecretKey 已更新。");
      setRotateOpen(false);
      setNewSecret("");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const testMutation = useMutation({
    mutationFn: () => testStorageSetting(client),
    onSuccess: (r) => {
      setTestResult(r);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  return (
    <ListPageCard title="对象存储设置" subtitle="S3 兼容对象存储配置(SecretKey 加密存储,永不回显明文)。">
      <div style={{ maxWidth: 640, padding: 16 }}>
        <Form layout="vertical" form={form} disabled={isFetching} onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item label="Provider" name="providerKey" initialValue="s3">
            <Input placeholder="s3 / oss / minio" />
          </Form.Item>
          <Form.Item label="Endpoint" name="endpoint" rules={[{ required: true, message: "请输入 Endpoint" }]}>
            <Input placeholder="https://oss-cn-hangzhou.aliyuncs.com" />
          </Form.Item>
          <Form.Item label="Region" name="region">
            <Input placeholder="cn-hangzhou" />
          </Form.Item>
          <Form.Item label="Bucket" name="bucket" rules={[{ required: true, message: "请输入 Bucket" }]}>
            <Input placeholder="my-bucket" />
          </Form.Item>
          <Form.Item label="Access Key ID" name="accessKeyId">
            <Input placeholder="AccessKeyId" />
          </Form.Item>
          <Form.Item label="Secret Access Key" name="secretAccessKey" extra={data?.hasSecret ? "已配置;留空保留原密钥,更换请用「轮换密钥」。" : "首次配置请填写。"}>
            <Input.Password placeholder={data?.hasSecret ? "留空保留原密钥" : "SecretAccessKey"} />
          </Form.Item>
          <Form.Item label="路径前缀 Prefix" name="prefix">
            <Input placeholder="可选,如 uploads/" />
          </Form.Item>
          <Form.Item label="公网访问域名" name="publicDomain">
            <Input placeholder="https://cdn.example.com" />
          </Form.Item>
          <Space size="large">
            <Form.Item label="私有桶" name="bucketPrivate" valuePropName="checked" initialValue>
              <Switch />
            </Form.Item>
            <Form.Item label="Path-Style(强制路径)" name="forcePathStyle" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>

          {testResult ? (
            <Alert
              style={{ marginBottom: 16 }}
              type={testResult.ok ? "success" : "error"}
              showIcon
              message={testResult.ok ? `连接成功 · 延迟 ${testResult.latencyMs} ms` : "连接失败"}
              description={testResult.ok ? undefined : testResult.errorMessage}
            />
          ) : data?.lastTestStatus ? (
            <Typography.Text type="secondary" style={{ display: "block", marginBottom: 12, fontSize: 12 }}>
              上次测试:{data.lastTestStatus === "success" ? "成功" : `失败(${data.lastTestMessage || "—"})`}
            </Typography.Text>
          ) : null}

          {canUpdate ? (
            <Space>
              <Button type="primary" htmlType="submit" loading={saveMutation.isPending}>
                保存
              </Button>
              <Button onClick={() => setRotateOpen(true)}>轮换密钥</Button>
              {canTest ? (
                <Button loading={testMutation.isPending} onClick={() => testMutation.mutate()}>
                  测试连接
                </Button>
              ) : null}
            </Space>
          ) : null}
        </Form>
      </div>

      <Modal
        title="轮换 Secret Access Key"
        open={rotateOpen}
        onCancel={() => setRotateOpen(false)}
        onOk={() => rotateMutation.mutate(newSecret)}
        confirmLoading={rotateMutation.isPending}
        okButtonProps={{ disabled: !newSecret.trim() }}
        okText="轮换"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary">输入新的 SecretKey,提交后立即加密存储,响应不回显明文。</Typography.Paragraph>
        <Input.Password placeholder="新 SecretAccessKey" value={newSecret} onChange={(e) => setNewSecret(e.target.value)} />
      </Modal>
    </ListPageCard>
  );
}
