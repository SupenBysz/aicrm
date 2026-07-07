import { useMemo, useState, type ReactNode } from "react";
import { Empty, Tabs } from "antd";
import {
  ApiOutlined,
  BellOutlined,
  BookOutlined,
  IdcardOutlined,
  MailOutlined,
  NotificationOutlined,
  PartitionOutlined,
  SlidersOutlined
} from "@ant-design/icons";
import { usePermissions } from "@ky/admin-core";
import { BasicInfoPage } from "./basic-info-page";
import { SettingsPage } from "./settings-page";
import { DictionariesPage } from "./dictionaries-page";
import { NotificationTemplatesPage } from "./notification-templates-page";
import { StoragePage } from "./storage-page";
import { SmsPage } from "./sms-page";
import { EmailPage } from "./email-page";
import { AppVersionPage } from "./app-version-page";

interface Section {
  key: string;
  label: string;
  icon: ReactNode;
  element: ReactNode;
  // visible if the user has the single perm, or any of the anyPerms
  perm?: string;
  anyPerms?: string[];
}

const SECTIONS: Section[] = [
  { key: "basic-info", label: "基础信息", icon: <IdcardOutlined />, perm: "platform.basic_info.view", element: <BasicInfoPage /> },
  { key: "settings", label: "参数配置", icon: <SlidersOutlined />, anyPerms: ["platform.settings.view", "agency.settings.view", "enterprise.settings.view"], element: <SettingsPage /> },
  { key: "dictionaries", label: "数据字典", icon: <BookOutlined />, perm: "platform.dictionaries.view", element: <DictionariesPage /> },
  { key: "notification-templates", label: "通知模板", icon: <NotificationOutlined />, perm: "platform.notification_templates.view", element: <NotificationTemplatesPage /> },
  { key: "storage", label: "对象存储", icon: <PartitionOutlined />, perm: "platform.storage.view", element: <StoragePage /> },
  { key: "sms", label: "短信服务", icon: <BellOutlined />, perm: "platform.sms.view", element: <SmsPage /> },
  { key: "email", label: "邮件服务", icon: <MailOutlined />, perm: "platform.email.view", element: <EmailPage /> },
  { key: "app-version", label: "App 版本", icon: <ApiOutlined />, perm: "platform.app_version.view", element: <AppVersionPage /> }
];

export function SettingsHubPage() {
  const permissions = usePermissions();
  const sections = useMemo(
    () => SECTIONS.filter((s) => (s.anyPerms ? permissions.canAny(s.anyPerms) : s.perm ? permissions.can(s.perm) : true)),
    [permissions]
  );
  const [active, setActive] = useState(sections[0]?.key ?? "");

  if (sections.length === 0) {
    return <Empty style={{ marginTop: 80 }} description="暂无可访问的系统配置项" />;
  }

  const activeKey = sections.some((s) => s.key === active) ? active : sections[0].key;

  return (
    <Tabs
      activeKey={activeKey}
      onChange={setActive}
      items={sections.map((s) => ({
        key: s.key,
        label: (
          <span>
            {s.icon} {s.label}
          </span>
        ),
        // Only the active tab mounts — avoids 8 pages firing queries at once.
        children: s.key === activeKey ? s.element : null
      }))}
    />
  );
}
