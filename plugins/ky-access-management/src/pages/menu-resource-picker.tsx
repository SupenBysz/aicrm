import { Alert, Button, Select, Space, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useCurrentWorkspace, useRequestClient } from "@ky/admin-core";
import type { MenuWebViewConfig } from "../api";
type Ref = MenuWebViewConfig["scripts"][number];
type Option = {
    identifier: string;
    name: string;
    assetType: "script" | "style";
    versionId: string;
    version: string;
};
export function MenuResourcePicker({ value = [], onChange, platform, assetType }: {
    value?: Ref[];
    onChange?: (value: Ref[]) => void;
    platform: string;
    assetType: "script" | "style";
}) {
    const client = useRequestClient();
    const workspace = useCurrentWorkspace();
    const query = useQuery({ queryKey: ["menu-resource-options", workspace?.type, workspace?.id, platform], enabled: !!workspace && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(platform ?? ""), queryFn: () => client.request<Option[]>(`/api/v1/matrix-account-douyin-scripts/menu-resource-options?platform=${encodeURIComponent(platform)}`) });
    const options = (query.data ?? []).filter(option => option.assetType === assetType);
    const identifiers = [...new Map(options.map(option => [option.identifier, option])).values()];
    const change = (index: number, next: Ref) => onChange?.(value.map((item, i) => i === index ? next : item));
    return <Space orientation="vertical" style={{ width: "100%" }}>
  {query.isError ? <Alert type="warning" showIcon title="资源列表暂不可用，已有绑定保留" action={<Button size="small" onClick={() => void query.refetch()}>重试</Button>}/> : null}
  {value.map((item, index) => <Space key={`${item.identifier}:${index}`} wrap>
   <Typography.Text>{identifiers.find(option => option.identifier === item.identifier)?.name ?? "已绑定资源"} <Typography.Text type="secondary">{item.identifier}</Typography.Text></Typography.Text>
   <Select value={item.versionPolicy} style={{ width: 145 }} onChange={policy => change(index, policy === "latest_released" ? { identifier: item.identifier, versionPolicy: policy } : { ...item, versionPolicy: policy })} options={[{ value: "latest_released", label: "最新已发布" }, { value: "pinned", label: "固定版本" }]}/>
   {item.versionPolicy === "pinned" ? <Select placeholder="选择发布版本" value={item.versionId} style={{ width: 160 }} onChange={id => { const version = options.find(option => option.versionId === id); if (version)
            change(index, { identifier: item.identifier, versionPolicy: "pinned", versionId: version.versionId, version: version.version }); }} options={options.filter(option => option.identifier === item.identifier).map(option => ({ value: option.versionId, label: option.version }))}/> : null}
   <Button danger type="link" onClick={() => onChange?.(value.filter((_, i) => i !== index))}>移除</Button>
  </Space>)}
  <Select allowClear value={undefined} showSearch optionFilterProp="label" loading={query.isFetching} placeholder="添加已发布资源" style={{ width: "100%" }} onChange={identifier => { if (identifier)
        onChange?.([...value, { identifier, versionPolicy: "latest_released" }]); }} options={identifiers.filter(option => !value.some(item => item.identifier === option.identifier)).map(option => ({ value: option.identifier, label: `${option.name} · ${option.identifier}` }))}/>
 </Space>;
}
