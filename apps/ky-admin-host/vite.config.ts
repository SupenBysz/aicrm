import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ky/admin-core": new URL("../../packages/ky-admin-core/src/index.ts", import.meta.url).pathname,
      "@ky/plugin-access-management": new URL("../../plugins/ky-access-management/src/index.tsx", import.meta.url).pathname,
      "@ky/plugin-ai-configuration": new URL("../../plugins/ky-ai-configuration/src/index.tsx", import.meta.url).pathname,
      "@ky/plugin-audit-management": new URL("../../plugins/ky-audit-management/src/index.tsx", import.meta.url).pathname,
      "@ky/plugin-identity-management": new URL("../../plugins/ky-identity-management/src/index.tsx", import.meta.url).pathname,
      "@ky/plugin-matrix-account": new URL("../../plugins/ky-matrix-account/src/index.tsx", import.meta.url).pathname,
      "@ky/plugin-notification": new URL("../../plugins/ky-notification/src/index.tsx", import.meta.url).pathname,
      "@ky/plugin-organization-management": new URL("../../plugins/ky-organization-management/src/index.tsx", import.meta.url).pathname,
      "@ky/plugin-system-settings": new URL("../../plugins/ky-system-settings/src/index.tsx", import.meta.url).pathname
    }
  },
  server: {
    host: "0.0.0.0",
    port: 5173
  }
});
