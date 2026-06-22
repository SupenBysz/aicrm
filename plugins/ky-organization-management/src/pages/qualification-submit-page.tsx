import { useState } from "react";
import { Button, Drawer, Form, Input, Select, Space, Table, Tag, Typography, message } from "antd";
import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
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
import { listMyQualifications, submitQualification, type Qualification, type QualificationSubmitInput } from "../api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  submitted: { label: "审核中", color: "blue" },
  approved: { label: "已通过", color: "green" },
  rejected: { label: "已驳回", color: "red" }
};

export function QualificationSubmitPage() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm<QualificationSubmitInput>();

  const canSubmit = permissions.canAny(["agency.qualification.submit", "enterprise.qualification.submit"]);

  const { data, isFetching } = useQuery({
    queryKey: ["qualifications", "mine", queryState.page, queryState.pageSize, queryState.status],
    queryFn: () => listMyQualifications(client, { page: queryState.page, pageSize: queryState.pageSize, status: queryState.status })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }

  const submitMutation = useMutation({
    mutationFn: (values: QualificationSubmitInput) => submitQualification(client, values),
    onSuccess: () => {
      void message.success("资质已提交，等待平台审核。");
      setDrawerOpen(false);
      queryClient.invalidateQueries({ queryKey: ["qualifications", "mine"] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  const columns: ColumnsType<Qualification> = [
    { title: "资质类型", dataIndex: "qualificationType", key: "qualificationType" },
    { title: "材料", key: "materials", render: (_, record) => (record.materials?.length ? `${record.materials.length} 份` : "—") },
    {
      title: "审核状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (status: string) => {
        const meta = STATUS_META[status] ?? { label: status, color: "default" };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      }
    },
    {
      title: "审核意见",
      dataIndex: "reviewRemark",
      key: "reviewRemark",
      render: (value: string) => value || <Typography.Text type="secondary">—</Typography.Text>
    },
    {
      title: "提交时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => new Date(value).toLocaleString("zh-CN")
    }
  ];

  return (
    <>
      <ListPageCard
        title="资质提交"
        subtitle="提交本组织的资质材料，提交后由平台审核。"
        extra={
          canSubmit ? (
            <Button
              type="primary"
              onClick={() => {
                form.resetFields();
                setDrawerOpen(true);
              }}
            >
              提交资质
            </Button>
          ) : null
        }
      >
        <Table<Qualification>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          style={{ padding: 8 }}
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
        title="提交资质"
        width={drawerWidths.standardForm}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={submitMutation.isPending} onClick={() => form.submit()}>
              提交
            </Button>
          </Space>
        }
      >
        <Form<QualificationSubmitInput> form={form} layout="vertical" onFinish={(values) => submitMutation.mutate(values)}>
          <Form.Item label="资质类型" name="qualificationType" rules={[{ required: true, message: "请输入资质类型" }]}>
            <Input placeholder="如 营业执照 / 行业资质" />
          </Form.Item>
          <Typography.Text type="secondary">材料</Typography.Text>
          <Form.List name="materials">
            {(fields, { add, remove }) => (
              <Space direction="vertical" size={8} style={{ width: "100%", marginTop: 8 }}>
                {fields.map((field) => (
                  <Space key={field.key} align="baseline" style={{ width: "100%" }}>
                    <Form.Item name={[field.name, "name"]} noStyle>
                      <Input placeholder="材料名称" style={{ width: 160 }} />
                    </Form.Item>
                    <Form.Item name={[field.name, "url"]} noStyle>
                      <Input placeholder="材料 URL" style={{ width: 260 }} />
                    </Form.Item>
                    <MinusCircleOutlined onClick={() => remove(field.name)} />
                  </Space>
                ))}
                <Button type="dashed" icon={<PlusOutlined />} onClick={() => add()}>
                  添加材料
                </Button>
              </Space>
            )}
          </Form.List>
        </Form>
      </Drawer>
    </>
  );
}
