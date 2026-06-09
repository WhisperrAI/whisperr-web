import { defineConfig } from "tsup";

export default defineConfig([
  // The library: ESM + CJS, typed, tree-shakeable.
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    minify: true,
    sourcemap: false,
    target: "es2020",
    platform: "browser",
  },
  // The script-tag build: a single self-executing file for <script src> use.
  // Exposes window.Whisperr; pairs with the <1KB inline stub loader.
  {
    entry: { whisperr: "src/loader.ts" },
    format: ["iife"],
    globalName: "WhisperrLoader",
    minify: true,
    sourcemap: false,
    target: "es2017",
    platform: "browser",
    outDir: "dist",
  },
]);
