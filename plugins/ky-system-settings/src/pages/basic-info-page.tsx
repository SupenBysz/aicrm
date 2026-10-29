import { PlatformBrandForm, preparePlatformBrand, platformBrandFormValues } from "../components/platform-brand-form";
import { useEffect, useRef, useState } from "react";
import { App as AntdApp, Alert, Button, Divider, Modal, Form, Input, Space, Tabs, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPageCard, useRequestClient, usePermissions } from "@ky/admin-core";
import { getPlatformProfile, updatePlatformProfile, type PlatformProfile } from "../api";

export function BasicInfoPage() {
  const { message } = AntdApp.useApp();
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const dirty = useRef(false);
  const [revision, setRevision] = useState("");
  const [conflict, setConflict] = useState(false);
 const [uploadBusy,setUploadBusy]=useState(false);
  const [form] = Form.useForm<PlatformProfile>();
  const [compactTabs, setCompactTabs] = useState(false);
  const [activeInfoTab, setActiveInfoTab] = useState("brand");

  const canUpdate = permissions.can("platform.basic_info.update");

  const { data, isFetching } = useQuery({
    queryKey: ["platform-profile"],
    queryFn: () => getPlatformProfile(client)
  });

  useEffect(() => {
    if (data && !dirty.current) { form.setFieldsValue(platformBrandFormValues(data)); setRevision(data.revision); }
  }, [data, form]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => setCompactTabs(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const saveMutation = useMutation({
    mutationFn: async (values: PlatformProfile) => updatePlatformProfile(client, { ...await preparePlatformBrand(client, values, data), revision }),
    onSuccess: (saved) => {
      dirty.current = false; setConflict(false); setRevision(saved.revision); form.setFieldsValue(platformBrandFormValues(saved));
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
        <Button type="primary" htmlType="button" loading={saveMutation.isPending} disabled={uploadBusy} onClick={() => form.submit()}>
          保存
        </Button>
      </Space>
    </Form.Item>
  ) : null;

  const fieldLabels: Record<string, string> = {
    name: "品牌名称",
    applicationName: "应用显示名称",
    iconText: "图标文字",
    copyrightHolder: "版权署名",
    brandLogoTextLong: "长文字 LOGO",
    brandLogoTextShort: "短文字 LOGO",
    companyName: "公司 / 平台主体名称",
    icpRecord: "ICP 备案号"
  };

  return (
    <ListPageCard title="基础信息" subtitle="维护平台品牌信息、公司主体信息与备案展示。">
      <div style={{ padding: 16 }}>
        {conflict && <Alert type="warning" showIcon title="配置已被其他管理员修改，当前输入已保留。" action={<Button onClick={() => Modal.confirm({ title: "加载最新配置？", content: "此操作会替换当前未保存的输入。", onOk: async () => { const result = await queryClient.fetchQuery({ queryKey: ["platform-profile"], queryFn: () => getPlatformProfile(client), staleTime: 0 }); dirty.current = false; setConflict(false); setRevision(result.revision); form.setFieldsValue(platformBrandFormValues(result)); } })}>加载最新配置</Button>} />}
        <Form<PlatformProfile>
          form={form}
          layout="vertical"
          preserve
          onValuesChange={() => { dirty.current = true; }}
          disabled={!canUpdate || isFetching || saveMutation.isPending || uploadBusy}
          onFinish={(v) => { if (!saveMutation.isPending) saveMutation.mutate(v); }}
          onFinishFailed={({ errorFields }) => {
            const first = errorFields[0];
            if (!first) {
              void message.error("请检查基础信息字段后再保存。");
              return;
            }
            const fieldName = String(first.name[first.name.length - 1]);
            if (fieldName === "companyName" || fieldName === "icpRecord") setActiveInfoTab("subject"); else setActiveInfoTab("brand");
            void form.scrollToField(first.name, { block: "center" });
            const reason = first.errors.join("、") || "值不符合要求";
            void message.error(`${fieldLabels[fieldName] ?? fieldName}：${reason}`);
          }}
        >
          {["longLogoFontSize","longLogoFontFamily","longLogoFontWeight","shortLogoFontSize","shortLogoFontFamily","shortLogoFontWeight","brandLogoTextLong","brandLogoTextShort"].map(field=><Form.Item name={field} key={field} hidden><Input/></Form.Item>)}
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

                  </span>
                ),
                forceRender: true,
                children: (
                  <div style={{ width: "100%", maxWidth: 720, padding: "0 16px" }}>
                    <PlatformBrandForm onDirty={()=>{dirty.current=true}} form={form} disabled={!canUpdate || isFetching || saveMutation.isPending || uploadBusy} onBusyChange={busy=>{setUploadBusy(busy);if(!busy)dirty.current=true}} />
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
