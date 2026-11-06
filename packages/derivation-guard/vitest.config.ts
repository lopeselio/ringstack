import { defineConfig } from "vitest/config";

export default defineConfig({
  // Inline Wallet Standard so vi.resetModules gives each test a fresh
  // getWallets() singleton, bound to that test's window.
  test: { server: { deps: { inline: [/@wallet-standard\//] } } },
});
