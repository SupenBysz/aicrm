import { useEffect, useState } from "react";
import { Button, Form, Input, Switch, Typography, Upload, message } from "antd";
import { BrandLogo, BrandIcon, BrandNavigationPreview, generatedBrandImage, useAppearance, useRequestClient, type RequestClient } from "@ky/admin-core";
import type { PlatformProfile } from "../api";
import "../../../../packages/ky-admin-core/src/brand-form.css";
const assetPath = "/api/v1/platform/platform-profile/assets";
export async function preparePlatformBrand(client: RequestClient, values: PlatformProfile, before?: PlatformProfile) {
 values = {...values,brand:values.brand?{...values.brand}:undefined};
 const brand = values.brand;
 if (!brand) return values;
 if(!brand.iconId || (brand.iconGenerated && (brand.iconText||brand.name)!==(before?.brand?.iconText||before?.brand?.name))) {
  const png=generatedBrandImage(brand.iconText||brand.name,"icon");
  const asset=await client.request<{id:string}>(assetPath,{method:"POST",body:{kind:"icon",pngBase64:png.split(",")[1]}});
  brand.iconId=asset.id;brand.iconGenerated=true;brand.iconGeneratorVersion=1;
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
 const name=brand?.name || "KyCRM", iconText=brand?.iconText || Array.from(name).slice(0,2).join("");
 useEffect(()=>{let active=true;for(const id of [brand?.iconId,brand?.navIconId,brand?.iconDarkId,brand?.wordmarkId,brand?.wordmarkDarkId]){if(!id)continue;void client.request<{pngBase64:string}>(assetPath+"/"+encodeURIComponent(id)).then(v=>{if(active)setPreviews(old=>({...old,[id]:"data:image/png;base64,"+v.pngBase64}));}).catch(()=>{});}return()=>{active=false}},[client,brand?.iconId,brand?.navIconId,brand?.iconDarkId,brand?.wordmarkId,brand?.wordmarkDarkId]);
 async function upload(file:File,kind:"icon"|"navIcon"|"iconDark"|"wordmark"|"wordmarkDark") {
  if(file.type!=="image/png" || file.size>4*1024*1024){void message.error("请选择4MB以内的PNG图片");return}
  onBusyChange(true);
  try {
   const bytes=new Uint8Array(await file.arrayBuffer());let raw="";for(const b of bytes)raw+=String.fromCharCode(b);
   const pngBase64=btoa(raw), saved=await client.request<{id:string}>(assetPath,{method:"POST",body:{kind:(kind==="navIcon"||kind.startsWith("icon")) ? "icon" : "wordmark",pngBase64}});
   const id=`${kind}Id` as const, flag=`${kind}Generated` as const;
   form.setFieldValue(["brand",id],saved.id);form.setFieldValue(["brand",flag],false);
   setPreviews(old=>({...old,[saved.id]:"data:image/png;base64,"+pngBase64}));
   onDirty();
   void message.success("图片已上传，保存后生效");
  }catch(e){void message.error(e instanceof Error?e.message:"上传失败")}finally{onBusyChange(false)}
 }
 return <>
  <Form.Item name={["brand","name"]} label="品牌名称" rules={[{required:true,whitespace:true,message:"请输入品牌名称"},{max:40}]}><Input maxLength={40}/></Form.Item>
  <Form.Item name={["brand","applicationName"]} label="应用显示名称" rules={[{required:true,whitespace:true,message:"请输入应用显示名称"},{max:80}]}><Input maxLength={80}/></Form.Item>
  <Form.Item name={["brand","iconText"]} label="图标文字（可选）" extra="未上传收起 LOGO 时显示；留空使用品牌名称前两个字。" rules={[{max:8}]}><Input maxLength={8}/></Form.Item>
  {["navIconId","navIconGenerated","iconDarkId","iconDarkGenerated","iconId","wordmarkId","wordmarkDarkId","wordmarkDarkGenerated","wordmarkDarkGeneratorVersion","iconGenerated","wordmarkGenerated","iconGeneratorVersion","wordmarkGeneratorVersion"].map(f=><Form.Item key={f} name={["brand",f]} hidden><Input/></Form.Item>)}
  <section className="agency-brand-upload" style={{marginBottom:24}}>
   <div className="agency-brand-upload-image icon"><img src={brand?.iconId&&!brand.iconGenerated?previews[brand.iconId]:generatedBrandImage(iconText,"icon")} alt="客户端桌面 LOGO"/></div>
   <div className="agency-brand-upload-info"><Typography.Text strong>客户端桌面 LOGO</Typography.Text><Typography.Text type="secondary">供客户端打包时选用，用于桌面快捷方式、应用启动器及 Dock／任务栏。正方形 PNG，不超过4MB；不会直接修改已安装客户端图标。</Typography.Text>
   <Upload accept="image/png" showUploadList={false} disabled={disabled} beforeUpload={file=>{void upload(file,"icon");return false}}><Button disabled={disabled}>{brand?.iconId?"更换桌面 LOGO":"上传桌面 LOGO"}</Button></Upload>
   {brand?.iconId&&<Button disabled={disabled} onClick={()=>{form.setFieldValue(["brand","iconId"],"");form.setFieldValue(["brand","iconGenerated"],false);onDirty()}}>恢复默认桌面图标</Button>}</div>
  </section>
  <Form.Item name={["brand","showAiIcon"]} label="显示 AI 图标" valuePropName="checked"><Switch checkedChildren="显示" unCheckedChildren="隐藏"/></Form.Item>
  <Typography.Text strong>应用 LOGO 预览</Typography.Text>
  <Typography.Paragraph type="secondary">展开使用横向文字 LOGO，收起使用独立图标或文字。按实际导航尺寸展示，窄屏可横向查看。展开素材为横向透明 PNG，收起素材建议正方形 PNG，均不超过4MB。</Typography.Paragraph>
  <BrandNavigationPreview themeId={themeId} actions={(dark,collapsed)=>{
   const kind=collapsed?(dark?"iconDark":"navIcon"):(dark?"wordmarkDark":"wordmark"),id=`${kind}Id` as const,flag=`${kind}Generated` as const;
   return <><Upload accept="image/png" showUploadList={false} disabled={disabled} beforeUpload={file=>{void upload(file,kind);return false}}><Button disabled={disabled}>{brand?.[id]&&!brand?.[flag]?"更换 LOGO":"上传 LOGO"}</Button></Upload>
    {brand?.[id]&&!brand?.[flag]&&<Button disabled={disabled} onClick={()=>{form.setFieldValue(["brand",id],"");form.setFieldValue(["brand",flag],false);onDirty()}}>恢复默认</Button>}</>;
  }} renderLogo={(dark,collapsed)=>{
   const kind=collapsed?(dark?"iconDark":"navIcon"):(dark?"wordmarkDark":"wordmark");
   const id=brand?.[`${kind}Id`],custom=id&&!brand?.[`${kind}Generated`];
   const src=custom?previews[id]:undefined;
   const identity={name,iconText,showAiIcon:brand?.showAiIcon===true,icon:!dark&&src?{url:src}:undefined,iconDark:dark&&src?{url:src}:undefined,wordmark:!dark&&src?{url:src}:undefined,wordmarkDark:dark&&src?{url:src}:undefined};
   return collapsed?<BrandIcon brand={identity} dark={dark}/>:<BrandLogo brand={identity} dark={dark} maxHeight={40}/>;
  }}/>


 </>;
}
