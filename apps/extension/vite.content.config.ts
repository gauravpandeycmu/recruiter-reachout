import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Content scripts must be a single classic script — Chrome cannot load split ES chunks. */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/content.ts"),
      name: "RecruiterReachoutContent",
      formats: ["iife"],
      fileName: () => "assets/content.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
