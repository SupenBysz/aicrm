import { useMemo, useState } from "react";
import { UserAddOutlined } from "@ant-design/icons";
import { Button, Drawer, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  drawerWidths,
  readListQueryState,
  runBatchRequests,
  useCurrentWorkspace,
  useRequestClient,
  usePermissions,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import {
  assignMemberRoles,
  assignMemberDepartments,
  assignMemberTeams,
  createMember,
  listDepartments,
  listRoles,
  listMembers,
  listTeams,
  removeMember,
  resetUserPassword,
  updateMemberStatus,
  updateUser,
  type CreateMemberInput,
  type Member,
  type UpdateUserInput
} from "../api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  active: { label: "正常", color: "green" },
  disabled: { label: "已禁用", color: "red" }
};

const STATUS_OPTIONS = [
  { value: "active", label: "正常" },
  { value: "disabled", label: "已禁用" }
];

const STATUS_SEGMENT_OPTIONS = [
  { value: "all", label: "全部" },
  ...STATUS_OPTIONS
];

function getRoleLabels(member: Member) {
  const roles = member.roles ?? [];
  if (roles.length > 0) {
    return roles.map((role, index) => ({
      key: role.id || role.code || `${role.name}-${index}`,
      label: role.name || role.code || role.id
    }));
  }
  return (member.roleIds ?? []).map((roleId) => ({ key: roleId, label: roleId }));
}

export function MembersPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const workspace = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [keywordInput, setKeywordInput] = useState(queryState.keyword ?? "");
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<CreateMemberInput>();
  const [assignKind, setAssignKind] = useState<null | "department" | "team">(null);
  const [assignMember, setAssignMember] = useState<Member | null>(null);
  const [assignIds, setAssignIds] = useState<string[]>([]);
  const [roleMember, setRoleMember] = useState<Member | null>(null);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [editMember, setEditMember] = useState<Member | null>(null);
  const [editForm] = Form.useForm<UpdateUserInput>();
  const [resetMember, setResetMember] = useState<Member | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);

  const canDisable = permissions.canAny(["platform.members.disable", "agency.members.disable", "enterprise.members.disable"]);
  const canRemove = permissions.canAny(["platform.members.remove", "agency.members.remove", "enterprise.members.remove"]);
  const canCreate = permissions.canAny(["platform.members.create", "agency.members.create", "enterprise.members.create"]);
  const canUpdate = permissions.canAny(["platform.members.update", "agency.members.update", "enterprise.members.update"]);
  const canResetPwd = permissions.canAny(["platform.members.reset_password", "agency.members.reset_password", "enterprise.members.reset_password"]);
  const canAssignDept = permissions.canAny(["agency.members.assign_department", "enterprise.members.assign_department"]);
  const canAssignTeam = permissions.canAny(["agency.members.assign_team", "enterprise.members.assign_team"]);
  const canAssignRoles = permissions.canAny(["platform.roles.assign", "agency.roles.assign", "enterprise.roles.assign"]);
  const canViewRoles = permissions.canAny(["platform.roles.view", "agency.roles.view", "enterprise.roles.view"]);
  const canViewDepartments = permissions.canAny(["agency.departments.view", "enterprise.departments.view"]);
  const canViewTeams = permissions.canAny(["agency.teams.view", "enterprise.teams.view"]);
  const isOrgWorkspace = workspace?.type === "agency" || workspace?.type === "enterprise";
  const currentMembershipId = workspace?.membershipId;

  const { data, isFetching } = useQuery({
    queryKey: ["members", workspace?.type, workspace?.id, queryState.page, queryState.pageSize, queryState.keyword, queryState.status],
    queryFn: () =>
      listMembers(client, {
        page: queryState.page,
        pageSize: queryState.pageSize,
        keyword: queryState.keyword,
        status: queryState.status
      })
  });

  const { data: rolesData, isFetching: rolesFetching } = useQuery({
    queryKey: ["member-create-roles", workspace?.type, workspace?.id],
    queryFn: () => listRoles(client),
    enabled: Boolean(canViewRoles && (canCreate || canAssignRoles))
  });

  const { data: departmentsData, isFetching: departmentsFetching } = useQuery({
    queryKey: ["member-departments", workspace?.type, workspace?.id],
    queryFn: () => listDepartments(client),
    enabled: Boolean(isOrgWorkspace && canViewDepartments && (canCreate || canAssignDept))
  });

  const { data: teamsData, isFetching: teamsFetching } = useQuery({
    queryKey: ["member-teams", workspace?.type, workspace?.id],
    queryFn: () => listTeams(client),
    enabled: Boolean(isOrgWorkspace && canViewTeams && (canCreate || canAssignTeam))
  });

  const roleOptions = useMemo(
    () =>
      (rolesData?.items ?? []).map((role) => ({
        value: role.id,
        label: `${role.name || role.code} (${role.code})`
      })),
    [rolesData]
  );

  const departmentOptions = useMemo(
    () =>
      (departmentsData ?? []).map((department) => ({
        value: department.id,
        label: department.code ? `${department.name} (${department.code})` : department.name
      })),
    [departmentsData]
  );

  const teamOptions = useMemo(
    () =>
      (teamsData ?? []).map((team) => ({
        value: team.id,
        label: team.code ? `${team.name} (${team.code})` : team.name
      })),
    [teamsData]
  );

  const departmentNameById = useMemo(
    () => new Map((departmentsData ?? []).map((department) => [department.id, department.name || department.code || department.id])),
    [departmentsData]
  );

  const teamNameById = useMemo(
    () => new Map((teamsData ?? []).map((team) => [team.id, team.name || team.code || team.id])),
    [teamsData]
  );

  function applyState(next: Partial<ListQueryState>) {
    setSelectedRowKeys([]);
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["members"] });

  const selectedMembers = useMemo(
    () => (data?.items ?? []).filter((member) => selectedRowKeys.includes(member.id)),
    [data?.items, selectedRowKeys]
  );
  const isCurrentMember = (member: Member) => Boolean(currentMembershipId && member.id === currentMembershipId);
  const selectedActionableMembers = selectedMembers.filter((member) => !isCurrentMember(member));
  const selectedActiveMembers = selectedActionableMembers.filter((member) => member.status === "active");
  const selectedDisabledMembers = selectedActionableMembers.filter((member) => member.status === "disabled");

  const createMutation = useMutation({
    mutationFn: (values: CreateMemberInput) => createMember(client, values),
    onSuccess: () => {
      void message.success("用户已创建。");
      setCreateOpen(false);
      createForm.resetFields();
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateMemberStatus(client, id, status),
    onSuccess: () => {
      void message.success("成员状态已更新。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const bulkStatusMutation = useMutation({
    mutationFn: (status: string) => {
      const targets = status === "disabled" ? selectedActiveMembers : selectedDisabledMembers;
      return runBatchRequests(
        targets,
        (member) => updateMemberStatus(client, member.id, status),
        "批量更新成员状态失败"
      );
    },
    onSuccess: () => {
      void message.success("成员状态已批量更新。");
      setSelectedRowKeys([]);
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

  const bulkRemoveMutation = useMutation({
    mutationFn: () =>
      runBatchRequests(selectedActionableMembers, (member) => removeMember(client, member.id), "批量移除成员失败"),
    onSuccess: () => {
      void message.success("成员已批量移除。");
      setSelectedRowKeys([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const editMutation = useMutation({
    mutationFn: (values: UpdateUserInput) => updateUser(client, editMember!.userId, values),
    onSuccess: () => {
      void message.success("用户信息已更新。");
      setEditMember(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const resetMutation = useMutation({
    mutationFn: (pwd: string) => resetUserPassword(client, resetMember!.userId, pwd),
    onSuccess: () => {
      void message.success("登录密码已重置。");
      setResetMember(null);
      setNewPassword("");
    },
    onError: (error: Error) => message.error(error.message)
  });

  function openEdit(member: Member) {
    setEditMember(member);
    editForm.setFieldsValue({ displayName: member.displayName, email: member.email, phone: member.phone });
  }

  const roleMutation = useMutation({
    mutationFn: (ids: string[]) => assignMemberRoles(client, roleMember!.id, ids),
    onSuccess: () => {
      void message.success("成员角色已更新。");
      setRoleMember(null);
      setRoleIds([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const assignMutation = useMutation({
    mutationFn: (ids: string[]) =>
      assignKind === "department"
        ? assignMemberDepartments(client, assignMember!.id, ids.map((id, index) => ({ departmentId: id, isPrimary: index === 0 })))
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

  function openAssignRoles(member: Member) {
    setRoleMember(member);
    setRoleIds(member.roleIds ?? []);
  }

  const columns: ColumnsType<Member> = useMemo(
    () => [
      {
        title: "用户名",
        key: "name",
        render: (_, record) => {
          const contact = record.phone || record.userId;
          const secondary = record.displayName ? `${record.displayName}${contact ? ` / ${contact}` : ""}` : contact;
          const username = record.username || record.userId;
          return (
            <Space direction="vertical" size={0}>
              <Tooltip title={record.email || "未配置邮箱"}>
                <Typography.Text strong>{username}</Typography.Text>
              </Tooltip>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {secondary || "—"}
              </Typography.Text>
            </Space>
          );
        }
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
        title: "角色",
        key: "roles",
        width: 220,
        render: (_, record) => {
          const roleLabels = getRoleLabels(record);
          if (roleLabels.length === 0) {
            return <Typography.Text type="secondary">—</Typography.Text>;
          }
          return (
            <Space size={[4, 4]} wrap>
              {roleLabels.map((role) => (
                <Tag
                  key={role.key}
                  title={role.label}
                  style={{ marginInlineEnd: 0, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {role.label}
                </Tag>
              ))}
            </Space>
          );
        }
      },
      ...(isOrgWorkspace
        ? [
            {
              title: "组织归属",
              key: "org",
              width: 240,
              render: (_: unknown, record: Member) => {
                const departments = (record.departmentIds ?? []).map((id) => departmentNameById.get(id) ?? id);
                const teams = (record.teamIds ?? []).map((id) => teamNameById.get(id) ?? id);
                if (departments.length === 0 && teams.length === 0) {
                  return <Typography.Text type="secondary">—</Typography.Text>;
                }
                return (
                  <Space direction="vertical" size={2}>
                    {departments.length > 0 ? (
                      <Typography.Text style={{ fontSize: 12 }}>部门：{departments.join("、")}</Typography.Text>
                    ) : null}
                    {teams.length > 0 ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        团队：{teams.join("、")}
                      </Typography.Text>
                    ) : null}
                  </Space>
                );
              }
            }
          ]
        : []),
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
        className: "table-action-column",
        width: 300,
        render: (_, record) => {
          const current = isCurrentMember(record);
          return (
            <Space className="table-action-grid" size={4} wrap>
              {canUpdate ? (
                <Button size="small" type="link" onClick={() => openEdit(record)}>
                  编辑
                </Button>
              ) : null}
              {canResetPwd ? (
                <Button size="small" type="link" onClick={() => { setResetMember(record); setNewPassword(""); }}>
                  重置密码
                </Button>
              ) : null}
              {canAssignRoles && canViewRoles ? (
                <Button size="small" type="link" onClick={() => openAssignRoles(record)}>
                  调角色
                </Button>
              ) : null}
              {canDisable ? (
                record.status === "active" ? (
                  current ? (
                    <Tooltip title="不能禁用当前登录身份">
                      <Button size="small" type="link" danger disabled>
                        禁用
                      </Button>
                    </Tooltip>
                  ) : (
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
                  )
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
                current ? (
                  <Tooltip title="不能移除当前登录身份">
                    <Button size="small" type="link" danger disabled>
                      移除
                    </Button>
                  </Tooltip>
                ) : (
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
                )
              ) : null}
            </Space>
          );
        }
      }
    ],
    [
      canAssignDept,
      canAssignRoles,
      canAssignTeam,
      canDisable,
      canRemove,
      canResetPwd,
      canUpdate,
      canViewRoles,
      currentMembershipId,
      departmentNameById,
      isOrgWorkspace,
      removeMutation,
      statusMutation,
      teamNameById
    ]
  );

  function submitCreate(values: CreateMemberInput) {
    createMutation.mutate({
      ...values,
      roleIds: values.roleIds ?? [],
      departmentIds: isOrgWorkspace ? values.departmentIds ?? [] : [],
      teamIds: isOrgWorkspace ? values.teamIds ?? [] : []
    });
  }

  return (
    <>
      <ListPageCard
        title="用户管理"
        subtitle={
          selectedRowKeys.length > 0 ? (
            <Space size={8}>
              <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 项</Typography.Text>
              <Button size="small" type="link" onClick={() => setSelectedRowKeys([])}>
                清空选择
              </Button>
            </Space>
          ) : (
            "管理当前工作区的用户、状态与归属。"
          )
        }
        toolbar={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="搜索用户名 / 姓名 / 邮箱 / 手机号"
              style={{ width: 260 }}
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              onSearch={(value) => applyState({ keyword: value || undefined, page: 1 })}
            />
            <Segmented
              className="list-status-segmented"
              options={STATUS_SEGMENT_OPTIONS}
              value={queryState.status ?? "all"}
              onChange={(value) => applyState({ status: value === "all" ? undefined : String(value), page: 1 })}
            />
          </Space>
        }
        extra={
          <Space wrap>
            {selectedMembers.length > 0 && canDisable ? (
              <>
                {selectedActiveMembers.length > 0 ? (
                  <Popconfirm
                    title={`确认禁用选中的 ${selectedActiveMembers.length} 个成员？`}
                    okText="禁用"
                    cancelText="取消"
                    onConfirm={() => bulkStatusMutation.mutate("disabled")}
                  >
                    <Button danger loading={bulkStatusMutation.isPending}>
                      批量禁用
                    </Button>
                  </Popconfirm>
                ) : null}
                {selectedDisabledMembers.length > 0 ? (
                  <Button loading={bulkStatusMutation.isPending} onClick={() => bulkStatusMutation.mutate("active")}>
                    批量启用
                  </Button>
                ) : null}
              </>
            ) : null}
            {selectedActionableMembers.length > 0 && canRemove ? (
              <Popconfirm
                title={`确认移除选中的 ${selectedActionableMembers.length} 个成员？`}
                okText="移除"
                cancelText="取消"
                onConfirm={() => bulkRemoveMutation.mutate()}
              >
                <Button danger loading={bulkRemoveMutation.isPending}>
                  批量移除
                </Button>
              </Popconfirm>
            ) : null}
            {canCreate ? (
              <Button
                type="primary"
                icon={<UserAddOutlined />}
                onClick={() => {
                  createForm.resetFields();
                  setCreateOpen(true);
                }}
              >
                新建用户
              </Button>
            ) : null}
          </Space>
        }
      >
        <Table<Member>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          rowSelection={
            canDisable || canRemove
              ? {
                  selectedRowKeys,
                  onChange: (keys) => setSelectedRowKeys(keys.map(String)),
                  getCheckboxProps: (record) => ({
                    disabled: isCurrentMember(record),
                    title: isCurrentMember(record) ? "不能批量操作当前登录身份" : undefined
                  })
                }
              : undefined
          }
          scroll={{ x: isOrgWorkspace ? 1360 : 1180 }}
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
        title="新建用户"
        width={drawerWidths.standardForm}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setCreateOpen(false)}>取消</Button>
            <Button type="primary" loading={createMutation.isPending} onClick={() => createForm.submit()}>
              创建
            </Button>
          </Space>
        }
      >
        <Form<CreateMemberInput> form={createForm} layout="vertical" onFinish={submitCreate}>
          <Form.Item
            label="登录用户名"
            name="username"
            rules={[
              { required: true, message: "请输入登录用户名" },
              { whitespace: true, message: "登录用户名不能为空" },
              { pattern: /^\S+$/, message: "登录用户名不能包含空白字符" }
            ]}
          >
            <Input placeholder="例如 zhangsan" autoComplete="off" />
          </Form.Item>
          <Form.Item label="显示名" name="displayName" rules={[{ required: true, message: "请输入显示名" }]}>
            <Input placeholder="用户显示名" />
          </Form.Item>
          <Form.Item label="初始密码" name="password" rules={[{ required: true, min: 6, message: "请输入至少 6 位初始密码" }]}>
            <Input.Password placeholder="至少 6 位" autoComplete="new-password" />
          </Form.Item>
          <Form.Item label="邮箱" name="email" rules={[{ type: "email", message: "邮箱格式不正确" }]}>
            <Input placeholder="user@example.com" allowClear />
          </Form.Item>
          <Form.Item label="手机号" name="phone">
            <Input placeholder="手机号" allowClear />
          </Form.Item>
          <Form.Item label="工号" name="employeeNo">
            <Input placeholder="工号" allowClear />
          </Form.Item>
          <Form.Item label="职务" name="title">
            <Input placeholder="职务" allowClear />
          </Form.Item>
          <Form.Item label="角色" name="roleIds" rules={[{ required: true, message: "请选择角色" }]}>
            <Select
              mode="multiple"
              disabled={!canViewRoles}
              loading={rolesFetching}
              options={roleOptions}
              placeholder={canViewRoles ? "选择当前工作区角色" : "无角色查看权限"}
              optionFilterProp="label"
              showSearch
            />
          </Form.Item>
          {isOrgWorkspace ? (
            <>
              <Form.Item label="部门归属" name="departmentIds">
                <Select
                  mode="multiple"
                  disabled={!canViewDepartments}
                  loading={departmentsFetching}
                  options={departmentOptions}
                  placeholder={canViewDepartments ? "选择部门，第一项作为主部门" : "无部门查看权限"}
                  optionFilterProp="label"
                  showSearch
                  maxTagCount="responsive"
                />
              </Form.Item>
              <Form.Item label="团队归属" name="teamIds">
                <Select
                  mode="multiple"
                  disabled={!canViewTeams}
                  loading={teamsFetching}
                  options={teamOptions}
                  placeholder={canViewTeams ? "选择团队" : "无团队查看权限"}
                  optionFilterProp="label"
                  showSearch
                  maxTagCount="responsive"
                />
              </Form.Item>
            </>
          ) : null}
        </Form>
      </Drawer>

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
          选择{assignKind === "department" ? "部门" : "团队"}，保存将覆盖该成员当前归属。
        </Typography.Paragraph>
        <Select
          mode="multiple"
          style={{ width: "100%" }}
          loading={assignKind === "department" ? departmentsFetching : teamsFetching}
          options={assignKind === "department" ? departmentOptions : teamOptions}
          placeholder={assignKind === "department" ? "选择部门，第一项作为主部门" : "选择团队"}
          value={assignIds}
          onChange={setAssignIds}
          optionFilterProp="label"
          showSearch
          maxTagCount="responsive"
        />
      </Modal>

      <Modal
        title={`调整角色${roleMember ? `：${roleMember.displayName || roleMember.username || roleMember.userId}` : ""}`}
        open={Boolean(roleMember)}
        onCancel={() => {
          setRoleMember(null);
          setRoleIds([]);
        }}
        onOk={() => roleMutation.mutate(roleIds)}
        confirmLoading={roleMutation.isPending}
        okButtonProps={{ disabled: roleIds.length === 0 }}
        okText="保存"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary">保存将覆盖该成员当前角色集合，至少保留一个角色。</Typography.Paragraph>
        <Select
          mode="multiple"
          style={{ width: "100%" }}
          loading={rolesFetching}
          disabled={!canViewRoles}
          options={roleOptions}
          placeholder={canViewRoles ? "选择当前工作区角色" : "无角色查看权限"}
          value={roleIds}
          onChange={setRoleIds}
          optionFilterProp="label"
          showSearch
          maxTagCount="responsive"
        />
      </Modal>

      <Drawer
        title="编辑用户"
        width={420}
        open={Boolean(editMember)}
        onClose={() => setEditMember(null)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setEditMember(null)}>取消</Button>
            <Button type="primary" loading={editMutation.isPending} onClick={() => editForm.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form<UpdateUserInput> form={editForm} layout="vertical" onFinish={(v) => editMutation.mutate(v)}>
          <Form.Item label="显示名" name="displayName" rules={[{ required: true, message: "请输入显示名" }]}>
            <Input placeholder="用户显示名" />
          </Form.Item>
          <Form.Item label="邮箱" name="email" rules={[{ type: "email", message: "邮箱格式不正确" }]}>
            <Input placeholder="user@example.com" allowClear />
          </Form.Item>
          <Form.Item label="手机号" name="phone">
            <Input placeholder="手机号" allowClear />
          </Form.Item>
        </Form>
      </Drawer>

      <Modal
        title={`重置登录密码${resetMember ? `：${resetMember.displayName || resetMember.email || resetMember.userId}` : ""}`}
        open={Boolean(resetMember)}
        onCancel={() => setResetMember(null)}
        onOk={() => resetMutation.mutate(newPassword)}
        confirmLoading={resetMutation.isPending}
        okButtonProps={{ disabled: newPassword.trim().length < 6 }}
        okText="重置"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary">
          为该用户设置新的登录密码(至少 6 位)。重置后用户的所有登录凭据将使用新密码,请妥善告知本人。
        </Typography.Paragraph>
        <Input.Password
          placeholder="新登录密码(≥6 位)"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </Modal>
    </>
  );
}
