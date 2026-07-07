import { useState } from "react";
import { Alert, Button, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, drawerWidths, useRequestClient, usePermissions } from "@ky/admin-core";
import {
  createSMSAccount, createSMSSignature, createSMSTemplate,
  deleteSMSAccount, deleteSMSSignature, deleteSMSTemplate,
  listSMSAccounts, listSMSSignatures, listSMSTemplates,
  testSMSTemplate, updateSMSAccount, updateSMSSignature, updateSMSTemplate,
  type SMSAccount, type SMSSignature, type SMSTemplate
} from "../api";

const STATUS_OPTS = [{ value: "enabled", label: "启用" }, { value: "disabled", label: "停用" }];

export function SmsPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const qc = useQueryClient();
  const canUpdate = permissions.can("platform.sms.update");
  const canTest = permissions.can("platform.sms.test");

  const accountsQ = useQuery({ queryKey: ["sms-accounts"], queryFn: () => listSMSAccounts(client) });
  const sigsQ = useQuery({ queryKey: ["sms-signatures"], queryFn: () => listSMSSignatures(client) });
  const tplsQ = useQuery({ queryKey: ["sms-templates"], queryFn: () => listSMSTemplates(client) });
  const accounts = accountsQ.data?.items ?? [];
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.accountName ?? id;
  const inval = (k: string) => qc.invalidateQueries({ queryKey: [k] });

  // --- account drawer ---
  const [accDrawer, setAccDrawer] = useState(false);
  const [accEditing, setAccEditing] = useState<SMSAccount | null>(null);
  const [accForm] = Form.useForm();
  const accSave = useMutation({
    mutationFn: (v: Record<string, unknown>) => (accEditing ? updateSMSAccount(client, accEditing.id, v) : createSMSAccount(client, v)),
    onSuccess: () => { void message.success("已保存"); setAccDrawer(false); setAccEditing(null); inval("sms-accounts"); },
    onError: (e: Error) => message.error(e.message)
  });
  const accDel = useMutation({ mutationFn: (id: string) => deleteSMSAccount(client, id), onSuccess: () => { void message.success("已删除"); inval("sms-accounts"); }, onError: (e: Error) => message.error(e.message) });

  // --- signature drawer ---
  const [sigDrawer, setSigDrawer] = useState(false);
  const [sigEditing, setSigEditing] = useState<SMSSignature | null>(null);
  const [sigForm] = Form.useForm();
  const sigSave = useMutation({
    mutationFn: (v: Record<string, unknown>) => (sigEditing ? updateSMSSignature(client, sigEditing.id, v) : createSMSSignature(client, v)),
    onSuccess: () => { void message.success("已保存"); setSigDrawer(false); setSigEditing(null); inval("sms-signatures"); },
    onError: (e: Error) => message.error(e.message)
  });
  const sigDel = useMutation({ mutationFn: (id: string) => deleteSMSSignature(client, id), onSuccess: () => { void message.success("已删除"); inval("sms-signatures"); }, onError: (e: Error) => message.error(e.message) });

  // --- template drawer + test ---
  const [tplDrawer, setTplDrawer] = useState(false);
  const [tplEditing, setTplEditing] = useState<SMSTemplate | null>(null);
  const [tplForm] = Form.useForm();
  const tplSave = useMutation({
    mutationFn: (v: Record<string, unknown>) => (tplEditing ? updateSMSTemplate(client, tplEditing.id, v) : createSMSTemplate(client, v)),
    onSuccess: () => { void message.success("已保存"); setTplDrawer(false); setTplEditing(null); inval("sms-templates"); },
    onError: (e: Error) => message.error(e.message)
  });
  const tplDel = useMutation({ mutationFn: (id: string) => deleteSMSTemplate(client, id), onSuccess: () => { void message.success("已删除"); inval("sms-templates"); }, onError: (e: Error) => message.error(e.message) });
  const [testTpl, setTestTpl] = useState<SMSTemplate | null>(null);
  const [testPhone, setTestPhone] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; errorMessage?: string } | null>(null);
  const testMut = useMutation({ mutationFn: (phone: string) => testSMSTemplate(client, testTpl!.id, phone), onSuccess: (r) => setTestResult(r), onError: (e: Error) => message.error(e.message) });

  const accCols: ColumnsType<SMSAccount> = [
    { title: "账号", dataIndex: "accountName", key: "name" },
    { title: "Provider", dataIndex: "providerKey", key: "p", width: 100 },
    { title: "Region", dataIndex: "region", key: "r", width: 120 },
    { title: "AccessKey", key: "ak", render: (_, r) => `${r.accessKeyId || "—"} / ${r.hasSecret ? "密钥已配" : "未配密钥"}` },
    { title: "状态", dataIndex: "status", key: "s", width: 80, render: (v) => <Tag color={v === "enabled" ? "green" : "default"}>{v === "enabled" ? "启用" : "停用"}</Tag> },
    { title: "操作", key: "a", className: "table-action-column", width: 180, render: (_, r) => canUpdate ? (
      <Space className="table-action-grid" size={4} wrap>
        <Button size="small" type="link" onClick={() => { setAccEditing(r); accForm.setFieldsValue({ ...r, accessKeySecret: "" }); setAccDrawer(true); }}>编辑</Button>
        <Popconfirm title="删除该账号及其签名/模板？" okText="删除" cancelText="取消" onConfirm={() => accDel.mutate(r.id)}><Button size="small" type="link" danger>删除</Button></Popconfirm>
      </Space>) : null }
  ];
  const sigCols: ColumnsType<SMSSignature> = [
    { title: "签名", dataIndex: "signatureName", key: "n" },
    { title: "所属账号", key: "acc", render: (_, r) => accountName(r.accountId) },
    { title: "状态", dataIndex: "status", key: "s", width: 80, render: (v) => <Tag color={v === "enabled" ? "green" : "default"}>{v === "enabled" ? "启用" : "停用"}</Tag> },
    { title: "操作", key: "a", className: "table-action-column", width: 180, render: (_, r) => canUpdate ? (
      <Space className="table-action-grid" size={4} wrap>
        <Button size="small" type="link" onClick={() => { setSigEditing(r); sigForm.setFieldsValue(r); setSigDrawer(true); }}>编辑</Button>
        <Popconfirm title="删除该签名？" okText="删除" cancelText="取消" onConfirm={() => sigDel.mutate(r.id)}><Button size="small" type="link" danger>删除</Button></Popconfirm>
      </Space>) : null }
  ];
  const tplCols: ColumnsType<SMSTemplate> = [
    { title: "场景", dataIndex: "scene", key: "sc" },
    { title: "模板Code", dataIndex: "templateCode", key: "tc" },
    { title: "所属账号", key: "acc", render: (_, r) => accountName(r.accountId) },
    { title: "验证码有效期", key: "ttl", render: (_, r) => `${r.codeTtlSeconds}s / 日限${r.dailyLimit} / 间隔${r.intervalSeconds}s` },
    { title: "状态", dataIndex: "status", key: "s", width: 80, render: (v) => <Tag color={v === "enabled" ? "green" : "default"}>{v === "enabled" ? "启用" : "停用"}</Tag> },
    { title: "操作", key: "a", className: "table-action-column", width: 220, render: (_, r) => canUpdate ? (
      <Space className="table-action-grid" size={4} wrap>
        <Button size="small" type="link" onClick={() => { setTplEditing(r); tplForm.setFieldsValue(r); setTplDrawer(true); }}>编辑</Button>
        {canTest ? <Button size="small" type="link" onClick={() => { setTestTpl(r); setTestPhone(""); setTestResult(null); }}>测试</Button> : null}
        <Popconfirm title="删除该模板？" okText="删除" cancelText="取消" onConfirm={() => tplDel.mutate(r.id)}><Button size="small" type="link" danger>删除</Button></Popconfirm>
      </Space>) : null }
  ];

  const accountOptions = accounts.map((a) => ({ value: a.id, label: a.accountName }));

  return (
    <ListPageCard title="短信服务" subtitle="管理短信账号、签名与场景模板(AccessKey 加密存储),支持真实发送测试。">
      <div style={{ padding: 16 }}>
        <Tabs
          items={[
            {
              key: "accounts", label: "账号",
              children: <>
                {canUpdate ? <Button type="primary" style={{ marginBottom: 12 }} onClick={() => { setAccEditing(null); accForm.resetFields(); accForm.setFieldsValue({ providerKey: "aliyun", status: "enabled" }); setAccDrawer(true); }}>新建账号</Button> : null}
                <Table<SMSAccount> rowKey="id" size="small" columns={accCols} dataSource={accounts} loading={accountsQ.isFetching} pagination={false} />
              </>
            },
            {
              key: "signatures", label: "签名",
              children: <>
                {canUpdate ? <Button type="primary" style={{ marginBottom: 12 }} disabled={!accounts.length} onClick={() => { setSigEditing(null); sigForm.resetFields(); sigForm.setFieldsValue({ status: "enabled" }); setSigDrawer(true); }}>新建签名</Button> : null}
                <Table<SMSSignature> rowKey="id" size="small" columns={sigCols} dataSource={sigsQ.data?.items ?? []} loading={sigsQ.isFetching} pagination={false} />
              </>
            },
            {
              key: "templates", label: "场景模板",
              children: <>
                {canUpdate ? <Button type="primary" style={{ marginBottom: 12 }} disabled={!accounts.length} onClick={() => { setTplEditing(null); tplForm.resetFields(); tplForm.setFieldsValue({ status: "enabled", codeVariable: "code", codeTtlSeconds: 300, dailyLimit: 10, intervalSeconds: 60 }); setTplDrawer(true); }}>新建模板</Button> : null}
                <Table<SMSTemplate> rowKey="id" size="small" columns={tplCols} dataSource={tplsQ.data?.items ?? []} loading={tplsQ.isFetching} pagination={false} />
              </>
            }
          ]}
        />
      </div>

      <Drawer title={accEditing ? "编辑账号" : "新建账号"} width={drawerWidths.standardForm} open={accDrawer} onClose={() => setAccDrawer(false)} destroyOnClose
        extra={<Space><Button onClick={() => setAccDrawer(false)}>取消</Button><Button type="primary" loading={accSave.isPending} onClick={() => accForm.submit()}>保存</Button></Space>}>
        <Form form={accForm} layout="vertical" onFinish={(v) => accSave.mutate(v)}>
          <Form.Item label="账号名称" name="accountName" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="Provider" name="providerKey" initialValue="aliyun"><Select options={[{ value: "aliyun", label: "阿里云短信" }]} /></Form.Item>
          <Form.Item label="Region" name="region"><Input placeholder="cn-hangzhou" /></Form.Item>
          <Form.Item label="AccessKey ID" name="accessKeyId"><Input /></Form.Item>
          <Form.Item label="AccessKey Secret" name="accessKeySecret" extra={accEditing?.hasSecret ? "已配置;留空保留原密钥" : "首次配置请填写"}><Input.Password placeholder={accEditing?.hasSecret ? "留空保留" : ""} /></Form.Item>
          <Form.Item label="默认签名" name="defaultSignatureId"><Select allowClear options={(sigsQ.data?.items ?? []).map((s) => ({ value: s.id, label: s.signatureName }))} /></Form.Item>
          <Form.Item label="状态" name="status" initialValue="enabled"><Select options={STATUS_OPTS} /></Form.Item>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Drawer>

      <Drawer title={sigEditing ? "编辑签名" : "新建签名"} width={drawerWidths.standardForm} open={sigDrawer} onClose={() => setSigDrawer(false)} destroyOnClose
        extra={<Space><Button onClick={() => setSigDrawer(false)}>取消</Button><Button type="primary" loading={sigSave.isPending} onClick={() => sigForm.submit()}>保存</Button></Space>}>
        <Form form={sigForm} layout="vertical" onFinish={(v) => sigSave.mutate(v)}>
          <Form.Item label="所属账号" name="accountId" rules={[{ required: true }]}><Select disabled={Boolean(sigEditing)} options={accountOptions} /></Form.Item>
          <Form.Item label="签名名称" name="signatureName" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="状态" name="status" initialValue="enabled"><Select options={STATUS_OPTS} /></Form.Item>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Drawer>

      <Drawer title={tplEditing ? "编辑模板" : "新建模板"} width={drawerWidths.standardForm} open={tplDrawer} onClose={() => setTplDrawer(false)} destroyOnClose
        extra={<Space><Button onClick={() => setTplDrawer(false)}>取消</Button><Button type="primary" loading={tplSave.isPending} onClick={() => tplForm.submit()}>保存</Button></Space>}>
        <Form form={tplForm} layout="vertical" onFinish={(v) => tplSave.mutate(v)}>
          <Form.Item label="所属账号" name="accountId" rules={[{ required: true }]}><Select disabled={Boolean(tplEditing)} options={accountOptions} /></Form.Item>
          <Form.Item label="场景" name="scene" rules={[{ required: true }]}><Select options={[{ value: "login_code", label: "登录验证码" }, { value: "register_code", label: "注册验证码" }, { value: "reset_password", label: "找回密码" }, { value: "bind_phone", label: "绑定手机" }]} /></Form.Item>
          <Form.Item label="阿里云模板 Code" name="templateCode" rules={[{ required: true }]}><Input placeholder="SMS_xxxxxxxx" /></Form.Item>
          <Form.Item label="验证码变量名" name="codeVariable" initialValue="code"><Input /></Form.Item>
          <Form.Item label="验证码有效期(秒)" name="codeTtlSeconds" initialValue={300}><InputNumber min={30} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="每日上限" name="dailyLimit" initialValue={10}><InputNumber min={1} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="发送间隔(秒)" name="intervalSeconds" initialValue={60}><InputNumber min={0} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="状态" name="status" initialValue="enabled"><Select options={STATUS_OPTS} /></Form.Item>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Drawer>

      <Modal title="短信发送测试" open={Boolean(testTpl)} onCancel={() => setTestTpl(null)} okText="发送测试" cancelText="关闭"
        confirmLoading={testMut.isPending} okButtonProps={{ disabled: !testPhone.trim() }} onOk={() => testMut.mutate(testPhone.trim())}>
        <Input placeholder="测试手机号" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} style={{ marginBottom: 12 }} />
        {testResult ? <Alert type={testResult.ok ? "success" : "error"} showIcon message={testResult.ok ? `发送成功 · 延迟 ${testResult.latencyMs} ms` : "发送失败"} description={testResult.ok ? undefined : testResult.errorMessage} /> : null}
      </Modal>
    </ListPageCard>
  );
}
