import type { PluginRoute } from "@ky/admin-core";
import { AgenciesPage } from "./pages/agencies-page";
import { EnterprisesPage } from "./pages/enterprises-page";
import { DepartmentsPage } from "./pages/departments-page";
import { TeamsPage } from "./pages/teams-page";
import { CurrentOrgPage } from "./pages/current-org-page";
import { QualificationReviewPage } from "./pages/qualification-review-page";
import { QualificationSubmitPage } from "./pages/qualification-submit-page";

export const routes: PluginRoute[] = [
  { path: "/agencies", requiredPermission: "platform.agencies.view", element: <AgenciesPage /> },
  { path: "/enterprises", requiredPermission: "platform.enterprises.view", element: <EnterprisesPage /> },
  {
    path: "/qualifications",
    requiredPermission: "platform.qualifications.view",
    element: <QualificationReviewPage />
  },
  {
    path: "/qualification-submit",
    requiredAnyPermissions: ["agency.qualification.view", "enterprise.qualification.view"],
    element: <QualificationSubmitPage />
  },
  {
    path: "/departments",
    requiredAnyPermissions: ["agency.departments.view", "enterprise.departments.view"],
    element: <DepartmentsPage />
  },
  {
    path: "/teams",
    requiredAnyPermissions: ["agency.teams.view", "enterprise.teams.view"],
    element: <TeamsPage />
  },
  {
    path: "/current-organization",
    requiredAnyPermissions: ["agency.profile.view", "enterprise.profile.view"],
    element: <CurrentOrgPage />
  }
];
