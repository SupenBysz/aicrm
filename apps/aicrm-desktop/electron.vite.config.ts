import { readFileSync } from "node:fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __KWW_PLUGIN_DEV_POLICY__: process.env.KWW_DESKTOP_PLUGIN_BUILD === "dev" ? readFileSync(new URL("./resources/desktop-plugin-dev-policy.json", import.meta.url), "utf8") : "null" }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts", "desktop-plugin": "src/preload/desktop-plugin.ts", "desktop-offline": "src/preload/desktop-offline.ts", "version-info-dialog": "src/preload/version-info-dialog.ts" },
        external: ["electron"],
        output: {
          format: "cjs",
          entryFileNames: "[name].js"
        }
      }
    }
  }
});
