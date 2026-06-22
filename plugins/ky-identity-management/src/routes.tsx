import type { PluginRoute } from "@ky/admin-core";
import { MembersPage } from "./pages/members-page";
import { InvitationsPage } from "./pages/invitations-page";

export const routes: PluginRoute[] = [
  {
    path: "/members",
    requiredAnyPermissions: ["platform.members.view", "agency.members.view", "enterprise.members.view"],
    element: <MembersPage />
  },
  {
    path: "/invitations",
    requiredAnyPermissions: ["platform.invitations.view", "agency.invitations.view", "enterprise.invitations.view"],
    element: <InvitationsPage />
  }
];
