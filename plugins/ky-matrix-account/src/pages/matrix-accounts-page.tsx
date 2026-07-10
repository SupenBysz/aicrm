import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { BugOutlined, InfoCircleOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Popover,
  Segmented,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableProps
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import {
  ListPageCard,
  captureMatrixAccountWebSpaceSnapshot,
  clearMatrixAccountWebSpace,
  clearMatrixAccountProfile,
  checkMatrixAccountSession,
  createMatrixAccountWebSpaceLogin,
  drawerWidths,
  hasMatrixAccountDesktopCapability,
  hasMatrixAccountWebSpaceDesktopCapability,
  isAiCrmDesktopClientRuntime,
  openAiExecutorTerminalWindow,
  openMatrixAccount,
  openMatrixAccountWebSpace,
  runMatrixAccountWebSpaceLoginScript,
  runBatchRequests,
  startMatrixAccountLogin,
  useCurrentUser,
  useCurrentWorkspace,
  usePermissions,
  useRequestClient,
  type MatrixAccountLoginScriptPurpose,
  type RequestClient,
  type MatrixAccountWebSpaceScriptResult,
  type MatrixAccountWebSpaceSnapshotResult,
  type MatrixAccountPlatform
} from "@ky/admin-core";
import {
  clearMatrixAccountWebSpaceRecord,
  createMatrixAccountWebSpace,
  createMatrixAccountRepairTask,
  deleteMatrixAccount,
  activateMatrixAccountLoginScriptVersion,
  getAiExecutorConfig,
  getAiExecutorRun,
  listAiExecutorRunEvents,
  listAiExecutorTerminalFrames,
  listMatrixAccountLoginScripts,
  listMatrixAccountLoginScriptVersions,
  listMatrixAccountLoginScriptRuns,
  listMatrixAccounts,
  resizeAiExecutorTerminal,
  resolveMatrixAccountLoginScript,
  submitMatrixAccountLoginScriptRunResult,
  submitMatrixAccountWebSpaceDetectResult,
  updateMatrixAccountLoginScriptStatus,
  updateMatrixAccount,
  updateMatrixAccountStatus,
  type AiExecutorEvent,
  type AiExecutorConfigSummary,
  type AiExecutorRawLog,
  type AiExecutorRun,
  type AiExecutorTerminalFrame,
  type AiExecutorTask,
  type MatrixAccount,
  type MatrixAccountDetectResultInput,
  type MatrixAccountInput,
  type MatrixAccountLoginStatus,
  type MatrixAccountLoginScript,
  type MatrixAccountLoginScriptRunLog,
  type MatrixAccountLoginScriptResolveResult,
  type MatrixAccountLoginScriptVersion,
  type MatrixAccountStatus,
  type MatrixAccountWebSpace
} from "../api";
import { matrixAccountPermissions } from "../permissions";

const platformLabels: Record<MatrixAccountPlatform, string> = {
  douyin: "抖音",
  kuaishou: "快手",
  xiaohongshu: "小红书"
};

const loginStatusLabels: Record<string, string> = {
  not_logged_in: "未登录",
  login_pending: "登录中",
  online: "在线",
  expired: "已失效",
  verify_required: "需验证",
  risk: "风控",
  unknown: "未知"
};

const loginStatusColors: Record<string, string> = {
  not_logged_in: "default",
  login_pending: "processing",
  online: "green",
  expired: "orange",
  verify_required: "gold",
  risk: "red",
  unknown: "default"
};

interface QueryState {
  keyword?: string;
  loginStatus?: string;
  status?: string;
  page: number;
  pageSize: number;
}

interface WebSpaceOpenOptions {
  showWindow?: boolean;
  silent?: boolean;
}

interface WebSpaceDetectOptions {
  silent?: boolean;
}

interface CreateWebSpaceOptions {
  flowId: number;
}

type WebSpaceFlowStatus =
  | "idle"
  | "initializing"
  | "waiting_qr"
  | "refreshing_qr"
  | "qr_ready"
  | "detecting_account"
  | "failed"
  | "success"
  | "releasing";

type WebSpaceFlowPhase =
  | "initializing"
  | "capturing_snapshot"
  | "resolving_script"
  | "generating_script"
  | "running_script"
  | "waiting_scan"
  | "refreshing_qr"
  | "detecting_account"
  | "failed"
  | "releasing";

interface WebSpaceFlowProgress {
  phase: WebSpaceFlowPhase;
  actor: "system" | "script" | "codex" | "desktop";
  title: string;
  reasonCode?: string;
  reasonText?: string;
  description?: string;
}

interface WebSpaceScriptSummary {
  purpose: MatrixAccountLoginScriptPurpose;
  version: number;
  status: string;
  source: string;
  reasonCode?: string;
  reasonText?: string;
}

interface WebSpaceFlowLogEntry {
  id: string;
  time: string;
  phase: WebSpaceFlowPhase;
  actor: WebSpaceFlowProgress["actor"];
  title: string;
  reasonCode?: string;
  reasonText?: string;
}

interface WebSpaceTabItem {
  key: string;
  label: string;
  children: ReactNode;
}

interface LoginScriptPurposeGroup {
  key: MatrixAccountLoginScriptPurpose;
  purpose: MatrixAccountLoginScriptPurpose;
  primary: MatrixAccountLoginScript;
  scripts: MatrixAccountLoginScript[];
  activeCount: number;
  successCount: number;
}

const initialWebSpaceProgress: WebSpaceFlowProgress = {
  phase: "initializing",
  actor: "system",
  title: "正在初始化登录空间",
  description: "AiCRM Desktop 正在准备本机受控浏览器。"
};

export function MatrixAccountsPage({ platform }: { platform: MatrixAccountPlatform }) {
  const client = useRequestClient();
  const workspace = useCurrentWorkspace();
  const currentUser = useCurrentUser();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<MatrixAccountInput>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<MatrixAccount | null>(null);
  const [webSpaceDrawerOpen, setWebSpaceDrawerOpen] = useState(false);
  const [activeWebSpace, setActiveWebSpace] = useState<MatrixAccountWebSpace | null>(null);
  const [webSpaceQrCode, setWebSpaceQrCode] = useState("");
  const [webSpaceQrReason, setWebSpaceQrReason] = useState("");
  const [webSpaceFlowStatus, setWebSpaceFlowStatus] = useState<WebSpaceFlowStatus>("idle");
  const [webSpaceProgress, setWebSpaceProgress] = useState<WebSpaceFlowProgress>(initialWebSpaceProgress);
  const [webSpaceScriptSummary, setWebSpaceScriptSummary] = useState<WebSpaceScriptSummary | null>(null);
  const [webSpaceRepairTask, setWebSpaceRepairTask] = useState<AiExecutorTask | null>(null);
  const [webSpaceLogsVisible, setWebSpaceLogsVisible] = useState(false);
  const [webSpaceFlowLogs, setWebSpaceFlowLogs] = useState<WebSpaceFlowLogEntry[]>([]);
  const [webSpaceActiveTab, setWebSpaceActiveTab] = useState("add");
  const [automationView, setAutomationView] = useState("overview");
  const [showTaskContext, setShowTaskContext] = useState(false);
  const [showEnvironmentInfo, setShowEnvironmentInfo] = useState(false);
  const [redactTerminalContent, setRedactTerminalContent] = useState(true);
  const [selectedScriptId, setSelectedScriptId] = useState("");
  const [scriptDetailDrawerOpen, setScriptDetailDrawerOpen] = useState(false);
  const [sensitiveSnapshot, setSensitiveSnapshot] = useState<MatrixAccountWebSpaceSnapshotResult | null>(null);
  const [sensitiveSnapshotDrawerOpen, setSensitiveSnapshotDrawerOpen] = useState(false);
  const [debugWindow, setDebugWindow] = useState<{ title: string; value: unknown } | null>(null);
  const [releasePendingWebSpace, setReleasePendingWebSpace] = useState<MatrixAccountWebSpace | null>(null);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [queryState, setQueryState] = useState<QueryState>({ page: 1, pageSize: 20 });
  const webSpaceDrawerOpenRef = useRef(false);
  const webSpaceFlowCompletedRef = useRef(false);
  const webSpaceFlowCancelledRef = useRef(false);
  const webSpaceFlowIdRef = useRef(0);
  const webSpaceRepairTaskRef = useRef<AiExecutorTask | null>(null);
  const releasePendingWebSpaceRef = useRef<MatrixAccountWebSpace | null>(null);

  const desktopAvailable = hasMatrixAccountDesktopCapability();
  const webSpaceDesktopAvailable = hasMatrixAccountWebSpaceDesktopCapability();
  const desktopRuntime = isAiCrmDesktopClientRuntime();
  const desktopCapabilityTip = desktopAvailable
    ? undefined
    : desktopRuntime
      ? "当前 AiCRM Desktop 客户端暂不支持矩阵账号登录态能力，请更新或重启客户端"
      : "请在 AiCRM Desktop 客户端中使用";
  const webSpaceCapabilityTip = webSpaceDesktopAvailable
    ? undefined
    : desktopRuntime
      ? "当前 AiCRM Desktop 客户端暂不支持新增登录空间，请更新或重启客户端"
      : "新增登录空间需要 AiCRM Desktop 客户端";
  const title = `${platformLabels[platform]}账号`;
  const listKey = ["matrix-accounts", platform, queryState] as const;
  const canCreate = permissions.canAny([...matrixAccountPermissions.create]);
  const canUpdate = permissions.canAny([...matrixAccountPermissions.update]);
  const canStatus = permissions.canAny([...matrixAccountPermissions.updateStatus]);
  const canLogin = permissions.canAny([...matrixAccountPermissions.login]);
  const canOpen = permissions.canAny([...matrixAccountPermissions.open]);
  const canCheck = permissions.canAny([...matrixAccountPermissions.check]);
  const canClearSession = permissions.canAny([...matrixAccountPermissions.clearSession]);
  const canDelete = permissions.canAny([...matrixAccountPermissions.delete]);
  const canScriptsView = permissions.canAny([...matrixAccountPermissions.scriptsView]);
  const canScriptsManage = permissions.canAny([...matrixAccountPermissions.scriptsManage]);
  const canWebSpacesDebug = permissions.canAny([...matrixAccountPermissions.webSpacesDebug]);
  const canSensitiveDebugView = permissions.canAny([...matrixAccountPermissions.sensitiveDebugView]);
  const isSuperAdmin =
    currentUser?.username?.toLowerCase() === "super.admin" ||
    workspace?.roles?.some((role) => role.code === "platform_owner") === true;
  const debugMode = useClientDebugMode();
  const canUseDebugTools = debugMode || isSuperAdmin;
  const taskContextVisible = canUseDebugTools && showTaskContext;
  const showScriptManagement = debugMode || isSuperAdmin || canScriptsView || canScriptsManage;
  const showWebSpaceDebug = debugMode || isSuperAdmin || canWebSpacesDebug;
  const showSensitiveDebug = debugMode || isSuperAdmin || canSensitiveDebugView;

  useEffect(() => {
    webSpaceDrawerOpenRef.current = webSpaceDrawerOpen;
  }, [webSpaceDrawerOpen]);

  useEffect(() => {
    webSpaceRepairTaskRef.current = webSpaceRepairTask;
  }, [webSpaceRepairTask]);

  useEffect(() => {
    releasePendingWebSpaceRef.current = releasePendingWebSpace;
  }, [releasePendingWebSpace]);

  useEffect(() => {
    if (!webSpaceRepairTask?.id) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const syncTask = async () => {
      const latest = await getAiExecutorRun(client, webSpaceRepairTask.id).catch(() => null);
      if (cancelled || !latest) return;
      setWebSpaceRepairTask(latest);
      if (isExecutorTaskExecuting(latest.status)) {
        timer = window.setTimeout(syncTask, 3000);
      }
    };
    timer = window.setTimeout(syncTask, 1200);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [client, webSpaceRepairTask?.id]);

  useEffect(() => {
    if (!releasePendingWebSpace) return;
    if (isExecutorTaskExecuting(webSpaceRepairTask?.status)) return;
    const pending = releasePendingWebSpace;
    setReleasePendingWebSpace(null);
    void releaseWebSpaceResources(pending, { silent: true });
  }, [releasePendingWebSpace, webSpaceRepairTask?.status]);

  useEffect(() => {
    if (automationView === "terminal") {
      setAutomationView("structured");
    }
  }, [automationView]);

  const { data, error, isFetching } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      listMatrixAccounts(client, {
        platform,
        keyword: queryState.keyword,
        loginStatus: queryState.loginStatus,
        status: queryState.status,
        page: queryState.page,
        pageSize: queryState.pageSize
      }),
    retry: false
  });

  const { data: webSpaceRunLogs, isFetching: webSpaceRunLogsFetching } = useQuery({
    queryKey: ["matrix-account-web-space-script-runs", activeWebSpace?.id],
    queryFn: () => listMatrixAccountLoginScriptRuns(client, activeWebSpace!.id),
    enabled: webSpaceDrawerOpen && webSpaceActiveTab === "automation" && automationView === "structured" && Boolean(activeWebSpace?.id),
    retry: false
  });

  const { data: loginScriptsData, isFetching: loginScriptsFetching } = useQuery({
    queryKey: ["matrix-account-login-scripts", workspace?.type, workspace?.id, platform],
    queryFn: () => listMatrixAccountLoginScripts(client, { platform, page: 1, pageSize: 100 }),
    enabled: webSpaceDrawerOpen && showScriptManagement,
    retry: false
  });

  const loginScripts = useMemo(() => loginScriptsData?.items ?? [], [loginScriptsData?.items]);
  const loginScriptGroups = useMemo(() => buildLoginScriptPurposeGroups(loginScripts), [loginScripts]);

  const { data: selectedScriptVersions = [], isFetching: scriptVersionsFetching } = useQuery({
    queryKey: ["matrix-account-login-script-versions", selectedScriptId],
    queryFn: () => listMatrixAccountLoginScriptVersions(client, selectedScriptId),
    enabled: scriptDetailDrawerOpen && showScriptManagement && Boolean(selectedScriptId),
    retry: false
  });

  useEffect(() => {
    if (!showScriptManagement || !scriptDetailDrawerOpen || loginScripts.length === 0) {
      setSelectedScriptId("");
      setScriptDetailDrawerOpen(false);
      return;
    }
    if (selectedScriptId && !loginScripts.some((script) => script.id === selectedScriptId)) {
      setSelectedScriptId("");
      setScriptDetailDrawerOpen(false);
    }
  }, [loginScripts, scriptDetailDrawerOpen, selectedScriptId, showScriptManagement]);

  const scriptStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "enabled" | "disabled" }) =>
      updateMatrixAccountLoginScriptStatus(client, id, status),
    onSuccess: () => {
      void message.success("脚本状态已更新");
      void queryClient.invalidateQueries({ queryKey: ["matrix-account-login-scripts"] });
    },
    onError: (err) => {
      void message.error(err instanceof Error ? err.message : "脚本状态更新失败");
    }
  });

  const activateScriptVersionMutation = useMutation({
    mutationFn: ({ scriptId, versionId }: { scriptId: string; versionId: string }) =>
      activateMatrixAccountLoginScriptVersion(client, scriptId, versionId),
    onSuccess: (_, variables) => {
      void message.success("脚本版本已启用");
      void queryClient.invalidateQueries({ queryKey: ["matrix-account-login-scripts"] });
      void queryClient.invalidateQueries({ queryKey: ["matrix-account-login-script-versions", variables.scriptId] });
    },
    onError: (err) => {
      void message.error(err instanceof Error ? err.message : "启用脚本版本失败");
    }
  });

  const sensitiveSnapshotMutation = useMutation({
    mutationFn: async () => {
      if (!workspace || !activeWebSpace) throw new Error("当前登录空间无效");
      if (!webSpaceDesktopAvailable) throw new Error(webSpaceCapabilityTip ?? "登录空间不可用");
      const result = await captureMatrixAccountWebSpaceSnapshot({
        webSpaceId: activeWebSpace.id,
        workspaceId: workspace.id,
        workspaceType: workspace.type,
        platform,
        browserPartition: activeWebSpace.browserPartition,
        includeScreenshot: true,
        includeSensitiveContext: true
      });
      if (!result.ok || !result.data) throw new Error(result.error?.message ?? "敏感调试快照读取失败");
      return result.data;
    },
    onSuccess: (snapshot) => {
      setSensitiveSnapshot(snapshot);
      setSensitiveSnapshotDrawerOpen(true);
      void message.success("敏感调试快照已读取");
    },
    onError: (err) => {
      void message.error(err instanceof Error ? err.message : "敏感调试快照读取失败");
    }
  });

  const selectedAccounts = useMemo(() => {
    const rows = data?.items ?? [];
    return selectedRowKeys.map((key) => rows.find((item) => item.id === key)).filter(Boolean) as MatrixAccount[];
  }, [data?.items, selectedRowKeys]);
  const selectedActiveAccounts = useMemo(
    () => selectedAccounts.filter((account) => account.status !== "disabled"),
    [selectedAccounts]
  );

  const saveMutation = useMutation({
    mutationFn: (values: MatrixAccountInput) => {
      if (!editing) throw new Error("请选择要编辑的账号");
      return updateMatrixAccount(client, editing.id, values);
    },
    onSuccess: () => {
      void message.success("账号已更新");
      setDrawerOpen(false);
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ["matrix-accounts", platform] });
    },
    onError: (err) => {
      void message.error(err instanceof Error ? err.message : "保存失败");
    }
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: MatrixAccountStatus }) =>
      updateMatrixAccountStatus(client, id, status),
    onSuccess: () => {
      void message.success("状态已更新");
      void queryClient.invalidateQueries({ queryKey: ["matrix-accounts", platform] });
    },
    onError: (err) => {
      void message.error(err instanceof Error ? err.message : "状态更新失败");
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMatrixAccount(client, id),
    onSuccess: () => {
      void message.success("账号已删除");
      void queryClient.invalidateQueries({ queryKey: ["matrix-accounts", platform] });
    },
    onError: (err) => {
      void message.error(err instanceof Error ? err.message : "删除失败");
    }
  });

  const bulkDisableMutation = useMutation({
    mutationFn: () =>
      runBatchRequests(selectedActiveAccounts, (account) => updateMatrixAccountStatus(client, account.id, "disabled"), "批量停用失败"),
    onSuccess: () => {
      void message.success("批量停用完成");
      setSelectedRowKeys([]);
      void queryClient.invalidateQueries({ queryKey: ["matrix-accounts", platform] });
    },
    onError: (err) => {
      void message.error(err instanceof Error ? err.message : "批量停用失败");
    }
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: () => runBatchRequests(selectedAccounts, (account) => deleteMatrixAccount(client, account.id), "批量删除失败"),
    onSuccess: () => {
      void message.success("批量删除完成");
      setSelectedRowKeys([]);
      void queryClient.invalidateQueries({ queryKey: ["matrix-accounts", platform] });
    },
    onError: (err) => {
      void message.error(err instanceof Error ? err.message : "批量删除失败");
    }
  });

  const bulkCheckMutation = useMutation({
    mutationFn: () =>
      runBatchRequests(
        selectedActiveAccounts,
        (account) =>
          checkDesktopAction(() =>
            openMatrixAccountInput(account, async (input) => {
              const result = await checkMatrixAccountSession(input);
              if (!result.ok) throw new Error(result.error?.message ?? "检测失败");
            })
          ),
        "批量检测失败"
      ),
    onSuccess: () => {
      void message.success("已发起批量检测");
      setSelectedRowKeys([]);
    },
    onError: (err) => {
      void message.error(err instanceof Error ? err.message : "批量检测失败");
    }
  });

  function updateWebSpaceProgress(progress: WebSpaceFlowProgress) {
    setWebSpaceProgress(progress);
    setWebSpaceFlowLogs((current) => {
      const latest = current[0];
      if (latest?.phase === progress.phase && latest.title === progress.title && latest.reasonCode === progress.reasonCode) {
        return current;
      }
      return [
        {
          id: `${Date.now()}-${current.length}`,
          time: new Date().toISOString(),
          phase: progress.phase,
          actor: progress.actor,
          title: progress.title,
          reasonCode: progress.reasonCode,
          reasonText: progress.reasonText
        },
        ...current
      ].slice(0, 60);
    });
  }

  function progressForCodexRepair(reasonCode: string, purpose: MatrixAccountLoginScriptPurpose): WebSpaceFlowProgress {
    return {
      phase: "generating_script",
      actor: "codex",
      title:
        purpose === "qr_login_refresh"
          ? "正在创建刷新二维码修复任务"
          : purpose === "account_detect"
            ? "正在创建账号识别修复任务"
            : "正在创建二维码识别修复任务",
      reasonCode,
      reasonText: generationReasonText(reasonCode),
      description: "当前脚本未达到预期，系统将启动 Codex 执行器复检页面并修复适配脚本。"
    };
  }

  async function createCodexRepairTask(
    webSpace: MatrixAccountWebSpace,
    purpose: MatrixAccountLoginScriptPurpose,
    triggerReason: string,
    context: {
      scriptId?: string;
      scriptVersionId?: string;
      snapshot?: MatrixAccountWebSpaceSnapshotResult;
      resultSummary?: Partial<MatrixAccountWebSpaceScriptResult> | Record<string, unknown>;
    } = {}
  ): Promise<AiExecutorTask> {
    const existing = webSpaceRepairTaskRef.current;
    if (existing?.webSpaceId === webSpace.id && existing.purpose === purpose && existing.triggerReason === triggerReason) {
      return existing;
    }
    setWebSpaceFlowStatus(purpose === "account_detect" ? "detecting_account" : "waiting_qr");
    updateWebSpaceProgress(progressForCodexRepair(triggerReason, purpose));
    try {
      const task = await createMatrixAccountRepairTask(client, {
        purpose,
        triggerReason,
        webSpaceId: webSpace.id,
        scriptId: context.scriptId,
        scriptVersionId: context.scriptVersionId,
        resultSummary: {
          platform,
          purpose,
          triggerReason,
          snapshot: context.snapshot ? compactSnapshot(context.snapshot) : undefined,
          scriptResult: context.resultSummary ?? undefined
        }
      });
      setWebSpaceRepairTask(task);
      webSpaceRepairTaskRef.current = task;
      updateWebSpaceProgress({
        phase: "generating_script",
        actor: "codex",
        title: "已创建 Codex 修复任务",
        reasonCode: triggerReason,
        reasonText: generationReasonText(triggerReason),
        description: "Codex 正在通过调试通道复检页面并修复脚本，可在 AI 执行器任务中查看终端输出和结构化事件。"
      });
      void queryClient.invalidateQueries({ queryKey: ["ai-executor-tasks"] });
      return task;
    } catch (err) {
      setWebSpaceFlowStatus("failed");
      updateWebSpaceProgress({
        phase: "failed",
        actor: "system",
        title: "Codex 修复任务创建失败",
        reasonCode: triggerReason,
        reasonText: generationReasonText(triggerReason),
        description: executorErrorMessage(err)
      });
      throw new Error(executorErrorMessage(err));
    }
  }

  function updateWebSpaceScriptSummary(result: MatrixAccountLoginScriptResolveResult, purpose: MatrixAccountLoginScriptPurpose) {
    if (!result.version) return;
    setWebSpaceScriptSummary({
      purpose,
      version: result.version.version,
      status: result.version.status,
      source: result.version.source,
      reasonCode: result.reason || result.version.generationReason,
      reasonText: generationReasonText(result.reason || result.version.generationReason)
    });
  }

  async function executeWebSpaceQrScript(
    webSpace: MatrixAccountWebSpace,
    purpose: Extract<MatrixAccountLoginScriptPurpose, "qr_login_prepare" | "qr_login_refresh">,
    options?: { retryOnFailure?: boolean }
  ): Promise<{ qrCodeDataUrl: string; webSpace: MatrixAccountWebSpace; repairTask?: AiExecutorTask }> {
    if (!workspace) throw new Error("当前工作区无效");
    const baseInput = {
      webSpaceId: webSpace.id,
      workspaceId: workspace.id,
      workspaceType: workspace.type,
      platform,
      browserPartition: webSpace.browserPartition
    };

    let retryReason = "";
    const maxAttempts = options?.retryOnFailure === false ? 1 : 2;
    setWebSpaceFlowStatus(purpose === "qr_login_refresh" ? "refreshing_qr" : "waiting_qr");
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      updateWebSpaceProgress({
        phase: "capturing_snapshot",
        actor: "desktop",
        title: "正在采集登录页状态",
        description: "只采集脱敏页面结构和必要截图，用于匹配或生成脚本。"
      });
      const snapshotResult = await captureMatrixAccountWebSpaceSnapshot({
        ...baseInput,
        includeScreenshot: true,
        includeSensitiveContext: true
      });
      if (!snapshotResult.ok || !snapshotResult.data) {
        throw new Error(snapshotResult.error?.message ?? "登录空间快照采集失败");
      }
      const snapshot = snapshotResult.data;

      updateWebSpaceProgress({
        phase: "resolving_script",
        actor: "system",
        title: purpose === "qr_login_refresh" ? "正在匹配刷新脚本" : "正在匹配登录脚本",
        description: "优先复用已验证脚本，命中时不会调用 AI。"
      });
      const resolved = await resolveMatrixAccountLoginScript(client, webSpace.id, {
        purpose,
        pageFingerprint: snapshot.pageFingerprint,
        url: snapshot.url
      });
      const shouldGenerate = Boolean(retryReason || !resolved.version || resolved.shouldGenerate);
      const generationReason = retryReason || resolved.reason || fallbackGenerationReason(purpose);
      if (shouldGenerate) {
        const repairTask = await createCodexRepairTask(webSpace, purpose, generationReason, {
          scriptId: resolved.script?.id,
          scriptVersionId: resolved.version?.id,
          snapshot
        });
        return { qrCodeDataUrl: "", webSpace, repairTask };
      }
      const scriptResult = resolved;
      if (!scriptResult.script || !scriptResult.version) {
        const repairTask = await createCodexRepairTask(webSpace, purpose, "no_active_script", { snapshot });
        return { qrCodeDataUrl: "", webSpace, repairTask };
      }
      updateWebSpaceScriptSummary(scriptResult, purpose);

      updateWebSpaceProgress({
        phase: purpose === "qr_login_refresh" ? "refreshing_qr" : "running_script",
        actor: "script",
        title: shouldGenerate ? "正在执行新适配脚本" : "已命中适配脚本，正在提取二维码",
        reasonCode: scriptResult.reason,
        reasonText: generationReasonText(scriptResult.reason),
        description: purpose === "qr_login_refresh" ? "正在当前登录空间内刷新并重新提取二维码。" : "正在当前登录空间内提取二维码。"
      });
      const runResult = await runMatrixAccountWebSpaceLoginScript({
        ...baseInput,
        scriptVersionId: scriptResult.version.id,
        purpose,
        dsl: scriptResult.version.dsl
      });
      const payload = runResult.data;
      const qrReady = Boolean(runResult.ok && payload?.status === "success" && payload.qrCodeDataUrl);
      await submitMatrixAccountLoginScriptRunResult(client, webSpace.id, {
        scriptId: scriptResult.script.id,
        scriptVersionId: scriptResult.version.id,
        purpose,
        status: qrReady ? "success" : payload?.status === "timeout" ? "timeout" : "failed",
        errorCode: qrReady ? undefined : runResult.ok ? payload?.errorCode || "qr_not_found" : runResult.error?.code,
        errorMessage: qrReady ? undefined : runResult.ok ? payload?.errorMessage || "二维码生成失败" : runResult.error?.message,
        durationMs: payload?.durationMs,
        resultSummary: payload
      });
      void queryClient.invalidateQueries({ queryKey: ["matrix-account-web-space-script-runs", webSpace.id] });
      if (qrReady && payload?.qrCodeDataUrl) {
        return {
          qrCodeDataUrl: payload.qrCodeDataUrl,
          webSpace: { ...webSpace, browserPartition: payload.browserPartition || webSpace.browserPartition }
        };
      }
      retryReason = purpose === "qr_login_refresh" ? "refresh_script_failed" : (payload?.errorCode === "qr_not_found" ? "qr_not_found" : "script_run_failed");
      const repairTask = await createCodexRepairTask(webSpace, purpose, retryReason, {
        scriptId: scriptResult.script.id,
        scriptVersionId: scriptResult.version.id,
        snapshot,
        resultSummary: payload ?? { error: runResult.error }
      });
      return { qrCodeDataUrl: "", webSpace, repairTask };
    }
    throw new Error("二维码生成失败");
  }

  async function executeWebSpaceAccountDetectScript(
    webSpace: MatrixAccountWebSpace,
    options?: { retryOnFailure?: boolean }
  ): Promise<{ pending: boolean; candidate?: MatrixAccountDetectResultInput; webSpace: MatrixAccountWebSpace; reason?: string }> {
    if (!workspace) throw new Error("当前工作区无效");
    if (!webSpaceQrCode) {
      setWebSpaceFlowStatus("waiting_qr");
      updateWebSpaceProgress({
        phase: "waiting_scan",
        actor: "system",
        title: "等待二维码生成",
        description: "二维码生成前不会执行账号识别。"
      });
      return { pending: true, webSpace, reason: "waiting_qr" };
    }
    const purpose: Extract<MatrixAccountLoginScriptPurpose, "account_detect"> = "account_detect";
    const baseInput = {
      webSpaceId: webSpace.id,
      workspaceId: workspace.id,
      workspaceType: workspace.type,
      platform,
      browserPartition: webSpace.browserPartition
    };

    let retryReason = "";
    const maxAttempts = options?.retryOnFailure === false ? 1 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const snapshotResult = await captureMatrixAccountWebSpaceSnapshot({
        ...baseInput,
        includeScreenshot: true,
        includeSensitiveContext: true
      });
      if (!snapshotResult.ok || !snapshotResult.data) {
        throw new Error(snapshotResult.error?.message ?? "登录空间快照采集失败");
      }
      const snapshot = snapshotResult.data;
      if (!retryReason && !isLikelyLoginCompleted(snapshot)) {
        return { pending: true, webSpace, reason: "waiting_scan" };
      }

      setWebSpaceFlowStatus("detecting_account");
      updateWebSpaceProgress({
        phase: "capturing_snapshot",
        actor: "desktop",
        title: "已检测到扫码完成，正在识别账号",
        description: "正在采集登录后的页面状态，用于匹配账号识别脚本。"
      });

      updateWebSpaceProgress({
        phase: "resolving_script",
        actor: "system",
        title: "正在匹配账号识别脚本",
        description: "优先复用已验证脚本，命中时不会调用 AI。"
      });
      const resolved = await resolveMatrixAccountLoginScript(client, webSpace.id, {
        purpose,
        pageFingerprint: snapshot.pageFingerprint,
        url: snapshot.url
      });
      const shouldGenerate = Boolean(retryReason || !resolved.version || resolved.shouldGenerate);
      const generationReason = retryReason || resolved.reason || fallbackGenerationReason(purpose);
      if (shouldGenerate) {
        await createCodexRepairTask(webSpace, purpose, generationReason, {
          scriptId: resolved.script?.id,
          scriptVersionId: resolved.version?.id,
          snapshot
        });
        return { pending: true, webSpace, reason: generationReason };
      }
      const scriptResult = resolved;
      if (!scriptResult.script || !scriptResult.version) {
        await createCodexRepairTask(webSpace, purpose, "detect_script_missing", { snapshot });
        return { pending: true, webSpace, reason: "detect_script_missing" };
      }
      updateWebSpaceScriptSummary(scriptResult, purpose);

      updateWebSpaceProgress({
        phase: "detecting_account",
        actor: "script",
        title: shouldGenerate ? "正在执行新账号识别脚本" : "已命中账号识别脚本",
        reasonCode: scriptResult.reason,
        reasonText: generationReasonText(scriptResult.reason),
        description: "正在识别平台账号基础信息，不读取敏感登录凭据。"
      });
      const runResult = await runMatrixAccountWebSpaceLoginScript({
        ...baseInput,
        scriptVersionId: scriptResult.version.id,
        purpose,
        dsl: scriptResult.version.dsl
      });
      const payload = runResult.data;
      const candidate = payload?.accountCandidate;
      const candidateReady = Boolean(runResult.ok && payload?.status === "success" && isUsableAccountCandidate(candidate));
      const errorCode = candidateReady
        ? undefined
        : runResult.ok
          ? payload?.errorCode || "account_identity_not_found"
          : runResult.error?.code || "detect_script_failed";
      await submitMatrixAccountLoginScriptRunResult(client, webSpace.id, {
        scriptId: scriptResult.script.id,
        scriptVersionId: scriptResult.version.id,
        purpose,
        status: candidateReady ? "success" : payload?.status === "timeout" ? "timeout" : "failed",
        errorCode,
        errorMessage: candidateReady ? undefined : runResult.ok ? payload?.errorMessage || "账号识别失败" : runResult.error?.message,
        durationMs: payload?.durationMs,
        resultSummary: payload
      });
      void queryClient.invalidateQueries({ queryKey: ["matrix-account-web-space-script-runs", webSpace.id] });
      if (candidateReady && candidate) {
        return {
          pending: false,
          webSpace: { ...webSpace, browserPartition: payload?.browserPartition || webSpace.browserPartition },
          candidate: {
            identityKey: candidate.identityKey,
            platformUid: candidate.platformUid,
            displayName: candidate.displayName,
            nickname: candidate.nickname,
            avatarUrl: candidate.avatarUrl,
            homeUrl: candidate.homeUrl,
            browserPartition: payload?.browserPartition || webSpace.browserPartition,
            loginStatus: "online"
          }
        };
      }
      retryReason = errorCode === "account_identity_not_found" ? "account_identity_not_found" : "detect_script_failed";
      await createCodexRepairTask(webSpace, purpose, retryReason, {
        scriptId: scriptResult.script.id,
        scriptVersionId: scriptResult.version.id,
        snapshot,
        resultSummary: payload ?? { error: runResult.error }
      });
      return { pending: true, webSpace, reason: retryReason };
    }
    return { pending: true, webSpace, reason: "waiting_scan" };
  }

  const createWebSpaceMutation = useMutation({
    mutationFn: async ({ flowId }: CreateWebSpaceOptions) => {
      if (!workspace) throw new Error("当前工作区无效");
      if (!webSpaceDesktopAvailable) throw new Error(webSpaceCapabilityTip ?? "新增登录空间不可用");
      const webSpace = await createMatrixAccountWebSpace(client, { platform });
      const result = await createMatrixAccountWebSpaceLogin({
        webSpaceId: webSpace.id,
        workspaceId: workspace.id,
        workspaceType: workspace.type,
        platform,
        browserPartition: webSpace.browserPartition,
        showWindow: false
      });
      if (!result.ok) throw new Error(result.error?.message ?? "打开登录空间失败");
      const openedWebSpace = { ...webSpace, browserPartition: result.data?.browserPartition ?? webSpace.browserPartition };
      setActiveWebSpace(openedWebSpace);
      if (result.data?.qrCodeDataUrl) {
        return {
          flowId,
          webSpace: openedWebSpace,
          qrCodeDataUrl: result.data.qrCodeDataUrl,
          qrCodeReason: result.data.qrCodeVerifyReason || result.data.qrCodeReason || "",
          qrCodeRecognized: result.data.qrCodeRecognized,
          repairTask: undefined
        };
      }
      const qrResult = await executeWebSpaceQrScript(openedWebSpace, "qr_login_prepare");
      return {
        flowId,
        webSpace: qrResult.webSpace,
        qrCodeDataUrl: qrResult.qrCodeDataUrl,
        qrCodeReason: "",
        repairTask: qrResult.repairTask
      };
    },
    onSuccess: ({ flowId, webSpace, qrCodeDataUrl, qrCodeReason, qrCodeRecognized, repairTask }) => {
      if (flowId !== webSpaceFlowIdRef.current || webSpaceFlowCancelledRef.current || !webSpaceDrawerOpenRef.current) {
        if (repairTask && isExecutorTaskExecuting(repairTask.status)) {
          setActiveWebSpace(webSpace);
          setWebSpaceRepairTask(repairTask);
          setReleasePendingWebSpace(webSpace);
          return;
        }
        void releaseWebSpaceResources(webSpace, { resetState: false, silent: true });
        return;
      }
      setWebSpaceQrCode(qrCodeDataUrl ?? "");
      setWebSpaceQrReason(qrCodeReason ?? "");
      setActiveWebSpace(webSpace);
      if (repairTask) {
        setWebSpaceRepairTask(repairTask);
        setWebSpaceFlowStatus("waiting_qr");
        return;
      }
      setWebSpaceFlowStatus(qrCodeDataUrl ? "qr_ready" : "waiting_qr");
      updateWebSpaceProgress({
        phase: "waiting_scan",
        actor: "system",
        title: qrCodeDataUrl ? "二维码已生成，等待扫码" : "等待平台生成二维码",
        description: qrCodeDataUrl ? qrCodeReadyDescription(qrCodeRecognized, qrCodeReason) : "可稍后刷新，或打开窗口手动处理。"
      });
      if (qrCodeDataUrl) void message.success("登录二维码已生成，请扫码登录");
    },
    onError: (err, options) => {
      if (options?.flowId !== webSpaceFlowIdRef.current || webSpaceFlowCancelledRef.current || !webSpaceDrawerOpenRef.current) return;
      setWebSpaceFlowStatus("failed");
      setWebSpaceQrReason(err instanceof Error ? err.message : "新增账号失败");
      void message.error(err instanceof Error ? err.message : "新增账号失败");
    }
  });

  const openWebSpaceMutation = useMutation({
    mutationFn: async (options?: WebSpaceOpenOptions) => {
      if (!workspace || !activeWebSpace) throw new Error("当前登录空间无效");
      if (!webSpaceDesktopAvailable) throw new Error(webSpaceCapabilityTip ?? "登录空间不可用");
      const result = await openMatrixAccountWebSpace({
        webSpaceId: activeWebSpace.id,
        workspaceId: workspace.id,
        workspaceType: workspace.type,
        platform,
        browserPartition: activeWebSpace.browserPartition,
        showWindow: options?.showWindow === true
      });
      if (!result.ok) throw new Error(result.error?.message ?? "打开登录空间失败");
      setActiveWebSpace((current) =>
        current ? { ...current, browserPartition: result.data?.browserPartition ?? current.browserPartition } : current
      );
      const openedWebSpace = {
        ...activeWebSpace,
        browserPartition: result.data?.browserPartition ?? activeWebSpace.browserPartition
      };
      if (options?.showWindow) return { ...result.data, qrCodeDataUrl: undefined, qrCodeReason: "", repairTask: undefined };
      if (result.data?.qrCodeDataUrl) {
        return {
          ...result.data,
          qrCodeDataUrl: result.data.qrCodeDataUrl,
          qrCodeReason: result.data.qrCodeVerifyReason || result.data.qrCodeReason || "",
          qrCodeRecognized: result.data.qrCodeRecognized,
          repairTask: undefined
        };
      }
      const qrResult = await executeWebSpaceQrScript(openedWebSpace, "qr_login_prepare", { retryOnFailure: false });
      return { ...result.data, qrCodeDataUrl: qrResult.qrCodeDataUrl, qrCodeReason: "", repairTask: qrResult.repairTask };
    },
    onSuccess: (result, options) => {
      setWebSpaceQrCode((current) => result?.qrCodeDataUrl ?? (options?.showWindow ? current : ""));
      setWebSpaceQrReason(result?.qrCodeReason ?? "");
      if (result?.repairTask) {
        setWebSpaceRepairTask(result.repairTask);
        setWebSpaceFlowStatus("waiting_qr");
      } else if (result?.qrCodeDataUrl) {
        setWebSpaceFlowStatus("qr_ready");
        updateWebSpaceProgress({
          phase: "waiting_scan",
          actor: "system",
          title: "二维码已生成，等待扫码",
          description: qrCodeReadyDescription(result.qrCodeRecognized, result.qrCodeReason)
        });
      } else if (!options?.showWindow) {
        setWebSpaceFlowStatus("waiting_qr");
      }
      if (options?.silent) return;
      if (options?.showWindow) {
        void message.success("已打开登录空间窗口");
      } else if (result?.qrCodeDataUrl) {
        void message.success("二维码已刷新");
      } else {
        void message.warning(result?.qrCodeReason || "暂未获取到二维码，请稍后刷新或打开窗口登录");
      }
    },
    onError: (err, options) => {
      setWebSpaceFlowStatus("failed");
      setWebSpaceQrReason(err instanceof Error ? err.message : "打开登录空间失败");
      if (options?.silent) return;
      void message.error(err instanceof Error ? err.message : "打开登录空间失败");
    }
  });

  const refreshWebSpaceQrMutation = useMutation({
    mutationFn: async () => {
      if (!workspace || !activeWebSpace) throw new Error("当前登录空间无效");
      if (!webSpaceDesktopAvailable) throw new Error(webSpaceCapabilityTip ?? "登录空间不可用");
      setWebSpaceFlowStatus("refreshing_qr");
      const qrResult = await executeWebSpaceQrScript(activeWebSpace, "qr_login_refresh");
      return qrResult;
    },
    onSuccess: ({ qrCodeDataUrl, webSpace, repairTask }) => {
      setActiveWebSpace(webSpace);
      if (repairTask) {
        setWebSpaceRepairTask(repairTask);
        setWebSpaceQrCode("");
        setWebSpaceQrReason("");
        setWebSpaceFlowStatus("waiting_qr");
        return;
      }
      setWebSpaceQrCode(qrCodeDataUrl);
      setWebSpaceQrReason("");
      setWebSpaceFlowStatus("qr_ready");
      updateWebSpaceProgress({
        phase: "waiting_scan",
        actor: "system",
        title: "二维码已更新，等待扫码",
        description: "请使用平台 App 扫码完成登录。"
      });
      void message.success("二维码已刷新");
    },
    onError: (err) => {
      setWebSpaceFlowStatus("failed");
      setWebSpaceQrReason(err instanceof Error ? err.message : "二维码刷新失败，请打开窗口手动处理或稍后重试");
      updateWebSpaceProgress({
        phase: "failed",
        actor: "system",
        title: "二维码刷新失败",
        description: "已保留当前二维码，可重试或打开窗口手动处理。"
      });
      void message.error(err instanceof Error ? err.message : "二维码刷新失败");
    }
  });

  const detectWebSpaceMutation = useMutation({
    mutationFn: async (options?: WebSpaceDetectOptions) => {
      if (!workspace || !activeWebSpace) throw new Error("当前登录空间无效");
      if (!webSpaceDesktopAvailable) throw new Error(webSpaceCapabilityTip ?? "登录空间不可用");
      if (!webSpaceQrCode || webSpaceFlowStatus !== "qr_ready") {
        return { pending: true, bindResult: undefined, silent: options?.silent === true };
      }
      const detected = await executeWebSpaceAccountDetectScript(activeWebSpace);
      if (detected.pending || !detected.candidate) {
        return { pending: true, bindResult: undefined, silent: options?.silent === true };
      }
      const bindResult = await submitMatrixAccountWebSpaceDetectResult(client, activeWebSpace.id, {
        identityKey: detected.candidate.identityKey,
        platformUid: detected.candidate.platformUid,
        displayName: detected.candidate.displayName,
        nickname: detected.candidate.nickname,
        avatarUrl: detected.candidate.avatarUrl,
        homeUrl: detected.candidate.homeUrl,
        browserPartition: detected.candidate.browserPartition,
        loginStatus: detected.candidate.loginStatus
      });
      return { pending: false, candidate: detected.candidate, bindResult, silent: options?.silent === true };
    },
    onSuccess: (result) => {
      if (result.pending || !result.bindResult) return;
      const bindResult = result.bindResult;
      const silent = result.silent;
      setActiveWebSpace(bindResult.webSpace);
      if (bindResult.account) {
        webSpaceFlowCompletedRef.current = true;
        setWebSpaceFlowStatus("success");
        updateWebSpaceProgress({
          phase: "detecting_account",
          actor: "system",
          title: "账号已识别",
          description: bindResult.created ? "账号档案已创建。" : "账号档案已绑定。"
        });
        void message.success(bindResult.created ? "账号已识别并创建" : "账号已识别并绑定");
        setWebSpaceDrawerOpen(false);
        setActiveWebSpace(null);
        setWebSpaceQrCode("");
        setWebSpaceQrReason("");
        void queryClient.invalidateQueries({ queryKey: ["matrix-accounts", platform] });
      } else {
        if (!silent) void message.warning("暂未识别到账号信息");
      }
    },
    onError: (err, options) => {
      if (options?.silent) return;
      void message.error(err instanceof Error ? err.message : "识别账号失败");
    }
  });

  useEffect(() => {
    if (
      !webSpaceDrawerOpen ||
      !activeWebSpace ||
      webSpaceQrCode ||
      !webSpaceDesktopAvailable ||
      webSpaceFlowStatus === "success" ||
      webSpaceFlowStatus === "failed" ||
      webSpaceFlowStatus === "releasing" ||
      Boolean(webSpaceRepairTask)
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      if (!openWebSpaceMutation.isPending) {
        openWebSpaceMutation.mutate({ showWindow: false, silent: true });
      }
    }, 4500);
    return () => window.clearInterval(timer);
  }, [
    activeWebSpace?.id,
    openWebSpaceMutation.isPending,
    webSpaceDesktopAvailable,
    webSpaceDrawerOpen,
    webSpaceFlowStatus,
    webSpaceQrCode,
    webSpaceRepairTask?.id
  ]);

  useEffect(() => {
    if (
      !webSpaceDrawerOpen ||
      !activeWebSpace ||
      !workspace ||
      !webSpaceDesktopAvailable ||
      !webSpaceQrCode ||
      webSpaceFlowStatus !== "qr_ready" ||
      Boolean(webSpaceRepairTask)
    ) {
      return;
    }
    const runDetect = () => {
      if (!detectWebSpaceMutation.isPending) {
        detectWebSpaceMutation.mutate({ silent: true });
      }
    };
    const firstDetect = window.setTimeout(runDetect, 2200);
    const timer = window.setInterval(runDetect, 3600);
    return () => {
      window.clearTimeout(firstDetect);
      window.clearInterval(timer);
    };
  }, [
    activeWebSpace?.id,
    detectWebSpaceMutation.isPending,
    webSpaceDesktopAvailable,
    webSpaceDrawerOpen,
    webSpaceFlowStatus,
    webSpaceQrCode,
    webSpaceRepairTask?.id,
    workspace?.id
  ]);

  function applyState(next: Partial<QueryState>) {
    setSelectedRowKeys([]);
    setQueryState((current) => ({ ...current, ...next }));
  }

  function resetWebSpaceFlow(options?: { keepCancelled?: boolean }) {
    setActiveWebSpace(null);
    setWebSpaceQrCode("");
    setWebSpaceQrReason("");
    setWebSpaceFlowStatus("idle");
    setWebSpaceProgress(initialWebSpaceProgress);
    setWebSpaceScriptSummary(null);
    setWebSpaceRepairTask(null);
    setWebSpaceLogsVisible(false);
    setWebSpaceFlowLogs([]);
    setWebSpaceActiveTab("add");
    setAutomationView("overview");
    setSelectedScriptId("");
    setScriptDetailDrawerOpen(false);
    setSensitiveSnapshot(null);
    setSensitiveSnapshotDrawerOpen(false);
    setDebugWindow(null);
    setReleasePendingWebSpace(null);
    webSpaceFlowCompletedRef.current = false;
    if (!options?.keepCancelled) {
      webSpaceFlowCancelledRef.current = false;
    }
  }

  async function releaseWebSpaceResources(
    webSpace: MatrixAccountWebSpace,
    options?: { resetState?: boolean; silent?: boolean }
  ) {
    const workspaceId = workspace?.id ?? webSpace.workspaceId;
    const workspaceType = (workspace?.type ?? webSpace.workspaceType) as "platform" | "agency" | "enterprise";
    if (options?.resetState !== false) {
      setWebSpaceFlowStatus("releasing");
      setWebSpaceProgress({
        phase: "releasing",
        actor: "desktop",
        title: "正在释放登录空间",
        description: "正在关闭临时受控浏览器并清理本次登录空间。"
      });
    }
    try {
      if (webSpaceDesktopAvailable) {
        const result = await clearMatrixAccountWebSpace({
          webSpaceId: webSpace.id,
          workspaceId,
          workspaceType,
          platform,
          browserPartition: webSpace.browserPartition
        });
        if (!result.ok) throw new Error(result.error?.message ?? "释放登录空间失败");
      }
      await clearMatrixAccountWebSpaceRecord(client, webSpace.id);
    } catch (err) {
      if (!options?.silent) {
        void message.error(err instanceof Error ? err.message : "释放登录空间失败");
      }
    } finally {
      if (options?.resetState !== false) {
        resetWebSpaceFlow();
      }
    }
  }

  function openCreate() {
    const flowId = webSpaceFlowIdRef.current + 1;
    webSpaceFlowIdRef.current = flowId;
    webSpaceFlowCompletedRef.current = false;
    webSpaceFlowCancelledRef.current = false;
    setActiveWebSpace(null);
    setWebSpaceQrCode("");
    setWebSpaceQrReason("");
    setWebSpaceFlowStatus("initializing");
    setWebSpaceProgress(initialWebSpaceProgress);
    setWebSpaceScriptSummary(null);
    setWebSpaceRepairTask(null);
    setWebSpaceLogsVisible(false);
    setWebSpaceFlowLogs([]);
    setWebSpaceActiveTab("add");
    setAutomationView("overview");
    setSelectedScriptId("");
    setScriptDetailDrawerOpen(false);
    setSensitiveSnapshot(null);
    setSensitiveSnapshotDrawerOpen(false);
    setDebugWindow(null);
    setReleasePendingWebSpace(null);
    setWebSpaceDrawerOpen(true);
    createWebSpaceMutation.mutate({ flowId });
  }

  function closeWebSpaceDrawer() {
    webSpaceFlowCancelledRef.current = true;
    setWebSpaceDrawerOpen(false);
    setScriptDetailDrawerOpen(false);
    setSensitiveSnapshot(null);
    setSensitiveSnapshotDrawerOpen(false);
    setDebugWindow(null);
    if (activeWebSpace && !webSpaceFlowCompletedRef.current) {
      const task = webSpaceRepairTaskRef.current;
      if (isExecutorTaskExecuting(task?.status)) {
        setReleasePendingWebSpace(activeWebSpace);
        void message.info("Codex 执行器任务仍在运行，任务结束后将自动释放登录空间");
        return;
      }
      void releaseWebSpaceResources(activeWebSpace);
      return;
    }
    resetWebSpaceFlow({ keepCancelled: createWebSpaceMutation.isPending });
  }

  async function openExecutorTerminalWindow(task: AiExecutorTask | null | undefined = webSpaceRepairTaskRef.current) {
    if (!task?.id) {
      void message.warning("暂无 Codex 执行器任务");
      return;
    }
    if (!workspace) {
      void message.warning("当前工作区上下文不可用");
      return;
    }
    const terminalUrl = new URL(
      `/w/${workspace.type}/${workspace.id}/workbench/matrix-accounts/executor-terminal/${task.id}`,
      window.location.origin
    );
    terminalUrl.searchParams.set("terminalWindow", "1");
    terminalUrl.searchParams.set("redactTerminal", canUseDebugTools && !redactTerminalContent ? "0" : "1");
    if (debugMode) terminalUrl.searchParams.set("debug", "1");

    if (!desktopRuntime) {
      window.open(
        terminalUrl.toString(),
        `aicrm-executor-terminal-${task.id}`,
        EXECUTOR_TERMINAL_POPUP_FEATURES
      );
      return;
    }

    const result = await openAiExecutorTerminalWindow({
      taskId: task.id,
      url: terminalUrl.toString(),
      title: `${platformLabels[platform]}执行器仿真终端`
    });
    if (!result.ok) {
      void message.error(result.error?.message || "打开独立终端窗口失败");
    }
  }

  function openEdit(account: MatrixAccount) {
    setEditing(account);
    form.resetFields();
    form.setFieldsValue({
      displayName: account.displayName,
      remark: account.remark
    });
    setDrawerOpen(true);
  }

  async function checkDesktopAction(action: () => Promise<unknown>) {
    if (!desktopAvailable) {
      throw new Error(desktopCapabilityTip ?? "矩阵账号登录态能力不可用");
    }
    await action();
  }

  async function openMatrixAccountInput<T>(
    account: MatrixAccount,
    action: (input: {
      accountId: string;
      workspaceId: string;
      workspaceType: "platform" | "agency" | "enterprise";
      platform: MatrixAccountPlatform;
      browserPartition?: string;
      url?: string;
    }) => Promise<T>
  ): Promise<T> {
    if (!workspace) throw new Error("当前工作区无效");
    return action({
      accountId: account.id,
      workspaceId: workspace.id,
      workspaceType: workspace.type,
      platform,
      browserPartition: account.browserPartition || undefined,
      url: account.homeUrl || undefined
    });
  }

  async function runDesktopAction(
    account: MatrixAccount,
    action: "login" | "open" | "clear",
    executor: typeof startMatrixAccountLogin | typeof openMatrixAccount | typeof clearMatrixAccountProfile
  ) {
    try {
      await checkDesktopAction(() =>
        openMatrixAccountInput(account, async (input) => {
          const result = await executor(input);
          if (!result.ok) throw new Error(result.error?.message ?? "客户端操作失败");
        })
      );
      if (action === "login") void message.success("已打开登录窗口");
      if (action === "open") void message.success("已打开受控浏览器窗口");
      if (action === "clear") void message.success("本机 Profile 已清理");
    } catch (err) {
      void message.error(err instanceof Error ? err.message : "客户端操作失败");
    }
  }

  const columns: TableProps<MatrixAccount>["columns"] = [
    {
      title: "账号",
      dataIndex: "displayName",
      width: 240,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.displayName || record.nickname || "未命名账号"}</Typography.Text>
          <Typography.Text type="secondary">{record.platformUid || record.nickname || "-"}</Typography.Text>
        </Space>
      )
    },
    {
      title: "归属人",
      dataIndex: "ownerName",
      width: 140,
      render: (value) => value || "-"
    },
    {
      title: "部门",
      dataIndex: "departmentName",
      width: 140,
      render: (value) => value || "-"
    },
    {
      title: "团队",
      dataIndex: "teamName",
      width: 140,
      render: (value) => value || "-"
    },
    {
      title: "登录状态",
      dataIndex: "loginStatus",
      width: 130,
      render: (value: MatrixAccountLoginStatus) => (
        <Tag color={loginStatusColors[value]}>{loginStatusLabels[value] ?? value}</Tag>
      )
    },
    {
      title: "业务状态",
      dataIndex: "status",
      width: 110,
      render: (value: MatrixAccountStatus) => <Tag color={value === "normal" ? "green" : "default"}>{value === "normal" ? "正常" : "已停用"}</Tag>
    },
    {
      title: "最近登录",
      dataIndex: "lastLoginAt",
      width: 170,
      render: formatTime
    },
    {
      title: "最近检测",
      dataIndex: "lastCheckAt",
      width: 170,
      render: formatTime
    },
    {
      title: "备注",
      dataIndex: "remark",
      width: 220,
      ellipsis: true,
      render: (value) => value || "-"
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 230,
      className: "table-action-column",
      render: (_, record) => (
        <div className="table-action-grid">
          {canLogin ? (
            <Tooltip title={desktopCapabilityTip}>
              <Button size="small" type="link" disabled={!desktopAvailable} onClick={() => runDesktopAction(record, "login", startMatrixAccountLogin)}>
                登录
              </Button>
            </Tooltip>
          ) : null}
          {canOpen ? (
            <Tooltip title={desktopCapabilityTip}>
              <Button size="small" type="link" disabled={!desktopAvailable} onClick={() => runDesktopAction(record, "open", openMatrixAccount)}>
                打开
              </Button>
            </Tooltip>
          ) : null}
          {canUpdate ? (
            <Button size="small" type="link" onClick={() => openEdit(record)}>
              编辑
            </Button>
          ) : null}
          {canStatus && record.status === "normal" ? (
            <Popconfirm title="确认停用该账号？" okText="停用" cancelText="取消" onConfirm={() => statusMutation.mutate({ id: record.id, status: "disabled" })}>
              <Button size="small" danger type="link">
                停用
              </Button>
            </Popconfirm>
          ) : null}
          {canStatus && record.status === "disabled" ? (
            <Button size="small" type="link" onClick={() => statusMutation.mutate({ id: record.id, status: "normal" })}>
              启用
            </Button>
          ) : null}
          {canClearSession ? (
            <Tooltip title={desktopCapabilityTip}>
              <Button size="small" type="link" disabled={!desktopAvailable} onClick={() => runDesktopAction(record, "clear", clearMatrixAccountProfile)}>
                清理
              </Button>
            </Tooltip>
          ) : null}
          {canDelete ? (
            <Popconfirm title="确认删除该账号？" okText="删除" cancelText="取消" onConfirm={() => deleteMutation.mutate(record.id)}>
              <Button size="small" danger type="link">
                删除
              </Button>
            </Popconfirm>
          ) : null}
        </div>
      )
    }
  ];

  const selectedScript = loginScripts.find((script) => script.id === selectedScriptId) ?? null;
  const selectedScriptGroup =
    loginScriptGroups.find((group) => group.scripts.some((script) => script.id === selectedScriptId)) ?? null;
  const currentFlowLogList = (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      {webSpaceFlowLogs.length > 0 ? (
        webSpaceFlowLogs.slice(0, 20).map((item) => (
          <div key={item.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <Typography.Text type="secondary" style={{ flex: "0 0 74px", fontSize: 12 }}>
              {formatShortTime(item.time)}
            </Typography.Text>
            <Typography.Text style={{ flex: 1 }}>{item.title}</Typography.Text>
            {item.reasonText ? <Tag>{item.reasonText}</Tag> : null}
          </div>
        ))
      ) : (
        <Typography.Text type="secondary">暂无当前流程日志</Typography.Text>
      )}
    </Space>
  );
  const webSpaceTabItems: WebSpaceTabItem[] = [
    {
      key: "add",
      label: "添加账号",
      children: (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div style={{ alignItems: "center", display: "flex", gap: 12, justifyContent: "space-between", width: "100%" }}>
            <Space wrap style={{ minWidth: 0 }}>
              <Tag color="blue">{platformLabels[platform]}</Tag>
              <Tag>{webSpaceFlowLabel(webSpaceFlowStatus)}</Tag>
              {webSpaceProgress.actor === "codex" ? <Tag color="purple">AI 自动化</Tag> : null}
            </Space>
            {activeWebSpace && ["waiting_qr", "qr_ready", "failed"].includes(webSpaceFlowStatus) ? (
              <Button
                loading={refreshWebSpaceQrMutation.isPending}
                onClick={() => refreshWebSpaceQrMutation.mutate()}
                disabled={!activeWebSpace || !webSpaceDesktopAvailable}
              >
                刷新二维码
              </Button>
            ) : null}
          </div>
          <Alert
            showIcon
            type={webSpaceFlowStatus === "failed" ? "warning" : webSpaceFlowStatus === "success" ? "success" : "info"}
            message={webSpaceProgress.title}
            description={
              webSpaceQrCode
                ? "请使用平台 App 扫码完成登录，登录成功后系统会自动进入账号识别。"
                : webSpaceFlowStatus === "failed"
                  ? "暂未获取到二维码，可刷新二维码或打开窗口手动处理。"
                  : webSpaceProgress.description || "正在初始化登录空间，等待平台二维码..."
            }
          />
          {webSpaceQrCode ? (
            <div style={{ display: "flex", justifyContent: "center", padding: "8px 0 4px" }}>
              <div
                style={{
                  width: 260,
                  minHeight: 260,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid rgba(127, 127, 127, 0.22)",
                  borderRadius: 8,
                  background: "#fff",
                  padding: 12
                }}
              >
                <img
                  src={webSpaceQrCode}
                  alt={`${platformLabels[platform]}扫码登录二维码`}
                  style={{ display: "block", width: "100%", height: "auto", maxHeight: 236, objectFit: "contain" }}
                />
              </div>
            </div>
          ) : (
            <div style={{ alignItems: "center", display: "flex", flexDirection: "column", gap: 12, padding: "34px 0" }}>
              <Spin />
              <Typography.Text type="secondary">
                {webSpaceFlowStatus === "failed" ? "等待二维码" : "正在等待二维码"}
              </Typography.Text>
            </div>
          )}
        </Space>
      )
    },
    {
      key: "automation",
      label: "AI自动化",
      children: (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Segmented
            value={automationView}
            onChange={(value) => setAutomationView(String(value))}
            options={[
              { value: "overview", label: "概览" },
              { value: "structured", label: "结构化日志" }
            ]}
          />
          {automationView === "overview" ? (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Alert
                showIcon
                type={webSpaceFlowStatus === "failed" ? "warning" : webSpaceFlowStatus === "success" ? "success" : "info"}
                message={webSpaceProgress.title}
                description={
                  <Space direction="vertical" size={2}>
                    {webSpaceProgress.reasonText ? (
                      <Typography.Text type="secondary">原因：{webSpaceProgress.reasonText}</Typography.Text>
                    ) : null}
                    {webSpaceProgress.description ? <Typography.Text type="secondary">{webSpaceProgress.description}</Typography.Text> : null}
                    {webSpaceScriptSummary ? (
                      <Typography.Text type="secondary">
                        当前脚本：{scriptPurposeLabel(webSpaceScriptSummary.purpose)} v{webSpaceScriptSummary.version}
                      </Typography.Text>
                    ) : null}
                  </Space>
                }
              />
              {webSpaceScriptSummary ? (
                <div style={{ border: "1px solid rgba(127, 127, 127, 0.18)", borderRadius: 8, padding: "10px 12px" }}>
                  <Space direction="vertical" size={6} style={{ width: "100%" }}>
                    <Typography.Text strong>当前脚本</Typography.Text>
                    <Space wrap size={6}>
                      <Tag color="blue">{scriptPurposeLabel(webSpaceScriptSummary.purpose)}</Tag>
                      <Tag>v{webSpaceScriptSummary.version}</Tag>
                      <Tag>{scriptVersionStatusLabel(webSpaceScriptSummary.status)}</Tag>
                      <Tag>{scriptVersionSourceLabel(webSpaceScriptSummary.source)}</Tag>
                    </Space>
                    {webSpaceScriptSummary.reasonText ? (
                      <Typography.Text type="secondary">{webSpaceScriptSummary.reasonText}</Typography.Text>
                    ) : null}
                  </Space>
                </div>
              ) : null}
              {webSpaceRepairTask ? (
                <div style={{ border: "1px solid rgba(127, 127, 127, 0.18)", borderRadius: 8, padding: "10px 12px" }}>
                  <Space direction="vertical" size={8} style={{ width: "100%" }}>
                    <Space style={{ width: "100%", justifyContent: "space-between" }} align="center">
                      <Typography.Text strong>Codex 修复任务</Typography.Text>
                      <Tag color={executorTaskStatusColor(webSpaceRepairTask.status)}>
                        {executorTaskStatusLabel(webSpaceRepairTask.status)}
                      </Tag>
                    </Space>
                    <Space wrap size={6}>
                      <Tag>{scriptPurposeLabel(webSpaceRepairTask.purpose || "qr_login_prepare")}</Tag>
                      {webSpaceRepairTask.triggerReason ? (
                        <Tag>{generationReasonText(webSpaceRepairTask.triggerReason)}</Tag>
                      ) : null}
                    </Space>
                    <Button size="small" href="/ai-executor-tasks">
                      查看执行器任务
                    </Button>
                  </Space>
                </div>
              ) : null}
            </Space>
          ) : null}
          {automationView === "structured" ? (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              {taskContextVisible ? (
                <MatrixAccountScriptStructuredContext
                  currentScript={webSpaceScriptSummary}
                  latestRunLog={webSpaceRunLogs?.[0] ?? null}
                  loading={webSpaceRunLogsFetching}
                  repairTask={webSpaceRepairTask}
                  scriptGroups={showScriptManagement ? loginScriptGroups : []}
                />
              ) : null}
              <MatrixAccountExecutorEventStream
                client={client}
                onOpenTerminal={() => openExecutorTerminalWindow(webSpaceRepairTask)}
                showDebugEvents={canUseDebugTools}
                taskId={webSpaceRepairTask?.id}
                taskStatus={webSpaceRepairTask?.status}
              />
              <Typography.Text strong>当前流程日志</Typography.Text>
              {currentFlowLogList}
              <Typography.Text strong>历史运行记录</Typography.Text>
              {webSpaceRunLogsFetching ? (
                <Spin />
              ) : webSpaceRunLogs && webSpaceRunLogs.length > 0 ? (
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  {webSpaceRunLogs.map((item, index) => (
                    <MatrixAccountScriptRunLogItem item={item} key={`${item.createdAt}-${index}`} />
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">暂无历史运行记录</Typography.Text>
              )}
            </Space>
          ) : null}
        </Space>
      )
    }
  ];

  if (showScriptManagement) {
    webSpaceTabItems.push({
      key: "scripts",
      label: "脚本管理",
      children: (
        <Space direction="vertical" size={14} style={{ width: "100%" }}>
          <Alert
            showIcon
            type="info"
            message="脚本管理仅用于调试和运维"
            description="这里展示添加账号流程使用的脚本 DSL、版本、模型、Token 统计与失败原因。"
          />
          <Table<LoginScriptPurposeGroup>
            rowKey="key"
            size="small"
            loading={loginScriptsFetching}
            dataSource={loginScriptGroups}
            pagination={false}
            scroll={{ x: 900 }}
            onRow={(record) => ({
              onClick: () => {
                setSelectedScriptId(record.primary.id);
                setScriptDetailDrawerOpen(true);
              }
            })}
            columns={[
              {
                title: "用途",
                dataIndex: "purpose",
                width: 120,
                render: (value: MatrixAccountLoginScriptPurpose, record) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text strong>{scriptPurposeLabel(value)}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {record.scripts.length} 条指纹适配
                    </Typography.Text>
                  </Space>
                )
              },
              {
                title: "默认展示脚本",
                key: "primary",
                width: 220,
                render: (_, record) => (
                  <Space direction="vertical" size={0}>
                    <Space size={6}>
                      <Tag color={record.primary.activeVersionId ? "green" : record.primary.lastSuccessAt ? "blue" : "default"}>
                        {record.primary.activeVersionId ? "当前有效脚本" : record.primary.lastSuccessAt ? "最近成功脚本" : "最近适配记录"}
                      </Tag>
                      <Tag color={scriptStatusColor(record.primary.status)}>{scriptStatusLabel(record.primary.status)}</Tag>
                    </Space>
                    <Typography.Text type="secondary" ellipsis style={{ maxWidth: 190, fontSize: 12 }}>
                      {record.primary.pageFingerprint ? shortFingerprint(record.primary.pageFingerprint) : "通用指纹"}
                    </Typography.Text>
                  </Space>
                )
              },
              {
                title: "有效/成功",
                key: "stats",
                width: 110,
                render: (_, record) => `${record.activeCount}/${record.successCount}`
              },
              {
                title: "模型",
                dataIndex: ["primary", "modelId"],
                width: 150,
                ellipsis: true,
                render: (value: string) => value || "-"
              },
              {
                title: "Token",
                dataIndex: ["primary", "totalTokens"],
                width: 100
              },
              {
                title: "失败",
                dataIndex: ["primary", "consecutiveFailureCount"],
                width: 90,
                render: (value: number, record) => `${value}/${record.primary.failureThreshold}`
              },
              {
                title: "最后失败",
                dataIndex: ["primary", "lastFailureReason"],
                width: 180,
                ellipsis: true,
                render: (value: string) => (value ? generationReasonText(value) : "-")
              },
              {
                title: "操作",
                key: "actions",
                fixed: "right",
                width: 120,
                render: (_, record) => (
                  <Button
                    size="small"
                    type="link"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedScriptId(record.primary.id);
                      setScriptDetailDrawerOpen(true);
                    }}
                  >
                    查看
                  </Button>
                )
              }
            ]}
          />
          {!loginScriptsFetching && loginScriptGroups.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无脚本" />
          ) : null}
        </Space>
      )
    });
  }

  if (showWebSpaceDebug) {
    webSpaceTabItems.push({
      key: "web-space",
      label: "登录空间",
      children: (
        <Space direction="vertical" size={14} style={{ width: "100%" }}>
          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label="Web 空间">{activeWebSpace?.id || "-"}</Descriptions.Item>
            <Descriptions.Item label="浏览器分区">{activeWebSpace?.browserPartition || "-"}</Descriptions.Item>
            <Descriptions.Item label="状态">{activeWebSpace?.status || webSpaceFlowStatus}</Descriptions.Item>
          </Descriptions>
          <Space>
            <Button
              loading={openWebSpaceMutation.isPending}
              onClick={() => openWebSpaceMutation.mutate({ showWindow: true })}
              disabled={!activeWebSpace || !webSpaceDesktopAvailable || webSpaceFlowStatus === "releasing"}
            >
              打开窗口
            </Button>
            {showSensitiveDebug ? (
              <Button
                danger
                loading={sensitiveSnapshotMutation.isPending}
                disabled={!activeWebSpace || !webSpaceDesktopAvailable}
                onClick={() =>
                  Modal.confirm({
                    title: "确认查看敏感调试数据？",
                    content: "该操作会读取当前登录空间的 Cookie、Storage、Token、原始截图、原始 DOM 等调试上下文，仅用于本次问题定位。",
                    okText: "确认查看",
                    cancelText: "取消",
                    okButtonProps: { danger: true },
                    onOk: () => {
                      setSensitiveSnapshot(null);
                      setSensitiveSnapshotDrawerOpen(true);
                      sensitiveSnapshotMutation.mutate();
                    }
                  })
                }
              >
                查看敏感调试快照
              </Button>
            ) : null}
          </Space>
          <Typography.Text type="secondary">敏感调试快照默认不读取，需显式确认后在独立侧滑窗口中展示。</Typography.Text>
        </Space>
      )
    });
  }

  const activeWebSpaceTab = webSpaceTabItems.find((item) => item.key === webSpaceActiveTab) ?? webSpaceTabItems[0];

  return (
    <>
      <ListPageCard
        title={title}
        subtitle={
          selectedRowKeys.length > 0 ? (
            <Space size={8}>
              <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 项</Typography.Text>
              <Button size="small" type="link" onClick={() => setSelectedRowKeys([])}>
                清空选择
              </Button>
            </Space>
          ) : (
            `管理${platformLabels[platform]} Web 登录态、归属关系与运行状态。`
          )
        }
        toolbar={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="搜索账号名称、UID、备注"
              style={{ width: 260 }}
              value={keywordDraft}
              onChange={(event) => setKeywordDraft(event.target.value)}
              onSearch={() => applyState({ keyword: keywordDraft.trim() || undefined, page: 1 })}
            />
            <Segmented
              className="list-status-segmented"
              value={queryState.status === "disabled" ? "disabled" : queryState.loginStatus ?? ""}
              onChange={(value) => {
                const next = String(value);
                applyState({
                  loginStatus: next && next !== "disabled" ? next : undefined,
                  status: next === "disabled" ? "disabled" : undefined,
                  page: 1
                });
              }}
              options={[
                { value: "", label: "全部" },
                { value: "online", label: "在线" },
                { value: "expired", label: "已失效" },
                { value: "verify_required", label: "需验证" },
                { value: "disabled", label: "已停用" }
              ]}
            />
            <Button
              onClick={() => {
                setKeywordDraft("");
                applyState({ keyword: undefined, loginStatus: undefined, status: undefined, page: 1 });
              }}
            >
              重置
            </Button>
          </Space>
        }
        extra={
          <Space wrap>
            {selectedActiveAccounts.length > 0 && canCheck ? (
              <Tooltip title={desktopCapabilityTip}>
                <Button disabled={!desktopAvailable} loading={bulkCheckMutation.isPending} onClick={() => bulkCheckMutation.mutate()}>
                  批量检测
                </Button>
              </Tooltip>
            ) : null}
            {selectedActiveAccounts.length > 0 && canStatus ? (
              <Popconfirm title={`确认停用选中的 ${selectedActiveAccounts.length} 个账号？`} okText="停用" cancelText="取消" onConfirm={() => bulkDisableMutation.mutate()}>
                <Button danger loading={bulkDisableMutation.isPending}>
                  批量停用
                </Button>
              </Popconfirm>
            ) : null}
            {selectedAccounts.length > 0 && canDelete ? (
              <Popconfirm title={`确认删除选中的 ${selectedAccounts.length} 个账号？`} okText="删除" cancelText="取消" onConfirm={() => bulkDeleteMutation.mutate()}>
                <Button danger loading={bulkDeleteMutation.isPending}>
                  批量删除
                </Button>
              </Popconfirm>
            ) : null}
            {canCreate ? (
              <Tooltip title={webSpaceCapabilityTip}>
                <Button type="primary" disabled={!webSpaceDesktopAvailable} loading={createWebSpaceMutation.isPending} onClick={openCreate}>
                  新增账号
                </Button>
              </Tooltip>
            ) : null}
          </Space>
        }
      >
        {error ? (
          <Alert
            banner
            type="warning"
            message="矩阵账号服务暂不可用"
            description={error instanceof Error ? error.message : "请确认后端矩阵账号服务已部署。"}
          />
        ) : null}
        {!desktopRuntime ? (
          <Alert banner type="info" message="登录态能力需要 AiCRM Desktop 客户端，Web 浏览器仅支持账号档案管理。" />
        ) : null}
        <Table<MatrixAccount>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          rowSelection={
            canStatus || canCheck || canDelete
              ? {
                  selectedRowKeys,
                  onChange: (keys) => setSelectedRowKeys(keys.map(String)),
                  getCheckboxProps: (record) => ({ disabled: !canDelete && record.status === "disabled" })
                }
              : undefined
          }
          scroll={{ x: 1700 }}
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
        destroyOnClose
        title="编辑矩阵账号"
        width={drawerWidths.standardForm}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form<MatrixAccountInput>
          form={form}
          layout="vertical"
          onFinish={(values) => saveMutation.mutate(values)}
        >
          {editing ? (
            <Alert
              showIcon
              type="info"
              message="账号识别信息来自平台 Web 登录结果"
              description={
                <Space direction="vertical" size={2}>
                  <Typography.Text>平台 UID：{editing.platformUid || "-"}</Typography.Text>
                  <Typography.Text>平台昵称：{editing.nickname || "-"}</Typography.Text>
                  <Typography.Text>主页地址：{editing.homeUrl || "-"}</Typography.Text>
                </Space>
              }
              style={{ marginBottom: 16 }}
            />
          ) : null}
          <Form.Item label="账号名称" name="displayName" rules={[{ required: true, message: "请输入账号名称" }]}>
            <Input placeholder={`${platformLabels[platform]}账号名称`} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} placeholder="账号用途、归属说明或运营备注" />
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer
        title={`新增${platformLabels[platform]}账号`}
        width={drawerWidths.simpleDetail}
        open={webSpaceDrawerOpen}
        onClose={closeWebSpaceDrawer}
        extra={
          <Space>
            <DebugSettingsButton
              visible={canUseDebugTools}
              showTaskContext={showTaskContext}
              showEnvironmentInfo={showEnvironmentInfo}
              redactTerminalContent={redactTerminalContent}
              onShowTaskContextChange={setShowTaskContext}
              onShowEnvironmentInfoChange={setShowEnvironmentInfo}
              onRedactTerminalContentChange={setRedactTerminalContent}
            />
            <Button
              loading={openWebSpaceMutation.isPending}
              onClick={() => openWebSpaceMutation.mutate({ showWindow: true })}
              disabled={!activeWebSpace || !webSpaceDesktopAvailable || webSpaceFlowStatus === "releasing"}
            >
              打开窗口
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Segmented
            block
            className="list-status-segmented"
            value={activeWebSpaceTab.key}
            onChange={(value) => setWebSpaceActiveTab(String(value))}
            options={webSpaceTabItems.map((item) => ({ value: item.key, label: item.label }))}
          />
          {activeWebSpaceTab.children}
        </Space>
      </Drawer>

      <Drawer
        destroyOnClose
        title={selectedScriptGroup ? `${scriptPurposeLabel(selectedScriptGroup.purpose)}脚本详情` : "脚本详情"}
        width={drawerWidths.simpleDetail}
        open={scriptDetailDrawerOpen}
        onClose={() => setScriptDetailDrawerOpen(false)}
        extra={
          selectedScript && canScriptsManage ? (
            <Button
              loading={scriptStatusMutation.isPending}
              onClick={() =>
                scriptStatusMutation.mutate({
                  id: selectedScript.id,
                  status: selectedScript.status === "enabled" ? "disabled" : "enabled"
                })
              }
            >
              {selectedScript.status === "enabled" ? "停用脚本" : "启用脚本"}
            </Button>
          ) : null
        }
      >
        {selectedScript ? (
          <Space direction="vertical" size={14} style={{ width: "100%" }}>
            <Descriptions size="small" bordered column={2}>
              <Descriptions.Item label="用途">{scriptPurposeLabel(selectedScriptGroup?.purpose ?? selectedScript.purpose)}</Descriptions.Item>
              <Descriptions.Item label="指纹适配">{selectedScriptGroup?.scripts.length ?? 1} 条</Descriptions.Item>
              <Descriptions.Item label="当前指纹">
                {selectedScript.pageFingerprint ? shortFingerprint(selectedScript.pageFingerprint) : "通用指纹"}
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={scriptStatusColor(selectedScript.status)}>{scriptStatusLabel(selectedScript.status)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="生效版本">{selectedScript.activeVersionId ? shortFingerprint(selectedScript.activeVersionId) : "-"}</Descriptions.Item>
              <Descriptions.Item label="模型">{selectedScript.modelId || "-"}</Descriptions.Item>
              <Descriptions.Item label="累计 Prompt Token">{selectedScript.totalPromptTokens}</Descriptions.Item>
              <Descriptions.Item label="累计 Completion Token">{selectedScript.totalCompletionTokens}</Descriptions.Item>
              <Descriptions.Item label="累计 Token">{selectedScript.totalTokens}</Descriptions.Item>
              <Descriptions.Item label="生成次数">{selectedScript.generationCount}</Descriptions.Item>
              <Descriptions.Item label="成功次数">{selectedScript.successCount}</Descriptions.Item>
              <Descriptions.Item label="失败次数">{selectedScript.failureCount}</Descriptions.Item>
              <Descriptions.Item label="连续失败">{`${selectedScript.consecutiveFailureCount}/${selectedScript.failureThreshold}`}</Descriptions.Item>
              <Descriptions.Item label="最后失败">
                {selectedScript.lastFailureReason ? generationReasonText(selectedScript.lastFailureReason) : "-"}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Text strong>指纹版本/适配记录</Typography.Text>
            <Table<MatrixAccountLoginScript>
              rowKey="id"
              size="small"
              dataSource={selectedScriptGroup?.scripts ?? [selectedScript]}
              pagination={false}
              scroll={{ x: 1100 }}
              onRow={(record) => ({
                onClick: () => setSelectedScriptId(record.id)
              })}
              columns={[
                {
                  title: "页面指纹",
                  dataIndex: "pageFingerprint",
                  width: 180,
                  ellipsis: true,
                  render: (value: string) =>
                    value ? (
                      <Tooltip title={value}>
                        <Typography.Text>{shortFingerprint(value)}</Typography.Text>
                      </Tooltip>
                    ) : (
                      "通用指纹"
                    )
                },
                {
                  title: "状态",
                  dataIndex: "status",
                  width: 96,
                  render: (value: string) => <Tag color={scriptStatusColor(value)}>{scriptStatusLabel(value)}</Tag>
                },
                {
                  title: "生效版本",
                  dataIndex: "activeVersionId",
                  width: 120,
                  ellipsis: true,
                  render: (value: string) => (value ? shortFingerprint(value) : "-")
                },
                {
                  title: "模型",
                  dataIndex: "modelId",
                  width: 140,
                  ellipsis: true,
                  render: (value: string) => value || "-"
                },
                {
                  title: "运行统计",
                  key: "runStats",
                  width: 120,
                  render: (_, record) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text style={{ fontSize: 12 }}>成功 {record.successCount}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        失败 {record.failureCount} / 连续 {record.consecutiveFailureCount}
                      </Typography.Text>
                    </Space>
                  )
                },
                {
                  title: "最近结果",
                  key: "latest",
                  width: 170,
                  render: (_, record) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text style={{ fontSize: 12 }}>
                        成功：{record.lastSuccessAt ? formatTime(record.lastSuccessAt) : "-"}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        失败：{record.lastFailedAt ? formatTime(record.lastFailedAt) : "-"}
                      </Typography.Text>
                    </Space>
                  )
                },
                {
                  title: "操作",
                  key: "actions",
                  fixed: "right",
                  width: 130,
                  render: (_, record) => (
                    <Space size={4}>
                      <Button
                        size="small"
                        type="link"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedScriptId(record.id);
                        }}
                      >
                        版本
                      </Button>
                      {canScriptsManage ? (
                        <Button
                          size="small"
                          type="link"
                          loading={scriptStatusMutation.isPending}
                          onClick={(event) => {
                            event.stopPropagation();
                            scriptStatusMutation.mutate({
                              id: record.id,
                              status: record.status === "enabled" ? "disabled" : "enabled"
                            });
                          }}
                        >
                          {record.status === "enabled" ? "停用" : "启用"}
                        </Button>
                      ) : null}
                    </Space>
                  )
                }
              ]}
            />
            <Typography.Text strong>
              当前指纹版本记录：{selectedScript.pageFingerprint ? shortFingerprint(selectedScript.pageFingerprint) : "通用指纹"}
            </Typography.Text>
            <Table<MatrixAccountLoginScriptVersion>
              rowKey="id"
              size="small"
              loading={scriptVersionsFetching}
              dataSource={selectedScriptVersions}
              pagination={false}
              scroll={{ x: 900 }}
              expandable={{
                expandedRowRender: (record) => renderHighlightedJson(record.dsl, 460)
              }}
              columns={[
                {
                  title: "版本",
                  dataIndex: "version",
                  width: 80,
                  render: (value: number) => `v${value}`
                },
                {
                  title: "状态",
                  dataIndex: "status",
                  width: 100,
                  render: (value: string) => <Tag>{scriptVersionStatusLabel(value)}</Tag>
                },
                {
                  title: "来源",
                  dataIndex: "source",
                  width: 110,
                  render: (value: string) => scriptVersionSourceLabel(value)
                },
                {
                  title: "模型",
                  dataIndex: "modelId",
                  width: 150,
                  ellipsis: true,
                  render: (value: string) => value || "-"
                },
                {
                  title: "Token",
                  dataIndex: "totalTokens",
                  width: 90
                },
                {
                  title: "原因",
                  dataIndex: "generationReason",
                  width: 180,
                  ellipsis: true,
                  render: (value: string) => (value ? generationReasonText(value) : "-")
                },
                {
                  title: "创建时间",
                  dataIndex: "createdAt",
                  width: 160,
                  render: formatTime
                },
                {
                  title: "操作",
                  key: "actions",
                  fixed: "right",
                  width: 110,
                  render: (_, record) =>
                    canScriptsManage && record.status !== "active" ? (
                      <Button
                        size="small"
                        type="link"
                        loading={activateScriptVersionMutation.isPending}
                        onClick={() =>
                          activateScriptVersionMutation.mutate({ scriptId: selectedScript.id, versionId: record.id })
                        }
                      >
                        启用
                      </Button>
                    ) : (
                      "-"
                    )
                }
              ]}
            />
          </Space>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择脚本" />
        )}
      </Drawer>

      <Drawer
        destroyOnClose
        title="敏感调试快照"
        width={drawerWidths.simpleDetail}
        open={sensitiveSnapshotDrawerOpen}
        onClose={() => setSensitiveSnapshotDrawerOpen(false)}
      >
        {sensitiveSnapshotMutation.isPending ? (
          <div style={{ alignItems: "center", display: "flex", flexDirection: "column", gap: 12, padding: "48px 0" }}>
            <Spin />
            <Typography.Text type="secondary">正在读取当前登录空间调试快照...</Typography.Text>
          </div>
        ) : sensitiveSnapshot ? (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Alert
              showIcon
              type="warning"
              message="敏感调试数据"
              description="该快照仅用于本次问题定位，包含登录空间原始截图、Cookie/Storage/Token 等调试上下文。"
            />
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="URL">{sensitiveSnapshot.url || "-"}</Descriptions.Item>
              <Descriptions.Item label="标题">{sensitiveSnapshot.title || "-"}</Descriptions.Item>
              <Descriptions.Item label="指纹">{sensitiveSnapshot.pageFingerprint || "-"}</Descriptions.Item>
            </Descriptions>
            {sensitiveSnapshot.screenshotDataUrl ? (
              <div style={{ border: "1px solid rgba(127, 127, 127, 0.18)", borderRadius: 8, padding: 8 }}>
                <img
                  src={sensitiveSnapshot.screenshotDataUrl}
                  alt="登录空间原始截图"
                  style={{ display: "block", maxWidth: "100%", borderRadius: 6 }}
                />
              </div>
            ) : null}
            <Space style={{ justifyContent: "space-between", width: "100%" }} align="center">
              <Typography.Text strong>敏感上下文</Typography.Text>
              <Button
                size="small"
                onClick={() => setDebugWindow({ title: "敏感上下文", value: sensitiveSnapshot.sensitiveContext ?? {} })}
              >
                窗口查看
              </Button>
            </Space>
            {renderJsonPreview(sensitiveSnapshot.sensitiveContext ?? {}, 180)}
            <Space style={{ justifyContent: "space-between", width: "100%" }} align="center">
              <Typography.Text strong>DOM 摘要</Typography.Text>
              <Button
                size="small"
                onClick={() => setDebugWindow({ title: "DOM 摘要", value: sensitiveSnapshot.domSummary ?? {} })}
              >
                窗口查看
              </Button>
            </Space>
            {renderJsonPreview(sensitiveSnapshot.domSummary, 180)}
          </Space>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无敏感调试快照" />
        )}
      </Drawer>

      <DebugJsonWindow
        open={Boolean(debugWindow)}
        title={debugWindow?.title ?? ""}
        value={debugWindow?.value ?? {}}
        onClose={() => setDebugWindow(null)}
      />
    </>
  );
}

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatShortTime(value: string | null | undefined) {
  if (!value) return "--:--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function DebugJsonWindow({
  onClose,
  open,
  title,
  value
}: {
  onClose: () => void;
  open: boolean;
  title: string;
  value: unknown;
}) {
  const [position, setPosition] = useState({ x: 96, y: 84 });
  const [keyword, setKeyword] = useState("");
  const dragRef = useRef<{ originX: number; originY: number; startX: number; startY: number } | null>(null);

  const jsonText = useMemo(() => {
    try {
      return JSON.stringify(value ?? {}, null, 2);
    } catch {
      return String(value ?? "");
    }
  }, [value]);
  const matchCount = useMemo(() => countTextMatches(jsonText, keyword), [jsonText, keyword]);

  useEffect(() => {
    if (!open) return;
    setKeyword("");
    setPosition({
      x: typeof window === "undefined" ? 96 : Math.max(24, Math.round((window.innerWidth - 780) / 2)),
      y: 84
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleMouseMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const nextX = drag.originX + event.clientX - drag.startX;
      const nextY = drag.originY + event.clientY - drag.startY;
      setPosition({
        x: clampNumber(nextX, 8, Math.max(8, window.innerWidth - 180)),
        y: clampNumber(nextY, 8, Math.max(8, window.innerHeight - 80))
      });
    };
    const handleMouseUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      style={{
        background: "rgba(0, 0, 0, 0.18)",
        inset: 0,
        pointerEvents: "none",
        position: "fixed",
        zIndex: 3000
      }}
    >
      <div
        style={{
          background: "var(--ant-color-bg-elevated, #fff)",
          border: "1px solid rgba(127, 127, 127, 0.22)",
          borderRadius: 10,
          boxShadow: "0 18px 50px rgba(0, 0, 0, 0.28)",
          display: "flex",
          flexDirection: "column",
          height: 560,
          left: position.x,
          minHeight: 320,
          minWidth: 520,
          overflow: "hidden",
          pointerEvents: "auto",
          position: "fixed",
          resize: "both",
          top: position.y,
          width: 780
        }}
      >
        <div
          onMouseDown={(event) => {
            dragRef.current = {
              originX: position.x,
              originY: position.y,
              startX: event.clientX,
              startY: event.clientY
            };
            event.preventDefault();
          }}
          style={{
            alignItems: "center",
            cursor: "move",
            display: "flex",
            gap: 12,
            justifyContent: "space-between",
            padding: "10px 12px",
            borderBottom: "1px solid rgba(127, 127, 127, 0.16)",
            userSelect: "none"
          }}
        >
          <Typography.Text strong>{title}</Typography.Text>
          <Space
            onMouseDown={(event) => event.stopPropagation()}
            style={{ cursor: "default" }}
          >
            <Input.Search
              allowClear
              size="small"
              placeholder="搜索内容"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              style={{ width: 240 }}
            />
            <Typography.Text type="secondary" style={{ minWidth: 70, textAlign: "right" }}>
              {keyword.trim() ? `${matchCount} 处` : ""}
            </Typography.Text>
            <Button size="small" onClick={onClose}>
              关闭
            </Button>
          </Space>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
          {renderHighlightedText(jsonText, keyword)}
        </div>
      </div>
    </div>
  );
}

export function MatrixAccountExecutorTerminalPage() {
  const client = useRequestClient();
  const workspace = useCurrentWorkspace();
  const currentUser = useCurrentUser();
  const { taskId = "" } = useParams<{ taskId: string }>();
  const workspaceReady = Boolean(workspace?.id && workspace?.type);
  const clientDebugMode = useClientDebugMode();
  const canUseDebugTools = clientDebugMode || isSuperAdminUser(currentUser, workspace);
  const [redactTerminalContent, setRedactTerminalContent] = useState(() => !readTerminalSearchFlag("redactTerminal", "0"));
  const [taskInfoDrawerOpen, setTaskInfoDrawerOpen] = useState(false);
  const terminalContentRedacted = !canUseDebugTools || redactTerminalContent;
  const { data: task, error, isFetching } = useQuery({
    queryKey: ["ai-executor-run", workspace?.type, workspace?.id, taskId],
    queryFn: () => getAiExecutorRun(client, taskId),
    enabled: Boolean(taskId && workspaceReady),
    retry: false
  });
  const { data: executorConfig } = useQuery({
    queryKey: ["ai-executor-config", workspace?.type, workspace?.id, task?.executorId],
    queryFn: () => getAiExecutorConfig(client, task?.executorId ?? ""),
    enabled: Boolean(task?.executorId && workspaceReady),
    retry: false
  });
  const terminalTitle = useMemo(() => buildExecutorTerminalTitleCopy(task ?? null, executorConfig ?? null), [
    task?.executorId,
    task?.executorType,
    executorConfig?.name,
    executorConfig?.executorType
  ]);
  const terminalPurpose = useMemo(() => buildExecutorTerminalPurposeCopy(task ?? null), [
    task?.purpose,
    task?.triggerReason,
    task?.status
  ]);
  const fallbackLines = useMemo(
    () => (taskId ? [`$ 正在连接执行器终端：${taskId}`] : ["$ 缺少执行器任务 ID"]),
    [taskId]
  );

  return (
    <div className="matrix-account-executor-terminal-page">
      <header
        className={
          terminalTitle.subtitle
            ? "global-account-header matrix-account-executor-terminal-page__header matrix-account-executor-terminal-page__header--with-subtitle"
            : "global-account-header matrix-account-executor-terminal-page__header"
        }
      >
        <div className="matrix-account-executor-terminal-page__header-left">
          <div className="matrix-account-executor-terminal-page__title-stack">
            <Typography.Text strong className="matrix-account-executor-terminal-page__title">
              {terminalTitle.title}
            </Typography.Text>
            {terminalTitle.subtitle ? (
              <span className="matrix-account-executor-terminal-page__subtitle">{terminalTitle.subtitle}</span>
            ) : null}
          </div>
        </div>
        <div className="matrix-account-executor-terminal-page__header-right">
          <div className="matrix-account-executor-terminal-page__purpose">
            <span className="matrix-account-executor-terminal-page__purpose-title">{terminalPurpose.title}</span>
            <span className="matrix-account-executor-terminal-page__purpose-description">{terminalPurpose.description}</span>
          </div>
          <Tooltip title="查看环境与任务信息">
            <Button
              aria-label="查看环境与任务信息"
              className="desktop-quick-action matrix-account-terminal-info-action"
              icon={<InfoCircleOutlined style={{ fontSize: 22 }} />}
              type="text"
              onClick={() => setTaskInfoDrawerOpen(true)}
            />
          </Tooltip>
        </div>
      </header>
      <main className="matrix-account-executor-terminal-page__body">
        {!taskId ? <Alert type="warning" showIcon message="缺少执行器任务 ID" /> : null}
        {error ? (
          <Alert
            type="warning"
            showIcon
            message="执行器任务读取失败"
            description={error instanceof Error ? error.message : "请确认任务是否存在。"}
          />
        ) : null}
        {taskId && !workspaceReady ? (
          <Spin />
        ) : isFetching && !task ? (
          <Spin />
        ) : (
          <MatrixAccountExecutorTerminal
            allowExpand={false}
            client={client}
            expanded
            fallbackLines={fallbackLines}
            height="100%"
            redactContent={terminalContentRedacted}
            taskIdOverride={taskId}
            task={task ?? null}
          />
        )}
      </main>
      <ExecutorTaskInfoDrawer
        canUseDebugTools={canUseDebugTools}
        executor={executorConfig ?? null}
        onClose={() => setTaskInfoDrawerOpen(false)}
        onRedactTerminalContentChange={setRedactTerminalContent}
        open={taskInfoDrawerOpen}
        redactTerminalContent={redactTerminalContent}
        task={task ?? null}
        terminalPurpose={terminalPurpose}
        terminalTitle={terminalTitle}
      />
    </div>
  );
}

const executorTaskInfoLabelStyle: CSSProperties = {
  minWidth: "26%",
  verticalAlign: "top",
  whiteSpace: "nowrap",
  width: "26%"
};

const executorTaskInfoContentStyle: CSSProperties = {
  minWidth: 0,
  verticalAlign: "top",
  width: "74%",
  wordBreak: "break-word"
};

function ExecutorTaskInfoDrawer({
  canUseDebugTools,
  executor,
  onClose,
  onRedactTerminalContentChange,
  open,
  redactTerminalContent,
  task,
  terminalPurpose,
  terminalTitle
}: {
  canUseDebugTools: boolean;
  executor: AiExecutorConfigSummary | null;
  onClose: () => void;
  onRedactTerminalContentChange: (value: boolean) => void;
  open: boolean;
  redactTerminalContent: boolean;
  task: AiExecutorRun | null;
  terminalPurpose: { title: string; description: string };
  terminalTitle: { title: string; subtitle: string };
}) {
  const [activeTab, setActiveTab] = useState("task");
  const [contextKeyword, setContextKeyword] = useState("");
  const visibleTab = canUseDebugTools ? activeTab : "task";
  const contextSummary = canUseDebugTools ? task?.resultSummary ?? {} : {};
  const contextJson = useMemo(() => stringifyJson(contextSummary), [contextSummary]);
  const contextMatchCount = useMemo(() => countTextMatches(contextJson, contextKeyword), [contextJson, contextKeyword]);
  const taskRequirements = useMemo(() => buildExecutorTaskRequirements(task), [task]);
  const taskConstraints = useMemo(() => buildExecutorTaskConstraints(task), [task]);
  const descriptionProps = {
    bordered: true,
    column: 1,
    contentStyle: executorTaskInfoContentStyle,
    labelStyle: executorTaskInfoLabelStyle,
    size: "small" as const
  };

  useEffect(() => {
    if (!canUseDebugTools && activeTab !== "task") {
      setActiveTab("task");
    }
  }, [activeTab, canUseDebugTools]);

  return (
    <Drawer
      title={canUseDebugTools ? "环境与任务信息" : "任务信息"}
      placement="right"
      width={drawerWidths.complexDetail}
      open={open}
      onClose={onClose}
      destroyOnHidden
      styles={{ body: { display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" } }}
    >
      <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: 14, minHeight: 0, width: "100%" }}>
        {canUseDebugTools ? (
          <Segmented
            block
            value={activeTab}
            onChange={(value) => setActiveTab(String(value))}
            options={[
              { label: "任务信息", value: "task" },
              { label: "运行环境", value: "environment" },
              { label: "任务上下文", value: "context" }
            ]}
          />
        ) : null}
        <div style={{ flex: 1, minHeight: 0, overflow: visibleTab === "context" ? "hidden" : "auto" }}>
          {visibleTab === "task" ? (
            <Space direction="vertical" size={14} style={{ width: "100%" }}>
              <Descriptions {...descriptionProps} title="基础信息">
                <Descriptions.Item label="终端标题">{terminalTitle.title}</Descriptions.Item>
                {terminalTitle.subtitle ? <Descriptions.Item label="执行器类型">{terminalTitle.subtitle}</Descriptions.Item> : null}
                <Descriptions.Item label="任务目的">{terminalPurpose.title}</Descriptions.Item>
                <Descriptions.Item label="触发原因">{terminalPurpose.description}</Descriptions.Item>
              </Descriptions>
              <Descriptions {...descriptionProps} title="执行要求">
                <Descriptions.Item label="处理要求">{renderExecutorTaskTextList(taskRequirements)}</Descriptions.Item>
                <Descriptions.Item label="执行约束">{renderExecutorTaskTextList(taskConstraints)}</Descriptions.Item>
              </Descriptions>
              <Descriptions {...descriptionProps} title="执行对象">
                <Descriptions.Item label="任务 ID">{task?.id || "-"}</Descriptions.Item>
                <Descriptions.Item label="任务类型">{task?.taskType || "-"}</Descriptions.Item>
                <Descriptions.Item label="Web 空间 ID">{task?.webSpaceId || "-"}</Descriptions.Item>
              </Descriptions>
              <Descriptions {...descriptionProps} title="脚本信息">
                <Descriptions.Item label="脚本用途">{task?.purpose ? scriptPurposeLabel(task.purpose) : "-"}</Descriptions.Item>
                <Descriptions.Item label="触发编码">{task?.triggerReason || "-"}</Descriptions.Item>
                <Descriptions.Item label="脚本 ID">{task?.scriptId || "-"}</Descriptions.Item>
                <Descriptions.Item label="脚本版本 ID">{task?.scriptVersionId || "-"}</Descriptions.Item>
              </Descriptions>
              <Descriptions {...descriptionProps} title="执行状态">
                <Descriptions.Item label="状态">{task?.status ? executorTaskStatusLabel(task.status) : "-"}</Descriptions.Item>
                <Descriptions.Item label="错误信息">{task?.errorMessage || "-"}</Descriptions.Item>
              </Descriptions>
            </Space>
          ) : null}
          {canUseDebugTools && visibleTab === "environment" ? (
            <Descriptions {...descriptionProps}>
              <Descriptions.Item label="执行器 ID">{task?.executorId || executor?.id || "-"}</Descriptions.Item>
              <Descriptions.Item label="执行器名称">{executor?.name || "-"}</Descriptions.Item>
              <Descriptions.Item label="执行器类型">{executorTypeLabel(executor?.executorType || task?.executorType || "") || "-"}</Descriptions.Item>
              <Descriptions.Item label="运行时类型">{executor?.runtimeType || "-"}</Descriptions.Item>
              <Descriptions.Item label="终端模式">Codex TUI + app-server</Descriptions.Item>
              <Descriptions.Item label="终端内容脱敏">
                {canUseDebugTools ? (
                  <Switch size="small" checked={redactTerminalContent} onChange={onRedactTerminalContentChange} />
                ) : (
                  "已开启"
                )}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
          {canUseDebugTools && visibleTab === "context" ? (
            Object.keys(contextSummary).length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
                <Space style={{ flex: "0 0 auto", justifyContent: "space-between", width: "100%" }} align="center">
                  <Input.Search
                    allowClear
                    placeholder="搜索任务上下文"
                    value={contextKeyword}
                    onChange={(event) => setContextKeyword(event.target.value)}
                    style={{ maxWidth: 360 }}
                  />
                  <Typography.Text type="secondary" style={{ minWidth: 72, textAlign: "right" }}>
                    {contextKeyword.trim() ? `${contextMatchCount} 处` : ""}
                  </Typography.Text>
                </Space>
                <div
                  style={{
                    background: "rgba(7, 12, 22, 0.94)",
                    border: "1px solid rgba(127, 127, 127, 0.18)",
                    borderRadius: 8,
                    flex: "1 1 auto",
                    minHeight: 0,
                    overflow: "auto"
                  }}
                >
                  {renderHighlightedText(contextJson, contextKeyword)}
                </div>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务上下文" />
            )
          ) : null}
        </div>
      </div>
    </Drawer>
  );
}

function DebugSettingsButton({
  onRedactTerminalContentChange,
  onShowEnvironmentInfoChange,
  onShowTaskContextChange,
  redactTerminalContent,
  showEnvironmentInfo,
  showTaskContext,
  variant = "default",
  visible
}: {
  onRedactTerminalContentChange: (value: boolean) => void;
  onShowEnvironmentInfoChange: (value: boolean) => void;
  onShowTaskContextChange: (value: boolean) => void;
  redactTerminalContent: boolean;
  showEnvironmentInfo: boolean;
  showTaskContext: boolean;
  variant?: "default" | "titlebar";
  visible: boolean;
}) {
  if (!visible) return null;
  const active = showTaskContext || showEnvironmentInfo || !redactTerminalContent;
  return (
    <Popover
      placement="bottomRight"
      title="Debug"
      trigger="click"
      content={
        <Space direction="vertical" size={10}>
          <Space style={{ justifyContent: "space-between", minWidth: 190 }} align="center">
            <Typography.Text>显示任务上下文</Typography.Text>
            <Switch size="small" checked={showTaskContext} onChange={onShowTaskContextChange} />
          </Space>
          <Space style={{ justifyContent: "space-between", minWidth: 190 }} align="center">
            <Typography.Text>显示环境信息</Typography.Text>
            <Switch size="small" checked={showEnvironmentInfo} onChange={onShowEnvironmentInfoChange} />
          </Space>
          <Space style={{ justifyContent: "space-between", minWidth: 190 }} align="center">
            <Typography.Text>终端内容脱敏</Typography.Text>
            <Switch size="small" checked={redactTerminalContent} onChange={onRedactTerminalContentChange} />
          </Space>
        </Space>
      }
    >
      <Button
        aria-label="Debug 设置"
        className={variant === "titlebar" ? `desktop-quick-action matrix-account-terminal-debug-action${active ? " is-active" : ""}` : undefined}
        icon={<BugOutlined style={variant === "titlebar" ? { fontSize: 22 } : undefined} />}
        type={variant === "titlebar" ? "text" : active ? "primary" : "default"}
      />
    </Popover>
  );
}

function useClientDebugMode() {
  const [desktopDebugMode, setDesktopDebugMode] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    let active = true;
    const appBridge = (window as unknown as {
      aicrm?: { app?: { getConfig?: () => Promise<{ debugMode?: boolean }> } };
    }).aicrm?.app;
    void appBridge?.getConfig?.()
      .then((config) => {
        if (active) setDesktopDebugMode(Boolean(config?.debugMode));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return readLocalDebugFlag() || desktopDebugMode;
}

function readLocalDebugFlag() {
  if (typeof window === "undefined") return false;
  return (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    new URLSearchParams(window.location.search).get("debug") === "1" ||
    window.localStorage.getItem("aicrm.debug") === "1"
  );
}

function readTerminalSearchFlag(key: string, expected = "1") {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get(key) === expected;
}

function isSuperAdminUser(
  currentUser: { username?: string | null } | null,
  workspace: { roles?: Array<{ code?: string | null }> } | null
) {
  return (
    currentUser?.username?.toLowerCase() === "super.admin" ||
    workspace?.roles?.some((role) => role.code === "platform_owner") === true
  );
}

function MatrixAccountScriptStructuredContext({
  currentScript,
  latestRunLog,
  loading,
  repairTask,
  scriptGroups
}: {
  currentScript: WebSpaceScriptSummary | null;
  latestRunLog: MatrixAccountLoginScriptRunLog | null;
  loading: boolean;
  repairTask: AiExecutorTask | null;
  scriptGroups: LoginScriptPurposeGroup[];
}) {
  const hasContext = Boolean(currentScript || latestRunLog || repairTask || scriptGroups.length > 0);

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <Space style={{ justifyContent: "space-between", width: "100%" }} align="center">
        <Typography.Text strong>脚本运行态</Typography.Text>
        {loading ? <Tag>同步中</Tag> : null}
      </Space>
      {hasContext ? (
        <Descriptions size="small" bordered column={1}>
          <Descriptions.Item label="当前脚本">
            {currentScript ? (
              <Space wrap size={6}>
                <Tag color="blue">{scriptPurposeLabel(currentScript.purpose)}</Tag>
                <Tag>v{currentScript.version}</Tag>
                <Tag>{scriptVersionStatusLabel(currentScript.status)}</Tag>
                <Tag>{scriptVersionSourceLabel(currentScript.source)}</Tag>
                {currentScript.reasonText ? <Tag>{currentScript.reasonText}</Tag> : null}
              </Space>
            ) : (
              <Typography.Text type="secondary">暂无当前命中脚本</Typography.Text>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="最近运行">
            {latestRunLog ? (
              <Space wrap size={6}>
                <Tag color={scriptRunStatusColor(latestRunLog.status)}>{scriptRunStatusLabel(latestRunLog.status)}</Tag>
                <Tag>{scriptPurposeLabel(latestRunLog.purpose)}</Tag>
                {latestRunLog.version > 0 ? <Tag>v{latestRunLog.version}</Tag> : null}
                {latestRunLog.versionStatus ? <Tag>{scriptVersionStatusLabel(latestRunLog.versionStatus)}</Tag> : null}
                {latestRunLog.versionSource ? <Tag>{scriptVersionSourceLabel(latestRunLog.versionSource)}</Tag> : null}
                {latestRunLog.reasonCode ? <Tag>{generationReasonText(latestRunLog.reasonCode)}</Tag> : null}
                {latestRunLog.durationMs ? <Typography.Text type="secondary">{latestRunLog.durationMs}ms</Typography.Text> : null}
              </Space>
            ) : (
              <Typography.Text type="secondary">暂无脚本运行记录</Typography.Text>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="执行器修复">
            {repairTask ? (
              <Space wrap size={6}>
                <Tag color={executorTaskStatusColor(repairTask.status)}>{executorTaskStatusLabel(repairTask.status)}</Tag>
                <Tag>{scriptPurposeLabel(repairTask.purpose || "qr_login_prepare")}</Tag>
                {repairTask.triggerReason ? <Tag>{generationReasonText(repairTask.triggerReason)}</Tag> : null}
                {repairTask.scriptVersionId ? <Tag>版本 {shortFingerprint(repairTask.scriptVersionId)}</Tag> : null}
              </Space>
            ) : (
              <Typography.Text type="secondary">暂无 Codex 修复任务</Typography.Text>
            )}
          </Descriptions.Item>
          {scriptGroups.length > 0 ? (
            <Descriptions.Item label="已配置脚本">
              <Space wrap size={6}>
                {scriptGroups.map((group) => (
                  <Tag key={group.key} color={group.activeCount > 0 ? "green" : group.primary.status === "learning" ? "blue" : "default"}>
                    {scriptPurposeLabel(group.purpose)}：{group.activeCount} 生效 / {group.scripts.length} 指纹
                  </Tag>
                ))}
              </Space>
            </Descriptions.Item>
          ) : null}
        </Descriptions>
      ) : (
        <Typography.Text type="secondary">暂无脚本上下文，脚本解析或执行后会在这里展示。</Typography.Text>
      )}
    </Space>
  );
}

function MatrixAccountScriptRunLogItem({ item }: { item: MatrixAccountLoginScriptRunLog }) {
  return (
    <div
      style={{
        border: "1px solid rgba(127, 127, 127, 0.18)",
        borderRadius: 8,
        padding: "8px 10px"
      }}
    >
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        <Space wrap size={6} align="center">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatShortTime(item.createdAt)}
          </Typography.Text>
          <Tag color={scriptRunStatusColor(item.status)}>{scriptRunStatusLabel(item.status)}</Tag>
          <Tag>{scriptPurposeLabel(item.purpose)}</Tag>
          {item.version > 0 ? <Tag>v{item.version}</Tag> : null}
          {item.versionStatus ? <Tag>{scriptVersionStatusLabel(item.versionStatus)}</Tag> : null}
          {item.versionSource ? <Tag>{scriptVersionSourceLabel(item.versionSource)}</Tag> : null}
          {item.reasonCode ? <Tag>{generationReasonText(item.reasonCode)}</Tag> : null}
          {item.durationMs ? <Typography.Text type="secondary">{item.durationMs}ms</Typography.Text> : null}
        </Space>
        {item.errorCode ? (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            错误码：{item.errorCode}
          </Typography.Text>
        ) : null}
        <details>
          <summary style={{ cursor: "pointer", color: "var(--ant-color-text-secondary)" }}>查看脚本结果摘要</summary>
          <div style={{ marginTop: 8 }}>{renderHighlightedJson(buildSafeScriptRunPayload(item), 260)}</div>
        </details>
      </Space>
    </div>
  );
}

const matrixAccountMotionCss = `
@keyframes matrixAccountLivePulse {
  0% {
    box-shadow: 0 0 0 0 var(--matrix-account-live-shadow);
    opacity: 0.9;
    transform: scale(0.92);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(82, 196, 26, 0);
    opacity: 1;
    transform: scale(1);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(82, 196, 26, 0);
    opacity: 0.9;
    transform: scale(0.92);
  }
}
@keyframes matrixAccountPanelBreath {
  0%, 100% {
    border-color: rgba(82, 196, 26, 0.24);
    box-shadow: inset 0 0 0 1px rgba(82, 196, 26, 0.06);
  }
  50% {
    border-color: rgba(82, 196, 26, 0.48);
    box-shadow: inset 0 0 0 1px rgba(82, 196, 26, 0.14), 0 0 18px rgba(82, 196, 26, 0.08);
  }
}
@keyframes matrixAccountScanLine {
  0% {
    opacity: 0;
    transform: translateX(-80%);
  }
  18%, 64% {
    opacity: 0.48;
  }
  100% {
    opacity: 0;
    transform: translateX(180%);
  }
}
.matrix-account-executor-terminal-page {
  --admin-header-height: 60px;
  background: var(--ant-color-bg-layout, #f7efe4);
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-width: 1180px;
  min-height: 100vh;
  overflow: hidden;
}
.matrix-account-executor-terminal-page__header {
  gap: 10px;
  flex: 0 0 var(--admin-header-height);
  align-items: center;
  background: var(--admin-nav-bg);
  border-bottom: 1px solid var(--admin-divider);
  display: grid !important;
  grid-template-columns: max-content minmax(0, 1fr);
  justify-content: initial;
  min-height: var(--admin-header-height);
  overflow: hidden;
  padding-left: 22px;
  padding-right: 16px;
  position: relative;
}
body.aicrm-desktop-window-chrome-enabled .matrix-account-executor-terminal-page__header {
  padding-right: calc(var(--aicrm-window-controls-width, 138px) + 5px) !important;
}
.matrix-account-executor-terminal-page__header::before {
  content: "";
  display: none;
}
.matrix-account-executor-terminal-page__header-left,
.matrix-account-executor-terminal-page__header-right {
  position: relative;
  z-index: 1;
}
.matrix-account-executor-terminal-page__header-left {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  min-width: max-content;
  padding-right: 22px;
}
.matrix-account-executor-terminal-page__header-right {
  align-items: center;
  align-self: stretch;
  display: flex;
  flex: 1 1 auto;
  gap: 10px;
  justify-content: flex-start;
  min-width: 0;
  padding-left: 16px;
}
.matrix-account-executor-terminal-page__header-right::before {
  background: var(--admin-right-shell-bg);
  border-top-left-radius: 40px;
  bottom: 0;
  content: "";
  left: 0;
  pointer-events: none;
  position: absolute;
  right: calc((var(--aicrm-window-controls-width, 138px) + 18px) * -1);
  top: 0;
  z-index: -1;
}
.matrix-account-executor-terminal-page__title-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: max-content;
}
.matrix-account-executor-terminal-page__title {
  font-size: 24px;
  line-height: 1;
  white-space: nowrap;
}
.matrix-account-executor-terminal-page__subtitle {
  color: var(--ant-color-text-secondary);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}
.matrix-account-executor-terminal-page__purpose {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  transform: translate(3px, 3px);
}
.matrix-account-executor-terminal-page__purpose-title {
  color: var(--ant-color-text);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.15;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.matrix-account-executor-terminal-page__purpose-description {
  color: var(--ant-color-text-secondary);
  font-size: 12px;
  line-height: 1.2;
  max-width: min(720px, calc(100vw - 520px));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.matrix-account-terminal-debug-action.ant-btn {
  flex: 0 0 42px;
}
.matrix-account-executor-terminal-page__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0;
}
:root[data-admin-theme="dark"] .matrix-account-executor-terminal-page {
  background: #050505;
}
.matrix-account-executor-terminal-page .matrix-account-terminal {
  border-radius: 0;
}
.matrix-account-live-indicator {
  align-items: center;
  color: var(--ant-color-text-secondary);
  display: inline-flex;
  font-size: 12px;
  gap: 5px;
  line-height: 1;
}
.matrix-account-live-indicator__dot {
  background: var(--matrix-account-live-color);
  border-radius: 50%;
  display: inline-block;
  height: 7px;
  width: 7px;
}
.matrix-account-live-indicator--active .matrix-account-live-indicator__dot {
  animation: matrixAccountLivePulse 1.45s ease-out infinite;
}
.matrix-account-terminal,
.matrix-account-stream-panel {
  position: relative;
}
.matrix-account-terminal-shell {
  --matrix-account-terminal-bg: #0d1117;
  --matrix-account-terminal-fg: #c9d1d9;
  --matrix-account-terminal-muted: rgba(201, 209, 217, 0.6);
  --matrix-account-terminal-accent: #58a6ff;
  --matrix-account-terminal-content-shadow: inset 0 -1px rgba(154, 106, 34, 0.12);
  --matrix-account-terminal-footer-bg: #f4ece2;
  --matrix-account-terminal-footer-divider: rgba(116, 83, 45, 0.18);
  --matrix-account-terminal-footer-fg: #34281a;
  --matrix-account-terminal-footer-muted: rgba(79, 59, 36, 0.68);
  --matrix-account-terminal-footer-accent: #9a6a22;
  --matrix-account-terminal-footer-button-bg: rgba(212, 154, 61, 0.12);
  --matrix-account-terminal-footer-button-hover-bg: rgba(212, 154, 61, 0.18);
  --matrix-account-terminal-footer-button-border: rgba(154, 106, 34, 0.22);
  min-height: 0;
}
:root[data-admin-theme="dark"] .matrix-account-terminal-shell {
  --matrix-account-terminal-bg: #0d1117;
  --matrix-account-terminal-fg: #c9d1d9;
  --matrix-account-terminal-muted: rgba(201, 209, 217, 0.6);
  --matrix-account-terminal-accent: #58a6ff;
  --matrix-account-terminal-content-shadow: inset 0 -1px rgba(215, 247, 223, 0.08);
  --matrix-account-terminal-footer-bg: #080d0a;
  --matrix-account-terminal-footer-divider: rgba(215, 247, 223, 0.1);
  --matrix-account-terminal-footer-fg: #d7f7df;
  --matrix-account-terminal-footer-muted: rgba(215, 247, 223, 0.52);
  --matrix-account-terminal-footer-accent: rgba(224, 175, 104, 0.95);
  --matrix-account-terminal-footer-button-bg: rgba(215, 247, 223, 0.08);
  --matrix-account-terminal-footer-button-hover-bg: rgba(215, 247, 223, 0.14);
  --matrix-account-terminal-footer-button-border: rgba(215, 247, 223, 0.14);
}
.matrix-account-terminal-shell--expanded {
  display: flex !important;
  flex: 1 1 auto;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.matrix-account-terminal-shell--expanded > .ant-space-item:last-child {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}
.matrix-account-terminal {
  background: var(--matrix-account-terminal-bg);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.matrix-account-terminal-shell--expanded .matrix-account-terminal {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}
.matrix-account-terminal__xterm {
  box-sizing: border-box;
  box-shadow: var(--matrix-account-terminal-content-shadow);
  flex: 1 1 auto;
  height: 420px;
  max-height: 420px;
  min-height: 280px;
  overflow: hidden;
  padding: 0;
  scrollbar-color: rgba(215, 247, 223, 0.32) transparent;
  scrollbar-width: thin;
}
.matrix-account-terminal-shell--expanded .matrix-account-terminal__xterm {
  flex: 1 1 auto;
  height: auto !important;
  max-height: none !important;
  min-height: var(--matrix-account-terminal-min-height, 0) !important;
}
.matrix-account-terminal__xterm .xterm {
  height: 100%;
  margin: 0 !important;
  padding: 0 !important;
  width: 100%;
  overflow: hidden;
}
.matrix-account-terminal__xterm .xterm-viewport,
.matrix-account-terminal__xterm .xterm-screen {
  background: transparent !important;
  margin: 0 !important;
  padding: 0 !important;
}
.matrix-account-terminal__xterm .xterm-viewport {
  scrollbar-color: rgba(215, 247, 223, 0.32) transparent;
  scrollbar-width: thin;
}
.matrix-account-terminal__xterm .xterm-rows {
  margin: 0 !important;
  padding: 0 !important;
}
.matrix-account-terminal--active {
  box-shadow: inset 0 0 0 1px rgba(82, 196, 26, 0.18);
}
.matrix-account-terminal-footer {
  align-items: center;
  background: var(--matrix-account-terminal-footer-bg);
  border-top: 1px solid var(--matrix-account-terminal-footer-divider);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.08);
  display: grid;
  flex: 0 0 auto;
  gap: 12px;
  grid-template-columns: minmax(0, 1fr) auto minmax(120px, 1fr);
  min-height: 42px;
  padding: 7px 10px 8px 12px;
}
.matrix-account-terminal-token-stats {
  align-items: center;
  color: var(--matrix-account-terminal-footer-fg);
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  gap: 8px;
  line-height: 1.35;
  min-width: 0;
}
.matrix-account-terminal-token-stats__label {
  color: var(--matrix-account-terminal-footer-accent);
  font-weight: 700;
  letter-spacing: 0;
}
.matrix-account-terminal-token-stats__meta {
  color: var(--matrix-account-terminal-footer-muted);
}
.matrix-account-terminal-footer__status {
  align-items: center;
  color: var(--matrix-account-terminal-footer-muted);
  display: inline-flex;
  font-size: 12px;
  justify-self: center;
  min-width: 0;
}
.matrix-account-terminal-footer__status .ant-tag {
  margin-inline-end: 0;
}
.matrix-account-terminal-footer__actions {
  justify-self: end;
  flex: 0 0 auto;
}
.matrix-account-terminal-footer__button.ant-btn-default {
  background: var(--matrix-account-terminal-footer-button-bg);
  border-color: var(--matrix-account-terminal-footer-button-border);
  color: var(--matrix-account-terminal-footer-fg);
}
.matrix-account-terminal-footer__button.ant-btn-default:hover {
  background: var(--matrix-account-terminal-footer-button-hover-bg) !important;
  border-color: var(--matrix-account-terminal-footer-button-border) !important;
  color: var(--matrix-account-terminal-footer-fg) !important;
}
.matrix-account-stream-panel--active {
  border-color: rgba(82, 196, 26, 0.18);
}
.matrix-account-stream-panel {
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 8px;
}
.matrix-account-terminal-statusbar {
  align-items: center;
  backdrop-filter: blur(8px);
  background: linear-gradient(180deg, rgba(12, 20, 16, 0.72), rgba(7, 12, 10, 0.92));
  border: 1px solid rgba(215, 247, 223, 0.12);
  border-radius: 8px;
  color: rgba(215, 247, 223, 0.88);
  display: flex;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  gap: 8px;
  justify-content: space-between;
  line-height: 1.4;
  min-height: 34px;
  overflow: visible;
  padding: 7px 12px;
  transition: border-color 180ms ease, box-shadow 180ms ease;
  white-space: nowrap;
}
.matrix-account-terminal-statusbar--active {
  border-color: rgba(82, 196, 26, 0.28);
  box-shadow: 0 0 16px rgba(82, 196, 26, 0.14);
}
.matrix-account-terminal-statusbar__main {
  align-items: center;
  display: inline-flex;
  flex: 1 1 auto;
  gap: 7px;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-color: rgba(215, 247, 223, 0.32) transparent;
  scrollbar-width: thin;
}
.matrix-account-terminal-statusbar__text {
  display: block;
  flex: 0 0 auto;
  min-width: 0;
  overflow: visible;
  text-overflow: clip;
  text-shadow: 0 0 10px rgba(215, 247, 223, 0.16);
  white-space: nowrap;
}
.matrix-account-terminal-statusbar__meta {
  color: rgba(215, 247, 223, 0.56);
  flex: 0 0 auto;
}
.matrix-account-terminal-modal--maximized {
  margin: 0;
  max-width: 100vw;
  padding-bottom: 0;
}
.matrix-account-terminal-modal--maximized .ant-modal-content {
  border-radius: 0;
  min-height: 100vh;
}
.matrix-account-terminal-modal--maximized .ant-modal-body {
  min-height: calc(100vh - 58px);
}
@media (prefers-reduced-motion: reduce) {
  .matrix-account-live-indicator--active .matrix-account-live-indicator__dot,
  .matrix-account-terminal--active,
  .matrix-account-stream-panel--active {
    animation: none;
  }
}
`;

function MatrixAccountMotionStyles() {
  return <style>{matrixAccountMotionCss}</style>;
}

type DocumentAdminColorScheme = "light" | "dark";

const GITHUB_DARK_TERMINAL_BACKGROUND = "#0d1117";
const EXECUTOR_TERMINAL_DEFAULT_WINDOW_WIDTH = 1180;
const EXECUTOR_TERMINAL_DEFAULT_WINDOW_HEIGHT = 760;
const EXECUTOR_TERMINAL_POPUP_FEATURES = [
  "popup=yes",
  `width=${EXECUTOR_TERMINAL_DEFAULT_WINDOW_WIDTH}`,
  `height=${EXECUTOR_TERMINAL_DEFAULT_WINDOW_HEIGHT}`,
  "resizable=yes",
  "scrollbars=no",
  "toolbar=no",
  "location=no",
  "menubar=no",
  "status=no"
].join(",");
const EXECUTOR_TERMINAL_FIXED_COLS = 150;
const EXECUTOR_TERMINAL_DEFAULT_ROWS = 32;
const EXECUTOR_TERMINAL_FONT_SIZE = 13;
const EXECUTOR_TERMINAL_LINE_HEIGHT = 1.42;
const EXECUTOR_TERMINAL_MIN_HEIGHT = Math.ceil(
  EXECUTOR_TERMINAL_DEFAULT_ROWS * EXECUTOR_TERMINAL_FONT_SIZE * EXECUTOR_TERMINAL_LINE_HEIGHT
);

function getDocumentAdminColorScheme(): DocumentAdminColorScheme {
  if (typeof document !== "undefined") {
    const value = document.documentElement.dataset.adminTheme;
    if (value === "dark" || value === "light") return value;
  }
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function useDocumentAdminColorScheme() {
  const [scheme, setScheme] = useState<DocumentAdminColorScheme>(() => getDocumentAdminColorScheme());

  useEffect(() => {
    const update = () => setScheme(getDocumentAdminColorScheme());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-admin-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);

  return scheme;
}

function buildExecutorTerminalTheme() {
  return {
    background: GITHUB_DARK_TERMINAL_BACKGROUND,
    black: "#0d1117",
    blue: "#79c0ff",
    brightBlack: "#6e7681",
    brightBlue: "#a5d6ff",
    brightCyan: "#b3f0ff",
    brightGreen: "#aff5b4",
    brightMagenta: "#d2a8ff",
    brightRed: "#ffa198",
    brightWhite: "#f0f6fc",
    brightYellow: "#f8e3a1",
    cyan: "#a5d6ff",
    foreground: "#c9d1d9",
    green: "#7ee787",
    magenta: "#d2a8ff",
    red: "#ff7b72",
    selectionBackground: "rgba(56, 139, 253, 0.28)",
    white: "#c9d1d9",
    yellow: "#d29922"
  };
}

function buildExecutorTerminalChromeTheme(scheme: DocumentAdminColorScheme) {
  if (scheme === "dark") {
    return {
      contentShadow: "inset 0 -1px rgba(215, 247, 223, 0.08)",
      footerAccent: "rgba(224, 175, 104, 0.95)",
      footerBackground: "#080d0a",
      footerButtonBackground: "rgba(215, 247, 223, 0.08)",
      footerButtonBorder: "rgba(215, 247, 223, 0.14)",
      footerButtonHoverBackground: "rgba(215, 247, 223, 0.14)",
      footerDivider: "rgba(215, 247, 223, 0.1)",
      footerForeground: "#d7f7df",
      footerMuted: "rgba(215, 247, 223, 0.52)"
    };
  }
  return {
    contentShadow: "inset 0 -1px rgba(116, 83, 45, 0.12)",
    footerAccent: "#9a6a22",
    footerBackground: "#f4ece2",
    footerButtonBackground: "rgba(212, 154, 61, 0.12)",
    footerButtonBorder: "rgba(154, 106, 34, 0.22)",
    footerButtonHoverBackground: "rgba(212, 154, 61, 0.18)",
    footerDivider: "rgba(116, 83, 45, 0.18)",
    footerForeground: "#34281a",
    footerMuted: "rgba(79, 59, 36, 0.68)"
  };
}

function MatrixAccountLiveIndicator({
  active,
  label,
  tone
}: {
  active: boolean;
  label: string;
  tone: "green" | "gold";
}) {
  const color = tone === "gold" ? "#faad14" : "#52c41a";
  return (
    <span
      className={active ? "matrix-account-live-indicator matrix-account-live-indicator--active" : "matrix-account-live-indicator"}
      style={{
        ["--matrix-account-live-color" as string]: color,
        ["--matrix-account-live-shadow" as string]: tone === "gold" ? "rgba(250, 173, 20, 0.28)" : "rgba(82, 196, 26, 0.28)"
      }}
    >
      <span className="matrix-account-live-indicator__dot" />
      <span>{active ? label : "静止"}</span>
    </span>
  );
}

function MatrixAccountExecutorTerminal({
  allowExpand = false,
  client,
  fallbackLines,
  height = 420,
  expanded = false,
  redactContent = true,
  taskIdOverride,
  task
}: {
  allowExpand?: boolean;
  client: RequestClient;
  fallbackLines: string[];
  height?: number | string;
  expanded?: boolean;
  redactContent?: boolean;
  taskIdOverride?: string;
  task?: AiExecutorTask | null;
}) {
  const [viewMode, setViewMode] = useState<"popup" | "maximized" | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<ExecutorRuntimeStatus | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastFrameSeqRef = useRef(0);
  const queuedFrameSeqRef = useRef(0);
  const lastReportedResizeRef = useRef("");
  const taskIdRef = useRef<string | undefined>(task?.id);
  const clientRef = useRef(client);
  const fallbackLinesRef = useRef(fallbackLines);
  const autoScrollRef = useRef(true);
  const pendingFramesRef = useRef<AiExecutorTerminalFrame[]>([]);
  const frameFlushTimerRef = useRef<number | null>(null);
  const frameCountRef = useRef(0);
  const lastTokenEventSeqRef = useRef(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [frameCount, setFrameCount] = useState(0);
  const [liveTask, setLiveTask] = useState<AiExecutorTask | null>(task ?? null);
  const [latestLogAt, setLatestLogAt] = useState("");
  const [streamStatus, setStreamStatus] = useState<"idle" | "connecting" | "connected" | "fallback">("idle");
  const [tokenStats, setTokenStats] = useState<ExecutorTokenStats>(() => createEmptyExecutorTokenStats());
  const terminalColorScheme = useDocumentAdminColorScheme();
  const currentWorkspace = useCurrentWorkspace();
  const workspaceSignature = currentWorkspace ? `${currentWorkspace.type}:${currentWorkspace.id}` : "";
  const terminalTheme = useMemo(() => buildExecutorTerminalTheme(), []);
  const terminalChromeTheme = useMemo(
    () => buildExecutorTerminalChromeTheme(terminalColorScheme),
    [terminalColorScheme]
  );
  const terminalShellStyle = useMemo(
    () =>
      ({
        "--matrix-account-terminal-bg": terminalTheme.background,
        "--matrix-account-terminal-content-shadow": terminalChromeTheme.contentShadow,
        "--matrix-account-terminal-footer-accent": terminalChromeTheme.footerAccent,
        "--matrix-account-terminal-footer-bg": terminalChromeTheme.footerBackground,
        "--matrix-account-terminal-footer-button-bg": terminalChromeTheme.footerButtonBackground,
        "--matrix-account-terminal-footer-button-border": terminalChromeTheme.footerButtonBorder,
        "--matrix-account-terminal-footer-button-hover-bg": terminalChromeTheme.footerButtonHoverBackground,
        "--matrix-account-terminal-footer-divider": terminalChromeTheme.footerDivider,
        "--matrix-account-terminal-footer-fg": terminalChromeTheme.footerForeground,
        "--matrix-account-terminal-footer-muted": terminalChromeTheme.footerMuted,
        "--matrix-account-terminal-min-height": `${EXECUTOR_TERMINAL_MIN_HEIGHT}px`,
        width: "100%"
      }) as CSSProperties,
    [terminalChromeTheme, terminalTheme.background]
  );
  const taskId = task?.id ?? taskIdOverride;

  const fitTerminal = () => {
    const currentTaskId = taskIdRef.current;
    const currentTerminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!currentTerminal || !fitAddon) return;
    try {
      const host = terminalHostRef.current;
      const xtermElement = host?.querySelector<HTMLElement>(".xterm");
      const rowElement = host?.querySelector<HTMLElement>(".xterm-rows > div");
      const hostRect = host?.getBoundingClientRect();
      const xtermRect = xtermElement?.getBoundingClientRect();
      const fallbackRowHeight =
        Number(currentTerminal.options.fontSize ?? EXECUTOR_TERMINAL_FONT_SIZE) *
        Number(currentTerminal.options.lineHeight ?? EXECUTOR_TERMINAL_LINE_HEIGHT);
      const measuredRowHeight = rowElement?.getBoundingClientRect().height || fallbackRowHeight;
      const availableHeight = Math.max(hostRect?.height ?? 0, xtermRect?.height ?? 0);
      const measuredRows =
        availableHeight > 0 && measuredRowHeight > 0 ? Math.ceil(availableHeight / measuredRowHeight) : 0;
      const proposed = fitAddon.proposeDimensions();
      const cols = EXECUTOR_TERMINAL_FIXED_COLS;
      const calculatedRows = measuredRows || proposed?.rows || currentTerminal.rows || EXECUTOR_TERMINAL_DEFAULT_ROWS;
      const rows = Math.max(EXECUTOR_TERMINAL_DEFAULT_ROWS, calculatedRows);
      if (cols > 0 && rows > 0) {
        if (currentTerminal.cols !== cols || currentTerminal.rows !== rows) {
          currentTerminal.resize(cols, rows);
        }
      } else {
        fitAddon.fit();
      }
      if (autoScrollRef.current) currentTerminal.scrollToBottom();
      if (!currentTaskId) return;
      const signature = `${currentTaskId}:${currentTerminal.cols}x${currentTerminal.rows}`;
      if (signature === lastReportedResizeRef.current) return;
      lastReportedResizeRef.current = signature;
      void resizeAiExecutorTerminal(clientRef.current, currentTaskId, currentTerminal.cols, currentTerminal.rows).catch(() => undefined);
    } catch {
      // xterm fit may fail while the window is still measuring.
    }
  };

  const scheduleTerminalFit = (delay = 0) => {
    window.setTimeout(() => window.requestAnimationFrame(fitTerminal), delay);
  };

  const settleTerminalLayout = (terminal: Terminal) => {
    if (terminalRef.current !== terminal) return;
    fitTerminal();
    if (!autoScrollRef.current) return;
    terminal.scrollToBottom();
    window.requestAnimationFrame(() => {
      fitTerminal();
      terminal.scrollToBottom();
    });
    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        fitTerminal();
        terminal.scrollToBottom();
      });
    }, 80);
  };

  const writeTerminal = (terminal: Terminal, payload: string) => {
    fitTerminal();
    terminal.write(payload, () => settleTerminalLayout(terminal));
  };

  useEffect(() => {
    autoScrollRef.current = autoScroll;
    if (autoScroll) {
      window.requestAnimationFrame(() => terminalRef.current?.scrollToBottom());
    }
  }, [autoScroll]);

  useEffect(() => {
    fallbackLinesRef.current = fallbackLines;
    if (taskId) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.reset();
    const lines = fallbackLines.length > 0 ? fallbackLines : ["$ 等待执行器终端输出..."];
    writeTerminal(terminal, `${lines.join("\r\n")}\r\n`);
  }, [fallbackLines, taskId]);

  useEffect(() => {
    taskIdRef.current = taskId;
  }, [taskId]);

  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalTheme;
    window.requestAnimationFrame(() => {
      terminal.refresh(0, terminal.rows - 1);
      fitTerminal();
    });
  }, [terminalTheme]);

  useEffect(() => {
    if (!taskId || !workspaceSignature) {
      lastTokenEventSeqRef.current = 0;
      setTokenStats(createEmptyExecutorTokenStats());
      return undefined;
    }

    let cancelled = false;
    lastTokenEventSeqRef.current = 0;
    setTokenStats(createEmptyExecutorTokenStats());

    const appendTokenEvent = (event: AiExecutorEvent) => {
      if (event.sequence <= lastTokenEventSeqRef.current) return;
      lastTokenEventSeqRef.current = event.sequence;
      const usage = extractExecutorTokenUsage(event);
      if (!usage) return;
      setTokenStats((current) => ({
        current: usage,
        cumulative: addExecutorTokenUsage(current.estimated ? createEmptyExecutorTokenUsage() : current.cumulative, usage),
        estimated: false,
        eventCount: current.estimated ? 1 : current.eventCount + 1,
        updatedAt: event.createdAt || new Date().toISOString()
      }));
    };

    void (async () => {
      const initial = await listAiExecutorRunEvents(client, taskId, 0).catch(() => []);
      if (cancelled) return;
      initial.forEach(appendTokenEvent);
      if (!client.stream) return;
      while (!cancelled) {
        const response = await client
          .stream(`/api/v1/ai-executor-runs/${taskId}/events-stream?after=${lastTokenEventSeqRef.current}`)
          .catch(() => null);
        if (!response?.body || cancelled) return;
        await readExecutorTerminalSse(response, (event) => {
          if (event.event === "stream.closed") return;
          appendTokenEvent(event.data as AiExecutorEvent);
        });
        if (!cancelled) await wait(250);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, taskId, workspaceSignature]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return undefined;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: EXECUTOR_TERMINAL_FONT_SIZE,
      lineHeight: EXECUTOR_TERMINAL_LINE_HEIGHT,
      scrollback: 3000,
      theme: buildExecutorTerminalTheme()
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    window.requestAnimationFrame(() => writeTerminal(terminal, "$ 等待执行器终端输出...\r\n"));
    const scrollDisposable = terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      const isAtBottom = buffer.viewportY >= buffer.baseY;
      if (!isAtBottom && autoScrollRef.current) {
        autoScrollRef.current = false;
        setAutoScroll(false);
      }
    });

    const resizeObserver = new ResizeObserver(() => window.requestAnimationFrame(fitTerminal));
    const observedElements = new Set(
      [
        host,
        host.parentElement,
        host.closest<HTMLElement>(".matrix-account-terminal"),
        host.closest<HTMLElement>(".matrix-account-terminal-shell"),
        host.closest<HTMLElement>(".matrix-account-executor-terminal-page__body")
      ].filter(Boolean) as HTMLElement[]
    );
    observedElements.forEach((element) => resizeObserver.observe(element));
    window.addEventListener("resize", fitTerminal);
    window.visualViewport?.addEventListener("resize", fitTerminal);
    const timers = [0, 80, 220, 520, 1000, 1800, 3000].map((delay) =>
      window.setTimeout(() => window.requestAnimationFrame(fitTerminal), delay)
    );
    void document.fonts?.ready.then(() => window.requestAnimationFrame(fitTerminal));

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("resize", fitTerminal);
      window.visualViewport?.removeEventListener("resize", fitTerminal);
      resizeObserver.disconnect();
      scrollDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    scheduleTerminalFit(0);
    scheduleTerminalFit(120);
    scheduleTerminalFit(360);
  }, [expanded, height]);

  useEffect(() => {
    setLiveTask(task ?? null);
    setLatestLogAt("");
    if (!taskId || !workspaceSignature) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const syncTask = async () => {
      const latest = await getAiExecutorRun(client, taskId).catch(() => null);
      if (cancelled || !latest) return;
      setLiveTask(latest);
      if (isExecutorTaskExecuting(latest.status)) {
        timer = window.setTimeout(syncTask, 3000);
      }
    };
    timer = window.setTimeout(syncTask, 1200);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [client, taskId, workspaceSignature]);

  useEffect(() => {
    if (!taskId || !workspaceSignature) {
      lastFrameSeqRef.current = 0;
      queuedFrameSeqRef.current = 0;
      lastReportedResizeRef.current = "";
      pendingFramesRef.current = [];
      if (frameFlushTimerRef.current != null) {
        window.cancelAnimationFrame(frameFlushTimerRef.current);
        frameFlushTimerRef.current = null;
      }
      frameCountRef.current = 0;
      setFrameCount(0);
      setRuntimeStatus(null);
      setStreamStatus("fallback");
      const terminal = terminalRef.current;
      if (terminal) {
        terminal.reset();
        const lines = taskId && !workspaceSignature
          ? ["$ 等待工作区上下文..."]
          : fallbackLinesRef.current.length > 0
            ? fallbackLinesRef.current
            : ["$ 等待执行器终端输出..."];
        writeTerminal(terminal, `${lines.join("\r\n")}\r\n`);
      }
      return undefined;
    }

    let cancelled = false;
    lastFrameSeqRef.current = 0;
    queuedFrameSeqRef.current = 0;
    lastReportedResizeRef.current = "";
    pendingFramesRef.current = [];
    if (frameFlushTimerRef.current != null) {
      window.cancelAnimationFrame(frameFlushTimerRef.current);
      frameFlushTimerRef.current = null;
    }
    frameCountRef.current = 0;
    setFrameCount(0);
    setRuntimeStatus(null);
    setStreamStatus("connecting");

    const flushFrames = () => {
      frameFlushTimerRef.current = null;
      if (cancelled) {
        pendingFramesRef.current = [];
        return;
      }
      const frames = pendingFramesRef.current.splice(0);
      if (frames.length === 0) return;
      const terminal = terminalRef.current;
      let payload = "";
      let acceptedCount = 0;
      let acceptedByteLength = 0;
      let latest = "";
      frames.forEach((frame) => {
        if (frame.frameSeq <= lastFrameSeqRef.current) return;
        lastFrameSeqRef.current = frame.frameSeq;
        let decodedPayload = decodeExecutorTerminalFrame(frame);
        if (redactContent) decodedPayload = redactTerminalText(decodedPayload);
        const status = extractExecutorRuntimeStatus(frame);
        if (status) {
          setRuntimeStatus(status);
        }
        payload += decodedPayload;
        acceptedByteLength += decodedPayload ? frame.byteLength || decodedPayload.length : 0;
        acceptedCount += 1;
        latest = maxIsoTime(latest, frame.createdAt);
      });
      if (terminal && payload) {
        writeTerminal(terminal, payload);
        scheduleTerminalFit(120);
      }
      if (acceptedCount > 0) {
        const estimatedUsage = estimateExecutorTerminalFrameUsage(payload, acceptedByteLength);
        if (estimatedUsage) {
          setTokenStats((current) => {
            if (!current.estimated && current.eventCount > 0) return current;
            return {
              current: estimatedUsage,
              cumulative: addExecutorTokenUsage(current.cumulative, estimatedUsage),
              estimated: true,
              eventCount: current.eventCount + 1,
              updatedAt: latest || new Date().toISOString()
            };
          });
        }
        frameCountRef.current += acceptedCount;
        setFrameCount(frameCountRef.current);
        setLatestLogAt((current) => maxIsoTime(current, latest));
      }
    };

    const enqueueFrame = (frame: AiExecutorTerminalFrame) => {
      const seenSeq = Math.max(lastFrameSeqRef.current, queuedFrameSeqRef.current);
      if (frame.frameSeq <= seenSeq) return;
      queuedFrameSeqRef.current = frame.frameSeq;
      pendingFramesRef.current.push(frame);
      if (frameFlushTimerRef.current == null) {
        frameFlushTimerRef.current = window.requestAnimationFrame(flushFrames);
      }
    };

    void (async () => {
      const terminal = terminalRef.current;
      if (terminal) {
        terminal.reset();
        writeTerminal(terminal, "$ 正在连接执行器终端流...\r\n");
      }
      const initial = await listAiExecutorTerminalFrames(client, taskId, 0).catch(() => []);
      if (cancelled) return;
      if (terminalRef.current) {
        terminalRef.current.reset();
      }
      initial.forEach(enqueueFrame);
      scheduleTerminalFit(40);
      scheduleTerminalFit(260);
      scheduleTerminalFit(900);
      if (initial.length === 0) {
        const currentTerminal = terminalRef.current;
        if (currentTerminal) writeTerminal(currentTerminal, "$ 等待执行器终端输出...\r\n");
      }
      if (!client.stream) {
        setStreamStatus("fallback");
        return;
      }
      while (!cancelled) {
        setStreamStatus("connected");
        const response = await client
          .stream(`/api/v1/ai-executor-runs/${taskId}/terminal-stream?afterFrame=${lastFrameSeqRef.current}`)
          .catch(() => null);
        if (!response?.body || cancelled) {
          setStreamStatus("fallback");
          return;
        }
        await readExecutorTerminalSse(response, (event) => {
          if (event.event !== "terminal.frame") return;
          enqueueFrame(event.data as AiExecutorTerminalFrame);
        });
        if (!cancelled) await wait(100);
      }
    })();

    return () => {
      cancelled = true;
      pendingFramesRef.current = [];
      if (frameFlushTimerRef.current != null) {
        window.cancelAnimationFrame(frameFlushTimerRef.current);
        frameFlushTimerRef.current = null;
      }
    };
  }, [client, redactContent, taskId, workspaceSignature]);

  const effectiveTask = liveTask ?? task ?? null;
  const taskStatus = effectiveTask?.status;
  const executing = isExecutorTaskExecuting(taskStatus) || (Boolean(taskId) && streamStatus === "connecting");
  const footerStatusLabel = taskStatus ? executorTaskStatusLabel(taskStatus) : streamStatusLabel(streamStatus);
  const footerStatusColor = taskStatus ? executorTaskStatusColor(taskStatus) : "default";

  const terminalNode = (
    <>
      <MatrixAccountMotionStyles />
      <Space
        className={expanded ? "matrix-account-terminal-shell matrix-account-terminal-shell--expanded" : "matrix-account-terminal-shell"}
        direction="vertical"
        size={8}
        style={terminalShellStyle}
      >
        {allowExpand ? (
          <Space style={{ justifyContent: "flex-end", width: "100%" }} align="center" size={6}>
            <Button size="small" onClick={() => setViewMode("popup")}>
              弹窗
            </Button>
            <Button size="small" onClick={() => setViewMode("maximized")}>
              最大化
            </Button>
          </Space>
        ) : null}
        <div
          className={executing ? "matrix-account-terminal matrix-account-terminal--active" : "matrix-account-terminal"}
          style={{
            flex: expanded ? "1 1 auto" : undefined,
            minHeight: expanded ? 0 : 280
          }}
        >
          <div
            ref={terminalHostRef}
            className="matrix-account-terminal__xterm"
            style={{
              height,
              maxHeight: expanded ? "none" : undefined,
              minHeight: expanded ? EXECUTOR_TERMINAL_MIN_HEIGHT : undefined
            }}
          />
          <div className="matrix-account-terminal-footer">
            <div className="matrix-account-terminal-token-stats">
              <span className="matrix-account-terminal-token-stats__label">Token</span>
              <span>{formatExecutorTokenUsage("本次", tokenStats.current)}</span>
              <span>{formatExecutorTokenUsage("累积", tokenStats.cumulative)}</span>
            </div>
            <div className="matrix-account-terminal-footer__status">
              <Tag color={footerStatusColor}>{footerStatusLabel}</Tag>
            </div>
            <Space size={6} className="matrix-account-terminal-footer__actions">
              <Button
                className="matrix-account-terminal-footer__button"
                size="small"
                onClick={() => {
                  const terminal = terminalRef.current;
                  if (terminal) {
                    terminal.clear();
                  }
                  setFrameCount(0);
                }}
              >
                清屏
              </Button>
              <Button
                className="matrix-account-terminal-footer__button"
                size="small"
                type={autoScroll ? "primary" : "default"}
                onClick={() => setAutoScroll((value) => !value)}
              >
                {autoScroll ? "✓ " : ""}跟随底部
              </Button>
            </Space>
          </div>
        </div>
      </Space>
    </>
  );

  return (
    <>
      {terminalNode}
      {allowExpand ? (
        <Modal
          className={viewMode === "maximized" ? "matrix-account-terminal-modal matrix-account-terminal-modal--maximized" : "matrix-account-terminal-modal"}
          destroyOnHidden
          footer={null}
          open={viewMode !== null}
          title={viewMode === "maximized" ? "执行器仿真终端 · 最大化" : "执行器仿真终端 · 弹窗"}
          width={viewMode === "maximized" ? "100vw" : "92vw"}
          onCancel={() => setViewMode(null)}
          style={viewMode === "maximized" ? { top: 0, maxWidth: "100vw", paddingBottom: 0 } : undefined}
          styles={{
            body: {
              padding: "8px 0 0"
            }
          }}
        >
          <MatrixAccountExecutorTerminal
            allowExpand={false}
            client={client}
            expanded
            fallbackLines={fallbackLines}
            height={viewMode === "maximized" ? "calc(100vh - 148px)" : "72vh"}
            redactContent={redactContent}
            task={task}
          />
        </Modal>
      ) : null}
    </>
  );
}

function MatrixAccountExecutorEventStream({
  client,
  onOpenTerminal,
  showDebugEvents = false,
  showPayload = true,
  taskId,
  taskStatus
}: {
  client: RequestClient;
  onOpenTerminal?: () => void;
  showDebugEvents?: boolean;
  showPayload?: boolean;
  taskId?: string;
  taskStatus?: string;
}) {
  const [events, setEvents] = useState<AiExecutorEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<"idle" | "connecting" | "connected" | "fallback">("idle");
  const lastSequenceRef = useRef(0);

  useEffect(() => {
    if (!taskId) {
      lastSequenceRef.current = 0;
      setEvents([]);
      setStreamStatus("idle");
      return undefined;
    }

    let cancelled = false;
    lastSequenceRef.current = 0;
    setEvents([]);
    setStreamStatus("connecting");

    const appendEvent = (event: AiExecutorEvent) => {
      if (event.sequence <= lastSequenceRef.current) return;
      lastSequenceRef.current = event.sequence;
      if (isHiddenExecutorStructuredEvent(event, showDebugEvents)) return;
      setEvents((current) => [...current.slice(-199), event]);
    };

    void (async () => {
      const initial = await listAiExecutorRunEvents(client, taskId, 0).catch(() => []);
      if (cancelled) return;
      initial.forEach(appendEvent);
      if (!client.stream) {
        setStreamStatus("fallback");
        return;
      }
      while (!cancelled) {
        setStreamStatus("connected");
        const response = await client
          .stream(`/api/v1/ai-executor-runs/${taskId}/events-stream?after=${lastSequenceRef.current}`)
          .catch(() => null);
        if (!response?.body || cancelled) {
          setStreamStatus("fallback");
          return;
        }
        await readExecutorTerminalSse(response, (event) => {
          if (event.event === "stream.closed") return;
          appendEvent(event.data as AiExecutorEvent);
        });
        if (!cancelled) await wait(250);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, showDebugEvents, taskId]);

  const executing = isExecutorTaskExecuting(taskStatus) || (Boolean(taskId) && streamStatus === "connecting");
  const liveLabel = taskStatus ? executorTaskStatusLabel(taskStatus) : streamStatusLabel(streamStatus);
  const eventGroups = useMemo(() => groupConsecutiveExecutorEvents(events), [events]);
  const visibleEventGroups = eventGroups.slice(-30);

  return (
    <Space
      className={executing ? "matrix-account-stream-panel matrix-account-stream-panel--active" : "matrix-account-stream-panel"}
      direction="vertical"
      size={8}
      style={{ width: "100%" }}
    >
      <MatrixAccountMotionStyles />
      <Space style={{ justifyContent: "space-between", width: "100%" }} align="center">
        <Space size={6}>
          <Typography.Text strong>Codex 结构化事件</Typography.Text>
          <MatrixAccountLiveIndicator active={executing} label={liveLabel} tone={taskStatus === "waiting_user_scan" ? "gold" : "green"} />
          {taskId ? <Tag color={streamStatus === "connected" ? "green" : "default"}>{streamStatusLabel(streamStatus)}</Tag> : null}
        </Space>
        <Space size={8}>
          {events.length > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {events.length} 条
            </Typography.Text>
          ) : null}
          <Button size="small" disabled={!taskId} onClick={onOpenTerminal}>
            打开终端
          </Button>
        </Space>
      </Space>
      {!taskId ? (
        <Typography.Text type="secondary">暂无 Codex 执行器任务，结构化订阅将在 AI 自动化介入后显示。</Typography.Text>
      ) : eventGroups.length === 0 ? (
        <Typography.Text type="secondary">等待 Codex 结构化事件...</Typography.Text>
      ) : (
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          {visibleEventGroups.map((group) => (
            <div
              key={group.id}
              style={{
                border: "1px solid rgba(127, 127, 127, 0.18)",
                borderRadius: 8,
                padding: "8px 10px"
              }}
            >
              <Space direction="vertical" size={6} style={{ width: "100%" }}>
                <Space wrap size={6}>
                  <Tag color={executorEventLevelColor(group.event.level)}>{executorEventLevelLabel(group.event.level)}</Tag>
                  <Tag>{group.event.eventType}</Tag>
                  {group.count > 1 ? <Tag color="blue">x{group.count}</Tag> : null}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {formatExecutorEventGroupSequence(group)} · {formatShortTime(group.event.createdAt)}
                  </Typography.Text>
                </Space>
                <Typography.Text>{group.event.message}</Typography.Text>
                {showPayload ? (
                  <details>
                    <summary style={{ cursor: "pointer", color: "var(--ant-color-text-secondary)" }}>结构化上下文与环境信息</summary>
                    <div style={{ marginTop: 8 }}>{renderHighlightedJson(redactStructuredPayload(group.event.payload), 260)}</div>
                  </details>
                ) : null}
              </Space>
            </div>
          ))}
        </Space>
      )}
    </Space>
  );
}

function isHiddenExecutorStructuredEvent(event: AiExecutorEvent, showDebugEvents: boolean) {
  return event.eventType === "terminal.resized" || (!showDebugEvents && event.level === "debug");
}

interface ExecutorEventGroup {
  count: number;
  event: AiExecutorEvent;
  firstSequence: number;
  id: string;
  lastSequence: number;
  repeatKey: string;
}

function groupConsecutiveExecutorEvents(events: AiExecutorEvent[]): ExecutorEventGroup[] {
  const groups: ExecutorEventGroup[] = [];
  events.forEach((event) => {
    const repeatKey = executorEventRepeatKey(event);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup?.repeatKey === repeatKey) {
      lastGroup.count += 1;
      lastGroup.event = event;
      lastGroup.lastSequence = event.sequence;
      return;
    }
    groups.push({
      count: 1,
      event,
      firstSequence: event.sequence,
      id: event.id,
      lastSequence: event.sequence,
      repeatKey
    });
  });
  return groups;
}

function executorEventRepeatKey(event: AiExecutorEvent) {
  return [
    event.level,
    event.eventType,
    event.message,
    stringifyJson(redactStructuredPayload(event.payload))
  ].join("\u001f");
}

function formatExecutorEventGroupSequence(group: ExecutorEventGroup) {
  return group.firstSequence === group.lastSequence
    ? `#${group.lastSequence}`
    : `#${group.firstSequence}-#${group.lastSequence}`;
}

function renderJsonPreview(value: unknown, maxHeight = 320) {
  return (
    <pre
      style={{
        maxHeight,
        margin: 0,
        padding: 12,
        overflow: "auto",
        border: "1px solid rgba(127, 127, 127, 0.18)",
        borderRadius: 8,
        background: "rgba(127, 127, 127, 0.08)",
        fontSize: 12,
        lineHeight: 1.55,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word"
      }}
    >
      {JSON.stringify(value ?? {}, null, 2)}
    </pre>
  );
}

function renderHighlightedJson(value: unknown, maxHeight = 420) {
  const json = stringifyJson(value);
  const tokenPattern =
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;
  const parts = json.split(tokenPattern);
  return (
    <pre
      style={{
        maxHeight,
        margin: 0,
        padding: 12,
        overflow: "auto",
        border: "1px solid rgba(127, 127, 127, 0.18)",
        borderRadius: 8,
        background: "rgba(7, 12, 22, 0.94)",
        color: "#d6deeb",
        fontSize: 12,
        lineHeight: 1.58,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word"
      }}
    >
      {parts.map((part, index) => {
        if (!part) return null;
        return (
          <span key={`${index}-${part.slice(0, 8)}`} style={jsonHighlightStyle(part)}>
            {part}
          </span>
        );
      })}
    </pre>
  );
}

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function renderHighlightedText(json: string, keyword: string) {
  const tokenPattern =
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;
  const parts = json.split(tokenPattern);
  return (
    <pre
      style={{
        margin: 0,
        color: "#d6deeb",
        fontSize: 12,
        lineHeight: 1.58,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        background: "rgba(7, 12, 22, 0.94)",
        borderRadius: 8,
        minHeight: "100%",
        padding: 12
      }}
    >
      {parts.map((part, index) => {
        if (!part) return null;
        return renderTextWithSearchHighlight(part, keyword, jsonHighlightStyle(part), `${index}-${part.slice(0, 8)}`);
      })}
    </pre>
  );
}

function renderTextWithSearchHighlight(text: string, keyword: string, style: CSSProperties | undefined, keyPrefix: string) {
  const needle = keyword.trim();
  if (!needle) {
    return (
      <span key={keyPrefix} style={style}>
        {text}
      </span>
    );
  }
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = lowerText.indexOf(lowerNeedle);
  let partIndex = 0;
  while (index >= 0) {
    if (index > cursor) {
      nodes.push(
        <span key={`${keyPrefix}-t-${partIndex}`} style={style}>
          {text.slice(cursor, index)}
        </span>
      );
      partIndex += 1;
    }
    nodes.push(
      <mark
        key={`${keyPrefix}-m-${partIndex}`}
        style={{
          ...style,
          background: "#ffe58f",
          borderRadius: 2,
          color: "#141414",
          padding: "0 1px"
        }}
      >
        {text.slice(index, index + needle.length)}
      </mark>
    );
    partIndex += 1;
    cursor = index + needle.length;
    index = lowerText.indexOf(lowerNeedle, cursor);
  }
  if (cursor < text.length) {
    nodes.push(
      <span key={`${keyPrefix}-t-${partIndex}`} style={style}>
        {text.slice(cursor)}
      </span>
    );
  }
  return nodes;
}

function jsonHighlightStyle(token: string) {
  if (/^".*":$/.test(token)) return { color: "#82aaff" };
  if (/^"/.test(token)) return { color: "#c3e88d" };
  if (/^-?\d/.test(token)) return { color: "#f78c6c" };
  if (token === "true" || token === "false") return { color: "#c792ea" };
  if (token === "null") return { color: "#7f8c98" };
  return undefined;
}

function countTextMatches(text: string, keyword: string) {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let count = 0;
  let cursor = haystack.indexOf(needle);
  while (cursor >= 0) {
    count += 1;
    cursor = haystack.indexOf(needle, cursor + needle.length);
  }
  return count;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

interface ExecutorSseEvent {
  event: string;
  data: unknown;
}

interface ExecutorRuntimeStatus {
  active: boolean;
  kind: string;
  meta: string;
  text: string;
}

interface ExecutorTokenUsage {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

interface ExecutorTokenStats {
  current: ExecutorTokenUsage;
  cumulative: ExecutorTokenUsage;
  estimated: boolean;
  eventCount: number;
  updatedAt: string;
}

function createEmptyExecutorTokenUsage(): ExecutorTokenUsage {
  return {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function createEmptyExecutorTokenStats(): ExecutorTokenStats {
  return {
    current: createEmptyExecutorTokenUsage(),
    cumulative: createEmptyExecutorTokenUsage(),
    estimated: false,
    eventCount: 0,
    updatedAt: ""
  };
}

async function readExecutorTerminalSse(response: Response, onEvent: (event: ExecutorSseEvent) => void) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = parseExecutorSseChunk(chunk);
      if (event) onEvent(event);
      index = buffer.indexOf("\n\n");
    }
  }
}

function parseExecutorSseChunk(chunk: string): ExecutorSseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return { event, data: dataLines.join("\n") };
  }
}

function decodeExecutorTerminalFrame(frame: AiExecutorTerminalFrame) {
  if (frame.encoding !== "base64") return frame.payload ?? "";
  try {
    const binary = window.atob(frame.payload ?? "");
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

const terminalSensitivePatterns: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[已脱敏]"],
  [/(sk-[A-Za-z0-9_-]{8,})/g, "[已脱敏]"],
  [
    /((?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|secret|password|passwd|storage|localStorage|sessionStorage|验证码|captcha)(?:["'\s:=]+))([^,\s"'`;}\]]{3,})/gi,
    "$1[已脱敏]"
  ],
  [/((?:token|secret|password|cookie)["']?\s*:\s*["'])([^"']{3,})(["'])/gi, "$1[已脱敏]$3"]
];

const structuredPayloadSensitiveKeyPattern =
  /^(authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|secret|password|passwd|captcha|otp|mfa|localStorage|sessionStorage|indexedDB|storage|rawScreenshot|screenshot|imageData|base64|rawPrompt|prompt|rawDom|domHtml|html)$/i;

function redactStructuredPayload(value: unknown, key = ""): unknown {
  if (value == null) return value;
  if (structuredPayloadSensitiveKeyPattern.test(key)) return "[已脱敏]";
  if (typeof value === "string") return redactTerminalText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactStructuredPayload(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactStructuredPayload(entryValue, entryKey)
      ])
    );
  }
  return value;
}

function redactTerminalText(value: string) {
  if (!value) return value;
  return terminalSensitivePatterns.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value);
}

function extractExecutorRuntimeStatus(frame: AiExecutorTerminalFrame): ExecutorRuntimeStatus | null {
  const raw = frame.rawJson as Record<string, unknown> | null | undefined;
  const status = raw?.runtimeStatus as Record<string, unknown> | null | undefined;
  const text = stringValue(status?.text).trim();
  if (!text) return null;
  return {
    active: Boolean(status?.active),
    kind: stringValue(status?.kind),
    meta: stringValue(status?.meta),
    text
  };
}

function extractExecutorTokenUsage(event: AiExecutorEvent): ExecutorTokenUsage | null {
  const raw = event.payload as Record<string, unknown> | null | undefined;
  const usage = findExecutorTokenUsage(raw);
  if (!usage) return null;
  return normalizeExecutorTokenUsage(usage);
}

function findExecutorTokenUsage(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!value || depth > 7) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const usage = findExecutorTokenUsage(item, depth + 1);
      if (usage) return usage;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (looksLikeExecutorTokenUsage(record)) return record;
  const preferredKeys = [
    "usage",
    "tokenUsage",
    "token_usage",
    "metrics",
    "message",
    "response",
    "event",
    "data",
    "result",
    "payload",
    "item"
  ];
  for (const key of preferredKeys) {
    const usage = findExecutorTokenUsage(record[key], depth + 1);
    if (usage) return usage;
  }
  for (const value of Object.values(record)) {
    const usage = findExecutorTokenUsage(value, depth + 1);
    if (usage) return usage;
  }
  return null;
}

function looksLikeExecutorTokenUsage(value: Record<string, unknown>) {
  return [
    "input_tokens",
    "inputTokens",
    "input_token_count",
    "prompt_tokens",
    "promptTokens",
    "output_tokens",
    "outputTokens",
    "output_token_count",
    "completion_tokens",
    "completionTokens",
    "reasoning_output_tokens",
    "reasoningOutputTokens",
    "total_tokens",
    "totalTokens",
    "total_token_count"
  ].some((key) => numberValue(value[key]) != null);
}

function normalizeExecutorTokenUsage(usage: Record<string, unknown>): ExecutorTokenUsage | null {
  const inputDetails =
    (usage.input_token_details as Record<string, unknown> | null | undefined) ??
    (usage.inputTokenDetails as Record<string, unknown> | null | undefined) ??
    (usage.prompt_tokens_details as Record<string, unknown> | null | undefined);
  const outputDetails =
    (usage.output_token_details as Record<string, unknown> | null | undefined) ??
    (usage.outputTokenDetails as Record<string, unknown> | null | undefined) ??
    (usage.completion_tokens_details as Record<string, unknown> | null | undefined);
  const inputTokens =
    numberValue(usage.input_tokens) ??
    numberValue(usage.inputTokens) ??
    numberValue(usage.input_token_count) ??
    numberValue(usage.prompt_tokens) ??
    numberValue(usage.promptTokens) ??
    0;
  const cachedInputTokens =
    numberValue(usage.cached_input_tokens) ??
    numberValue(usage.cachedInputTokens) ??
    numberValue(inputDetails?.cached_tokens) ??
    numberValue(inputDetails?.cache_read_input_tokens) ??
    0;
  const outputTokens =
    numberValue(usage.output_tokens) ??
    numberValue(usage.outputTokens) ??
    numberValue(usage.output_token_count) ??
    numberValue(usage.completion_tokens) ??
    numberValue(usage.completionTokens) ??
    0;
  const reasoningOutputTokens =
    numberValue(usage.reasoning_output_tokens) ??
    numberValue(usage.reasoningOutputTokens) ??
    numberValue(outputDetails?.reasoning_tokens) ??
    0;
  const totalTokens =
    numberValue(usage.total_tokens) ??
    numberValue(usage.totalTokens) ??
    numberValue(usage.total_token_count) ??
    inputTokens + outputTokens;
  if (inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens + totalTokens <= 0) return null;
  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function estimateExecutorTerminalFrameUsage(payload: string, byteLength = 0): ExecutorTokenUsage | null {
  const text = payload
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Za-z0-9])/g, " ")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const outputTokens = text.length >= 8 ? Math.ceil(text.length / 4) : Math.ceil(byteLength / 24);
  if (outputTokens <= 0) return null;
  return {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: outputTokens
  };
}

function addExecutorTokenUsage(left: ExecutorTokenUsage, right: ExecutorTokenUsage): ExecutorTokenUsage {
  return {
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

function formatExecutorTokenUsage(label: string, usage: ExecutorTokenUsage) {
  if (usage.totalTokens <= 0 && usage.inputTokens <= 0 && usage.outputTokens <= 0) return `${label}合计 -`;
  return `${label}合计 ${formatTokenCount(usage.totalTokens)}`;
}

function formatTokenCount(value: number) {
  return Math.max(0, Math.round(value)).toLocaleString("zh-CN");
}

function formatExecutorTerminalLine(log: AiExecutorRawLog) {
  return `[${formatShortTime(log.createdAt)}] [${log.source}/${log.direction}] ${formatExecutorTerminalText(log)}`;
}

function formatExecutorTerminalText(log: AiExecutorRawLog) {
  const raw = log.rawJson as Record<string, unknown> | null | undefined;
  const eventType = stringValue(raw?.type);
  const item = raw?.item as Record<string, unknown> | undefined;
  const itemType = stringValue(item?.type);

  if (eventType === "item.started") {
    if (itemType === "command_execution") {
      return `$ ${normalizeCodexCommand(stringValue(item?.command) || "执行命令")}`;
    }
    if (itemType === "agent_message") return "Codex 正在生成回复...";
    return `开始 ${itemType || "任务步骤"}`;
  }

  if (eventType === "item.completed") {
    if (itemType === "agent_message") {
      return stringValue(item?.text) || "Codex 已输出回复";
    }
    if (itemType === "command_execution") {
      const command = normalizeCodexCommand(stringValue(item?.command) || "执行命令");
      const exitCode = numberValue(item?.exit_code);
      const output = stringValue(item?.aggregated_output).trim();
      return output
        ? `$ ${command}\n# exit ${exitCode ?? "-"}\n${truncateTerminalOutput(output)}`
        : `$ ${command}\n# exit ${exitCode ?? "-"}`;
    }
    return `完成 ${itemType || "任务步骤"}`;
  }

  if (eventType === "turn.completed") {
    const usage = raw?.usage as Record<string, unknown> | undefined;
    const inputTokens = numberValue(usage?.input_tokens);
    const cachedTokens = numberValue(usage?.cached_input_tokens);
    const outputTokens = numberValue(usage?.output_tokens);
    const reasoningTokens = numberValue(usage?.reasoning_output_tokens);
    return [
      "Codex 回合完成",
      inputTokens == null ? "" : `input=${inputTokens}`,
      cachedTokens == null ? "" : `cached=${cachedTokens}`,
      outputTokens == null ? "" : `output=${outputTokens}`,
      reasoningTokens == null ? "" : `reasoning=${reasoningTokens}`
    ]
      .filter(Boolean)
      .join(" · ");
  }

  if (log.terminalLine && !looksLikeJson(log.terminalLine)) return log.terminalLine;
  if (log.rawText && !looksLikeJson(log.rawText)) return log.rawText;
  return eventType || JSON.stringify(log.rawJson ?? {});
}

function normalizeCodexCommand(command: string) {
  const value = command.trim();
  const match = value.match(/^\/bin\/bash -lc "([\s\S]*)"$/);
  if (match?.[1]) return match[1].replace(/\\"/g, "\"");
  const singleQuoteMatch = value.match(/^\/bin\/bash -lc '([\s\S]*)'$/);
  if (singleQuoteMatch?.[1]) return singleQuoteMatch[1];
  return value;
}

function truncateTerminalOutput(value: string, maxLength = 4000) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n... 已截断 ${value.length - maxLength} 字符`;
}

function maxIsoTime(current: string, next: string) {
  if (!current) return next;
  if (!next) return current;
  const currentTime = Date.parse(current);
  const nextTime = Date.parse(next);
  if (Number.isNaN(currentTime)) return next;
  if (Number.isNaN(nextTime)) return current;
  return nextTime > currentTime ? next : current;
}

function buildExecutorTerminalStatus(
  task: AiExecutorTask | null,
  context: {
    executing: boolean;
    latestLogAt: string;
    now: number;
    runtimeStatus: ExecutorRuntimeStatus | null;
    streamStatus: "idle" | "connecting" | "connected" | "fallback";
  }
) {
  if (!task) {
    return {
      active: context.streamStatus === "connecting",
      meta: streamStatusLabel(context.streamStatus),
      text: "暂无执行器任务，终端等待 AI 自动化介入。",
      tone: "green" as const
    };
  }

  const startAt = parseTime(task.startedAt || task.createdAt);
  const completedAt = parseTime(task.completedAt);
  const latestAt = parseTime(context.latestLogAt);
  const updatedAt = parseTime(task.updatedAt);
  const endAt = context.executing ? context.now : completedAt || latestAt || updatedAt || context.now;
  const elapsedText = formatElapsedDuration(Math.max(0, endAt - (startAt || endAt)));
  const meta = context.executing ? `已用时 ${elapsedText}` : `耗时 ${elapsedText}`;

  if (context.executing) {
    return {
      active: true,
      meta,
      text: executorTerminalRunningText(task.status),
      tone: task.status === "waiting_user_scan" ? ("gold" as const) : ("green" as const)
    };
  }

  return {
    active: false,
    meta,
    text: executorTerminalFinishedText(task.status, task.errorMessage),
    tone: task.status === "failed" || task.status === "timeout" ? ("gold" as const) : ("green" as const)
  };
}

function executorTerminalRunningText(status: string) {
  if (status === "waiting_user_scan") return "执行器正在等待扫码确认，脚本生成或优化流程仍在进行中。";
  if (status === "waiting_executor") return "执行器任务已创建，正在等待可用 Codex 执行器接管。";
  if (status === "pending") return "执行器任务已排队，正在等待开始生成或优化脚本。";
  return "执行器正在生成或优化脚本，流程仍在进行中。";
}

function executorTerminalFinishedText(status: string, errorMessage?: string) {
  if (status === "completed") return "执行器已完成脚本生成或优化。";
  if (status === "failed") return errorMessage ? `执行器执行失败：${errorMessage}` : "执行器执行失败，脚本生成或优化已结束。";
  if (status === "timeout") return "执行器执行超时，脚本生成或优化已结束。";
  if (status === "cancelled") return "执行器任务已取消。";
  return "执行器任务已结束。";
}

function parseTime(value: string | null | undefined) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function formatElapsedDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function looksLikeJson(value: string) {
  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0])) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function streamStatusLabel(status: "idle" | "connecting" | "connected" | "fallback") {
  const labels = {
    idle: "未连接",
    connecting: "连接中",
    connected: "实时投影",
    fallback: "静态日志"
  };
  return labels[status];
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function webSpaceFlowLabel(status: WebSpaceFlowStatus) {
  const labels: Record<WebSpaceFlowStatus, string> = {
    idle: "等待扫码",
    initializing: "初始化中",
    waiting_qr: "取码中",
    refreshing_qr: "刷新中",
    qr_ready: "等待扫码",
    detecting_account: "识别中",
    failed: "等待扫码",
    success: "已识别",
    releasing: "释放中"
  };
  return labels[status];
}

function fallbackGenerationReason(purpose: MatrixAccountLoginScriptPurpose) {
  if (purpose === "account_detect") return "detect_script_missing";
  return purpose === "qr_login_refresh" ? "refresh_script_missing" : "no_active_script";
}

function generationReasonText(reasonCode: string) {
  const labels: Record<string, string> = {
    no_active_script: "当前平台暂无可用脚本，正在自动构建适配脚本",
    script_disabled: "已配置脚本不可用，正在重新适配",
    no_active_version: "当前脚本缺少可执行版本，正在自动生成新版本",
    page_fingerprint_changed: "检测到登录页结构变化，正在重新适配脚本",
    script_run_failed: "已缓存脚本执行失败，正在重新构建适配脚本",
    consecutive_failures: "脚本连续失败，正在使用 AI 重新优化脚本",
    qr_not_found: "未识别到二维码区域，正在重新分析页面",
    refresh_script_missing: "暂无刷新二维码脚本，正在自动生成刷新脚本",
    refresh_script_failed: "刷新二维码脚本执行失败，正在重新适配刷新逻辑",
    detect_script_missing: "暂无账号识别脚本，正在自动生成识别脚本",
    detect_script_failed: "账号识别脚本执行失败，正在重新适配识别逻辑",
    login_completed_detect_missing: "已完成扫码登录，正在构建账号识别脚本",
    account_identity_not_found: "未识别到稳定账号身份，正在重新分析账号页面",
    manual_retry: "正在按本次操作重新适配脚本"
  };
  return labels[reasonCode] ?? "正在自动适配当前登录页脚本";
}

function qrCodeReadyDescription(recognized: boolean | undefined, reason?: string) {
  if (recognized === true) return "二维码已通过本机识别验证，请使用平台 App 扫码完成登录。";
  if (recognized === false) {
    return reason
      ? `二维码已提取，但本机识别器未确认可读：${reason}`
      : "二维码已提取，但本机识别器未确认可读，请打开窗口核对。";
  }
  return "请使用平台 App 扫码完成登录。";
}

function buildExecutorTerminalTitleCopy(task: AiExecutorTask | null, executor: AiExecutorConfigSummary | null) {
  const executorType = executor?.executorType || task?.executorType || "codex";
  const typeLabel = executorTypeLabel(executorType);
  const fallbackTitle = typeLabel ? `${typeLabel} 执行器` : task?.executorId || "执行器终端";
  const title = (executor?.name || fallbackTitle).trim();
  return {
    title,
    subtitle: typeLabel && !includesExecutorTypeName(title, typeLabel, executorType) ? typeLabel : ""
  };
}

function executorTypeLabel(type: string) {
  const value = type.trim();
  const labels: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    open_code: "OpenCode",
    opencode: "OpenCode"
  };
  return labels[value.toLowerCase()] ?? value;
}

function includesExecutorTypeName(title: string, typeLabel: string, rawType: string) {
  const normalizedTitle = normalizeExecutorTypeText(title);
  return [typeLabel, rawType, executorTypeLabel(rawType)]
    .map(normalizeExecutorTypeText)
    .filter(Boolean)
    .some((item) => normalizedTitle.includes(item));
}

function normalizeExecutorTypeText(value: string) {
  return value.toLowerCase().replace(/[\s_\-]+/g, "");
}

function buildExecutorTerminalPurposeCopy(task: AiExecutorTask | null) {
  const purpose = task?.purpose || "qr_login_prepare";
  const purposeTitle = scriptPurposeLabel(purpose);
  const reasonCode = task?.triggerReason || "";
  const reason = reasonCode ? generationReasonText(reasonCode) : "等待 Codex 执行器接入并同步任务上下文";
  const action = executorScriptActionText(reasonCode);
  return {
    description: reason,
    title: `${action}：${purposeTitle}脚本`
  };
}

function buildExecutorTaskRequirements(task: AiExecutorTask | null) {
  if (task?.taskType === "script_repair" || !task?.taskType) {
    return [
      "根据任务上下文判断为什么脚本没有达到预期标识。",
      "输出可执行的修复建议或 DSL 脚本调整方案。",
      "如果上下文不足，明确说明还需要哪些浏览器调试通道数据。"
    ];
  }
  return ["根据任务上下文完成当前执行器任务，并输出可验证的处理结论。"];
}

function buildExecutorTaskConstraints(task: AiExecutorTask | null) {
  if (task?.taskType === "script_repair" || !task?.taskType) {
    return [
      "本轮先作为后端执行器联调，不要修改仓库文件，不要执行部署命令。",
      "不要编造已经修复成功；无法确认时输出待补充的调试数据。",
      "输出中请包含：失败原因、建议脚本步骤、需要保存的新脚本版本说明。"
    ];
  }
  return ["遵循当前执行器任务限制，无法确认时明确说明缺失的上下文。"];
}

function renderExecutorTaskTextList(items: string[]) {
  return (
    <ol style={{ margin: 0, paddingInlineStart: 18 }}>
      {items.map((item, index) => (
        <li key={`${index}-${item}`} style={{ marginBottom: index === items.length - 1 ? 0 : 4 }}>
          {item}
        </li>
      ))}
    </ol>
  );
}

function executorScriptActionText(reasonCode: string) {
  if (!reasonCode) return "正在处理";
  if (reasonCode === "consecutive_failures") return "正在优化";
  if (
    [
      "no_active_script",
      "no_active_version",
      "refresh_script_missing",
      "detect_script_missing",
      "login_completed_detect_missing"
    ].includes(reasonCode)
  ) {
    return "正在创建";
  }
  return "正在修复";
}

function scriptPurposeLabel(purpose: MatrixAccountLoginScriptPurpose) {
  const labels: Record<MatrixAccountLoginScriptPurpose, string> = {
    qr_login_prepare: "获取二维码",
    qr_login_refresh: "刷新二维码",
    account_detect: "账号识别",
    session_check: "登录检测"
  };
  return labels[purpose] ?? purpose;
}

function buildLoginScriptPurposeGroups(items: MatrixAccountLoginScript[]): LoginScriptPurposeGroup[] {
  const grouped = new Map<MatrixAccountLoginScriptPurpose, MatrixAccountLoginScript[]>();
  items.forEach((item) => {
    const purpose = item.purpose;
    grouped.set(purpose, [...(grouped.get(purpose) ?? []), item]);
  });
  const purposeOrder: MatrixAccountLoginScriptPurpose[] = ["qr_login_prepare", "qr_login_refresh", "account_detect", "session_check"];
  return Array.from(grouped.entries())
    .map(([purpose, scripts]) => {
      const sorted = scripts.slice().sort(compareLoginScriptsForDisplay);
      return {
        key: purpose,
        purpose,
        primary: sorted[0],
        scripts: sorted,
        activeCount: scripts.filter((script) => Boolean(script.activeVersionId) && script.status === "enabled").length,
        successCount: scripts.filter((script) => Boolean(script.lastSuccessAt)).length
      };
    })
    .sort((a, b) => purposeOrder.indexOf(a.purpose) - purposeOrder.indexOf(b.purpose));
}

function compareLoginScriptsForDisplay(a: MatrixAccountLoginScript, b: MatrixAccountLoginScript) {
  return loginScriptDisplayScore(b) - loginScriptDisplayScore(a);
}

function loginScriptDisplayScore(script: MatrixAccountLoginScript) {
  const activeScore = script.status === "enabled" && script.activeVersionId ? 1_000_000_000_000_000 : 0;
  const successScore = script.lastSuccessAt ? 500_000_000_000_000 + Date.parse(script.lastSuccessAt) : 0;
  const updatedScore = Date.parse(script.updatedAt || script.createdAt || "") || 0;
  return activeScore + successScore + updatedScore;
}

function scriptStatusLabel(status: string) {
  const labels: Record<string, string> = {
    enabled: "启用",
    disabled: "停用",
    learning: "学习中",
    failed: "失败"
  };
  return labels[status] ?? (status || "未知");
}

function scriptStatusColor(status: string) {
  const colors: Record<string, string> = {
    enabled: "green",
    disabled: "default",
    learning: "blue",
    failed: "red"
  };
  return colors[status] ?? "default";
}

function shortFingerprint(value: string) {
  const text = String(value || "").trim();
  if (text.length <= 18) return text || "-";
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function scriptVersionStatusLabel(status: string) {
  const labels: Record<string, string> = {
    candidate: "候选版本",
    active: "已生效",
    archived: "已归档",
    failed: "执行失败"
  };
  return labels[status] ?? (status || "未知状态");
}

function scriptVersionSourceLabel(source: string) {
  const labels: Record<string, string> = {
    ai_generated: "AI 生成",
    manual: "人工维护",
    imported: "导入"
  };
  return labels[source] ?? (source || "未知来源");
}

function scriptRunStatusLabel(status: string) {
  const labels: Record<string, string> = {
    success: "成功",
    failed: "失败",
    timeout: "超时",
    cancelled: "已取消"
  };
  return labels[status] ?? (status || "未知");
}

function scriptRunStatusColor(status: string) {
  const colors: Record<string, string> = {
    success: "green",
    failed: "red",
    timeout: "orange",
    cancelled: "default"
  };
  return colors[status] ?? "default";
}

function buildSafeScriptRunPayload(item: MatrixAccountLoginScriptRunLog) {
  return {
    script: {
      purpose: item.purpose,
      purposeText: scriptPurposeLabel(item.purpose),
      version: item.version || undefined,
      versionStatus: item.versionStatus || undefined,
      versionStatusText: item.versionStatus ? scriptVersionStatusLabel(item.versionStatus) : undefined,
      versionSource: item.versionSource || undefined,
      versionSourceText: item.versionSource ? scriptVersionSourceLabel(item.versionSource) : undefined,
      runStatus: item.status,
      runStatusText: scriptRunStatusLabel(item.status),
      triggerReason: item.reasonCode || undefined,
      triggerReasonText: item.reasonCode ? generationReasonText(item.reasonCode) : undefined,
      errorCode: item.errorCode || undefined,
      durationMs: item.durationMs || undefined,
      createdAt: item.createdAt || undefined
    },
    result: sanitizeScriptResultSummary(item.resultSummary)
  };
}

function sanitizeScriptResultSummary(value: unknown) {
  const record = asPlainRecord(value);
  const qrCodeDataUrl = stringValue(record.qrCodeDataUrl);
  const accountCandidate = asPlainRecord(record.accountCandidate);
  const sensitiveKeys = Object.keys(record).filter(isSensitiveSummaryKey);

  return compactSafeRecord({
    webSpaceId: record.webSpaceId,
    platform: record.platform,
    browserPartition: record.browserPartition,
    scriptVersionId: record.scriptVersionId,
    status: record.status,
    durationMs: record.durationMs,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    qrCode: {
      extracted: Boolean(qrCodeDataUrl),
      dataUrlLength: qrCodeDataUrl ? qrCodeDataUrl.length : undefined,
      recognized: record.qrCodeRecognized,
      payloadLength: record.qrCodePayloadLength,
      verifyReason: record.qrCodeVerifyReason
    },
    accountCandidate: Object.keys(accountCandidate).length
      ? {
          identityKeyPresent: Boolean(accountCandidate.identityKey),
          platformUid: accountCandidate.platformUid,
          displayName: accountCandidate.displayName,
          nickname: accountCandidate.nickname,
          homeUrl: accountCandidate.homeUrl,
          avatarUrlPresent: Boolean(accountCandidate.avatarUrl)
        }
      : undefined,
    safeResultKeys: Object.keys(record).filter((key) => !isSensitiveSummaryKey(key)).sort(),
    omittedSensitiveKeys: sensitiveKeys.length > 0 ? sensitiveKeys.sort() : undefined
  });
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function compactSafeRecord(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactSafeRecord).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") {
    if (value === "" || value === null || value === undefined) return undefined;
    return value;
  }
  const output: Record<string, unknown> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    const compacted = compactSafeRecord(entry);
    if (compacted !== undefined) output[key] = compacted;
  });
  return Object.keys(output).length > 0 ? output : undefined;
}

function isSensitiveSummaryKey(key: string) {
  if (["errorCode", "reasonCode", "qrCodeRecognized", "qrCodePayloadLength", "qrCodeVerifyReason"].includes(key)) return false;
  return /cookie|storage|token|password|passwd|secret|captcha|sms|verify|otp|mfa|screenshot|dataurl|dataUrl|prompt|dom|html|localstorage|sessionstorage/i.test(
    key
  );
}

function executorTaskStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "待执行",
    waiting_executor: "等待执行器",
    running: "执行中",
    waiting_user_scan: "等待扫码",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    timeout: "已超时"
  };
  return labels[status] ?? (status || "未知");
}

function executorTaskStatusColor(status: string) {
  const colors: Record<string, string> = {
    pending: "default",
    waiting_executor: "processing",
    running: "processing",
    waiting_user_scan: "gold",
    completed: "green",
    failed: "red",
    cancelled: "default",
    timeout: "orange"
  };
  return colors[status] ?? "default";
}

function isExecutorTaskExecuting(status: string | undefined) {
  return status === "pending" || status === "waiting_executor" || status === "running" || status === "waiting_user_scan";
}

function executorEventLevelLabel(level: string) {
  const labels: Record<string, string> = {
    debug: "调试",
    info: "信息",
    success: "成功",
    warning: "注意",
    error: "失败"
  };
  return labels[level] ?? level;
}

function executorEventLevelColor(level: string) {
  const colors: Record<string, string> = {
    debug: "default",
    info: "blue",
    success: "green",
    warning: "orange",
    error: "red"
  };
  return colors[level] ?? "default";
}

function executorErrorMessage(err: unknown) {
  const code = (err as { code?: string })?.code;
  if (code === "executor_disabled") {
    return "Codex 执行器未启用，请先在 AI 执行器配置中启用后重试。";
  }
  return err instanceof Error ? err.message : "Codex 修复任务创建失败";
}

function compactSnapshot(snapshot: MatrixAccountWebSpaceSnapshotResult) {
  return {
    webSpaceId: snapshot.webSpaceId,
    platform: snapshot.platform,
    browserPartition: snapshot.browserPartition,
    url: snapshot.url,
    title: snapshot.title,
    pageFingerprint: snapshot.pageFingerprint,
    visibleText: snapshot.visibleText?.slice(0, 5000) ?? "",
    domSummary: snapshot.domSummary,
    accessibilityTree: snapshot.accessibilityTree,
    elementRects: snapshot.elementRects?.slice(0, 80) ?? [],
    screenshotAvailable: Boolean(snapshot.screenshotDataUrl),
    sensitiveContext: snapshot.sensitiveContext
  };
}

function isLikelyLoginCompleted(snapshot: { url: string; title: string; visibleText: string; sensitiveContext?: unknown }) {
  const value = `${snapshot.url} ${snapshot.title} ${snapshot.visibleText}`.toLowerCase();
  const cdp = readCdpSignals(snapshot.sensitiveContext);
  if (cdp.loginPhase === "account" || cdp.hasAccount === true) return true;
  if (/\/creator-micro\/(home|content|manage|data|creator|message|notification|income|monetize)(\/|$|\?)/i.test(snapshot.url)) return true;
  if (/\/(user|profile)\/[^/?#]{4,}|\/creator-micro\/user\/[^/?#]{4,}/i.test(snapshot.url)) return true;

  const hasStrongAccountSignal = /退出登录|账号设置|个人主页|抖音号[:：]|快手号[:：]|小红书号[:：]|粉丝\s*\d|获赞\s*\d|高清发布|新的创作|发布视频|发布图文|作品管理|内容管理|数据中心|创作者服务中心|店铺管理|变现中心/.test(value);
  if (hasStrongAccountSignal) return true;

  const hasWaitingSignal = /扫码登录|二维码登录|验证码登录|密码登录|登录\/注册|打开.{0,16}扫一扫|qr|scan|安全验证/.test(value);
  if (cdp.hasQr === true || cdp.hasLogin === true || hasWaitingSignal) return false;

  return false;
}

function isUsableAccountCandidate(candidate: MatrixAccountDetectResultInput | undefined) {
  if (!candidate?.identityKey) return false;
  const identity = candidate.identityKey.trim();
  if (identity.length < 6) return false;
  if (/^(0|null|undefined|false|true|login|profile|default|anonymous|guest)$/i.test(identity)) return false;
  const display = (candidate.displayName || candidate.nickname || "").trim();
  const homeUrl = (candidate.homeUrl || "").trim();
  const uid = (candidate.platformUid || "").trim();
  const hasProfileUrl = /\/(user|profile)\/[^/?#]{4,}|\/creator-micro\/user\/[^/?#]{4,}/i.test(homeUrl);
  const hasDisplay = display.length >= 2 && !isGenericAccountDisplay(display);
  const hasUsefulUid = Boolean(uid && uid !== identity && uid.length >= 6);
  return hasProfileUrl || (hasDisplay && hasUsefulUid) || (hasDisplay && Boolean(candidate.avatarUrl));
}

function readCdpSignals(value: unknown): { hasQr?: boolean; hasLogin?: boolean; hasAccount?: boolean; loginPhase?: string } {
  const signal = (value as { cdp?: { loginSignals?: { hasQr?: boolean; hasLogin?: boolean; hasAccount?: boolean; loginPhase?: string } } })?.cdp?.loginSignals;
  if (signal) return signal;
  const nested = (value as { sensitiveContext?: { cdp?: { loginSignals?: { hasQr?: boolean; hasLogin?: boolean; hasAccount?: boolean; loginPhase?: string } } } })
    ?.sensitiveContext?.cdp?.loginSignals;
  return nested ?? {};
}

function isGenericAccountDisplay(value: string) {
  return /登录|扫码|二维码|创作服务平台|创作者中心|工作台|开放平台|账号中心|管理后台|login|scan|dashboard|creator/i.test(value);
}
