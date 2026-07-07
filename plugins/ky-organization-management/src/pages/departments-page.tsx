import { useMemo, useState } from "react";
import { Button, Drawer, Form, Input, InputNumber, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, drawerWidths, useRequestClient, usePermissions } from "@ky/admin-core";
import {
  createDepartment,
  deleteDepartment,
  listDepartments,
  updateDepartment,
  type Department,
  type DepartmentInput
} from "../api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  normal: { label: "正常", color: "green" },
  disabled: { label: "已停用", color: "red" }
};

export function DepartmentsPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [form] = Form.useForm<DepartmentInput>();

  const canCreate = permissions.canAny(["agency.departments.create", "enterprise.departments.create"]);
  const canUpdate = permissions.canAny(["agency.departments.update", "enterprise.departments.update"]);
  const canDelete = permissions.canAny(["agency.departments.delete", "enterprise.departments.delete"]);

  const { data, isFetching } = useQuery({
    queryKey: ["org", "departments"],
    queryFn: () => listDepartments(client)
  });
  const departments = data ?? [];
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    departments.forEach((d) => map.set(d.id, d.name));
    return map;
  }, [departments]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["org", "departments"] });

  const saveMutation = useMutation({
    mutationFn: (values: DepartmentInput) =>
      editing ? updateDepartment(client, editing.id, values) : createDepartment(client, values),
    onSuccess: () => {
      void message.success(editing ? "部门已更新。" : "部门已创建。");
      setDrawerOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteDepartment(client, id),
    onSuccess: () => {
      void message.success("部门已删除。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  function openCreate() {
    setEditing(null);
    form.resetFields();
    setDrawerOpen(true);
  }

  function openEdit(department: Department) {
    setEditing(department);
    form.setFieldsValue({
      parentId: department.parentId ?? undefined,
      name: department.name,
      code: department.code,
      sortOrder: department.sortOrder,
      status: department.status
    });
    setDrawerOpen(true);
  }

  const columns: ColumnsType<Department> = useMemo(
    () => [
      {
        title: "部门",
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
        title: "上级部门",
        key: "parent",
        render: (_, record) =>
          record.parentId ? (
            <Typography.Text>{nameById.get(record.parentId) ?? record.parentId}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">顶级</Typography.Text>
          )
      },
      { title: "排序", dataIndex: "sortOrder", key: "sortOrder", width: 80 },
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
        title: "操作",
        key: "actions",
        className: "table-action-column",
        width: 180,
        render: (_, record) => (
          <Space className="table-action-grid" size={4} wrap>
            {canUpdate ? (
              <Button size="small" type="link" onClick={() => openEdit(record)}>
                编辑
              </Button>
            ) : null}
            {canDelete ? (
              <Popconfirm
                title="确认删除该部门？"
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
        )
      }
    ],
    [nameById, canUpdate, canDelete, deleteMutation]
  );

  const parentOptions = departments
    .filter((d) => !editing || d.id !== editing.id)
    .map((d) => ({ value: d.id, label: d.name }));

  return (
    <>
      <ListPageCard
        title="部门管理"
        subtitle="维护当前组织的部门层级结构。"
        extra={
          canCreate ? (
            <Button type="primary" onClick={openCreate}>
              新建部门
            </Button>
          ) : null
        }
      >
        <Table<Department>
          rowKey="id"
          columns={columns}
          dataSource={departments}
          loading={isFetching}
          pagination={false}
          style={{ padding: 8 }}
        />
      </ListPageCard>

      <Drawer
        title={editing ? "编辑部门" : "新建部门"}
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
        <Form<DepartmentInput> form={form} layout="vertical" onFinish={(values) => saveMutation.mutate(values)}>
          <Form.Item label="上级部门" name="parentId">
            <Select allowClear placeholder="顶级部门（可空）" options={parentOptions} />
          </Form.Item>
          <Form.Item label="部门名称" name="name" rules={[{ required: true, message: "请输入部门名称" }]}>
            <Input placeholder="请输入部门名称" />
          </Form.Item>
          <Form.Item label="部门编码" name="code" rules={[{ required: !editing, message: "请输入部门编码" }]}>
            <Input placeholder="请输入部门编码" disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item label="排序" name="sortOrder" initialValue={0}>
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="状态" name="status" initialValue="normal">
            <Select
              options={[
                { value: "normal", label: "正常" },
                { value: "disabled", label: "已停用" }
              ]}
            />
          </Form.Item>
        </Form>
      </Drawer>
    </>
  );
}
