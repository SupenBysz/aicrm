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
  assignEnterpriseAgency,
  createEnterprise,
  listAllAgencies,
  listEnterprises,
  updateEnterprise,
  updateEnterpriseStatus,
  type Enterprise,
  type EnterpriseInput,
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

interface EnterpriseFormValues extends EnterpriseInput {
  agencyId?: string;
}

interface EnterpriseFilterValues {
  keyword: string;
  status?: string;
  agencyId?: string;
}

export function EnterprisesPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [filterValues, setFilterValues] = useState<EnterpriseFilterValues>({
    keyword: queryState.keyword ?? "",
    status: queryState.status,
    agencyId: queryState.type
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Enterprise | null>(null);
  const [detail, setDetail] = useState<Enterprise | null>(null);
  const [creator, setCreator] = useState<UserBrief | null>(null);
  const [membersOrg, setMembersOrg] = useState<OrgRef | null>(null);
  const [form] = Form.useForm<EnterpriseFormValues>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);

  const canCreate = permissions.can("platform.enterprises.create");
  const canUpdate = permissions.can("platform.enterprises.update");
  const canDisable = permissions.can("platform.enterprises.disable");
  const canAssignAgency = permissions.can("platform.enterprises.assign_agency");

  useEffect(() => {
    setFilterValues({
      keyword: queryState.keyword ?? "",
      status: queryState.status,
      agencyId: queryState.type
    });
  }, [queryState.keyword, queryState.status, queryState.type]);

  const agenciesQuery = useQuery({
    queryKey: ["org", "agencies", "options"],
    queryFn: () => listAllAgencies(client)
  });
  const agencyOptions = (agenciesQuery.data?.items ?? []).map((agency) => ({ value: agency.id, label: agency.name }));
  const agencyNameById = useMemo(() => {
    const map = new Map<string, string>();
    (agenciesQuery.data?.items ?? []).forEach((agency) => map.set(agency.id, agency.name));
    return map;
  }, [agenciesQuery.data]);

  const { data, isFetching } = useQuery({
    queryKey: ["org", "enterprises", queryState.page, queryState.pageSize, queryState.keyword, queryState.status, queryState.type],
    queryFn: () =>
      listEnterprises(client, {
        page: queryState.page,
        pageSize: queryState.pageSize,
        keyword: queryState.keyword,
        status: queryState.status,
        agencyId: queryState.type
      })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSelectedRowKeys([]);
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }

  function submitFilters() {
    const keyword = filterValues.keyword.trim();
    applyState({
      keyword: keyword || undefined,
      status: filterValues.status,
      type: filterValues.agencyId,
      page: 1
    });
  }

  function resetFilters() {
    setFilterValues({ keyword: "", status: undefined, agencyId: undefined });
    applyState({ keyword: undefined, status: undefined, type: undefined, page: 1 });
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["org", "enterprises"] });
  const selectedEnterprises = useMemo(
    () => (data?.items ?? []).filter((enterprise) => selectedRowKeys.includes(enterprise.id)),
    [data?.items, selectedRowKeys]
  );
  const selectedNormalEnterprises = selectedEnterprises.filter((enterprise) => enterprise.status === "normal");
  const selectedInactiveEnterprises = selectedEnterprises.filter((enterprise) => enterprise.status !== "normal");

  const saveMutation = useMutation({
    mutationFn: async (values: EnterpriseFormValues) => {
      if (editing) {
        await updateEnterprise(client, editing.id, values);
        if (canAssignAgency && (values.agencyId ?? "") !== (editing.agencyId ?? "")) {
          await assignEnterpriseAgency(client, editing.id, values.agencyId ?? "");
        }
        return;
      }
      await createEnterprise(client, values);
    },
    onSuccess: () => {
      void message.success(editing ? "企业已更新。" : "企业已创建。");
      setDrawerOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateEnterpriseStatus(client, id, status),
    onSuccess: () => {
      void message.success("企业状态已更新。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const bulkStatusMutation = useMutation({
    mutationFn: (status: string) => {
      const targets = status === "disabled" ? selectedNormalEnterprises : selectedInactiveEnterprises;
      return runBatchRequests(
        targets,
        (enterprise) => updateEnterpriseStatus(client, enterprise.id, status),
        "批量更新企业状态失败"
      );
    },
    onSuccess: () => {
      void message.success("企业状态已批量更新。");
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

  function openEdit(enterprise: Enterprise) {
    setEditing(enterprise);
    form.setFieldsValue({
      agencyId: enterprise.agencyId ?? undefined,
      name: enterprise.name,
      code: enterprise.code,
      logoUrl: enterprise.logoUrl,
      description: enterprise.description,
      contactName: enterprise.contactName,
      contactPhone: enterprise.contactPhone,
      contactEmail: enterprise.contactEmail
    });
    setDrawerOpen(true);
  }

  const columns: ColumnsType<Enterprise> = useMemo(
    () => [
      {
        title: "企业",
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
        title: "归属机构",
        key: "agency",
        render: (_, record) =>
          record.agencyId ? (
            <Typography.Text>{agencyNameById.get(record.agencyId) ?? record.agencyId}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">未归属</Typography.Text>
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
          <Button size="small" type="link" onClick={() => setMembersOrg({ type: "enterprise", id: record.id, name: record.name })}>
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
                  title="确认停用该企业？"
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
    [agencyNameById, canUpdate, canDisable, statusMutation]
  );

  return (
    <>
      <ListPageCard
        title="企业管理"
        subtitle={
          selectedRowKeys.length > 0 ? (
            <Space size={8}>
              <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 项</Typography.Text>
              <Button size="small" type="link" onClick={() => setSelectedRowKeys([])}>
                清空选择
              </Button>
            </Space>
          ) : (
            "管理平台下的企业主体及其归属机构。"
          )
        }
        toolbar={
          <Space wrap>
            <Input
              allowClear
              placeholder="搜索企业名称或编码"
              style={{ width: 240 }}
              value={filterValues.keyword}
              onChange={(event) => setFilterValues((values) => ({ ...values, keyword: event.target.value }))}
            />
            <Select
              allowClear
              placeholder="归属机构"
              style={{ width: 200 }}
              options={agencyOptions}
              value={filterValues.agencyId}
              onChange={(value) => setFilterValues((values) => ({ ...values, agencyId: value || undefined }))}
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
            {selectedEnterprises.length > 0 && canDisable ? (
              <>
                {selectedNormalEnterprises.length > 0 ? (
                  <Popconfirm
                    title={`确认停用选中的 ${selectedNormalEnterprises.length} 个企业？`}
                    okText="停用"
                    cancelText="取消"
                    onConfirm={() => bulkStatusMutation.mutate("disabled")}
                  >
                    <Button danger loading={bulkStatusMutation.isPending}>
                      批量停用
                    </Button>
                  </Popconfirm>
                ) : null}
                {selectedInactiveEnterprises.length > 0 ? (
                  <Button loading={bulkStatusMutation.isPending} onClick={() => bulkStatusMutation.mutate("normal")}>
                    批量启用
                  </Button>
                ) : null}
              </>
            ) : null}
            {canCreate ? (
              <Button type="primary" onClick={openCreate}>
                新建企业
              </Button>
            ) : null}
          </Space>
        }
      >
        <Table<Enterprise>
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
        title={editing ? "编辑企业" : "新建企业"}
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
        <Form<EnterpriseFormValues> form={form} layout="vertical" onFinish={(values) => saveMutation.mutate(values)}>
          <Form.Item label="归属机构" name="agencyId">
            <Select allowClear placeholder="选择归属机构（可空）" options={agencyOptions} />
          </Form.Item>
          <Form.Item label="企业名称" name="name" rules={[{ required: true, message: "请输入企业名称" }]}>
            <Input placeholder="请输入企业名称" />
          </Form.Item>
          <Form.Item label="企业编码" name="code" rules={[{ required: !editing, message: "请输入企业编码" }]}>
            <Input placeholder="请输入企业编码" disabled={Boolean(editing)} />
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
            <Input.TextArea rows={3} placeholder="企业描述" />
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer title="企业详情" width={drawerWidths.simpleDetail} open={Boolean(detail)} onClose={() => setDetail(null)}>
        {detail ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="名称">{detail.name}</Descriptions.Item>
            <Descriptions.Item label="编码">{detail.code}</Descriptions.Item>
            <Descriptions.Item label="归属机构">
              {detail.agencyId ? agencyNameById.get(detail.agencyId) ?? detail.agencyId : "未归属"}
            </Descriptions.Item>
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
