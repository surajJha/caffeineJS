import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    estimate: "src/estimate.ts",
    react: "src/react/index.ts",
    inspect: "src/inspect/index.ts",
    "inspect-bin": "src/inspect/bin.ts",
    dashboard: "src/dashboard/index.ts",
    "dashboard/server": "src/dashboard/server.ts",
  },
  format: ["esm", "cjs", "iife"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  target: "es2020",
  globalName: "CaffeineJS",
  external: ["react", "@skj48817/caffeine-js"],
  outExtension({ format }) {
    if (format === "iife") return { js: ".global.js" };
    return { js: format === "esm" ? ".mjs" : ".cjs" };
  },
});
