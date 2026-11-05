import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so dist/ works from any static host or subpath.
  base: "./",
  build: {
    target: "es2022",
    // The zolana SDK chunk is large by nature; it is loaded lazily.
    chunkSizeWarningLimit: 6000,
  },
});
