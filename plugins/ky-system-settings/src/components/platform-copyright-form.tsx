import { Form, Input, Select, Typography } from "antd";
import { copyrightStyleOptions, formatCopyright } from "@ky/admin-core";
import type { PlatformProfile } from "../api";

export function PlatformCopyrightForm({ form }: {
  form: ReturnType<typeof Form.useForm<PlatformProfile>>[0];
}) {
  const brand = Form.useWatch("brand", form);
  const company = Form.useWatch("companyName", form);
  const style = Form.useWatch("copyrightStyle", form);
  return <>
    <Typography.Title level={5}>版权信息</Typography.Title>
    <Form.Item name={["brand", "copyrightHolder"]} label="版权署名（可选）"
      extra="留空使用公司 / 平台主体名称。" rules={[{ max: 120 }]}>
      <Input placeholder="填写主体名称，不含©或年份" />
    </Form.Item>
    <Form.Item name="copyrightStyle" label="版权显示风格">
      <Select options={copyrightStyleOptions} />
    </Form.Item>
    <Typography.Paragraph type="secondary">
      预览：{formatCopyright(brand?.copyrightHolder || company || brand?.name || "KyCRM", style || "standard")}
    </Typography.Paragraph>
  </>;
}
