import { useState } from "react";
import {
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message
} from "antd";
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
  createAnnouncement,
  deleteAnnouncement,
  listAgencyOptions,
  listAnnouncements,
  listEnterpriseOptions,
  publishAnnouncement,
  resolveTargetNames,
  resolveUserOptions,
  searchUserOptions,
  updateAnnouncement,
  type Announcement,
  type AnnouncementInput,
  type TargetOption
} from "../api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: "草稿", color: "default" },
  published: { label: "已发布", color: "green" }
};

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "draft", label: "草稿" },
  { value: "published", label: "已发布" }
];

const SCOPE_LABELS: Record<string, string> = {
  all: "全部（所有人）",
  agency_all: "全部机构",
  agency: "指定机构",
  enterprise_all: "全部企业",
  enterprise: "指定企业",
  user_all: "全部用户",
  user: "指定用户"
};

const SCOPE_OPTIONS = [
  { value: "all", label: "全部（所有人）" },
  { value: "agency_all", label: "全部机构" },
  { value: "agency", label: "指定机构" },
  { value: "enterprise_all", label: "全部企业" },
  { value: "enterprise", label: "指定企业" },
  { value: "user_all", label: "全部用户" },
  { value: "user", label: "指定用户" }
];

// Scopes that need an explicit id list (the "指定" ones). Others are broadcasts.
const SPECIFIC_SCOPES = ["agency", "enterprise", "user"];

export function AnnouncementsPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [detail, setDetail] = useState<Announcement | null>(null);
  const [userKeyword, setUserKeyword] = useState("");
  const [selectedUserOptions, setSelectedUserOptions] = useState<TargetOption[]>([]);
  const [form] = Form.useForm<AnnouncementInput>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const targetScope = Form.useWatch("targetScope", form) ?? "all";

  const canCreate = permissions.can("platform.announcements.create");
  const canUpdate = permissions.can("platform.announcements.update");
  const canDelete = permissions.can("platform.announcements.delete");
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
    setSelectedRowKeys([]);
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["announcements"] });
  const selectedAnnouncements = (data?.items ?? []).filter((announcement) => selectedRowKeys.includes(announcement.id));

  const saveMutation = useMutation({
    mutationFn: (values: AnnouncementInput) => {
      const payload = { ...values, targetScope: values.targetScope || "all" };
      return editing ? updateAnnouncement(client, editing.id, payload) : createAnnouncement(client, payload);
    },
    onSuccess: () => {
      void message.success(editing ? "公告已更新。" : "公告已创建。");
      setDrawerOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAnnouncement(client, id),
    onSuccess: () => {
      void message.success("公告已删除。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const bulkDeleteMutation = useMutation({
    mutationFn: () =>
      runBatchRequests(
        selectedAnnouncements,
        (announcement) => deleteAnnouncement(client, announcement.id),
        "批量删除公告失败"
      ),
    onSuccess: () => {
      void message.success("公告已批量删除。");
      setSelectedRowKeys([]);
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
  const bulkPublishMutation = useMutation({
    mutationFn: () =>
      runBatchRequests(
        selectedAnnouncements,
        (announcement) => publishAnnouncement(client, announcement.id),
        "批量发布公告失败"
      ),
    onSuccess: () => {
      void message.success("公告已批量发布。");
      setSelectedRowKeys([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  // Detail drawer: resolve target ids → human-readable names.
  const detailNamesQuery = useQuery({
    queryKey: ["announce-detail-names", detail?.id, detail?.targetScope],
    queryFn: () => resolveTargetNames(client, detail!.targetScope, detail!.targetIds ?? []),
    enabled: Boolean(detail) && SPECIFIC_SCOPES.includes(detail?.targetScope ?? "")
  });

  function openCreate() {
    setEditing(null);
    setSelectedUserOptions([]);
    setUserKeyword("");
    form.resetFields();
    setDrawerOpen(true);
  }

  async function openEdit(record: Announcement) {
    setEditing(record);
    setUserKeyword("");
    form.setFieldsValue({
      title: record.title,
      content: record.content,
      targetScope: record.targetScope,
      targetIds: record.targetIds ?? []
    });
    // Seed labels for already-selected users so the multi-select shows names, not ids.
    if (record.targetScope === "user" && (record.targetIds?.length ?? 0) > 0) {
      setSelectedUserOptions(await resolveUserOptions(client, record.targetIds));
    } else {
      setSelectedUserOptions([]);
    }
    setDrawerOpen(true);
  }

  // Union of resolved-selected + live search results (dedup by value) for the user select.
  const userSelectOptions = (() => {
    const map = new Map<string, TargetOption>();
    [...selectedUserOptions, ...(userOptionsQuery.data ?? [])].forEach((o) => map.set(o.value, o));
    return [...map.values()];
  })();

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
        return SPECIFIC_SCOPES.includes(record.targetScope) ? `${lbl}（${record.targetIds?.length ?? 0}）` : lbl;
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
      className: "table-action-column",
      width: 240,
      render: (_, record) => {
        const isDraft = record.status !== "published";
        return (
          <Space className="table-action-grid" size={4} wrap>
            <Button size="small" type="link" onClick={() => setDetail(record)}>
              详情
            </Button>
            {canUpdate && isDraft ? (
              <Button size="small" type="link" onClick={() => void openEdit(record)}>
                编辑
              </Button>
            ) : null}
            {canPublish && isDraft ? (
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
            ) : null}
            {canDelete && isDraft ? (
              <Popconfirm
                title="确认删除该草稿公告？"
                okText="删除"
                cancelText="取消"
                onConfirm={() => deleteMutation.mutate(record.id)}
              >
                <Button size="small" type="link" danger>
                  删除
                </Button>
              </Popconfirm>
            ) : null}
          </Space>
        );
      }
    }
  ];

  return (
    <>
      <ListPageCard
        title="公告管理"
        subtitle={
          selectedRowKeys.length > 0 ? (
            <Space size={8}>
              <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 项</Typography.Text>
              <Button size="small" type="link" onClick={() => setSelectedRowKeys([])}>
                清空选择
              </Button>
            </Space>
          ) : (
            "发布平台公告，发布后将桥接为成员通知。"
          )
        }
        toolbar={
          <Segmented
            className="list-status-segmented"
            options={STATUS_OPTIONS}
            value={queryState.status ?? "all"}
            onChange={(value) => applyState({ status: value === "all" ? undefined : String(value), page: 1 })}
          />
        }
        extra={
          <Space wrap>
            {selectedAnnouncements.length > 0 && canPublish ? (
              <Popconfirm
                title={`确认发布选中的 ${selectedAnnouncements.length} 个公告？`}
                okText="发布"
                cancelText="取消"
                onConfirm={() => bulkPublishMutation.mutate()}
              >
                <Button loading={bulkPublishMutation.isPending}>批量发布</Button>
              </Popconfirm>
            ) : null}
            {selectedAnnouncements.length > 0 && canDelete ? (
              <Popconfirm
                title={`确认删除选中的 ${selectedAnnouncements.length} 个草稿公告？`}
                okText="删除"
                cancelText="取消"
                onConfirm={() => bulkDeleteMutation.mutate()}
              >
                <Button danger loading={bulkDeleteMutation.isPending}>
                  批量删除
                </Button>
              </Popconfirm>
            ) : null}
            {canCreate ? (
              <Button type="primary" onClick={openCreate}>
                新建公告
              </Button>
            ) : null}
          </Space>
        }
      >
        <Table<Announcement>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          rowSelection={{
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys.map(String)),
            getCheckboxProps: (record) => ({ disabled: record.status === "published" })
          }}
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
        title={editing ? "编辑公告" : "新建公告"}
        width={drawerWidths.standardForm}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form<AnnouncementInput> form={form} layout="vertical" onFinish={(values) => saveMutation.mutate(values)}>
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
                options={userSelectOptions}
                notFoundContent={userOptionsQuery.isFetching ? "搜索中…" : "输入关键字搜索用户"}
              />
            </Form.Item>
          ) : null}
        </Form>
      </Drawer>

      <Drawer title="公告详情" width={drawerWidths.standardForm} open={Boolean(detail)} onClose={() => setDetail(null)}>
        {detail ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="标题">{detail.title}</Descriptions.Item>
            <Descriptions.Item label="内容">
              <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                {detail.content}
              </Typography.Paragraph>
            </Descriptions.Item>
            <Descriptions.Item label="目标范围">{SCOPE_LABELS[detail.targetScope] ?? detail.targetScope}</Descriptions.Item>
            <Descriptions.Item label="目标对象">
              {!SPECIFIC_SCOPES.includes(detail.targetScope) ? (
                SCOPE_LABELS[detail.targetScope] ?? detail.targetScope
              ) : detailNamesQuery.isFetching ? (
                "加载中…"
              ) : (
                <Space size={[4, 4]} wrap>
                  {(detailNamesQuery.data ?? []).map((name, i) => (
                    <Tag key={i}>{name}</Tag>
                  ))}
                </Space>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={STATUS_META[detail.status]?.color ?? "default"}>
                {STATUS_META[detail.status]?.label ?? detail.status}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="发布时间">
              {detail.publishedAt ? new Date(detail.publishedAt).toLocaleString("zh-CN") : "—"}
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">{new Date(detail.createdAt).toLocaleString("zh-CN")}</Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>
    </>
  );
}
