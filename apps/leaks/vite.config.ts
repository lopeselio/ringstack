import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so dist/ works from /ringstack/leaks/ or any host.
  base: "./",
  build: { target: "es2022" },
});
