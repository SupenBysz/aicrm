# KyaiCRM

KyaiCRM Phase 1 is a multi-tenant, user-centered administration foundation.

The first phase focuses on the reusable backend-management base layer rather than CRM business features. It supports platform, agency, and enterprise workspaces, department and team scopes, multi-identity workspace switching, permissions, audit, notifications, system settings, and AI provider/model configuration.

## Phase 1 Scope

Included:

- Global user identity.
- Platform / agency / enterprise backend workspaces.
- Department and team organization scopes.
- Memberships, invitations, roles, permissions, and data scopes.
- Audit logs and notifications.
- System settings and dictionaries.
- AI provider and model configuration only.
- Native VM deployment with Nginx and systemd.

Excluded from Phase 1:

- CRM business modules.
- AI employees, AI executors, AI workflows, and AI collaboration.
- IM and mobile applications.
- Kubernetes-first or Docker-first deployment.

## Repository Layout

```text
apps/       Frontend host applications.
packages/   Shared frontend packages and contracts.
plugins/    Admin plugins that contribute pages, routes, and menus.
services/   Go backend services split by domain.
ops/        Database, native deployment, and seed assets.
scripts/    Build, deploy, seed, and verification scripts.
docs/       Locked Phase 1 requirements and architecture documents.
```

## Naming

- Directories and services: `ky-*`
- NPM packages: `@ky/*` and `@ky/plugin-*`
- Database tables: `ky_` prefix
- Environment variables: `KY_` prefix
- Workspace headers: `X-KY-Workspace-Id`, `X-KY-Workspace-Type`, `X-KY-Request-Id`
- Frontend session key: `ky.admin.session.v1`

## Locked Documents

The Phase 1 baseline is defined by the documents under `docs/`.
