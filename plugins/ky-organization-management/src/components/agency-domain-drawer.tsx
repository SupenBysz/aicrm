import "./organization-drawers.css";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  ConfigProvider,
  Checkbox,
  Button,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCurrentUser,
  useCurrentWorkspace,
  usePermissions,
  useRequestClient,
} from "@ky/admin-core";
export interface DomainBinding {
  id: string;
  agencyId: string;
  hostname: string;
  mode: "managed";
  state: string;
  revision: number;
  generation: number;
  challenge: string;
  expiresAt: string;
  observation: {
    verified?: boolean;
    nameserverChangeRequired?: boolean;
    platformPending?: boolean;
    dnsReady?: boolean;
    tlsReady?: boolean;
    routeReady?: boolean;
    message?: string;
    records?: { type: string; name: string; value: string }[];
    nameservers?: string[];
  };
  tasks?: {
    id: string;
    phase: string;
    state: string;
    message: string;
    nextAt: string;
  }[];
}
export const domainStates: Record<string, string> = {
  awaiting_verification: "待验证所有权",
  awaiting_dns: "待配置解析",
  provisioning: "准备证书及入口",
  ready: "待确认切换",
  active: "已启用",
  degraded: "入口异常",
  suspended: "已停用",
  cancelled: "已取消",
  detaching: "清理中",
  detached: "已解绑",
};
export function AgencyDomainDrawer({
  agency,
  onClose,
}: {
  agency: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const workspace = useCurrentWorkspace(),
 user = useCurrentUser();
  return agency ? (
    <ConfigProvider locale={zhCN}>
      <DomainEditor
        key={`${agency.id}/${workspace?.type}/${workspace?.id}/${user?.id}`}
        agency={agency}
        onClose={onClose}
      />
    </ConfigProvider>
  ) : null;
}
function DomainEditor({
  agency,
  onClose,
}: {
  agency: { id: string; name: string };
  onClose: () => void;
}) {
  const client = useRequestClient(),
    workspace = useCurrentWorkspace(),
 user=useCurrentUser(),
    permissions = usePermissions(),
    queries = useQueryClient();
  const base = `/api/v1/platform/agencies/${agency.id}/domains`,
    cache = ["agency-domains", user?.id,workspace?.membershipId,workspace?.type, workspace?.id, agency.id];
  const [form] = Form.useForm();
  const [selected, setSelected] = useState<string>(),
    [creating, setCreating] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef<ReturnType<typeof Modal.confirm> | undefined>(
    undefined,
  );
  const key = useRef<{ payload: string; key: string } | undefined>(undefined),
    lock = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      dialog.current?.destroy();
    };
  }, []);
  const canManage = permissions.can("platform.agency_domains.manage"),
    canActivate = permissions.can("platform.agency_domains.activate");
  const list = useQuery({
    queryKey: cache,
    queryFn: ({ signal }) =>
      client.request<{
        items: DomainBinding[];
        mode: string;
        automationReady: boolean;
        managedEnabled: boolean;
      }>(base, { signal }),
    refetchInterval: 10000,
  });
  const items = (list.data?.items || []).filter((x) => !["detached", "cancelled"].includes(x.state)),
    primary = items.find((x) =>
      ["active", "degraded", "suspended"].includes(x.state),
    ),
    candidate = items.find((x) =>
      [
        "awaiting_verification",
        "awaiting_dns",
        "provisioning",
        "ready",
      ].includes(x.state),
    );
  const target = items.find((x) => x.id === selected) || candidate || primary;
  const detail = useQuery({
    queryKey: [...cache, target?.id],
    enabled: !!target && !creating,
    queryFn: ({ signal }) =>
      client.request<DomainBinding>(`${base}/${target!.id}`, { signal }),
    refetchInterval: 10000,
  });
  const binding = detail.data || target;
  const o = binding?.observation || {};
  const mode = Form.useWatch("mode", form) || "managed";
  const activeStep =
    o.routeReady && o.tlsReady ? 3 : o.verified ? (o.dnsReady ? 2 : 1) : 0;
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      message.success("已复制");
    } catch {
      message.error("复制失败，请手动选择记录内容复制");
    }
  }
  async function act(action: string, reason = "") {
    if (lock.current) return;
    let values: {
      hostname?: string;
      mode?: string;
      revision?: number;
      reason?: string;
      nsConsent?: boolean;
    };
    if (action === "create") {
      try {
        values = await form.validateFields();
      } catch {
        return;
      }
    } else {
      if (!binding) return;
      values = { revision: binding.revision, reason };
    }
    const payload = JSON.stringify({
      action,
      values,
      binding: action === "create" ? "" : binding?.id,
    });
    if (key.current?.payload !== payload)
      key.current = { payload, key: crypto.randomUUID() };
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const out = await client.request<DomainBinding>(
        action === "create" ? base : `${base}/${binding!.id}/${action}`,
        {
          method: "POST",
          headers: { "Idempotency-Key": key.current.key },
          body: values,
        },
      );
      if (!mounted.current) return;
      setSelected(out.id);
      setCreating(false);
      setDirty(false);
      key.current = undefined;
      void Promise.all([
        queries.invalidateQueries({ queryKey: cache }),
        queries.invalidateQueries({ queryKey: ["agency-domain-summaries"] }),
      ]).catch(() =>
        message.warning("操作已提交，列表刷新失败，可稍后重新打开查看"),
      );
      message.success(
        action === "check" ? "已提交检测，后台会继续处理" : "域名操作已提交",
      );
      return true;
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : "结果暂未确认，请保留当前配置并重试",
        );
      return false;
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function confirm(action: string) {
    const labels: Record<string, string> = {
      activate: primary ? "确认切换到新域名" : "确认启用域名",
      suspend: "停用当前域名",
      resume: "重新验证并恢复",
      detach: "解除当前域名绑定",
      cancel: "取消新域名配置",
      "renew-challenge": "更新所有权验证",
    };
    let reason = "";
    dialog.current?.destroy();
    dialog.current = Modal.confirm({
      title: labels[action],
      content: (
        <>
          <p>{binding?.hostname}</p>
          <p>
            {action === "activate"
              ? primary
                ? "旧域名将停止准入，旧登录状态不会迁移，请确认已通知使用者。"
                : "入口验证已就绪，确认后将开放该机构有效成员登录。"
              : action === "cancel"
                ? "仅取消当前候选，原正式入口保持不变。"
                : action === "suspend" || action === "detach"
                  ? "此入口将停止登录和后续访问。清理外部资源需要时间，现有业务数据保留。"
                  : "系统会重新核对所有权、DNS、证书和入口配置。"}
          </p>
          {action !== "cancel" && <Input.TextArea
            maxLength={300}
            rows={2}
            placeholder="请输入操作说明"
            onChange={(e) => (reason = e.target.value)}
          />}
        </>
      ),
      okText: "确认",
      cancelText: "返回",
      okButtonProps: {
        danger: ["suspend", "detach", "cancel"].includes(action),
      },
      onOk: async () => {
        if (action !== "cancel" && !reason.trim()) {
          message.warning("请填写操作说明");
          throw new Error("reason required");
        }
        if (!(await act(action, reason.trim())))
          throw new Error("operation pending");
      },
    });
  }
  function close() {
    if (busy) return;
    if (dirty)
      dialog.current = Modal.confirm({
        title: "放弃尚未提交的域名配置？",
        content: "已提交的后台任务会继续运行。",
        okText: "放弃修改",
        cancelText: "继续填写",
        onOk: onClose,
      });
    else onClose();
  }
  const records = o.records?.length
    ? o.records
    : [
        {
          type: "TXT",
          name: `_kycrm.${binding?.hostname || ""}`,
          value: binding?.challenge || "",
        },
      ];
  return (
    <Drawer
      rootClassName="organization-contribution-drawer"
      open
      title={`${agency.name} · 域名`}
      size="min(760px, 100vw)"
      onClose={close}
      maskClosable={!busy}
      keyboard={!busy}
      extra={
        <Space style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button disabled={busy} onClick={close}>
            稍后继续
          </Button>
          {(creating || !target) && canManage && (
            <Button
              type="primary"
              loading={busy}
              disabled={!!list.error || list.isPending || !list.data?.managedEnabled}
              onClick={() => void act("create")}
            >
              检测并继续
            </Button>
          )}
        </Space>
      }
    >
      {list.error && (
        <Typography.Paragraph role="alert" type="danger">
          读取失败：{list.error.message}
          <Button type="link" onClick={() => void list.refetch()}>
            重试
          </Button>
        </Typography.Paragraph>
      )}
      {error && (
        <Typography.Paragraph role="alert" type="danger">
          {error}
        </Typography.Paragraph>
      )}
      {list.data && !list.data.automationReady && (
        <Typography.Paragraph type="secondary">
          平台自动接入尚未完全配置，可准备所有权验证；安全门禁就绪前不会开放登录。
        </Typography.Paragraph>
      )}
      {primary && (
        <Typography.Paragraph>
          当前正式入口：
          <Typography.Text copyable={{ tooltips: ["复制", "已复制"] }}>
            {primary.hostname}
          </Typography.Text>{" "}
          · {domainStates[primary.state]}
        </Typography.Paragraph>
      )}
      {items.length > 1 && (
        <Select
          aria-label="选择域名记录"
          style={{ width: "100%", marginBottom: 16 }}
          value={binding?.id}
          options={items.map((x) => ({
            value: x.id,
            label: `${x.hostname} · ${x.state === "provisioning" && x.observation?.platformPending ? "平台接入待准备" : domainStates[x.state]}`,
          }))}
          onChange={(id) => {
            setSelected(id);
            setCreating(false);
          }}
        />
      )}
      {(creating || !target) && !list.isPending && (
        <Form
          form={form}
          layout="vertical"
          initialValues={{ mode: "managed" }}
          disabled={busy || !canManage}
          onValuesChange={() => setDirty(true)}
        >
          <Typography.Paragraph>
            绑定机构登录入口。平台自动配置并检查域名；如需修改名称服务器会显示指引，关闭此窗口不影响后台任务。
          </Typography.Paragraph>
          <Form.Item
            name="hostname"
            label="访问域名"
            rules={[
              { required: true, message: "请输入完整子域名" },
              { max: 2048, message: "域名内容过长" },
            ]}
          >
            <Input placeholder="例如 work.example.com" autoComplete="off" />
          </Form.Item>
          <Form.Item name="mode" label="接入方式">
            <Select
              options={[
                { value: "managed", label: "Cloudflare 托管", disabled: !list.data?.managedEnabled },
                { value: "ip", label: "IP 解析（后续支持）", disabled: true },
              ]}
            />
          </Form.Item>
          {mode === "managed" && (
            <>
              <Form.Item
                name="nsConsent"
                valuePropName="checked"
                rules={[
                  {
                    validator: (_, v) =>
                      v
                        ? Promise.resolve()
                        : Promise.reject(new Error("请确认DNS迁移准备")),
                  },
                ]}
              >
                <Checkbox>
                  我有权管理该域名，并会在修改NS前核对官网、邮件及全部原DNS记录。
                </Checkbox>
              </Form.Item>
              <Typography.Paragraph type="warning">
                此方式可能需要修改注册商处的NS。请先由域名管理员核对官网、邮件及全部现有DNS记录；系统不会替换冲突记录或删除整个站点。
              </Typography.Paragraph>
            </>
          )}
          <Typography.Paragraph type="secondary">
            首次绑定将在所有权、DNS、证书和安全门禁全部通过后自动启用；更换现有入口仍需最后确认切换。首期仅支持注册根域名下一级子域名。
          </Typography.Paragraph>
        </Form>
      )}
      {binding && !creating && (
        <>
          <Space wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {binding.hostname}
            </Typography.Title>
            <Tag
              color={
                binding.state === "active"
                  ? "success"
                  : binding.state === "degraded"
                    ? "error"
                    : "default"
              }
            >
              {binding.state === "provisioning" && o.platformPending ? "平台接入待准备" : domainStates[binding.state]}
            </Tag>
          </Space>
          <Divider />
          <Steps
            size="small"
            current={activeStep}
            items={[
              { title: binding.mode === "managed" ? "检查托管" : "验证所有权" },
              { title: o.platformPending ? "平台准备 / 配置解析" : "配置解析" },
              { title: "准备证书" },
              { title: binding.state === "active" ? "已启用" : "验证入口" },
            ]}
          />
          {binding.state === "active" ? (
            <Alert
              style={{ marginTop: 20 }}
              type="success"
              showIcon
              message="域名已接入，可正常使用"
              description={binding.mode === "managed"
                ? "DNS 与隧道入口由平台自动维护，无需手动配置。请保留现有解析和名称服务器设置。"
                : "域名验证与 HTTPS 检查已通过，请保留现有 DNS 记录。"}
            />
          ) : (
            <Typography.Paragraph type={o.platformPending ? "warning" : undefined} style={{ marginTop: 20 }} aria-live="polite">
              {o.message || (binding.mode === "managed"
                ? "请按引导完成名称服务器设置，生效后平台将自动配置解析并验证入口。"
                : "请先配置所有权TXT，系统会自动继续检测。")}
            </Typography.Paragraph>
          )}
          {binding.mode === "managed" && o.nameserverChangeRequired && !!o.nameservers?.length && (
            <Typography.Paragraph style={{ marginTop: 16 }}>
              请在域名注册商处设置名称服务器，生效后平台将自动继续接入：
              <Typography.Text copyable={{ tooltips: ["复制", "已复制"] }}>
                {o.nameservers.join("\n")}
              </Typography.Text>
            </Typography.Paragraph>
          )}
          {!["detached", "cancelled"].includes(binding.state) && (
            <details style={{ marginTop: 20 }} open={binding.mode !== "managed" && binding.state !== "active"}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>技术详情（DNS 与名称服务器）</summary>
              <Typography.Title level={5}>{binding.mode === "managed" ? "平台维护的 DNS 记录" : "需要保留的 DNS 记录"}</Typography.Title>
              <Typography.Paragraph type="secondary">
                {binding.mode === "managed"
                  ? "以下记录由平台配置，用于域名验证和隧道接入，仅供排查，无需手动重复添加。"
                  : "请保留验证记录用于持续检测。部分DNS控制台只需填写主机名前缀，请以控制台提示为准。同名TXT有多个值时请分别添加，勿覆盖。"}
              </Typography.Paragraph>
              <Table
                size="small"
                pagination={false}
                rowKey={(r) => `${r.type}:${r.name}:${r.value}`}
                dataSource={records}
                scroll={{ x: 600 }}
                columns={[
                  { title: "类型", dataIndex: "type", width: 70 },
                  {
                    title: "主机记录",
                    dataIndex: "name",
                    render: (v) => (
                      <Typography.Text
                        copyable={{ tooltips: ["复制", "已复制"] }}
                        style={{ wordBreak: "break-all" }}
                      >
                        {v}
                      </Typography.Text>
                    ),
                  },
                  {
                    title: "记录值",
                    dataIndex: "value",
                    render: (v) => (
                      <Typography.Text
                        copyable={{ tooltips: ["复制", "已复制"] }}
                        style={{ wordBreak: "break-all" }}
                      >
                        {v}
                      </Typography.Text>
                    ),
                  },
                ]}
              />
              <Button
                style={{ marginTop: 12 }}
                onClick={() =>
                  void copy(
                    records
                      .map((r) => `${r.type}\t${r.name}\t${r.value}`)
                      .join("\n"),
                  )
                }
              >
                复制全部记录
              </Button>
              {o.nameservers?.length && (
                <Typography.Paragraph style={{ marginTop: 16 }}>
                  Cloudflare 分配的名称服务器：
                  <Typography.Text copyable={{ tooltips: ["复制", "已复制"] }}>
                    {o.nameservers.join("\n")}
                  </Typography.Text>
                </Typography.Paragraph>
              )}
            </details>
          )}
          <Divider />
          <Descriptions
            column={1}
            items={[
              {
                key: "mode",
                label: "接入方式",
                children:
                  binding.mode === "managed" ? "Cloudflare 托管" : "历史接入记录（已停止新增）",
              },
              {
                key: "challenge",
                label: "初次验证期限",
                children: new Date(binding.expiresAt).toLocaleString(),
              },
              {
                key: "dns",
                label: "解析 / HTTPS / 入口",
                children: `${o.dnsReady ? "已确认" : "待确认"} / ${o.tlsReady ? "已确认" : "待确认"} / ${o.routeReady ? "已确认" : "待确认"}`,
              },
            ]}
          />
          <Space wrap style={{ marginTop: 16 }}>
            {canManage &&
              !["detached", "cancelled"].includes(binding.state) && (
                <Button loading={busy} onClick={() => void act("check")}>
                  重新检测
                </Button>
              )}
            {binding.state === "active" && (
              <Button
                type="link"
                href={`https://${binding.hostname}/login`}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开登录页
              </Button>
            )}
            {canManage &&
              !candidate &&
              !["detaching"].includes(binding.state) && (
                <Button
                  onClick={() => {
                    setCreating(true);
                    form.resetFields();
                    setDirty(false);
                  }}
                >
                  绑定新域名
                </Button>
              )}
            {canActivate && binding.state === "ready" && (
              <Button
                type="primary"
                disabled={busy || !list.data?.automationReady}
                onClick={() => confirm("activate")}
              >
                {primary ? "确认切换" : "确认启用"}
              </Button>
            )}
            {canActivate && ["active", "degraded"].includes(binding.state) && (
              <Button danger disabled={busy} onClick={() => confirm("suspend")}>
                停用
              </Button>
            )}
            {canActivate && binding.state === "suspended" && (
              <Button
                disabled={busy || !list.data?.automationReady}
                onClick={() => confirm("resume")}
              >
                重新验证并恢复
              </Button>
            )}
            {canActivate &&
              ["active", "degraded", "suspended"].includes(binding.state) && (
                <Button
                  danger
                  disabled={busy}
                  onClick={() => confirm("detach")}
                >
                  解除绑定
                </Button>
              )}
            {canManage &&
              [
                "awaiting_verification",
                "awaiting_dns",
                "provisioning",
                "ready",
              ].includes(binding.state) && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() => confirm("renew-challenge")}
                  >
                    更新验证
                  </Button>
                  <Button
                    danger
                    disabled={busy}
                    onClick={() => confirm("cancel")}
                  >
                    取消新域名配置
                  </Button>
                </>
              )}
          </Space>
          <Divider />
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>检查记录（{binding.tasks?.length || 0}）</summary>
          {detail.error && (
            <Typography.Paragraph type="danger">
              进度读取失败
              <Button type="link" onClick={() => void detail.refetch()}>
                重试
              </Button>
            </Typography.Paragraph>
          )}
          <Table
            size="small"
            locale={{ emptyText: "等待后台检查" }}
            pagination={{ pageSize: 5, size: "small", hideOnSinglePage: true, showSizeChanger: false }}
            rowKey="id"
            dataSource={binding.tasks || []}
            columns={[
              {
                title: "进度",
                dataIndex: "state",
                render: (v) =>
                  ({
                    queued: "等待检查",
                    running: "检测中",
                    done: "本次检查完成",
                    cancelled: "已取消",
                  })[String(v)] || v,
              },
              { title: "说明", dataIndex: "message" },
              {
                title: "计划检查时间",
                dataIndex: "nextAt",
                render: (v) => new Date(v).toLocaleString(),
              },
            ]}
          />
          </details>
        </>
      )}
    </Drawer>
  );
}
