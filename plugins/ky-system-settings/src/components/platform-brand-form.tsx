import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Button, Form, Input, Switch, Typography, Upload, message } from "antd";
import { BrandLogoLockup, generatedBrandImage, themeVariables, useAppearance, useRequestClient, type RequestClient } from "@ky/admin-core";
import type { PlatformProfile } from "../api";
import "../../../../packages/ky-admin-core/src/brand-form.css";
const assetPath = "/api/v1/platform/platform-profile/assets";
export async function preparePlatformBrand(client: RequestClient, values: PlatformProfile, before?: PlatformProfile) {
 values = {...values,brand:values.brand?{...values.brand}:undefined};
 const brand = values.brand;
 if (!brand) return values;
 for (const kind of ["icon", "wordmark", "wordmarkDark"] as const) {
  const id = `${kind}Id` as const;
  const generated = `${kind}Generated` as const;
  const text = kind === "icon" ? brand.iconText?.trim() || brand.name : brand.name;
  const oldText = kind === "icon" ? before?.brand?.iconText?.trim() || before?.brand?.name : before?.brand?.name;
  if (!brand[id] || (brand[generated] && text !== oldText)) {
   const png = generatedBrandImage(text, kind === "icon" ? "icon" : "wordmark", kind === "wordmarkDark");
   const saved = await client.request<{id:string}>(assetPath,{method:"POST",body:{kind:kind === "icon" ? "icon" : "wordmark",pngBase64:png.split(",")[1]}});
   brand[id] = saved.id; brand[generated] = true;
   if (kind === "icon") brand.iconGeneratorVersion = 1; else if(kind === "wordmarkDark") brand.wordmarkDarkGeneratorVersion = 1; else brand.wordmarkGeneratorVersion = 1;
  }
 }
 // Maintain old clients' text fields without coupling brand and legal subject names.
 return {...values, brandLogoTextLong:brand.name, brandLogoTextShort:brand.iconText || values.brandLogoTextShort};
}
export function platformBrandFormValues(p:PlatformProfile):PlatformProfile {
 return {...p,brand:{ ...p.brand, name:p.brand?.name || p.brandLogoTextLong || p.companyName || "KyCRM",
 applicationName:p.brand?.applicationName || p.brand?.name || p.brandLogoTextLong || p.companyName || "KyCRM",
 iconText:p.brand?.iconText || p.brandLogoTextShort || "", iconId:p.brand?.iconId || "",wordmarkId:p.brand?.wordmarkId || "",wordmarkDarkId:p.brand?.wordmarkDarkId || "",
 showAiIcon:p.brand?.showAiIcon === true,copyrightHolder:p.brand?.copyrightHolder || "",
 // Missing fields in old JSON must not overwrite compatibility defaults.
 }};
}
export function PlatformBrandForm({form,disabled,onBusyChange,onDirty}:{form:ReturnType<typeof Form.useForm<PlatformProfile>>[0];disabled:boolean;onBusyChange:(busy:boolean)=>void;onDirty:()=>void}) {
 const client=useRequestClient();
 const {themeId}=useAppearance();
 const brand=Form.useWatch("brand",form);
 const [previews,setPreviews]=useState<Record<string,string>>({});
 const name=brand?.name || "KyCRM", iconText=brand?.iconText || name;
 const generated=useMemo(()=>({icon:generatedBrandImage(iconText,"icon"),wordmark:generatedBrandImage(name,"wordmark"),wordmarkDark:generatedBrandImage(name,"wordmark",true)}),[iconText,name]);
 useEffect(()=>{let active=true;for(const id of [brand?.iconId,brand?.wordmarkId,brand?.wordmarkDarkId]){if(!id)continue;void client.request<{pngBase64:string}>(assetPath+"/"+encodeURIComponent(id)).then(v=>{if(active)setPreviews(old=>({...old,[id]:"data:image/png;base64,"+v.pngBase64}));}).catch(()=>{});}return()=>{active=false}},[client,brand?.iconId,brand?.wordmarkId,brand?.wordmarkDarkId]);
 async function upload(file:File,kind:"icon"|"wordmark"|"wordmarkDark") {
  if(file.type!=="image/png" || file.size>4*1024*1024){void message.error("请选择4MB以内的PNG图片");return}
  onBusyChange(true);
  try {
   const bytes=new Uint8Array(await file.arrayBuffer());let raw="";for(const b of bytes)raw+=String.fromCharCode(b);
   const pngBase64=btoa(raw), saved=await client.request<{id:string}>(assetPath,{method:"POST",body:{kind:kind === "icon" ? "icon" : "wordmark",pngBase64}});
   const id=`${kind}Id` as const, flag=`${kind}Generated` as const;
   form.setFieldValue(["brand",id],saved.id);form.setFieldValue(["brand",flag],false);
   setPreviews(old=>({...old,[saved.id]:"data:image/png;base64,"+pngBase64}));
   void message.success("图片已上传，保存后生效");
  }catch(e){void message.error(e instanceof Error?e.message:"上传失败")}finally{onBusyChange(false)}
 }
 const image=(kind:"icon"|"wordmark"|"wordmarkDark")=>{
  const id=brand?.[`${kind}Id`];
  const auto=brand?.[`${kind}Generated`];
  return !id||auto?generated[kind]:previews[id];
 };
 return <>
  <Form.Item name={["brand","name"]} label="品牌名称" rules={[{required:true,whitespace:true,message:"请输入品牌名称"},{max:40}]}><Input maxLength={40}/></Form.Item>
  <Form.Item name={["brand","applicationName"]} label="应用显示名称" rules={[{required:true,whitespace:true,message:"请输入应用显示名称"},{max:80}]}><Input maxLength={80}/></Form.Item>
  <Form.Item name={["brand","iconText"]} label="图标文字（可选）" extra="用于自动生成应用图标和导航收起态；留空使用品牌名称。" rules={[{max:8}]}><Input maxLength={8}/></Form.Item>
  {["iconId","wordmarkId","wordmarkDarkId","wordmarkDarkGenerated","wordmarkDarkGeneratorVersion","iconGenerated","wordmarkGenerated","iconGeneratorVersion","wordmarkGeneratorVersion"].map(f=><Form.Item key={f} name={["brand",f]} hidden><Input/></Form.Item>)}
  <div className="agency-brand-uploads">{(["icon","wordmark","wordmarkDark"] as const).map(kind=>{
   const id=`${kind}Id` as const,flag=`${kind}Generated` as const;
   return <section className="agency-brand-upload" key={kind}>
    <div className={`agency-brand-upload-image ${kind}`}><img src={image(kind)} alt={kind==="icon"?"应用图标预览":"文字 LOGO预览"}/></div>
    <div className="agency-brand-upload-info"><Typography.Text strong>{kind==="icon"?"应用图标":kind==="wordmarkDark"?"文字 LOGO（暗色）":"文字 LOGO（亮色）"}</Typography.Text>
     <Typography.Text type="secondary">{kind==="icon"?"正方形 PNG，用于应用品牌图标":"透明 PNG，仅包含品牌文字，AI 后缀由开关控制"} · 不超过4MB</Typography.Text>
     <Upload accept="image/png" showUploadList={false} disabled={disabled} beforeUpload={file=>{void upload(file,kind);return false}}><Button disabled={disabled}>{brand?.[id]?"更换图片":"上传图片"}</Button></Upload>
     {brand?.[id]&&<Button disabled={disabled} danger type="text" onClick={()=>{form.setFieldValue(["brand",id],"");form.setFieldValue(["brand",flag],false);onDirty()}}>删除</Button>}
    </div>
   </section>
  })}</div>
  <Form.Item name={["brand","showAiIcon"]} label="显示 AI 图标" valuePropName="checked"><Switch checkedChildren="显示" unCheckedChildren="隐藏"/></Form.Item>
  <section className="agency-brand-previews"><Typography.Text strong>应用 LOGO 预览</Typography.Text>
   <Typography.Paragraph type="secondary">按后台顶部实际尺寸展示；窄屏可横向查看完整效果。</Typography.Paragraph>
   {[false,true].map(dark=><div key={String(dark)} className={`agency-brand-preview ${dark?"dark":"light"}`} style={themeVariables(themeId,dark) as CSSProperties}><span className="agency-brand-preview-label">{dark?"深色背景":"浅色背景"}</span><div className="agency-brand-preview-scroll"><div className="agency-brand-preview-header">
    <BrandLogoLockup compactInset={6} className="agency-brand-lockup" showAIIcon={brand?.showAiIcon===true}><img className="agency-brand-wordmark" src={image(dark?"wordmarkDark":"wordmark")} alt="品牌文字"/></BrandLogoLockup>
    <div className="agency-brand-preview-modes" aria-label="顶部导航位置参考"><span>工作台</span><span>管理中心</span></div>
   </div></div></div>)}
  </section>
 </>;
}
