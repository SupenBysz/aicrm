import { useState } from "react";
import { Button, Input, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  readListQueryState,
  useRequestClient,
  usePermissions,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import {
  approveQualification,
  listQualifications,
  rejectQualification,
  type Qualification
} from "../api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  submitted: { label: "待审核", color: "blue" },
  approved: { label: "已通过", color: "green" },
  rejected: { label: "已驳回", color: "red" }
};

const STATUS_OPTIONS = [
  { value: "submitted", label: "待审核" },
  { value: "approved", label: "已通过" },
  { value: "rejected", label: "已驳回" }
];

export function QualificationReviewPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [reject, setReject] = useState<Qualification | null>(null);
  const [rejectRemark, setRejectRemark] = useState("");

  const canReview = permissions.can("platform.qualifications.review");

  const { data, isFetching } = useQuery({
    queryKey: ["qualifications", "review", queryState.page, queryState.pageSize, queryState.status],
    queryFn: () => listQualifications(client, { page: queryState.page, pageSize: queryState.pageSize, status: queryState.status })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["qualifications"] });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approveQualification(client, id, ""),
    onSuccess: () => {
      void message.success("资质已通过。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });
  const rejectMutation = useMutation({
    mutationFn: ({ id, remark }: { id: string; remark: string }) => rejectQualification(client, id, remark),
    onSuccess: () => {
      void message.success("资质已驳回。");
      setReject(null);
      setRejectRemark("");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const columns: ColumnsType<Qualification> = [
    { title: "资质类型", dataIndex: "qualificationType", key: "qualificationType" },
    {
      title: "提交主体",
      key: "target",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Tag>{record.targetType === "agency" ? "机构" : "企业"}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.targetId}
          </Typography.Text>
        </Space>
      )
    },
    { title: "材料", key: "materials", render: (_, record) => (record.materials?.length ? `${record.materials.length} 份` : "—") },
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
      title: "提交时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => new Date(value).toLocaleString("zh-CN")
    },
    {
      title: "操作",
      key: "actions",
      width: 130,
      render: (_, record) =>
        canReview && record.status === "submitted" ? (
          <Space size={4}>
            <Button size="small" type="link" loading={approveMutation.isPending} onClick={() => approveMutation.mutate(record.id)}>
              通过
            </Button>
            <Button size="small" type="link" danger onClick={() => { setReject(record); setRejectRemark(""); }}>
              驳回
            </Button>
          </Space>
        ) : null
    }
  ];

  return (
    <>
      <ListPageCard title="资质审核" subtitle="审核机构 / 企业提交的资质材料。">
        <Space style={{ padding: 16 }} wrap>
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 140 }}
            options={STATUS_OPTIONS}
            value={queryState.status}
            onChange={(value) => applyState({ status: value || undefined, page: 1 })}
          />
        </Space>
        <Table<Qualification>
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

      <Modal
        title="驳回资质"
        open={Boolean(reject)}
        onCancel={() => setReject(null)}
        onOk={() => reject && rejectMutation.mutate({ id: reject.id, remark: rejectRemark })}
        confirmLoading={rejectMutation.isPending}
        okText="确认驳回"
        cancelText="取消"
        okButtonProps={{ danger: true }}
      >
        <Typography.Paragraph type="secondary">填写驳回意见（可选）。</Typography.Paragraph>
        <Input.TextArea rows={3} value={rejectRemark} onChange={(event) => setRejectRemark(event.target.value)} placeholder="驳回原因" />
      </Modal>
    </>
  );
}
