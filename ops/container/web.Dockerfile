# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
ENV CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ky/admin-core build && pnpm --filter @ky/admin-host... typecheck && pnpm --filter @ky/admin-host build
FROM nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
COPY --from=build /src/apps/ky-admin-host/dist /usr/share/nginx/html
COPY ops/container/nginx.conf /etc/nginx/conf.d/default.conf
USER 101:101
