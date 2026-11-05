import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [
    starlight({
      title: "ringstack",
      description: "Open-source tooling for private payments on Solana, built on Helius Privacy.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/lopeselio/helius-privacy" }],
      customCss: ["./src/styles/theme.css"],
      lastUpdated: false,
      sidebar: [
        { label: "Start here", items: ["index", "overview", "getting-started"] },
        { label: "Guides", items: ["guides/devnet", "guides/privacy"] },
        {
          label: "Tools",
          items: ["tools/ringd", "tools/payroll", "tools/verifier", "tools/checkout-demo"],
        },
        {
          label: "Reference",
          items: ["reference/ringpay-uri", "reference/receipt-format", "reference/payment-proof", "reference/ringd-client"],
        },
        {
          label: "Background",
          collapsed: true,
          items: ["background/platform-notes", "background/sdk-findings", "background/roadmap"],
        },
      ],
    }),
  ],
});
