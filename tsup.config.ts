import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/estimate.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2020",
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" };
  },
});
