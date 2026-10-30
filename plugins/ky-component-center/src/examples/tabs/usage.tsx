import { Tabs } from "antd";
export default function Example({ label = "标签页", disabled = false }: { label?: string; disabled?: boolean } = {}) {
return <Tabs items={[{key:"basic",label:"基本信息",children:label},{key:"advanced",label:"高级选项",disabled,children:"只在示例内切换"}]} />;
}
