import { useState } from "react";
import { Button, Drawer, Form, Input, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  drawerWidths,
  readListQueryState,
  useRequestClient,
  usePermissions,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import {
  createAnnouncement,
  listAgencyOptions,
  listAnnouncements,
  listEnterpriseOptions,
  publishAnnouncement,
  searchUserOptions,
  type Announcement,
  type AnnouncementInput
} from "../api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: "草稿", color: "default" },
  published: { label: "已发布", color: "green" }
};

const SCOPE_LABELS: Record<string, string> = {
  all: "全部",
  agency: "指定机构",
  enterprise: "指定企业",
  user: "指定用户"
};

const SCOPE_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "agency", label: "指定机构" },
  { value: "enterprise", label: "指定企业" },
  { value: "user", label: "指定用户" }
];

export function AnnouncementsPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userKeyword, setUserKeyword] = useState("");
  const [form] = Form.useForm<AnnouncementInput>();
  const targetScope = Form.useWatch("targetScope", form) ?? "all";

  const canCreate = permissions.can("platform.announcements.create");
  const canPublish = permissions.can("platform.announcements.publish");

  // Targeting option sources — loaded only when the matching scope is selected.
  const agencyOptionsQuery = useQuery({
    queryKey: ["announce-target", "agencies"],
    queryFn: () => listAgencyOptions(client),
    enabled: drawerOpen && targetScope === "agency"
  });
  const enterpriseOptionsQuery = useQuery({
    queryKey: ["announce-target", "enterprises"],
    queryFn: () => listEnterpriseOptions(client),
    enabled: drawerOpen && targetScope === "enterprise"
  });
  const userOptionsQuery = useQuery({
    queryKey: ["announce-target", "users", userKeyword],
    queryFn: () => searchUserOptions(client, userKeyword),
    enabled: drawerOpen && targetScope === "user"
  });

  const { data, isFetching } = useQuery({
    queryKey: ["announcements", queryState.page, queryState.pageSize, queryState.status],
    queryFn: () =>
      listAnnouncements(client, { page: queryState.page, pageSize: queryState.pageSize, status: queryState.status })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["announcements"] });

  const createMutation = useMutation({
    mutationFn: (values: AnnouncementInput) =>
      createAnnouncement(client, { ...values, targetScope: values.targetScope || "all" }),
    onSuccess: () => {
      void message.success("公告已创建。");
      setDrawerOpen(false);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const publishMutation = useMutation({
    mutationFn: (id: string) => publishAnnouncement(client, id),
    onSuccess: () => {
      void message.success("公告已发布。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const columns: ColumnsType<Announcement> = [
    {
      title: "标题",
      key: "title",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.title}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
            {record.content}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: "范围",
      key: "targetScope",
      width: 140,
      render: (_, record) => {
        const lbl = SCOPE_LABELS[record.targetScope] ?? record.targetScope;
        return record.targetScope === "all" ? lbl : `${lbl}（${record.targetIds?.length ?? 0}）`;
      }
    },
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
      title: "发布时间",
      dataIndex: "publishedAt",
      key: "publishedAt",
      width: 180,
      render: (value: string | null) => (value ? new Date(value).toLocaleString("zh-CN") : "—")
    },
    {
      title: "操作",
      key: "actions",
      width: 90,
      render: (_, record) =>
        canPublish && record.status !== "published" ? (
          <Popconfirm
            title="确认发布该公告？"
            okText="发布"
            cancelText="取消"
            onConfirm={() => publishMutation.mutate(record.id)}
          >
            <Button size="small" type="link">
              发布
            </Button>
          </Popconfirm>
        ) : null
    }
  ];

  return (
    <>
      <ListPageCard
        title="公告管理"
        subtitle="发布平台公告，发布后将桥接为成员通知。"
        extra={
          canCreate ? (
            <Button
              type="primary"
              onClick={() => {
                form.resetFields();
                setDrawerOpen(true);
              }}
            >
              新建公告
            </Button>
          ) : null
        }
      >
        <Space style={{ padding: 16 }} wrap>
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 140 }}
            options={[
              { value: "draft", label: "草稿" },
              { value: "published", label: "已发布" }
            ]}
            value={queryState.status}
            onChange={(value) => applyState({ status: value || undefined, page: 1 })}
          />
        </Space>
        <Table<Announcement>
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

      <Drawer
        title="新建公告"
        width={drawerWidths.standardForm}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={createMutation.isPending} onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form<AnnouncementInput> form={form} layout="vertical" onFinish={(values) => createMutation.mutate(values)}>
          <Form.Item label="标题" name="title" rules={[{ required: true, message: "请输入标题" }]}>
            <Input placeholder="请输入公告标题" />
          </Form.Item>
          <Form.Item label="内容" name="content" rules={[{ required: true, message: "请输入内容" }]}>
            <Input.TextArea rows={5} placeholder="请输入公告内容" />
          </Form.Item>
          <Form.Item label="目标范围" name="targetScope" initialValue="all">
            <Select
              options={SCOPE_OPTIONS}
              onChange={() => form.setFieldsValue({ targetIds: [] })}
            />
          </Form.Item>
          {targetScope === "agency" ? (
            <Form.Item
              label="指定机构"
              name="targetIds"
              rules={[{ required: true, message: "请选择至少一个机构" }]}
            >
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="label"
                placeholder="选择要通知的机构"
                loading={agencyOptionsQuery.isFetching}
                options={agencyOptionsQuery.data ?? []}
              />
            </Form.Item>
          ) : null}
          {targetScope === "enterprise" ? (
            <Form.Item
              label="指定企业"
              name="targetIds"
              rules={[{ required: true, message: "请选择至少一个企业" }]}
            >
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="label"
                placeholder="选择要通知的企业"
                loading={enterpriseOptionsQuery.isFetching}
                options={enterpriseOptionsQuery.data ?? []}
              />
            </Form.Item>
          ) : null}
          {targetScope === "user" ? (
            <Form.Item
              label="指定用户"
              name="targetIds"
              rules={[{ required: true, message: "请选择至少一个用户" }]}
            >
              <Select
                mode="multiple"
                showSearch
                filterOption={false}
                placeholder="搜索用户（姓名 / 邮箱 / 手机）"
                onSearch={setUserKeyword}
                loading={userOptionsQuery.isFetching}
                options={userOptionsQuery.data ?? []}
                notFoundContent={userOptionsQuery.isFetching ? "搜索中…" : "输入关键字搜索用户"}
              />
            </Form.Item>
          ) : null}
        </Form>
      </Drawer>
    </>
  );
}
