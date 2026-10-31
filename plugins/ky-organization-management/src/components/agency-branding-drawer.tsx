import "./organization-drawers.css";
import "./agency-branding-drawer.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Space,
  Typography,
  Upload,
  Select,
  Switch,
  message,
} from "antd";
import {
  BrandLogoLockup,
  BrandIcon,
  generatedBrandImage,
  BrandNavigationPreview,
  useAppearance,
  copyrightStyleOptions,
  formatCopyright,
  type CopyrightStyle,
  drawerWidths,
  usePermissions,
  useRequestClient,
} from "@ky/admin-core";
// Interaction structure and image generation ported from the source product.
interface Draft {
 navIconId?:string;navIconGenerated?:boolean;
 iconDarkId?:string;
 iconDarkGenerated?:boolean;
  showAiIcon?: boolean;
  iconGeneratorVersion?: number;
  wordmarkGeneratorVersion?: number;
  iconText?: string;
  copyrightHolder?: string;
  copyrightStyle?: CopyrightStyle | "";
  name: string;
  applicationName: string;
  iconId: string;
  wordmarkId: string;
  wordmarkDarkId?: string;
  wordmarkDarkGenerated?: boolean;
  wordmarkDarkGeneratorVersion?: number;
  iconGenerated?: boolean;
  wordmarkGenerated?: boolean;
}
interface Branding {
  agencyId: string;
  revision: number;
  publishedVersion: number;
  draft: Draft;
  published?: { name: string; applicationName: string };
}
// Draft assets remain authenticated. The source UI uses the public asset URL,
// which cannot be reused for unpublished material in the target contract.
function BrandAssetPreview({
  path,
  assetId,
  className,
  alt,
}: {
  path: string;
  assetId: string;
  className: string;
  alt: string;
}) {
  const client = useRequestClient(),
    key = path + "/assets/" + encodeURIComponent(assetId);
  const [result, setResult] = useState<{
      key: string;
      src?: string;
      error?: boolean;
    }>(),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void client
      .request<{ pngBase64: string }>(key)
      .then((v) => {
        if (active)
          setResult({ key, src: "data:image/png;base64," + v.pngBase64 });
      })
      .catch(() => {
        if (active) setResult({ key, error: true });
      });
    return () => {
      active = false;
    };
  }, [client, key, retry]);
  if (result?.key !== key) return <span role="status">加载预览…</span>;
  if (result.error)
    return (
      <Button
        type="text"
        size="small"
        onClick={() => {
          setResult(undefined);
          setRetry((x) => x + 1);
        }}
      >
        重试预览
      </Button>
    );
  return (
    <img
      className={className}
      src={result.src}
      alt={alt}
      onError={() => setResult({ key, error: true })}
    />
  );
}

export function AgencyBrandingDrawer({
  agency,
  onClose,
}: {
  agency: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const { themeId } = useAppearance();
  const client = useRequestClient(),
    permissions = usePermissions(),
    [form] = Form.useForm<Draft>();
  Form.useWatch("navIconId",form);
  Form.useWatch("navIconGenerated",form);
  Form.useWatch("iconDarkId",form);
  Form.useWatch("iconDarkGenerated",form);
  const [data, setData] = useState<Branding | null>(null),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [rollback, setRollback] = useState<number | null>(null),
    [loadError, setLoadError] = useState(""),
    [retry, setRetry] = useState(0);
  const canEdit = permissions.can("platform.agency_branding.update"),
    canPublish = permissions.can("platform.agency_branding.publish");
  const path = agency
    ? `/api/v1/platform/agencies/${encodeURIComponent(agency.id)}/branding`
    : "";
  const scope = useRef(path),
    generation = useRef(0);
  scope.current = path;
  useLayoutEffect(() => {
    let active = true;
    ++generation.current;
    setData(null);
    setLoadError("");
    setBusy(false);
    setDirty(false);
    setRollback(null);
    form.resetFields();
    if (!agency) return;
    void client
      .request<Branding>(path)
      .then((v) => {
        if (active) {
          setData(v);
          form.setFieldsValue({ ...v.draft, showAiIcon: v.draft.showAiIcon === true });
        }
      })
      .catch((e: Error) => {
        if (active) setLoadError(e.message);
      });
    return () => {
      active = false;
      ++generation.current;
    };
  }, [agency?.id, client, form, path, retry]);
  async function action(kind: "save" | "publish" | "rollback") {
    if (!data || busy) return;
    const epoch = generation.current;
    const current = () =>
      scope.current === path && generation.current === epoch;
    setBusy(true);
    try {
      if (kind === "save") {
        const draft = await form.validateFields();
        if(!draft.iconId || (draft.iconGenerated && (draft.iconText||draft.name)!==(data.draft.iconText||data.draft.name))) {
         const png=generatedBrandImage(draft.iconText||draft.name,"icon");
         const asset=await client.request<{id:string}>(path+"/assets",{method:"POST",body:{kind:"icon",pngBase64:png.split(",")[1]}});
         draft.iconId=asset.id;draft.iconGenerated=true;draft.iconGeneratorVersion=1;
        }
        if (!current()) return;
        await client.request(path + "/draft", {
          method: "POST",
          body: { draft, expectedRevision: data.revision },
        });
      } else {
        if (dirty) throw Error("请先保存草稿，再发布或回滚");
        if (kind === "rollback" && !rollback) throw Error("请输入历史品牌版本");
        await client.request(path + "/publish", {
          method: "POST",
          body: {
            expectedRevision: data.revision,
            rollbackVersion: kind === "rollback" ? rollback : 0,
          },
        });
      }
      const next = await client.request<Branding>(path);
      if (!current()) return;
      setData(next);
      form.setFieldsValue({ ...next.draft, showAiIcon: next.draft.showAiIcon === true });
      setDirty(false);
      if (kind !== "save")
        window.dispatchEvent(new Event("ky:agency-branding-updated"));
      void message.success(
        kind === "save" ? "草稿已保存" : "品牌已发布，客户端将在刷新后同步",
      );
    } catch (e) {
      if (!current()) return;
      const fields = (e as { errorFields?: { errors: string[] }[] })
        ?.errorFields;
      if (fields?.length) {
        void message.error(fields[0].errors[0] || "请完善品牌信息");
      } else {
        void message.error(e instanceof Error ? e.message : "品牌操作失败");
      }
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function upload(file: File | undefined, kind: "icon" | "navIcon" | "iconDark" | "wordmark" | "wordmarkDark") {
    if (!file || !data || busy) return;
    if (file.type !== "image/png" || file.size > 4 * 1024 * 1024) {
      void message.error("请选择4MB以内的PNG图片");
      return;
    }
    const epoch = generation.current;
    const current = () =>
      scope.current === path && generation.current === epoch;
    setBusy(true);
    try {
      const bytes = await file.arrayBuffer();
      let binary = "";
      for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
      const asset = await client.request<{ id: string }>(path + "/assets", {
        method: "POST",
        body: { kind: (kind==="navIcon"||kind.startsWith("icon")) ? "icon" : "wordmark", pngBase64: btoa(binary) },
      });
      if (!current()) return;
      form.setFieldValue(`${kind}Id` as const, asset.id);
      form.setFieldValue(
        `${kind}Generated` as const,
        false,
      );
      setDirty(true);
      void message.success("图片已上传，请保存草稿");
    } catch (e) {
      if (current())
        void message.error(e instanceof Error ? e.message : "上传失败");
    } finally {
      if (current()) setBusy(false);
    }
  }
  const showAiIcon = Form.useWatch("showAiIcon", form);
  const iconText = Form.useWatch("iconText", form),
    copyrightHolder = Form.useWatch("copyrightHolder", form),
    copyrightStyle = Form.useWatch("copyrightStyle", form);
  const [official, setOfficial] = useState({
    name: "KyCRM",
    copyrightHolder: "",
    copyrightStyle: "standard" as CopyrightStyle,
  });
  useEffect(() => {
    let active = true;
    void client
      .request<{
        companyName: string;
        brandLogoTextLong: string;
        copyrightStyle: CopyrightStyle;
      }>("/api/v1/public/platform-profile")
      .then((p) => {
        if (active)
          setOfficial({
            name: p.brandLogoTextLong || p.companyName || "KyCRM",
            copyrightHolder: p.companyName || p.brandLogoTextLong || "KyCRM",
            copyrightStyle: p.copyrightStyle || "standard",
          });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client]);
  const name = Form.useWatch("name", form),
    iconId = Form.useWatch("iconId", form),
    wordmarkId = Form.useWatch("wordmarkId", form),
    wordmarkDarkId = Form.useWatch("wordmarkDarkId", form),
    wordmarkDarkGenerated = Form.useWatch("wordmarkDarkGenerated", form),
    iconGenerated = Form.useWatch("iconGenerated", form),
    wordmarkGenerated = Form.useWatch("wordmarkGenerated", form);
  return (
    <Drawer
      rootClassName="organization-contribution-drawer"
      open={Boolean(agency)}
      title={`机构品牌 · ${agency?.name ?? ""}`}
      width={drawerWidths.standardForm}
      onClose={onClose}
      extra={
        <Space>
          {canEdit && (
            <Button
              disabled={!data || busy}
              onClick={() => void action("save")}
            >
              保存草稿
            </Button>
          )}
          {canPublish && (
            <Button
              disabled={!data || !rollback || busy || dirty}
              onClick={() => void action("rollback")}
            >
              回滚并发布
            </Button>
          )}
          {canPublish && (
            <Button
              type="primary"
              disabled={!data || busy || dirty}
              onClick={() => void action("publish")}
            >
              发布
            </Button>
          )}
        </Space>
      }
    >
      {loadError && (
        <Alert
          type="error"
          title={loadError}
          action={<Button onClick={() => setRetry((x) => x + 1)}>重试</Button>}
        />
      )}
      <Alert type="info" message="品牌仅平台可修改，旗下企业及成员自动继承。" />
      <Typography.Paragraph style={{ marginTop: 16 }}>
        已发布版本：{data?.publishedVersion || "未发布（使用平台品牌）"}
        {dirty ? " · 有未保存修改" : ""}
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        disabled={!data || !canEdit || busy}
        onValuesChange={() => setDirty(true)}
      >
        <Form.Item
          name="name"
          label="品牌名称"
          rules={[
            { required: true, whitespace: true, message: "请输入品牌名称" },
            { max: 40, message: "品牌名称不能超过40个字" },
          ]}
        >
          <Input placeholder="例如：品牌名称" />
        </Form.Item>
        <Form.Item
          name="applicationName"
          label="应用显示名称"
          rules={[
            { required: true, whitespace: true, message: "请输入应用显示名称" },
            { max: 80, message: "应用显示名称不能超过80个字" },
          ]}
        >
          <Input placeholder="例如：品牌应用" />
        </Form.Item>
        <Form.Item name="iconId" hidden>
          <Input />
        </Form.Item>
        {["navIconId","navIconGenerated","iconDarkId","iconDarkGenerated","wordmarkDarkId","wordmarkDarkGenerated","wordmarkDarkGeneratorVersion"].map(field=><Form.Item key={field} name={field} hidden><Input/></Form.Item>)}
        <Form.Item name="wordmarkId" hidden>
          <Input />
        </Form.Item>
        <Form.Item name="iconGeneratorVersion" hidden>
          <InputNumber />
        </Form.Item>
        <Form.Item name="wordmarkGeneratorVersion" hidden>
          <InputNumber />
        </Form.Item>
        <Form.Item name="iconGenerated" hidden>
          <Input />
        </Form.Item>
        <Form.Item name="wordmarkGenerated" hidden>
          <Input />
        </Form.Item>
        <Form.Item
          name="iconText"
          label="图标文字（可选）"
          extra="未上传收起 LOGO 时显示，建议1–4个字符；留空使用品牌名称前两个字。上传图片优先，恢复默认后显示文字。"
          rules={[
            {
              validator: (_, v) =>
                Array.from(v || "").length <= 8
                  ? Promise.resolve()
                  : Promise.reject(new Error("图标文字最多8个字符")),
            },
          ]}
        >
          <Input placeholder="例如：Ky" />
        </Form.Item>
        <Typography.Paragraph type="secondary">
          图片为可选项；应用图标按图标文字生成，文字LOGO按品牌名称生成。
        </Typography.Paragraph>
        <section className="agency-brand-upload" style={{marginBottom:24}}>
         <div className="agency-brand-upload-image icon">{iconId&&!iconGenerated?<BrandAssetPreview path={path} assetId={iconId} className="" alt="客户端桌面 LOGO"/>:<img src={generatedBrandImage(iconText||name||"品牌","icon")} alt="默认客户端桌面 LOGO"/>}</div>
         <div className="agency-brand-upload-info"><Typography.Text strong>客户端桌面 LOGO</Typography.Text><Typography.Text type="secondary">供客户端打包时选用，用于桌面快捷方式、应用启动器及 Dock／任务栏。正方形 PNG，不超过4MB；不会直接修改已安装客户端图标。</Typography.Text>
         <Upload accept="image/png" showUploadList={false} disabled={!data||!canEdit||busy} beforeUpload={file=>{void upload(file,"icon");return false}}><Button disabled={!data||!canEdit||busy}>{iconId?"更换桌面 LOGO":"上传桌面 LOGO"}</Button></Upload>
         {iconId&&<Button disabled={!data||!canEdit||busy} onClick={()=>{form.setFieldValue("iconId","");form.setFieldValue("iconGenerated",true);setDirty(true)}}>恢复默认桌面图标</Button>}</div>
        </section>
        <Form.Item name="showAiIcon" label="显示 AI 图标" valuePropName="checked" initialValue={false} extra="在品牌文字右侧显示 AI 图标；保存草稿并发布后生效。">
          <Switch checkedChildren="显示" unCheckedChildren="隐藏" />
        </Form.Item>
        <Typography.Title level={5}>版权信息</Typography.Title>
        <Form.Item
          name="copyrightHolder"
          label="版权署名（可选）"
          extra={`留空使用平台版权署名：${official.copyrightHolder}`}
          rules={[
            {
              validator: (_, v) =>
                v?.includes("©")
                  ? Promise.reject(
                      new Error("只需填写版权主体名称，不含©或年份"),
                    )
                  : Promise.resolve(),
            },
            {
              validator: (_, v) =>
                Array.from(v || "").length <= 120
                  ? Promise.resolve()
                  : Promise.reject(new Error("版权署名最多120个字符")),
            },
          ]}
        >
          <Input placeholder="填写主体名称，不含©或年份" />
        </Form.Item>
        <Form.Item name="copyrightStyle" label="版权显示风格" initialValue="">
          <Select
            options={[
              {
                value: "",
                label: `跟随平台（${copyrightStyleOptions.find((o) => o.value === official.copyrightStyle)?.label}）`,
              },
              ...copyrightStyleOptions,
            ]}
          />
        </Form.Item>
        <Typography.Paragraph type="secondary">
          预览，发布后生效：
          {formatCopyright(
            copyrightHolder?.trim() || official.copyrightHolder,
            copyrightStyle || official.copyrightStyle,
          )}
        </Typography.Paragraph>
      </Form>
      <Typography.Text strong>应用 LOGO 预览</Typography.Text>
      <Typography.Paragraph type="secondary">展开使用横向文字 LOGO，收起使用独立图标或文字；窄屏可横向查看实际导航尺寸。展开素材为横向透明 PNG，收起素材建议正方形 PNG，均不超过4MB。</Typography.Paragraph>
      <BrandNavigationPreview themeId={themeId} actions={(dark,collapsed)=>{
        const kind=collapsed?(dark?"iconDark":"navIcon"):(dark?"wordmarkDark":"wordmark"),id=form.getFieldValue(`${kind}Id`),custom=id&&!form.getFieldValue(`${kind}Generated`);
        return <><Upload accept="image/png" showUploadList={false} disabled={!data||!canEdit||busy} beforeUpload={file=>{void upload(file,kind);return false}}><Button disabled={!data||!canEdit||busy} loading={busy}>{custom?"更换 LOGO":"上传 LOGO"}</Button></Upload>
        {custom&&<Button disabled={!data||!canEdit||busy} onClick={()=>{form.setFieldValue(`${kind}Id`,"");form.setFieldValue(`${kind}Generated`,true);setDirty(true)}}>恢复默认</Button>}</>;
      }} renderLogo={(dark,collapsed)=>{
        const kind=collapsed?(dark?"iconDark":"navIcon"):(dark?"wordmarkDark":"wordmark"),id=form.getFieldValue(`${kind}Id`),auto=form.getFieldValue(`${kind}Generated`);
        const text=collapsed?(iconText||Array.from(name||"品牌").slice(0,2).join("")):(name||"品牌");
        if(collapsed)return id&&!auto?<span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:48,height:48}}><BrandAssetPreview path={path} assetId={id} className="brand-preview-app-icon" alt="应用图标"/></span>:<BrandIcon brand={{name:name||"品牌",iconText:text}} dark={dark}/>;
        return <BrandLogoLockup fitText maxHeight={40} className="agency-brand-lockup" showAIIcon={showAiIcon===true}>
          {id&&!auto?<BrandAssetPreview path={path} assetId={id} className={collapsed?"brand-preview-app-icon":"agency-brand-wordmark"} alt={collapsed?"应用图标":"品牌文字"}/>:<span>{text}</span>}
        </BrandLogoLockup>;
      }}/>
      {canPublish && (
        <Space style={{ marginTop: 24 }}>
          <InputNumber
            min={1}
            max={data?.publishedVersion}
            value={rollback}
            onChange={setRollback}
            placeholder="历史版本"
          />
          <Typography.Text type="secondary">
            选择历史版本后，使用顶部“回滚并发布”
          </Typography.Text>
        </Space>
      )}
    </Drawer>
  );
}
