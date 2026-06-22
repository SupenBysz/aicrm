import { useState } from "react";
import { Descriptions, Drawer, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useQuery } from "@tanstack/react-query";
import { drawerWidths, useRequestClient } from "@ky/admin-core";
import { listOrgMembers, type OrgMember, type UserBrief } from "../api";

/** Read-only detail of a user (the org creator). */
export function UserBriefDrawer({ user, onClose }: { user: UserBrief | null; onClose: () => void }) {
  return (
    <Drawer title="用户详情" width={drawerWidths.simpleDetail} open={Boolean(user)} onClose={onClose}>
      {user ? (
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="显示名">{user.displayName || "—"}</Descriptions.Item>
          <Descriptions.Item label="用户名">{user.username || "—"}</Descriptions.Item>
          <Descriptions.Item label="邮箱">{user.email || "—"}</Descriptions.Item>
          <Descriptions.Item label="手机">{user.phone || "—"}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <Tag color={user.status === "normal" ? "green" : "default"}>{user.status || "—"}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="用户 ID">{user.id}</Descriptions.Item>
        </Descriptions>
      ) : null}
    </Drawer>
  );
}

export interface OrgRef {
  type: string;
  id: string;
  name: string;
}

/** Lists members of an organization; clicking a member opens its detail. */
export function OrgMembersDrawer({ org, onClose }: { org: OrgRef | null; onClose: () => void }) {
  const client = useRequestClient();
  const [page, setPage] = useState(1);
  const [member, setMember] = useState<OrgMember | null>(null);

  const { data, isFetching } = useQuery({
    queryKey: ["org-members", org?.type, org?.id, page],
    queryFn: () => listOrgMembers(client, org!.type, org!.id, { page, pageSize: 10 }),
    enabled: Boolean(org)
  });

  const columns: ColumnsType<OrgMember> = [
    {
      title: "成员",
      key: "name",
      render: (_, record) => (
        <Typography.Link onClick={() => setMember(record)}>
          {record.displayName || record.email || record.userId}
        </Typography.Link>
      )
    },
    {
      title: "工号 / 职务",
      key: "employee",
      render: (_, record) => `${record.employeeNo || "—"}${record.title ? " / " + record.title : ""}`
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 90,
      render: (status: string) => <Tag color={status === "active" ? "green" : "red"}>{status}</Tag>
    },
    {
      title: "加入时间",
      dataIndex: "joinedAt",
      key: "joinedAt",
      width: 170,
      render: (value: string | null) => (value ? new Date(value).toLocaleString("zh-CN") : "—")
    }
  ];

  return (
    <>
      <Drawer
        title={`所属用户${org ? ` - ${org.name}` : ""}`}
        width={drawerWidths.wideList}
        open={Boolean(org)}
        onClose={onClose}
      >
        <Table<OrgMember>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          size="small"
          locale={{ emptyText: "该组织暂无用户" }}
          pagination={{
            current: page,
            pageSize: 10,
            total: data?.pagination.total ?? 0,
            showTotal: (total) => `共 ${total} 人`,
            onChange: (next) => setPage(next)
          }}
        />
      </Drawer>

      <Drawer title="用户详情" width={drawerWidths.simpleDetail} open={Boolean(member)} onClose={() => setMember(null)}>
        {member ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="显示名">{member.displayName || "—"}</Descriptions.Item>
            <Descriptions.Item label="邮箱">{member.email || "—"}</Descriptions.Item>
            <Descriptions.Item label="手机">{member.phone || "—"}</Descriptions.Item>
            <Descriptions.Item label="工号">{member.employeeNo || "—"}</Descriptions.Item>
            <Descriptions.Item label="职务">{member.title || "—"}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={member.status === "active" ? "green" : "red"}>{member.status}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="加入时间">
              {member.joinedAt ? new Date(member.joinedAt).toLocaleString("zh-CN") : "—"}
            </Descriptions.Item>
            <Descriptions.Item label="用户 ID">{member.userId}</Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>
    </>
  );
}
