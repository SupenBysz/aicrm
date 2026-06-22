import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";

export const notificationPlugin: AdminPlugin = {
  name: "ky-notification",
  navGroup: "通知中心",
  navOrder: 40,
  menus: [
    {
      key: "ky-notification.notifications",
      label: "通知",
      path: "/notifications",
      icon: "BellOutlined",
      menuKey: "notification.notifications.view",
      requiredAnyPermissions: [
        "platform.notifications.view",
        "agency.notifications.view",
        "enterprise.notifications.view"
      ]
    },
    {
      key: "ky-notification.announcements",
      label: "公告管理",
      path: "/announcements",
      icon: "NotificationOutlined",
      menuKey: "notification.announcements.view",
      requiredAnyPermissions: [
        "platform.announcements.view",
        "agency.announcements.view",
        "enterprise.announcements.view"
      ]
    }
  ],
  routes
};

export default notificationPlugin;
