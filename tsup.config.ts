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
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2020",
  external: ["react", "caffeine-js"],
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" };
  },
});
