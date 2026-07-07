import { useMemo, useState } from "react";
import { Button, Drawer, Form, Input, Popconfirm, Segmented, Space, Table, Tag, Tree, Typography, message } from "antd";
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
  createRole,
  listPermissions,
  listRoles,
  setRolePermissions,
  updateRole,
  updateRoleStatus,
  type Role,
  type RoleInput
} from "../api";
import {
  DOMAIN_LABELS,
  DOMAIN_ORDER,
  RESOURCE_LABELS,
  isPermissionResourceVisible,
  label,
  resourceDomain,
  type DomainKey
} from "../permission-labels";

const STATUS_META: Record<string, { label: string; color: string }> = {
  normal: { label: "正常", color: "green" },
  disabled: { label: "已停用", color: "red" }
};

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "normal", label: "正常" },
  { value: "disabled", label: "已停用" }
];

export function RolesPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);
  const [form] = Form.useForm<RoleInput>();
  const [permRole, setPermRole] = useState<Role | null>(null);
  const [checkedPerms, setCheckedPerms] = useState<string[]>([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);

  const canCreate = permissions.canAny(["platform.roles.create", "agency.roles.create", "enterprise.roles.create"]);
  const canUpdate = permissions.canAny(["platform.roles.update", "agency.roles.update", "enterprise.roles.update"]);
  const canStatus = permissions.canAny(["platform.roles.disable", "agency.roles.update", "enterprise.roles.update"]);
  const canSetPerms = permissions.canAny([
    "platform.roles.update_permissions",
    "agency.roles.update_permissions",
    "enterprise.roles.update_permissions"
  ]);

  const { data, isFetching } = useQuery({
    queryKey: ["roles", queryState.page, queryState.pageSize, queryState.status],
    queryFn: () => listRoles(client, { page: queryState.page, pageSize: queryState.pageSize, status: queryState.status })
  });
  const permissionsQuery = useQuery({ queryKey: ["permissions", "catalog"], queryFn: () => listPermissions(client) });
  const visiblePermissions = useMemo(
    () => (permissionsQuery.data ?? []).filter((perm) => isPermissionResourceVisible(perm.resource)),
    [permissionsQuery.data]
  );
  const visiblePermissionIds = useMemo(() => new Set(visiblePermissions.map((perm) => perm.id)), [visiblePermissions]);

  function applyState(next: Partial<ListQueryState>) {
    setSelectedRowKeys([]);
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["roles"] });
  const selectedRoles = useMemo(
    () => (data?.items ?? []).filter((role) => selectedRowKeys.includes(role.id)),
    [data?.items, selectedRowKeys]
  );
  const selectedNormalRoles = selectedRoles.filter((role) => role.status === "normal");
  const selectedDisabledRoles = selectedRoles.filter((role) => role.status === "disabled");

  const saveMutation = useMutation({
    mutationFn: (values: RoleInput) => (editing ? updateRole(client, editing.id, values) : createRole(client, values)),
    onSuccess: () => {
      void message.success(editing ? "角色已更新。" : "角色已创建。");
      setDrawerOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateRoleStatus(client, id, status),
    onSuccess: () => {
      void message.success("角色状态已更新。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const bulkStatusMutation = useMutation({
    mutationFn: (status: string) => {
      const targets = status === "disabled" ? selectedNormalRoles : selectedDisabledRoles;
      return runBatchRequests(targets, (role) => updateRoleStatus(client, role.id, status), "批量更新角色状态失败");
    },
    onSuccess: () => {
      void message.success("角色状态已批量更新。");
      setSelectedRowKeys([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const permMutation = useMutation({
    mutationFn: (ids: string[]) => {
      const hiddenExistingIds = (permRole?.permissionIds ?? []).filter((id) => !visiblePermissionIds.has(id));
      return setRolePermissions(client, permRole!.id, [...hiddenExistingIds, ...ids]);
    },
    onSuccess: () => {
      void message.success("角色权限已更新。");
      setPermRole(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  function openCreate() {
    setEditing(null);
    form.resetFields();
    setDrawerOpen(true);
  }
  function openEdit(role: Role) {
    setEditing(role);
    form.setFieldsValue({ name: role.name, code: role.code, description: role.description });
    setDrawerOpen(true);
  }
  function openPermissions(role: Role) {
    setPermRole(role);
    setCheckedPerms(role.permissionIds.filter((id) => visiblePermissionIds.has(id)));
  }

  // 3-level authorization tree: 领域(中文) → 资源(中文) → 具体权限. Checking a
  // domain or resource node selects all descendants for quick bulk assignment.
  const permTreeData = useMemo(() => {
    const domains = new Map<DomainKey, Map<string, { title: string; key: string }[]>>();
    visiblePermissions.forEach((perm) => {
      const dom = resourceDomain(perm.resource);
      if (!domains.has(dom)) domains.set(dom, new Map());
      const byResource = domains.get(dom)!;
      const list = byResource.get(perm.resource) ?? [];
      list.push({ title: `${perm.name}（${perm.code}）`, key: perm.id });
      byResource.set(perm.resource, list);
    });
    return DOMAIN_ORDER.filter((dom) => domains.has(dom)).map((dom) => {
      const byResource = domains.get(dom)!;
      let domainCount = 0;
      const resourceNodes = [...byResource.entries()]
        .sort((a, b) => label(RESOURCE_LABELS, a[0]).localeCompare(label(RESOURCE_LABELS, b[0]), "zh"))
        .map(([resource, children]) => {
          domainCount += children.length;
          return {
            title: `${label(RESOURCE_LABELS, resource)}（${children.length}）`,
            key: `res:${dom}:${resource}`,
            selectable: false,
            children: [...children].sort((a, b) => a.title.localeCompare(b.title, "zh"))
          };
        });
      return {
        title: `${DOMAIN_LABELS[dom]}（${domainCount}）`,
        key: `dom:${dom}`,
        selectable: false,
        children: resourceNodes
      };
    });
  }, [visiblePermissions]);

  const columns: ColumnsType<Role> = useMemo(
    () => [
      {
        title: "角色",
        key: "name",
        render: (_, record) => (
          <Space direction="vertical" size={0}>
            <Space size={6}>
              <Typography.Text strong>{record.name}</Typography.Text>
              {record.isSystem ? <Tag>系统</Tag> : null}
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              编码：{record.code}
            </Typography.Text>
          </Space>
        )
      },
      {
        title: "描述",
        dataIndex: "description",
        key: "description",
        render: (value: string) => value || <Typography.Text type="secondary">—</Typography.Text>
      },
      {
        title: "权限数",
        key: "permCount",
        width: 90,
        render: (_, record) => record.permissionIds.filter((id) => visiblePermissionIds.has(id)).length
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
        title: "操作",
        key: "actions",
        className: "table-action-column",
        width: 240,
        render: (_, record) => (
          <Space className="table-action-grid" size={4} wrap>
            {canUpdate ? (
              <Button size="small" type="link" onClick={() => openEdit(record)}>
                编辑
              </Button>
            ) : null}
            {canSetPerms ? (
              <Button size="small" type="link" onClick={() => openPermissions(record)}>
                授权
              </Button>
            ) : null}
            {canStatus ? (
              record.status === "normal" ? (
                <Popconfirm
                  title="确认停用该角色？"
                  okText="停用"
                  cancelText="取消"
                  onConfirm={() => statusMutation.mutate({ id: record.id, status: "disabled" })}
                >
                  <Button size="small" type="link" danger>
                    停用
                  </Button>
                </Popconfirm>
              ) : (
                <Button size="small" type="link" onClick={() => statusMutation.mutate({ id: record.id, status: "normal" })}>
                  启用
                </Button>
              )
            ) : null}
          </Space>
        )
      }
    ],
    [canUpdate, canSetPerms, canStatus, statusMutation, visiblePermissionIds]
  );

  return (
    <>
      <ListPageCard
        title="角色管理"
        subtitle={
          selectedRowKeys.length > 0 ? (
            <Space size={8}>
              <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 项</Typography.Text>
              <Button size="small" type="link" onClick={() => setSelectedRowKeys([])}>
                清空选择
              </Button>
            </Space>
          ) : (
            "维护当前工作区的角色、权限授予与状态。"
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
            {selectedRoles.length > 0 && canStatus ? (
              <>
                {selectedNormalRoles.length > 0 ? (
                  <Popconfirm
                    title={`确认停用选中的 ${selectedNormalRoles.length} 个角色？`}
                    okText="停用"
                    cancelText="取消"
                    onConfirm={() => bulkStatusMutation.mutate("disabled")}
                  >
                    <Button danger loading={bulkStatusMutation.isPending}>
                      批量停用
                    </Button>
                  </Popconfirm>
                ) : null}
                {selectedDisabledRoles.length > 0 ? (
                  <Button loading={bulkStatusMutation.isPending} onClick={() => bulkStatusMutation.mutate("normal")}>
                    批量启用
                  </Button>
                ) : null}
              </>
            ) : null}
            {canCreate ? (
              <Button type="primary" onClick={openCreate}>
                新建角色
              </Button>
            ) : null}
          </Space>
        }
      >
        <Table<Role>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          rowSelection={
            canStatus
              ? {
                  selectedRowKeys,
                  onChange: (keys) => setSelectedRowKeys(keys.map(String)),
                  getCheckboxProps: (record) => ({ disabled: record.isSystem })
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
        title={editing ? "编辑角色" : "新建角色"}
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
        <Form<RoleInput> form={form} layout="vertical" onFinish={(values) => saveMutation.mutate(values)}>
          <Form.Item label="角色名称" name="name" rules={[{ required: true, message: "请输入角色名称" }]}>
            <Input placeholder="请输入角色名称" />
          </Form.Item>
          <Form.Item label="角色编码" name="code" rules={[{ required: !editing, message: "请输入角色编码" }]}>
            <Input placeholder="请输入角色编码" disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={3} placeholder="角色描述" />
          </Form.Item>
          <Typography.Text type="secondary">权限授予可在列表「授权」操作中配置。</Typography.Text>
        </Form>
      </Drawer>

      <Drawer
        title={`授权角色${permRole ? `：${permRole.name}` : ""}`}
        width={drawerWidths.wideList}
        open={Boolean(permRole)}
        onClose={() => setPermRole(null)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setPermRole(null)}>取消</Button>
            <Button type="primary" loading={permMutation.isPending} onClick={() => permMutation.mutate(checkedPerms)}>
              保存授权
            </Button>
          </Space>
        }
      >
        <Tree
          checkable
          blockNode
          checkedKeys={checkedPerms}
          onCheck={(checked) => {
            const keys = Array.isArray(checked) ? checked : checked.checked;
            setCheckedPerms(
              keys.map(String).filter((key) => !key.startsWith("dom:") && !key.startsWith("res:"))
            );
          }}
          treeData={permTreeData}
          defaultExpandedKeys={DOMAIN_ORDER.map((dom) => `dom:${dom}`)}
        />
      </Drawer>
    </>
  );
}
