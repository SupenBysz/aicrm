import { useMemo, useState } from "react";
import { Button, Drawer, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  readListQueryState,
  useRequestClient,
  usePermissions,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import {
  assignMemberDepartments,
  assignMemberTeams,
  listMembers,
  removeMember,
  updateMemberStatus,
  type Member
} from "../api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  active: { label: "正常", color: "green" },
  disabled: { label: "已禁用", color: "red" }
};

const STATUS_OPTIONS = [
  { value: "active", label: "正常" },
  { value: "disabled", label: "已禁用" }
];

export function MembersPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [keywordInput, setKeywordInput] = useState(queryState.keyword ?? "");
  const [assignKind, setAssignKind] = useState<null | "department" | "team">(null);
  const [assignMember, setAssignMember] = useState<Member | null>(null);
  const [assignIds, setAssignIds] = useState<string[]>([]);

  const canDisable = permissions.canAny(["platform.members.disable", "agency.members.disable", "enterprise.members.disable"]);
  const canRemove = permissions.canAny(["platform.members.remove", "agency.members.remove", "enterprise.members.remove"]);
  const canAssignDept = permissions.canAny(["agency.members.assign_department", "enterprise.members.assign_department"]);
  const canAssignTeam = permissions.canAny(["agency.members.assign_team", "enterprise.members.assign_team"]);

  const { data, isFetching } = useQuery({
    queryKey: ["members", queryState.page, queryState.pageSize, queryState.keyword, queryState.status],
    queryFn: () =>
      listMembers(client, {
        page: queryState.page,
        pageSize: queryState.pageSize,
        keyword: queryState.keyword,
        status: queryState.status
      })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["members"] });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateMemberStatus(client, id, status),
    onSuccess: () => {
      void message.success("成员状态已更新。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => removeMember(client, id),
    onSuccess: () => {
      void message.success("成员已移除。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const assignMutation = useMutation({
    mutationFn: (ids: string[]) =>
      assignKind === "department"
        ? assignMemberDepartments(client, assignMember!.id, ids.map((id) => ({ departmentId: id, isPrimary: false })))
        : assignMemberTeams(client, assignMember!.id, ids),
    onSuccess: () => {
      void message.success("归属已更新。");
      setAssignKind(null);
      setAssignMember(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  function openAssign(kind: "department" | "team", member: Member) {
    setAssignKind(kind);
    setAssignMember(member);
    setAssignIds(kind === "department" ? member.departmentIds : member.teamIds);
  }

  const columns: ColumnsType<Member> = useMemo(
    () => [
      {
        title: "成员",
        key: "name",
        render: (_, record) => (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{record.displayName || "—"}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.email || record.phone || record.userId}
            </Typography.Text>
          </Space>
        )
      },
      {
        title: "工号 / 职务",
        key: "employee",
        render: (_, record) => (
          <Space direction="vertical" size={0}>
            <Typography.Text>{record.employeeNo || "—"}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.title || ""}
            </Typography.Text>
          </Space>
        )
      },
      {
        title: "状态",
        dataIndex: "status",
        key: "status",
        width: 90,
        render: (status: string) => {
          const meta = STATUS_META[status] ?? { label: status, color: "default" };
          return <Tag color={meta.color}>{meta.label}</Tag>;
        }
      },
      {
        title: "加入时间",
        dataIndex: "joinedAt",
        key: "joinedAt",
        width: 180,
        render: (value: string | null) => (value ? new Date(value).toLocaleString("zh-CN") : "—")
      },
      {
        title: "操作",
        key: "actions",
        width: 220,
        render: (_, record) => (
          <Space size={4} wrap>
            {canDisable ? (
              record.status === "active" ? (
                <Popconfirm
                  title="确认禁用该成员？"
                  okText="禁用"
                  cancelText="取消"
                  onConfirm={() => statusMutation.mutate({ id: record.id, status: "disabled" })}
                >
                  <Button size="small" type="link" danger>
                    禁用
                  </Button>
                </Popconfirm>
              ) : (
                <Button size="small" type="link" onClick={() => statusMutation.mutate({ id: record.id, status: "active" })}>
                  启用
                </Button>
              )
            ) : null}
            {canAssignDept ? (
              <Button size="small" type="link" onClick={() => openAssign("department", record)}>
                调部门
              </Button>
            ) : null}
            {canAssignTeam ? (
              <Button size="small" type="link" onClick={() => openAssign("team", record)}>
                调团队
              </Button>
            ) : null}
            {canRemove ? (
              <Popconfirm
                title="确认移除该成员？"
                okText="移除"
                cancelText="取消"
                onConfirm={() => removeMutation.mutate(record.id)}
              >
                <Button size="small" type="link" danger>
                  移除
                </Button>
              </Popconfirm>
            ) : null}
          </Space>
        )
      }
    ],
    [canDisable, canRemove, canAssignDept, canAssignTeam, statusMutation, removeMutation]
  );

  return (
    <>
      <ListPageCard title="用户管理" subtitle="管理当前工作区的用户、状态与归属。">
        <Space style={{ padding: 16, width: "100%" }} wrap>
          <Input.Search
            allowClear
            placeholder="搜索姓名 / 邮箱 / 手机号"
            style={{ width: 260 }}
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            onSearch={(value) => applyState({ keyword: value || undefined, page: 1 })}
          />
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 140 }}
            options={STATUS_OPTIONS}
            value={queryState.status}
            onChange={(value) => applyState({ status: value || undefined, page: 1 })}
          />
        </Space>
        <Table<Member>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
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

      <Modal
        title={assignKind === "department" ? "调整部门归属" : "调整团队归属"}
        open={Boolean(assignKind && assignMember)}
        onCancel={() => {
          setAssignKind(null);
          setAssignMember(null);
        }}
        onOk={() => assignMutation.mutate(assignIds)}
        confirmLoading={assignMutation.isPending}
        okText="保存"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary">
          输入{assignKind === "department" ? "部门" : "团队"} ID（回车分隔），保存将覆盖该成员的归属集合。
        </Typography.Paragraph>
        <Select
          mode="tags"
          style={{ width: "100%" }}
          placeholder="输入 ID 后回车"
          value={assignIds}
          onChange={setAssignIds}
          tokenSeparators={[",", " "]}
        />
      </Modal>
    </>
  );
}
