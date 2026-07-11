import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    build: {
      rollupOptions: {
        external: ["electron"],
        output: {
          format: "cjs",
          entryFileNames: "[name].js"
        }
      }
    }
  }
});
