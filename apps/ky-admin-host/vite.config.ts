import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";


const configDir = fileURLToPath(new URL(".", import.meta.url));
const pluginNames=["ky-matrix-account","ky-identity-management","ky-organization-management","ky-access-management","ky-audit-management","ky-notification","ky-system-settings","ky-ai-configuration"];
const versions=Object.fromEntries(pluginNames.map(name=>[name,JSON.parse(readFileSync(resolve(configDir,"../../plugins",name,"package.json"),"utf8")).version]));
const buildId=createHash("sha256").update(JSON.stringify(versions)+new Date().toISOString()+Math.random()).digest("hex").slice(0,16);

export default defineConfig({
  define: { __KWW_ADMIN_PLUGIN_BUILD__: JSON.stringify({buildId, versions}) },
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
