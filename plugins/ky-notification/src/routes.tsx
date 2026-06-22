import type { PluginRoute } from "@ky/admin-core";
import { NotificationsPage } from "./pages/notifications-page";
import { AnnouncementsPage } from "./pages/announcements-page";

export const routes: PluginRoute[] = [
  {
    path: "/notifications",
    requiredAnyPermissions: [
      "platform.notifications.view",
      "agency.notifications.view",
      "enterprise.notifications.view"
    ],
    element: <NotificationsPage />
  },
  {
    path: "/announcements",
    requiredAnyPermissions: [
      "platform.announcements.view",
      "agency.announcements.view",
      "enterprise.announcements.view"
    ],
    element: <AnnouncementsPage />
  }
];
