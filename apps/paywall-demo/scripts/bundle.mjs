// Bundle the server into dist/server.mjs: one file, no node_modules and no
// TypeScript at runtime. Hosts like Azure App Service's free tier cap CPU, and
// unpacking thousands of node_modules files or transpiling on boot exhausts it.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  // CommonJS dependencies inside an ESM bundle still call require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
