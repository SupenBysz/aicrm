import { useState } from "react";
import { Button, Drawer, Form, Input, Popconfirm, Segmented, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  drawerWidths,
  readListQueryState,
  runBatchRequests,
  useRequestClient,
  usePermissions,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import {
  cancelInvitation,
  createInvitation,
  listInvitations,
  type CreateInvitationInput,
  type Invitation
} from "../api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: "待接受", color: "blue" },
  accepted: { label: "已接受", color: "green" },
  cancelled: { label: "已取消", color: "default" },
  expired: { label: "已过期", color: "red" }
};

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待接受" },
  { value: "accepted", label: "已接受" },
  { value: "cancelled", label: "已取消" },
  { value: "expired", label: "已过期" }
];

export function InvitationsPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm<CreateInvitationInput>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);

  const canInvite = permissions.canAny([
    "platform.members.invite",
    "agency.members.invite",
    "agency.enterprises.invite_admin",
    "enterprise.members.invite"
  ]);

  const { data, isFetching } = useQuery({
    queryKey: ["invitations", queryState.page, queryState.pageSize, queryState.status],
    queryFn: () =>
      listInvitations(client, { page: queryState.page, pageSize: queryState.pageSize, status: queryState.status })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSelectedRowKeys([]);
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["invitations"] });
  const selectedInvitations = (data?.items ?? []).filter((invitation) => selectedRowKeys.includes(invitation.id));

  const createMutation = useMutation({
    mutationFn: (values: CreateInvitationInput) =>
      createInvitation(client, { ...values, invitationType: values.invitationType || "member" }),
    onSuccess: () => {
      void message.success("邀请已创建。");
      setDrawerOpen(false);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelInvitation(client, id),
    onSuccess: () => {
      void message.success("邀请已取消。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const bulkCancelMutation = useMutation({
    mutationFn: () =>
      runBatchRequests(selectedInvitations, (invitation) => cancelInvitation(client, invitation.id), "批量取消邀请失败"),
    onSuccess: () => {
      void message.success("邀请已批量取消。");
      setSelectedRowKeys([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const columns: ColumnsType<Invitation> = [
    {
      title: "受邀人",
      key: "invitee",
      render: (_, record) => (
        <Typography.Text>{record.inviteeEmail || record.inviteePhone || "—"}</Typography.Text>
      )
    },
    { title: "类型", dataIndex: "invitationType", key: "invitationType", width: 100 },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (status: string) => {
        const meta = STATUS_META[status] ?? { label: status, color: "default" };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      }
    },
    {
      title: "过期时间",
      dataIndex: "expiresAt",
      key: "expiresAt",
      width: 180,
      render: (value: string) => (value ? new Date(value).toLocaleString("zh-CN") : "—")
    },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => new Date(value).toLocaleString("zh-CN")
    },
    {
      title: "操作",
      key: "actions",
      className: "table-action-column",
      width: 180,
      render: (_, record) =>
        canInvite && record.status === "pending" ? (
          <Popconfirm
            title="确认取消该邀请？"
            okText="取消邀请"
            cancelText="返回"
            onConfirm={() => cancelMutation.mutate(record.id)}
          >
            <Button size="small" type="link" danger>
              取消
            </Button>
          </Popconfirm>
        ) : null
    }
  ];

  return (
    <>
      <ListPageCard
        title="邀请管理"
        subtitle={
          selectedRowKeys.length > 0 ? (
            <Space size={8}>
              <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 项</Typography.Text>
              <Button size="small" type="link" onClick={() => setSelectedRowKeys([])}>
                清空选择
              </Button>
            </Space>
          ) : (
            "向邮箱或手机号发起加入邀请，并跟踪受理状态。"
          )
        }
        toolbar={
          <Segmented
            className="invitation-status-segmented"
            options={STATUS_OPTIONS}
            value={queryState.status ?? "all"}
            onChange={(value) => applyState({ status: value === "all" ? undefined : String(value), page: 1 })}
          />
        }
        extra={
          <Space wrap>
            {selectedInvitations.length > 0 && canInvite ? (
              <Popconfirm
                title={`确认取消选中的 ${selectedInvitations.length} 个邀请？`}
                okText="取消邀请"
                cancelText="返回"
                onConfirm={() => bulkCancelMutation.mutate()}
              >
                <Button danger loading={bulkCancelMutation.isPending}>
                  批量取消
                </Button>
              </Popconfirm>
            ) : null}
            {canInvite ? (
              <Button
                type="primary"
                onClick={() => {
                  form.resetFields();
                  setDrawerOpen(true);
                }}
              >
                新建邀请
              </Button>
            ) : null}
          </Space>
        }
      >
        <Table<Invitation>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          rowSelection={
            canInvite
              ? {
                  selectedRowKeys,
                  onChange: (keys) => setSelectedRowKeys(keys.map(String)),
                  getCheckboxProps: (record) => ({ disabled: record.status !== "pending" })
                }
              : undefined
          }
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
        title="新建邀请"
        width={drawerWidths.standardForm}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={createMutation.isPending} onClick={() => form.submit()}>
              发送邀请
            </Button>
          </Space>
        }
      >
        <Form<CreateInvitationInput> form={form} layout="vertical" onFinish={(values) => createMutation.mutate(values)}>
          <Form.Item label="受邀邮箱" name="inviteeEmail">
            <Input placeholder="受邀人邮箱（邮箱/手机号至少填一项）" />
          </Form.Item>
          <Form.Item label="受邀手机号" name="inviteePhone">
            <Input placeholder="受邀人手机号" />
          </Form.Item>
          <Form.Item label="预置角色" name="roleIds">
            <Select mode="tags" placeholder="输入角色 ID 后回车" tokenSeparators={[",", " "]} />
          </Form.Item>
          <Form.Item label="预置部门" name="departmentIds">
            <Select mode="tags" placeholder="输入部门 ID 后回车" tokenSeparators={[",", " "]} />
          </Form.Item>
          <Form.Item label="预置团队" name="teamIds">
            <Select mode="tags" placeholder="输入团队 ID 后回车" tokenSeparators={[",", " "]} />
          </Form.Item>
        </Form>
      </Drawer>
    </>
  );
}
