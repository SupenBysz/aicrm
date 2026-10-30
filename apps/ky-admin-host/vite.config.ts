import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";


const configDir = fileURLToPath(new URL(".", import.meta.url));
const pluginNames=["ky-component-center","ky-script-management","ky-matrix-account","ky-identity-management","ky-organization-management","ky-access-management","ky-audit-management","ky-notification","ky-system-settings","ky-ai-configuration"];
const versions=Object.fromEntries(pluginNames.map(name=>[name,JSON.parse(readFileSync(resolve(configDir,"../../plugins",name,"package.json"),"utf8")).version]));
const buildId=createHash("sha256").update(JSON.stringify(versions)+new Date().toISOString()+Math.random()).digest("hex").slice(0,16);

export default defineConfig({
  build: { rolldownOptions: { input: { main: resolve(configDir, "index.html"), componentPreview: resolve(configDir, "component-preview.html") } } },
  define: { __KWW_ADMIN_PLUGIN_BUILD__: JSON.stringify({buildId, versions}) },
  plugins: [react(), {
    name: "component-preview-dev-policy",
    configureServer(server) {
      server.middlewares.use((req,res,next) => {
        if(req.url?.split("?")[0] === "/component-preview.html") {
          res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ws://127.0.0.1:5173 ws://localhost:5173; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'self'");
          res.setHeader("Cache-Control", "no-cache");
        }
        next();
      });
    }
  }],
  resolve: {
    dedupe: ["react", "react-dom", "antd", "@ant-design/icons"],
    alias: {
      "@ky/plugin-component-center": new URL("../../plugins/ky-component-center/src/index.tsx", import.meta.url).pathname,
      "@ky/plugin-script-management": new URL("../../plugins/ky-script-management/src/index.tsx", import.meta.url).pathname,
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
