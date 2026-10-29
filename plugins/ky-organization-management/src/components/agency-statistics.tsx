import { useState } from "react";
import { Button, Popover, Space, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import {
  useCurrentUser,
  useCurrentWorkspace,
  useRequestClient,
} from "@ky/admin-core";
export interface AgencyStatistics {
  users: { online: number; employed: number; left: number; total: number };
  enterpriseCount: number;
  terminalsSupported: false;
}
export function useAgencyStatistics(
  ids: string[],
  scope: "agencies" | "enterprises" = "agencies",
) {
  const client = useRequestClient(),
    ws = useCurrentWorkspace(),
    user = useCurrentUser();
  return useQuery({
    queryKey: [
      "agency-statistics",
      user?.id,
      ws?.type,
      ws?.id,
      ws?.membershipId,
      scope,
      ids,
    ],
    enabled: ids.length > 0,
    staleTime: 15000,
    retry: false,
    queryFn: () =>
      client.request<Record<string, AgencyStatistics>>(
        `/api/v1/platform/${scope}/statistics`,
        { method: "POST", body: { ids } },
      ),
  });
}
export function AgencyStatisticsCell({
  id,
  summary,
  loading,
  scope = "agencies",
  retry,
}: {
  id: string;
  summary?: AgencyStatistics;
  loading: boolean;
  scope?: "agencies" | "enterprises";
  retry: () => void;
}) {
  const [open, setOpen] = useState(false),
    client = useRequestClient(),
    ws = useCurrentWorkspace(),
    user = useCurrentUser();
  const detail = useQuery({
    queryKey: [
      "agency-statistic-detail",
      user?.id,
      ws?.type,
      ws?.id,
      ws?.membershipId,
      scope,
      id,
    ],
    enabled: open,
    staleTime: 0,
    retry: false,
    queryFn: () =>
      client.request<Record<string, AgencyStatistics>>(
        `/api/v1/platform/${scope}/statistics`,
        { method: "POST", body: { ids: [id] } },
      ),
  });
  const value = detail.data?.[id] || summary;
  function content() {
    if (detail.isFetching)
      return (
        <Typography.Text type="secondary">正在加载最新统计…</Typography.Text>
      );
    if (detail.isError)
      return (
        <Space direction="vertical">
          <Typography.Text type="danger">统计暂不可用</Typography.Text>
          <Button type="text" onClick={() => void detail.refetch()}>
            重试
          </Button>
        </Space>
      );
    if (!value) return "暂无统计";
    const v = value.users;
    return (
      <Space direction="vertical" size={4}>
        {Object.entries(v).map(([key, n]) => (
          <span key={key}>
            {
              {
                online: "在线",
                employed: "在职",
                left: "离职",
                offline: "离线",
                expired: "过期",
                total: "总数",
              }[key]
            }
            ：{n}
          </span>
        ))}
        <Typography.Text type="secondary">
          在线按最近90秒心跳计算
        </Typography.Text>
      </Space>
    );
  }
  return (
    <Space direction="vertical" size={4}>
      {scope === "agencies" && (
        <span style={{ whiteSpace: "nowrap" }}>
          企业 {summary?.enterpriseCount ?? (loading ? "加载中…" : "暂不可用")}
        </span>
      )}
      <Popover
        title="旗下用户累计"
        content={content()}
        onOpenChange={setOpen}
        mouseEnterDelay={0.25}
        trigger={["hover", "focus", "click"]}
      >
        <span tabIndex={0} style={{ cursor: "help", whiteSpace: "nowrap" }}>
          用户{" "}
          <Typography.Text>
            {value
              ? `${value.users.online} / ${value.users.employed} / ${value.users.total}`
              : loading
                ? "加载中…"
                : "暂不可用"}
          </Typography.Text>
        </span>
      </Popover>
      <Popover
        title="旗下终端累计"
        content="当前项目尚未接入终端统计"
        trigger={["hover", "focus", "click"]}
        mouseEnterDelay={0.25}
      >
        <span tabIndex={0} style={{ cursor: "help", whiteSpace: "nowrap" }}>
          终端 <Typography.Text type="secondary">未接入</Typography.Text>
        </span>
      </Popover>
      {!summary && !loading && (
        <Button type="text" size="small" onClick={retry}>
          重试统计
        </Button>
      )}
    </Space>
  );
}
