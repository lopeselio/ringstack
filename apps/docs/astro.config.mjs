import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// Served by GitHub Pages at https://lopeselio.github.io/ringstack/.
const site = "https://lopeselio.github.io";
const base = "/ringstack";

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: "ringstack",
      description: "Open-source tooling for private payments on Solana, built on Helius Privacy.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/lopeselio/ringstack" }],
      customCss: ["./src/styles/theme.css"],
      lastUpdated: false,
      sidebar: [
        { label: "Start here", items: ["index", "overview", "getting-started"] },
        { label: "Guides", items: ["guides/devnet", "guides/privacy"] },
        {
          label: "Tools",
          items: [
            "tools/ringd",
            "tools/payroll",
            "tools/paywall",
            "tools/agent-mcp",
            "tools/verifier",
            "tools/checkout-demo",
            "tools/paywall-demo",
            "tools/leakscan",
            "tools/leak-report",
            "tools/derivation-guard",
            "tools/derivation-guard-extension",
          ],
        },
        {
          label: "Reference",
          items: ["reference/ringpay-uri", "reference/receipt-format", "reference/payment-proof", "reference/ringd-client"],
        },
        {
          label: "Background",
          collapsed: true,
          items: ["background/platform-notes", "background/sdk-findings", "background/zk-dsl", "background/roadmap"],
        },
      ],
    }),
  ],
});
