import { useEffect, useRef, useState } from "react";
import { App as AntdApp, Alert, Button, Divider, Modal, Form, Input, InputNumber, Select, Space, Tabs, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { copyrightStyleOptions, formatCopyright, ListPageCard, useRequestClient, usePermissions } from "@ky/admin-core";
import { getPlatformProfile, updatePlatformProfile, type PlatformProfile } from "../api";

const logoFontFamilyOptions = [
  { label: "系统无衬线", value: "system" },
  { label: "无衬线", value: "sans" },
  { label: "衬线", value: "serif" },
  { label: "等宽", value: "mono" }
];
const logoFontWeightOptions = [
  { label: "常规 400", value: 400 },
  { label: "中等 500", value: 500 },
  { label: "半粗 600", value: 600 },
  { label: "粗体 700", value: 700 }
];

export function BasicInfoPage() {
  const { message } = AntdApp.useApp();
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const dirty = useRef(false);
  const [revision, setRevision] = useState("");
  const [conflict, setConflict] = useState(false);
  const [form] = Form.useForm<PlatformProfile>();
  const [compactTabs, setCompactTabs] = useState(false);
  const [activeInfoTab, setActiveInfoTab] = useState("brand");

  const holder = Form.useWatch("companyName", form);
  const copyrightStyle = Form.useWatch("copyrightStyle", form);
  const canUpdate = permissions.can("platform.basic_info.update");

  const { data, isFetching } = useQuery({
    queryKey: ["platform-profile"],
    queryFn: () => getPlatformProfile(client)
  });

  useEffect(() => {
    if (data && !dirty.current) { form.setFieldsValue(data); setRevision(data.revision); }
  }, [data, form]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => setCompactTabs(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const saveMutation = useMutation({
    mutationFn: (values: PlatformProfile) => updatePlatformProfile(client, { ...values, revision }),
    onSuccess: (saved) => {
      dirty.current = false; setConflict(false); setRevision(saved.revision); form.setFieldsValue(saved);
      queryClient.setQueryData(["platform-profile"], saved);
      void message.success("基础信息已保存。");
      queryClient.invalidateQueries({ queryKey: ["platform-profile"] });
      // Tell the host to refresh the brand (header title, tab title, login footer).
      window.dispatchEvent(new Event("ky:platform-profile-updated"));
    },
    onError: (error: Error) => { if ((error as Error & {code?: string}).code === "conflict") setConflict(true); void message.error(error.message); }
  });

  const saveButton = canUpdate ? (
    <Form.Item style={{ margin: "16px 0 0" }}>
      <Space>
        <Button type="primary" htmlType="button" loading={saveMutation.isPending} onClick={() => form.submit()}>
          保存
        </Button>
      </Space>
    </Form.Item>
  ) : null;

  const fieldLabels: Record<string, string> = {
    brandLogoTextLong: "长文字 LOGO",
    brandLogoTextShort: "短文字 LOGO",
    companyName: "公司 / 平台主体名称",
    icpRecord: "ICP 备案号"
  };

  return (
    <ListPageCard title="基础信息" subtitle="维护平台品牌信息、公司主体信息与备案展示。">
      <div style={{ padding: 16 }}>
        {conflict && <Alert type="warning" showIcon title="配置已被其他管理员修改，当前输入已保留。" action={<Button onClick={() => Modal.confirm({ title: "加载最新配置？", content: "此操作会替换当前未保存的输入。", onOk: async () => { const result = await queryClient.fetchQuery({ queryKey: ["platform-profile"], queryFn: () => getPlatformProfile(client), staleTime: 0 }); dirty.current = false; setConflict(false); setRevision(result.revision); form.setFieldsValue(result); } })}>加载最新配置</Button>} />}
        <Form<PlatformProfile>
          form={form}
          layout="vertical"
          preserve
          onValuesChange={() => { dirty.current = true; }}
          disabled={isFetching}
          onFinish={(v) => saveMutation.mutate(v)}
          onFinishFailed={({ errorFields }) => {
            const first = errorFields[0];
            if (!first) {
              void message.error("请检查基础信息字段后再保存。");
              return;
            }
            const fieldName = String(first.name[first.name.length - 1]);
            if (fieldName === "companyName" || fieldName === "icpRecord") setActiveInfoTab("subject");
            void form.scrollToField(first.name, { block: "center" });
            const reason = first.errors.join("、") || "值不符合要求";
            void message.error(`${fieldLabels[fieldName] ?? fieldName}：${reason}`);
          }}
        >
          <Tabs
            className="system-settings-tabs"
            activeKey={activeInfoTab}
            onChange={setActiveInfoTab}
            destroyOnHidden={false}
            tabPosition={compactTabs ? "top" : "left"}
            style={{ width: "100%" }}
            tabBarStyle={compactTabs ? undefined : { minWidth: 168 }}
            items={[
              {
                key: "brand",
                label: (
                  <span className="system-settings-dictionary-tab-label">
                    <Typography.Text>品牌信息</Typography.Text>
                    <Typography.Text type="secondary" className="system-settings-dictionary-tab-code">
                      brand_info
                    </Typography.Text>
                  </span>
                ),
                forceRender: true,
                children: (
                  <div style={{ width: "100%", maxWidth: 720, padding: "0 16px" }}>
                    <Form.Item
                      extra="用于导航展开态、登录页主品牌与浏览器标题。为空时使用公司 / 平台主体名称。"
                      label="长文字 LOGO"
                      name="brandLogoTextLong"
                      rules={[{ max: 20, message: "长文字 LOGO 最多 20 个字符" }]}
                    >
                      <Input maxLength={20} placeholder="如 AI 智能 CRM / AiCRM" showCount />
                    </Form.Item>
                    <Typography.Text type="secondary">字体设置仅作用于左上角的 Logo。</Typography.Text>
                    <Space wrap size={12} style={{ width: "100%" }}>
                      <Form.Item label="字体大小" name="longLogoFontSize" rules={[{ required: true, type: "number", min: 8, max: 72, message: "请输入 8—72 的字号" }]}>
                        <InputNumber addonAfter="px" min={8} max={72} precision={0} />
                      </Form.Item>
                      <Form.Item label="字体" name="longLogoFontFamily" rules={[{ required: true, message: "请选择字体" }]}>
                        <Select options={logoFontFamilyOptions} style={{ minWidth: 150 }} />
                      </Form.Item>
                      <Form.Item label="粗细" name="longLogoFontWeight" rules={[{ required: true, message: "请选择字重" }]}>
                        <Select options={logoFontWeightOptions} style={{ minWidth: 130 }} />
                      </Form.Item>
                    </Space>
                    <Form.Item
                      extra="用于导航收起态，建议中文 1-2 个字或英文 2-6 个字符。为空时自动从长文字 LOGO 生成。"
                      label="短文字 LOGO"
                      name="brandLogoTextShort"
                      rules={[{ max: 6, message: "短文字 LOGO 最多 6 个字符" }]}
                    >
                      <Input maxLength={6} placeholder="如 AI / CRM / AiCRM" showCount />
                    </Form.Item>
                    <Typography.Text type="secondary">字体设置仅作用于左上角的 Logo。</Typography.Text>
                    <Space wrap size={12} style={{ width: "100%" }}>
                      <Form.Item label="字体大小" name="shortLogoFontSize" rules={[{ required: true, type: "number", min: 8, max: 72, message: "请输入 8—72 的字号" }]}>
                        <InputNumber addonAfter="px" min={8} max={72} precision={0} />
                      </Form.Item>
                      <Form.Item label="字体" name="shortLogoFontFamily" rules={[{ required: true, message: "请选择字体" }]}>
                        <Select options={logoFontFamilyOptions} style={{ minWidth: 150 }} />
                      </Form.Item>
                      <Form.Item label="粗细" name="shortLogoFontWeight" rules={[{ required: true, message: "请选择字重" }]}>
                        <Select options={logoFontWeightOptions} style={{ minWidth: 130 }} />
                      </Form.Item>
                    </Space>
                    <Divider />
                    {saveButton}
                  </div>
                )
              },
              {
                key: "subject",
                label: (
                  <span className="system-settings-dictionary-tab-label">
                    <Typography.Text>主体信息</Typography.Text>
                    <Typography.Text type="secondary" className="system-settings-dictionary-tab-code">
                      subject_info
                    </Typography.Text>
                  </span>
                ),
                forceRender: true,
                children: (
                  <div style={{ width: "100%", maxWidth: 720, padding: "0 16px" }}>
                    <Form.Item label="公司 / 平台主体名称" name="companyName" rules={[{ max: 120, message: "最多120个字符" }]}>
                      <Input placeholder="如 凯翼科技" />
                    </Form.Item>
                    <Form.Item label="ICP 备案号" name="icpRecord">
                      <Input placeholder="如 京ICP备2026000001号" />
                    </Form.Item>
                    <Form.Item label="版权显示风格" name="copyrightStyle"><Select options={copyrightStyleOptions} /></Form.Item>
                    <Typography.Paragraph type="secondary">预览：{formatCopyright(holder || "平台名称", copyrightStyle || "standard")}</Typography.Paragraph>
                    {data?.updatedAt ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        最后更新:{new Date(data.updatedAt).toLocaleString("zh-CN")}
                      </Typography.Text>
                    ) : null}
                    {saveButton}
                  </div>
                )
              }
            ]}
          />
        </Form>
      </div>
    </ListPageCard>
  );
}
