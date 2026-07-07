import { useState } from "react";
import { Alert, Button, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, drawerWidths, useRequestClient, usePermissions } from "@ky/admin-core";
import {
  createEmailAccount, createEmailIdentity, createEmailTemplate,
  deleteEmailAccount, deleteEmailIdentity, deleteEmailTemplate,
  listEmailAccounts, listEmailIdentities, listEmailTemplates,
  testEmailTemplate, updateEmailAccount, updateEmailIdentity, updateEmailTemplate,
  type EmailAccount, type EmailIdentity, type EmailTemplate
} from "../api";

const STATUS_OPTS = [{ value: "enabled", label: "启用" }, { value: "disabled", label: "停用" }];
const ENC_OPTS = [{ value: "ssl", label: "SSL(465)" }, { value: "tls", label: "STARTTLS(587)" }, { value: "none", label: "无加密(25)" }];

export function EmailPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const qc = useQueryClient();
  const canUpdate = permissions.can("platform.email.update");
  const canTest = permissions.can("platform.email.test");

  const accountsQ = useQuery({ queryKey: ["email-accounts"], queryFn: () => listEmailAccounts(client) });
  const idsQ = useQuery({ queryKey: ["email-identities"], queryFn: () => listEmailIdentities(client) });
  const tplsQ = useQuery({ queryKey: ["email-templates"], queryFn: () => listEmailTemplates(client) });
  const accounts = accountsQ.data?.items ?? [];
  const identities = idsQ.data?.items ?? [];
  const accName = (id: string) => accounts.find((a) => a.id === id)?.accountName ?? id;
  const inval = (k: string) => qc.invalidateQueries({ queryKey: [k] });
  const accountOptions = accounts.map((a) => ({ value: a.id, label: a.accountName }));

  const [accDrawer, setAccDrawer] = useState(false);
  const [accEditing, setAccEditing] = useState<EmailAccount | null>(null);
  const [accForm] = Form.useForm();
  const accSave = useMutation({
    mutationFn: (v: Record<string, unknown>) => (accEditing ? updateEmailAccount(client, accEditing.id, v) : createEmailAccount(client, v)),
    onSuccess: () => { void message.success("已保存"); setAccDrawer(false); setAccEditing(null); inval("email-accounts"); },
    onError: (e: Error) => message.error(e.message)
  });
  const accDel = useMutation({ mutationFn: (id: string) => deleteEmailAccount(client, id), onSuccess: () => { void message.success("已删除"); inval("email-accounts"); }, onError: (e: Error) => message.error(e.message) });

  const [idDrawer, setIdDrawer] = useState(false);
  const [idEditing, setIdEditing] = useState<EmailIdentity | null>(null);
  const [idForm] = Form.useForm();
  const idSave = useMutation({
    mutationFn: (v: Record<string, unknown>) => (idEditing ? updateEmailIdentity(client, idEditing.id, v) : createEmailIdentity(client, v)),
    onSuccess: () => { void message.success("已保存"); setIdDrawer(false); setIdEditing(null); inval("email-identities"); },
    onError: (e: Error) => message.error(e.message)
  });
  const idDel = useMutation({ mutationFn: (id: string) => deleteEmailIdentity(client, id), onSuccess: () => { void message.success("已删除"); inval("email-identities"); }, onError: (e: Error) => message.error(e.message) });

  const [tplDrawer, setTplDrawer] = useState(false);
  const [tplEditing, setTplEditing] = useState<EmailTemplate | null>(null);
  const [tplForm] = Form.useForm();
  const tplSave = useMutation({
    mutationFn: (v: Record<string, unknown>) => (tplEditing ? updateEmailTemplate(client, tplEditing.id, v) : createEmailTemplate(client, v)),
    onSuccess: () => { void message.success("已保存"); setTplDrawer(false); setTplEditing(null); inval("email-templates"); },
    onError: (e: Error) => message.error(e.message)
  });
  const tplDel = useMutation({ mutationFn: (id: string) => deleteEmailTemplate(client, id), onSuccess: () => { void message.success("已删除"); inval("email-templates"); }, onError: (e: Error) => message.error(e.message) });
  const [testTpl, setTestTpl] = useState<EmailTemplate | null>(null);
  const [testEmail, setTestEmail] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; errorMessage?: string } | null>(null);
  const testMut = useMutation({ mutationFn: (to: string) => testEmailTemplate(client, testTpl!.id, to), onSuccess: (r) => setTestResult(r), onError: (e: Error) => message.error(e.message) });

  const statusTag = (v: string) => <Tag color={v === "enabled" ? "green" : "default"}>{v === "enabled" ? "启用" : "停用"}</Tag>;

  const accCols: ColumnsType<EmailAccount> = [
    { title: "账号", dataIndex: "accountName", key: "n" },
    { title: "SMTP", key: "smtp", render: (_, r) => `${r.host}:${r.port} (${r.encryption})` },
    { title: "用户名", key: "u", render: (_, r) => `${r.username} / ${r.hasPassword ? "密码已配" : "未配密码"}` },
    { title: "发件人", key: "from", render: (_, r) => r.fromEmail || "—" },
    { title: "状态", dataIndex: "status", key: "s", width: 80, render: statusTag },
    { title: "操作", key: "a", className: "table-action-column", width: 180, render: (_, r) => canUpdate ? (
      <Space className="table-action-grid" size={4} wrap>
        <Button size="small" type="link" onClick={() => { setAccEditing(r); accForm.setFieldsValue({ ...r, password: "" }); setAccDrawer(true); }}>编辑</Button>
        <Popconfirm title="删除该账号及其身份/模板？" okText="删除" cancelText="取消" onConfirm={() => accDel.mutate(r.id)}><Button size="small" type="link" danger>删除</Button></Popconfirm>
      </Space>) : null }
  ];
  const idCols: ColumnsType<EmailIdentity> = [
    { title: "身份名称", dataIndex: "identityName", key: "n" },
    { title: "所属账号", key: "acc", render: (_, r) => accName(r.accountId) },
    { title: "发件邮箱", dataIndex: "fromEmail", key: "fe" },
    { title: "状态", dataIndex: "status", key: "s", width: 80, render: statusTag },
    { title: "操作", key: "a", className: "table-action-column", width: 180, render: (_, r) => canUpdate ? (
      <Space className="table-action-grid" size={4} wrap>
        <Button size="small" type="link" onClick={() => { setIdEditing(r); idForm.setFieldsValue(r); setIdDrawer(true); }}>编辑</Button>
        <Popconfirm title="删除该身份？" okText="删除" cancelText="取消" onConfirm={() => idDel.mutate(r.id)}><Button size="small" type="link" danger>删除</Button></Popconfirm>
      </Space>) : null }
  ];
  const tplCols: ColumnsType<EmailTemplate> = [
    { title: "场景", dataIndex: "scene", key: "sc" },
    { title: "主题", dataIndex: "subject", key: "su" },
    { title: "所属账号", key: "acc", render: (_, r) => accName(r.accountId) },
    { title: "状态", dataIndex: "status", key: "s", width: 80, render: statusTag },
    { title: "操作", key: "a", className: "table-action-column", width: 220, render: (_, r) => canUpdate ? (
      <Space className="table-action-grid" size={4} wrap>
        <Button size="small" type="link" onClick={() => { setTplEditing(r); tplForm.setFieldsValue(r); setTplDrawer(true); }}>编辑</Button>
        {canTest ? <Button size="small" type="link" onClick={() => { setTestTpl(r); setTestEmail(""); setTestResult(null); }}>测试</Button> : null}
        <Popconfirm title="删除该模板？" okText="删除" cancelText="取消" onConfirm={() => tplDel.mutate(r.id)}><Button size="small" type="link" danger>删除</Button></Popconfirm>
      </Space>) : null }
  ];

  return (
    <ListPageCard title="邮件服务" subtitle="管理 SMTP 账号、发件身份与场景模板(密码加密存储),支持真实发送测试。">
      <div style={{ padding: 16 }}>
        <Tabs items={[
          { key: "accounts", label: "账号", children: <>
            {canUpdate ? <Button type="primary" style={{ marginBottom: 12 }} onClick={() => { setAccEditing(null); accForm.resetFields(); accForm.setFieldsValue({ encryption: "ssl", port: 465, status: "enabled" }); setAccDrawer(true); }}>新建账号</Button> : null}
            <Table<EmailAccount> rowKey="id" size="small" columns={accCols} dataSource={accounts} loading={accountsQ.isFetching} pagination={false} />
          </> },
          { key: "identities", label: "发件身份", children: <>
            {canUpdate ? <Button type="primary" style={{ marginBottom: 12 }} disabled={!accounts.length} onClick={() => { setIdEditing(null); idForm.resetFields(); idForm.setFieldsValue({ status: "enabled" }); setIdDrawer(true); }}>新建身份</Button> : null}
            <Table<EmailIdentity> rowKey="id" size="small" columns={idCols} dataSource={identities} loading={idsQ.isFetching} pagination={false} />
          </> },
          { key: "templates", label: "场景模板", children: <>
            {canUpdate ? <Button type="primary" style={{ marginBottom: 12 }} disabled={!accounts.length} onClick={() => { setTplEditing(null); tplForm.resetFields(); tplForm.setFieldsValue({ status: "enabled", codeVariable: "code", codeTtlSeconds: 300, dailyLimit: 10, intervalSeconds: 60 }); setTplDrawer(true); }}>新建模板</Button> : null}
            <Table<EmailTemplate> rowKey="id" size="small" columns={tplCols} dataSource={tplsQ.data?.items ?? []} loading={tplsQ.isFetching} pagination={false} />
          </> }
        ]} />
      </div>

      <Drawer title={accEditing ? "编辑账号" : "新建账号"} width={drawerWidths.standardForm} open={accDrawer} onClose={() => setAccDrawer(false)} destroyOnClose
        extra={<Space><Button onClick={() => setAccDrawer(false)}>取消</Button><Button type="primary" loading={accSave.isPending} onClick={() => accForm.submit()}>保存</Button></Space>}>
        <Form form={accForm} layout="vertical" onFinish={(v) => accSave.mutate(v)}>
          <Form.Item label="账号名称" name="accountName" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="SMTP 主机" name="host" rules={[{ required: true }]}><Input placeholder="smtp.exmail.qq.com" /></Form.Item>
          <Form.Item label="端口" name="port" initialValue={465}><InputNumber min={1} max={65535} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="加密方式" name="encryption" initialValue="ssl"><Select options={ENC_OPTS} /></Form.Item>
          <Form.Item label="用户名" name="username" rules={[{ required: true }]}><Input placeholder="noreply@example.com" /></Form.Item>
          <Form.Item label="密码 / 授权码" name="password" extra={accEditing?.hasPassword ? "已配置;留空保留原密码" : "首次配置请填写"}><Input.Password placeholder={accEditing?.hasPassword ? "留空保留" : ""} /></Form.Item>
          <Form.Item label="发件邮箱" name="fromEmail"><Input placeholder="noreply@example.com" /></Form.Item>
          <Form.Item label="发件人名称" name="fromName"><Input /></Form.Item>
          <Form.Item label="回复邮箱" name="replyToEmail"><Input /></Form.Item>
          <Form.Item label="状态" name="status" initialValue="enabled"><Select options={STATUS_OPTS} /></Form.Item>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Drawer>

      <Drawer title={idEditing ? "编辑身份" : "新建身份"} width={drawerWidths.standardForm} open={idDrawer} onClose={() => setIdDrawer(false)} destroyOnClose
        extra={<Space><Button onClick={() => setIdDrawer(false)}>取消</Button><Button type="primary" loading={idSave.isPending} onClick={() => idForm.submit()}>保存</Button></Space>}>
        <Form form={idForm} layout="vertical" onFinish={(v) => idSave.mutate(v)}>
          <Form.Item label="所属账号" name="accountId" rules={[{ required: true }]}><Select disabled={Boolean(idEditing)} options={accountOptions} /></Form.Item>
          <Form.Item label="身份名称" name="identityName" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="发件邮箱" name="fromEmail"><Input /></Form.Item>
          <Form.Item label="发件人名称" name="fromName"><Input /></Form.Item>
          <Form.Item label="回复邮箱" name="replyToEmail"><Input /></Form.Item>
          <Form.Item label="状态" name="status" initialValue="enabled"><Select options={STATUS_OPTS} /></Form.Item>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Drawer>

      <Drawer title={tplEditing ? "编辑模板" : "新建模板"} width={drawerWidths.standardForm} open={tplDrawer} onClose={() => setTplDrawer(false)} destroyOnClose
        extra={<Space><Button onClick={() => setTplDrawer(false)}>取消</Button><Button type="primary" loading={tplSave.isPending} onClick={() => tplForm.submit()}>保存</Button></Space>}>
        <Form form={tplForm} layout="vertical" onFinish={(v) => tplSave.mutate(v)}>
          <Form.Item label="所属账号" name="accountId" rules={[{ required: true }]}><Select disabled={Boolean(tplEditing)} options={accountOptions} /></Form.Item>
          <Form.Item label="发件身份(可选)" name="identityId"><Select allowClear options={identities.map((i) => ({ value: i.id, label: i.identityName }))} /></Form.Item>
          <Form.Item label="场景" name="scene" rules={[{ required: true }]}><Select options={[{ value: "login_code", label: "登录验证码" }, { value: "register_code", label: "注册验证码" }, { value: "reset_password", label: "找回密码" }, { value: "bind_email", label: "绑定邮箱" }]} /></Form.Item>
          <Form.Item label="主题" name="subject" rules={[{ required: true }]}><Input placeholder="支持 {{变量}}" /></Form.Item>
          <Form.Item label="正文" name="body"><Input.TextArea rows={5} placeholder="支持 {{code}} 等变量" /></Form.Item>
          <Form.Item label="验证码变量名" name="codeVariable" initialValue="code"><Input /></Form.Item>
          <Form.Item label="验证码有效期(秒)" name="codeTtlSeconds" initialValue={300}><InputNumber min={30} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="每日上限" name="dailyLimit" initialValue={10}><InputNumber min={1} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="发送间隔(秒)" name="intervalSeconds" initialValue={60}><InputNumber min={0} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="状态" name="status" initialValue="enabled"><Select options={STATUS_OPTS} /></Form.Item>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Drawer>

      <Modal title="邮件发送测试" open={Boolean(testTpl)} onCancel={() => setTestTpl(null)} okText="发送测试" cancelText="关闭"
        confirmLoading={testMut.isPending} okButtonProps={{ disabled: !testEmail.trim() }} onOk={() => testMut.mutate(testEmail.trim())}>
        <Input placeholder="测试收件邮箱" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} style={{ marginBottom: 12 }} />
        {testResult ? <Alert type={testResult.ok ? "success" : "error"} showIcon message={testResult.ok ? `发送成功 · 延迟 ${testResult.latencyMs} ms` : "发送失败"} description={testResult.ok ? undefined : testResult.errorMessage} /> : null}
      </Modal>
    </ListPageCard>
  );
}
