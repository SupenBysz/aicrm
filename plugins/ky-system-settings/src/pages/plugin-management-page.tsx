import { Alert, Button, ConfigProvider, Descriptions, Drawer, Input, Result, Select, Space, Table, Tag, Typography, Tooltip } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListPageCard, drawerWidths, useCurrentUser, useCurrentWorkspace, usePermissions, usePluginInventoryPort } from "@ky/admin-core";
import type { PluginInventoryItem, PluginInventoryQuery, PluginInventoryResult } from "@ky/admin-core";

const labels: Record<string, string> = {
  draining: "等待旧实例结束", activating: "激活中", probation: "观察中", blocked: "更新受限", waiting_ui: "等待界面恢复", drain_busy: "旧实例仍有任务", connection_failed: "连接失败", http_status: "服务响应异常", oversize: "响应超出限制", cancelled: "已取消", ok: "正常", plugin_activation_failed: "插件激活失败", plugin_runtime_crash: "插件进程异常", plugin_boot_failed: "插件启动失败", plugin_interrupted_boot: "上次启动被中断", plugin_update_rejected: "更新被拒绝",
  admin: "后台业务插件", desktop: "客户端宿主插件", admin_host: "后台宿主", current_client: "当前客户端",
  enabled: "已启用", disabled: "已停用", not_applicable: "不适用", unknown: "未知",
  loaded: "已加载", not_loaded: "未加载", loading: "加载中", failed: "加载失败",
  running: "运行中", unresponsive: "无响应", stopped: "已停止", healthy: "服务就绪", unhealthy: "服务异常", timeout: "超时",
  confirmed: "已确认", unconfirmed: "未确认", verified: "已验证", builtin_trusted: "内置可信", unverified: "未验证",
  stable: "稳定", staged: "已暂存", preparing: "准备中", switching: "切换中", awaiting_ui_ack: "等待界面确认",
  candidate: "候选验证中", rollback: "回退中", rolled_back: "已回退", committed: "已提交", idle: "空闲",
  auth: "身份认证", org: "组织服务", membership: "成员权限", matrix: "矩阵账号", "ai-model": "模型服务",
  source_timeout: "状态采集超时", source_unavailable: "状态来源暂不可用", source_stale: "状态已过期",
  invalid_response: "状态响应无效", not_sampled: "尚未采集", connection_error: "连接失败", read_error: "响应读取失败",
  invalid_json: "响应格式异常", service_mismatch: "服务身份不匹配", http_error: "服务响应异常",
  ready: "已就绪", success: "成功", updated: "更新成功", rollback_success: "回退成功"
};
const label = (value: string | null | undefined) => value ? labels[value] ?? "其他状态" : "—";
const time = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) : "暂无记录";
const stateTag = (value: string) => <Tag color={["healthy", "running", "loaded", "confirmed"].includes(value) ? "green" : ["unhealthy", "unresponsive", "failed"].includes(value) ? "red" : ["unknown", "timeout"].includes(value) ? "orange" : undefined}>{label(value)}</Tag>;

const serviceCell = (services: PluginInventoryItem["services"], stale: boolean) => {
  if (!services.length) return "不适用";
  const names = services.map(item => label(item.key)).join(" / ");
  const rank: Record<string, number> = { unknown: 4, timeout: 3, unhealthy: 2, healthy: 1, not_applicable: 0 };
  const worst = services.reduce((a, b) => (rank[b.state] ?? 5) > (rank[a.state] ?? 5) ? b : a, services[0]);
  const detail = services.map(item => `${label(item.key)}：${label(item.state)}${item.reason ? `（${label(item.reason)}）` : ""}`).join("；");
  const line: React.CSSProperties = { display: "block", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  return <Tooltip title={detail}><div style={{ minWidth: 0, maxWidth: "100%" }}><Typography.Text style={line}>{names}</Typography.Text><Typography.Text type={worst.state === "healthy" && !stale ? undefined : "warning"} style={line}>{services.every(item => item.state === worst.state) ? label(worst.state) : `最差：${label(worst.state)}`}{stale ? " · 过期" : ""}</Typography.Text></div></Tooltip>;
};
const dateCell = (value: string | null, stale: boolean) => { if (!value || !Number.isFinite(Date.parse(value))) return "暂无记录"; const d = new Date(value); const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); const timePart = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d); const line: React.CSSProperties = { display: "block", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }; return <Tooltip title={`${date} ${timePart}（北京时间）`}><div style={{ minWidth: 0, maxWidth: "100%" }}><span style={line}>{date}</span><Typography.Text type={stale ? "warning" : undefined} style={line}>{timePart}{stale ? " · 过期" : ""}</Typography.Text></div></Tooltip>; };
const initialQuery: PluginInventoryQuery = { page: 1, pageSize: 20, sort: "abnormal_first" };

export function PluginManagementPage() {
  const port = usePluginInventoryPort();
  const workspace = useCurrentWorkspace();
  const user = useCurrentUser();
  const permissions = usePermissions();
  const allowed = workspace?.type === "platform" && workspace.id === "platform_root" && permissions.can("platform.plugin_management.view");
  const scope = `${user?.id ?? ""}:${workspace?.type}:${workspace?.id}:${workspace?.membershipId}:${allowed}`;
  const [query, setQuery] = useState<PluginInventoryQuery>(initialQuery);
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState<"admin" | "desktop" | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [result, setResult] = useState<PluginInventoryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<PluginInventoryItem | null>(null);
  const selected = useRef<string | null>(null);
  const run = useRef(0);
  const active = useRef<AbortController | null>(null);
  const initialized = useRef(false);
  const inFlight = useRef(false);

  const load = useCallback(async (refresh: boolean, quiet = false) => {
    if (!allowed || !port || forbidden || (!refresh && !initialized.current && quiet)) return;
    if (quiet && inFlight.current) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const ticket = ++run.current;
    inFlight.current = true;
    if (!quiet) setLoading(true);
    try {
      const next = await port.list({ ...query, refresh, signal: controller.signal });
      if (ticket !== run.current || controller.signal.aborted) return;
      initialized.current = true;
      setResult(next);
      setError("");
      if (selected.current) {
        const item = await port.get(selected.current, controller.signal);
        if (ticket === run.current && !controller.signal.aborted) setDetail(item);
      }
    } catch (cause) {
      if (ticket !== run.current || controller.signal.aborted) return;
      const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
      if (["unauthorized", "permission_denied", "workspace_forbidden"].includes(code)) {
        port.clear(); setResult(null); setDetail(null); selected.current = null; setForbidden(true);
      } else setError("插件状态暂时无法获取，请稍后刷新。");
    } finally {
      if (ticket === run.current) { inFlight.current = false; setLoading(false); }
    }
  }, [allowed, forbidden, port, query, scope]);

  useEffect(() => {
    setForbidden(false); setResult(null); setDetail(null); selected.current = null;
    initialized.current = false; setError("");
    return () => { ++run.current; active.current?.abort(); inFlight.current = false; port?.clear(); };
  }, [port, scope]);
  useEffect(() => { void load(!initialized.current); }, [load]);
  useEffect(() => {
    if (!allowed || forbidden) return;
    let poll: ReturnType<typeof setInterval> | undefined;
    let freshness: ReturnType<typeof setInterval> | undefined;
    const stop = () => { clearInterval(poll); clearInterval(freshness); };
    const resume = () => {
      stop();
      if (document.visibilityState === "hidden") { ++run.current; active.current?.abort(); inFlight.current = false; setLoading(false); return; }
      void load(false, true).then(() => load(true, true));
      poll = setInterval(() => { void load(true, true); }, 30_000);
      freshness = setInterval(() => { void load(false, true); }, 1_000);
    };
    // 初次采集由上面的 effect 负责，避免重复网络请求。
    if (document.visibilityState !== "hidden") {
      poll = setInterval(() => { void load(true, true); }, 30_000);
      freshness = setInterval(() => { void load(false, true); }, 1_000);
    }
    document.addEventListener("visibilitychange", resume);
    return () => { stop(); document.removeEventListener("visibilitychange", resume); };
  }, [allowed, forbidden, load]);

  if (!allowed || forbidden) return <Result status="403" title="无权访问" subTitle="仅平台工作区内具有插件查看权限的成员可访问。" />;
  if (!port) return <Alert type="warning" showIcon message="当前宿主未提供插件清单，请更新客户端或联系管理员。" />;
  const apply = () => setQuery({ ...query, page: 1, keyword, type,
    loadState: status?.startsWith("load:") ? status.slice(5) as PluginInventoryQuery["loadState"] : undefined,
    runtimeState: status?.startsWith("runtime:") ? status.slice(8) as PluginInventoryQuery["runtimeState"] : undefined });
  const open = async (id: string) => { selected.current = id; const item = await port.get(id); if (selected.current === id) setDetail(item); };
  const sourceNotices = result ? Object.entries(result.sources).flatMap(([key, source]) => {
    if (source.availability === "supported") return [];
    const message = source.reason === "browser_not_supported" ? "当前为浏览器访问，客户端宿主插件状态不可用。"
      : source.reason === "client_upgrade_required" ? "当前客户端版本不支持插件状态查询，请更新客户端。"
      : `${key === "desktop" ? "客户端插件" : key === "health" ? "关联服务" : "后台插件"}状态暂不可用；最后成功采集：${time(source.lastSuccess)}。`;
    return [<Alert key={key} type="warning" showIcon message={message} />];
  }) : [];
  const sourceNoticeContent = sourceNotices.length > 0 ? sourceNotices : null;
  const errorNotice = error ? <Alert type="error" showIcon message={error} /> : null;
  const sourceErrorNotice = result?.sourceError ? <Alert type="error" showIcon message={result.sourceError.message} /> : null;
  return <ConfigProvider locale={zhCN}>
    <ListPageCard title="插件管理" subtitle="查看后台业务插件及当前客户端宿主插件；关联服务状态仅表示服务就绪情况。"
      extra={<Button loading={loading} onClick={() => void load(true)}>刷新</Button>}
      toolbar={<Space wrap>
        <Input aria-label="插件名称或标识" placeholder="插件名称或标识" value={keyword} allowClear onChange={e => setKeyword(e.target.value)} onPressEnter={apply} style={{ width: 220 }} />
        <Select aria-label="插件类型" placeholder="全部类型" allowClear value={type} onChange={setType} style={{ width: 170 }} options={[{ value: "admin", label: "后台业务插件" }, { value: "desktop", label: "客户端宿主插件" }]} />
        <Select aria-label="插件状态" placeholder="全部状态" allowClear value={status} onChange={setStatus} style={{ width: 140 }} options={["load:loaded", "load:failed", "load:unknown", "runtime:running", "runtime:unresponsive", "runtime:stopped", "runtime:unknown"].map(value => ({ value, label: label(value.split(":")[1]) + (value === "load:unknown" ? "（加载）" : value === "runtime:unknown" ? "（运行）" : "") }))} />
        <Button type="primary" onClick={apply}>查询</Button>
        <Button onClick={() => { setKeyword(""); setType(undefined); setStatus(undefined); setQuery(initialQuery); }}>重置</Button>
        <Select aria-label="排序方式" value={query.sort} onChange={sort => setQuery({ ...query, page: 1, sort })} style={{ width: 140 }} options={[{ value: "abnormal_first", label: "异常优先" }, { value: "name_asc", label: "按名称排序" }]} />
      </Space>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
        {sourceNoticeContent}
        {errorNotice}
        {sourceErrorNotice}
        <Table<PluginInventoryItem> rowKey="id" size="middle" loading={loading} dataSource={result?.items ?? []} scroll={{ x: 1260 }}
          pagination={{ current: query.page, pageSize: query.pageSize, total: result?.total ?? 0, showSizeChanger: true, pageSizeOptions: [20, 50, 100], showTotal: total => `共 ${total} 个插件`, onChange: (page, pageSize) => setQuery({ ...query, page, pageSize }) }}
          columns={[
            { title: "插件名称 / 标识", key: "name", width: 260, render: (_, row) => <Space direction="vertical" size={0}><Typography.Text strong>{row.name}</Typography.Text><Typography.Text type="secondary" copyable={{ text: row.id, tooltips: ["复制标识", "已复制"] }} style={{ fontSize: 12 }}>{row.id}</Typography.Text></Space> },
            { title: "类型", dataIndex: "type", width: 150, render: label },
            { title: "实际版本", dataIndex: "version", width: 110, render: value => value ?? "未知" },
            { title: "运行位置", dataIndex: "location", width: 120, render: label },
            { title: "启用状态", dataIndex: "enabledState", width: 105, render: stateTag },
            { title: "加载状态", dataIndex: "loadState", width: 105, render: stateTag },
            { title: "运行状态", dataIndex: "runtimeState", width: 105, render: stateTag },
            { title: "关联服务", key: "services", width: 150, render: (_, row) => serviceCell(row.services, row.freshness === "stale") },
            { title: "采集时间", key: "time", width: 125, render: (_, row) => dateCell(row.sampledAtUtc, row.freshness === "stale") },
            { title: "操作", key: "action", fixed: "right", width: 80, render: (_, row) => <Button type="link" onClick={() => void open(row.id)}>详情</Button> }
          ]} />
      </div>
    </ListPageCard>
    <Drawer title={detail ? `${detail.name} · 插件详情` : "插件详情"} open={Boolean(detail)} width={drawerWidths.wideList} onClose={() => { selected.current = null; setDetail(null); }}>
      {detail && <Descriptions bordered column={1} size="small" items={[
        { key: "id", label: "插件标识", children: <Typography.Text copyable={{ tooltips: ["复制标识", "已复制"] }}>{detail.id}</Typography.Text> },
        { key: "description", label: "功能说明", children: detail.description ?? "暂无说明" },
        { key: "type", label: "插件类型 / 位置", children: `${label(detail.type)} / ${label(detail.location)}` },
        { key: "version", label: "实际版本", children: detail.version ?? "未知" },
        { key: "build", label: "构建标识", children: detail.buildId ?? "暂无记录" },
        { key: "provider", label: "提供者", children: detail.provider ?? "暂无记录" },
        { key: "capabilities", label: "声明能力", children: detail.capabilities.join("、") || "暂无声明" },
        { key: "compatibility", label: "兼容宿主 / 插件接口 / 界面接口", children: [detail.compatibleHost, detail.pluginApi, detail.uiApi].map(x => x ?? "不适用").join(" / ") },
        { key: "states", label: "启用 / 加载 / 运行", children: <Space wrap>{stateTag(detail.enabledState)}{stateTag(detail.loadState)}{stateTag(detail.runtimeState)}</Space> },
        { key: "ui", label: "界面确认", children: stateTag(detail.uiConfirmationState) },
        { key: "phase", label: "更新阶段", children: label(detail.updatePhase) },
        { key: "signature", label: "完整性 / 签名", children: label(detail.signatureState) },
        { key: "candidate", label: "候选版本", children: detail.candidateVersion ?? "无" },
        { key: "rollback", label: "可回退版本", children: detail.rollbackVersion ?? "无" },
        { key: "lastUpdate", label: "最近更新结果", children: detail.lastUpdateResult ? label(detail.lastUpdateResult.code) : "暂无记录" },
        { key: "lastRollback", label: "最近回退结果", children: detail.lastRollbackResult ? label(detail.lastRollbackResult.code) : "暂无记录" },
        { key: "lastSuccess", label: "最近成功结果", children: detail.lastSuccess ? label(detail.lastSuccess.code) : "暂无记录" },
        { key: "error", label: "异常原因", children: detail.errorReason ? label(detail.errorReason) : "无" },
        { key: "services", label: "关联服务", children: detail.services.length ? <Space direction="vertical">{detail.services.map(s => <span key={s.key}>{label(s.key)} {stateTag(s.state)} {s.reason ? label(s.reason) : ""} · {time(s.checkedAtUtc)}</span>)}</Space> : "不适用" },
        { key: "sampled", label: "采集时间（北京时间）", children: time(detail.sampledAtUtc) },
        { key: "freshness", label: "数据时效", children: detail.freshness === "fresh" ? "有效" : "已过期" }
      ]} />}
    </Drawer>
  </ConfigProvider>;
}
