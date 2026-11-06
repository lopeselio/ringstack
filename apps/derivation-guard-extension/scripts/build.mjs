// Builds dist/: the manifest and one classic script. Not minified, so anyone
// can read what runs in their pages.
import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/content.ts"],
  outfile: "dist/guard.js",
  bundle: true,
  format: "iife",
  target: "chrome111",
  legalComments: "none",
  logLevel: "info",
});
await copyFile("manifest.json", "dist/manifest.json");
