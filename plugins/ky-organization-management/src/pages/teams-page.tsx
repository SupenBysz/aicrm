import { useMemo, useState } from "react";
import { Button, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, drawerWidths, useRequestClient, usePermissions } from "@ky/admin-core";
import {
  createTeam,
  listDepartments,
  listTeams,
  setTeamMembers,
  updateTeam,
  type Team,
  type TeamInput
} from "../api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  normal: { label: "正常", color: "green" },
  disabled: { label: "已停用", color: "red" }
};

export function TeamsPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Team | null>(null);
  const [form] = Form.useForm<TeamInput>();
  const [membersTeam, setMembersTeam] = useState<Team | null>(null);
  const [memberIds, setMemberIds] = useState<string[]>([]);

  const canCreate = permissions.canAny(["agency.teams.create", "enterprise.teams.create"]);
  const canUpdate = permissions.canAny(["agency.teams.update", "enterprise.teams.update"]);
  const canManageMembers = permissions.canAny(["agency.teams.manage_members", "enterprise.teams.manage_members"]);

  const { data, isFetching } = useQuery({ queryKey: ["org", "teams"], queryFn: () => listTeams(client) });
  const teams = data ?? [];
  const departmentsQuery = useQuery({ queryKey: ["org", "departments", "options"], queryFn: () => listDepartments(client) });
  const departmentOptions = (departmentsQuery.data ?? []).map((d) => ({ value: d.id, label: d.name }));
  const departmentNameById = useMemo(() => {
    const map = new Map<string, string>();
    (departmentsQuery.data ?? []).forEach((d) => map.set(d.id, d.name));
    return map;
  }, [departmentsQuery.data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["org", "teams"] });

  const saveMutation = useMutation({
    mutationFn: (values: TeamInput) => (editing ? updateTeam(client, editing.id, values) : createTeam(client, values)),
    onSuccess: () => {
      void message.success(editing ? "团队已更新。" : "团队已创建。");
      setDrawerOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const membersMutation = useMutation({
    mutationFn: (ids: string[]) => setTeamMembers(client, membersTeam!.id, ids),
    onSuccess: () => {
      void message.success("团队成员已更新。");
      setMembersTeam(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  function openCreate() {
    setEditing(null);
    form.resetFields();
    setDrawerOpen(true);
  }

  function openEdit(team: Team) {
    setEditing(team);
    form.setFieldsValue({
      departmentId: team.departmentId ?? undefined,
      name: team.name,
      code: team.code,
      description: team.description,
      status: team.status
    });
    setDrawerOpen(true);
  }

  const columns: ColumnsType<Team> = useMemo(
    () => [
      {
        title: "团队",
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
        title: "所属部门",
        key: "department",
        render: (_, record) =>
          record.departmentId ? (
            <Typography.Text>{departmentNameById.get(record.departmentId) ?? record.departmentId}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          )
      },
      {
        title: "描述",
        dataIndex: "description",
        key: "description",
        render: (value: string) => value || <Typography.Text type="secondary">—</Typography.Text>
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
            {canManageMembers ? (
              <Button
                size="small"
                type="link"
                onClick={() => {
                  setMembersTeam(record);
                  setMemberIds([]);
                }}
              >
                成员
              </Button>
            ) : null}
          </Space>
        )
      }
    ],
    [departmentNameById, canUpdate, canManageMembers]
  );

  return (
    <>
      <ListPageCard
        title="团队管理"
        subtitle="维护当前组织的团队及其成员。"
        extra={
          canCreate ? (
            <Button type="primary" onClick={openCreate}>
              新建团队
            </Button>
          ) : null
        }
      >
        <Table<Team>
          rowKey="id"
          columns={columns}
          dataSource={teams}
          loading={isFetching}
          pagination={false}
          style={{ padding: 8 }}
        />
      </ListPageCard>

      <Drawer
        title={editing ? "编辑团队" : "新建团队"}
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
        <Form<TeamInput> form={form} layout="vertical" onFinish={(values) => saveMutation.mutate(values)}>
          <Form.Item label="所属部门" name="departmentId">
            <Select allowClear placeholder="选择所属部门（可空）" options={departmentOptions} />
          </Form.Item>
          <Form.Item label="团队名称" name="name" rules={[{ required: true, message: "请输入团队名称" }]}>
            <Input placeholder="请输入团队名称" />
          </Form.Item>
          <Form.Item label="团队编码" name="code" rules={[{ required: !editing, message: "请输入团队编码" }]}>
            <Input placeholder="请输入团队编码" disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={3} placeholder="团队描述" />
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

      <Modal
        title={`设置团队成员${membersTeam ? `：${membersTeam.name}` : ""}`}
        open={Boolean(membersTeam)}
        onCancel={() => setMembersTeam(null)}
        onOk={() => membersMutation.mutate(memberIds)}
        confirmLoading={membersMutation.isPending}
        okText="保存"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary">
          输入要纳入该团队的成员身份 ID（membershipId），回车分隔。保存将覆盖团队现有成员集合。
        </Typography.Paragraph>
        <Select
          mode="tags"
          style={{ width: "100%" }}
          placeholder="输入 membershipId 后回车"
          value={memberIds}
          onChange={setMemberIds}
          tokenSeparators={[",", " "]}
        />
      </Modal>
    </>
  );
}
