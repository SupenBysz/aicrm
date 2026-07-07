import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  Popconfirm,
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
  createAgency,
  listAgencies,
  updateAgency,
  updateAgencyStatus,
  type Agency,
  type AgencyInput,
  type UserBrief
} from "../api";
import { OrgMembersDrawer, UserBriefDrawer, type OrgRef } from "../components/org-people-drawers";

const STATUS_META: Record<string, { label: string; color: string }> = {
  normal: { label: "正常", color: "green" },
  disabled: { label: "已停用", color: "red" },
  frozen: { label: "已冻结", color: "orange" }
};

const STATUS_OPTIONS = [
  { value: "normal", label: "正常" },
  { value: "disabled", label: "已停用" },
  { value: "frozen", label: "已冻结" }
];

interface AgencyFilterValues {
  keyword: string;
  status?: string;
}

export function AgenciesPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [filterValues, setFilterValues] = useState<AgencyFilterValues>({
    keyword: queryState.keyword ?? "",
    status: queryState.status
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Agency | null>(null);
  const [detail, setDetail] = useState<Agency | null>(null);
  const [creator, setCreator] = useState<UserBrief | null>(null);
  const [membersOrg, setMembersOrg] = useState<OrgRef | null>(null);
  const [form] = Form.useForm<AgencyInput>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);

  const canCreate = permissions.can("platform.agencies.create");
  const canUpdate = permissions.can("platform.agencies.update");
  const canDisable = permissions.can("platform.agencies.disable");

  useEffect(() => {
    setFilterValues({ keyword: queryState.keyword ?? "", status: queryState.status });
  }, [queryState.keyword, queryState.status]);

  const listQueryKey = ["org", "agencies", queryState.page, queryState.pageSize, queryState.keyword, queryState.status];
  const { data, isFetching } = useQuery({
    queryKey: listQueryKey,
    queryFn: () =>
      listAgencies(client, {
        page: queryState.page,
        pageSize: queryState.pageSize,
        keyword: queryState.keyword,
        status: queryState.status
      })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSelectedRowKeys([]);
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }

  function submitFilters() {
    const keyword = filterValues.keyword.trim();
    applyState({ keyword: keyword || undefined, status: filterValues.status, page: 1 });
  }

  function resetFilters() {
    setFilterValues({ keyword: "", status: undefined });
    applyState({ keyword: undefined, status: undefined, page: 1 });
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["org", "agencies"] });
  const selectedAgencies = useMemo(
    () => (data?.items ?? []).filter((agency) => selectedRowKeys.includes(agency.id)),
    [data?.items, selectedRowKeys]
  );
  const selectedNormalAgencies = selectedAgencies.filter((agency) => agency.status === "normal");
  const selectedInactiveAgencies = selectedAgencies.filter((agency) => agency.status !== "normal");

  const saveMutation = useMutation({
    mutationFn: (values: AgencyInput) =>
      editing ? updateAgency(client, editing.id, values) : createAgency(client, values),
    onSuccess: () => {
      void message.success(editing ? "机构已更新。" : "机构已创建。");
      setDrawerOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateAgencyStatus(client, id, status),
    onSuccess: () => {
      void message.success("机构状态已更新。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const bulkStatusMutation = useMutation({
    mutationFn: (status: string) => {
      const targets = status === "disabled" ? selectedNormalAgencies : selectedInactiveAgencies;
      return runBatchRequests(
        targets,
        (agency) => updateAgencyStatus(client, agency.id, status),
        "批量更新机构状态失败"
      );
    },
    onSuccess: () => {
      void message.success("机构状态已批量更新。");
      setSelectedRowKeys([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  function openCreate() {
    setEditing(null);
    form.resetFields();
    setDrawerOpen(true);
  }

  function openEdit(agency: Agency) {
    setEditing(agency);
    form.setFieldsValue({
      name: agency.name,
      code: agency.code,
      logoUrl: agency.logoUrl,
      description: agency.description,
      contactName: agency.contactName,
      contactPhone: agency.contactPhone,
      contactEmail: agency.contactEmail
    });
    setDrawerOpen(true);
  }

  const columns: ColumnsType<Agency> = useMemo(
    () => [
      {
        title: "机构",
        key: "name",
        render: (_, record) => (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{record.name}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              编码：{record.code}
            </Typography.Text>
          </Space>
        )
      },
      {
        title: "联系人",
        key: "contact",
        render: (_, record) =>
          record.contactName || record.contactPhone || record.contactEmail ? (
            <Space direction="vertical" size={0}>
              <Typography.Text>{record.contactName || "—"}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {record.contactPhone || record.contactEmail || ""}
              </Typography.Text>
            </Space>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          )
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
        title: "创建时间",
        dataIndex: "createdAt",
        key: "createdAt",
        width: 180,
        render: (value: string) => new Date(value).toLocaleString("zh-CN")
      },
      {
        title: "创建人",
        key: "creator",
        width: 130,
        render: (_, record) =>
          record.creator ? (
            <Typography.Link onClick={() => setCreator(record.creator)}>
              {record.creator.displayName || record.creator.username}
            </Typography.Link>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          )
      },
      {
        title: "所属用户",
        key: "members",
        width: 100,
        render: (_, record) => (
          <Button size="small" type="link" onClick={() => setMembersOrg({ type: "agency", id: record.id, name: record.name })}>
            {record.memberCount} 人
          </Button>
        )
      },
      {
        title: "操作",
        key: "actions",
        className: "table-action-column",
        width: 240,
        render: (_, record) => (
          <Space className="table-action-grid" size={4} wrap>
            <Button size="small" type="link" onClick={() => setDetail(record)}>
              详情
            </Button>
            {canUpdate ? (
              <Button size="small" type="link" onClick={() => openEdit(record)}>
                编辑
              </Button>
            ) : null}
            {canDisable ? (
              record.status === "normal" ? (
                <Popconfirm
                  title="确认停用该机构？"
                  okText="停用"
                  cancelText="取消"
                  onConfirm={() => statusMutation.mutate({ id: record.id, status: "disabled" })}
                >
                  <Button size="small" type="link" danger>
                    停用
                  </Button>
                </Popconfirm>
              ) : (
                <Button
                  size="small"
                  type="link"
                  onClick={() => statusMutation.mutate({ id: record.id, status: "normal" })}
                >
                  启用
                </Button>
              )
            ) : null}
          </Space>
        )
      }
    ],
    [canUpdate, canDisable, statusMutation]
  );

  return (
    <>
      <ListPageCard
        title="机构管理"
        subtitle={
          selectedRowKeys.length > 0 ? (
            <Space size={8}>
              <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 项</Typography.Text>
              <Button size="small" type="link" onClick={() => setSelectedRowKeys([])}>
                清空选择
              </Button>
            </Space>
          ) : (
            "管理平台下的机构主体，包含基础信息与启停状态。"
          )
        }
        toolbar={
          <Space wrap>
            <Input
              allowClear
              placeholder="搜索机构名称或编码"
              style={{ width: 260 }}
              value={filterValues.keyword}
              onChange={(event) => setFilterValues((values) => ({ ...values, keyword: event.target.value }))}
            />
            <Select
              allowClear
              placeholder="状态"
              style={{ width: 140 }}
              options={STATUS_OPTIONS}
              value={filterValues.status}
              onChange={(value) => setFilterValues((values) => ({ ...values, status: value || undefined }))}
            />
            <Button type="primary" onClick={submitFilters}>
              查询
            </Button>
            <Button onClick={resetFilters}>重置</Button>
          </Space>
        }
        extra={
          <Space wrap>
            {selectedAgencies.length > 0 && canDisable ? (
              <>
                {selectedNormalAgencies.length > 0 ? (
                  <Popconfirm
                    title={`确认停用选中的 ${selectedNormalAgencies.length} 个机构？`}
                    okText="停用"
                    cancelText="取消"
                    onConfirm={() => bulkStatusMutation.mutate("disabled")}
                  >
                    <Button danger loading={bulkStatusMutation.isPending}>
                      批量停用
                    </Button>
                  </Popconfirm>
                ) : null}
                {selectedInactiveAgencies.length > 0 ? (
                  <Button loading={bulkStatusMutation.isPending} onClick={() => bulkStatusMutation.mutate("normal")}>
                    批量启用
                  </Button>
                ) : null}
              </>
            ) : null}
            {canCreate ? (
              <Button type="primary" onClick={openCreate}>
                新建机构
              </Button>
            ) : null}
          </Space>
        }
      >
        <Table<Agency>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          rowSelection={
            canDisable
              ? {
                  selectedRowKeys,
                  onChange: (keys) => setSelectedRowKeys(keys.map(String))
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
        title={editing ? "编辑机构" : "新建机构"}
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
        <Form<AgencyInput> form={form} layout="vertical" onFinish={(values) => saveMutation.mutate(values)}>
          <Form.Item label="机构名称" name="name" rules={[{ required: true, message: "请输入机构名称" }]}>
            <Input placeholder="请输入机构名称" />
          </Form.Item>
          <Form.Item label="机构编码" name="code" rules={[{ required: !editing, message: "请输入机构编码" }]}>
            <Input placeholder="请输入机构编码" disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item label="联系人" name="contactName">
            <Input placeholder="请输入联系人姓名" />
          </Form.Item>
          <Form.Item label="联系电话" name="contactPhone">
            <Input placeholder="请输入联系电话" />
          </Form.Item>
          <Form.Item label="联系邮箱" name="contactEmail">
            <Input placeholder="请输入联系邮箱" />
          </Form.Item>
          <Form.Item label="Logo URL" name="logoUrl">
            <Input placeholder="https://..." />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={3} placeholder="机构描述" />
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer title="机构详情" width={drawerWidths.simpleDetail} open={Boolean(detail)} onClose={() => setDetail(null)}>
        {detail ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="名称">{detail.name}</Descriptions.Item>
            <Descriptions.Item label="编码">{detail.code}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={STATUS_META[detail.status]?.color ?? "default"}>
                {STATUS_META[detail.status]?.label ?? detail.status}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="联系人">{detail.contactName || "—"}</Descriptions.Item>
            <Descriptions.Item label="联系电话">{detail.contactPhone || "—"}</Descriptions.Item>
            <Descriptions.Item label="联系邮箱">{detail.contactEmail || "—"}</Descriptions.Item>
            <Descriptions.Item label="描述">{detail.description || "—"}</Descriptions.Item>
            <Descriptions.Item label="Logo URL">{detail.logoUrl || "—"}</Descriptions.Item>
            <Descriptions.Item label="创建时间">{new Date(detail.createdAt).toLocaleString("zh-CN")}</Descriptions.Item>
            <Descriptions.Item label="更新时间">{new Date(detail.updatedAt).toLocaleString("zh-CN")}</Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>

      <UserBriefDrawer user={creator} onClose={() => setCreator(null)} />
      <OrgMembersDrawer org={membersOrg} onClose={() => setMembersOrg(null)} />
    </>
  );
}
