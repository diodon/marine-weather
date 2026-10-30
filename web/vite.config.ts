import { defineConfig } from "vite";

// Relative base so the build works under any GitHub Pages project path
// (https://<user>.github.io/<repo>/).
export default defineConfig({
  base: "./",
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
});
