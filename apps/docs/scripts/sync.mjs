// Copy the repo's specs, guides and READMEs into the docs site at build time,
// so each page has one source of truth. Adds frontmatter, drops the source's
// H1 (Starlight renders the title), and rewrites relative links: targets that
// are on the site become page-relative site links (so the site works under any
// base path, e.g. GitHub Pages' /ringstack/), everything else points at GitHub.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const out = resolve(here, "../src/content/docs");
const GITHUB = "https://github.com/lopeselio/ringstack/blob/main/";

/** Repo path → site slug, title, description. */
const PAGES = [
  ["docs/devnet.md", "guides/devnet", "Running on devnet", "Setup, results, and how the client reaches devnet."],
  ["docs/privacy.md", "guides/privacy", "Privacy limits", "What stays hidden, what is public, and what operators can see."],
  ["spec/ringpay-uri.md", "reference/ringpay-uri", "ringpay: payment requests", "The ringpay: URI and its order memo."],
  ["spec/receipt.md", "reference/receipt-format", "Receipts", "Sender-issued receipts that open one transaction."],
  ["spec/payment-proof.md", "reference/payment-proof", "Payment proofs", "Payee-side proofs that open one output."],
  ["packages/ringd-client/README.md", "reference/ringd-client", "ringd-client", "Webhook types and verification."],
  ["apps/ringd/README.md", "tools/ringd", "ringd", "Self-hosted watcher with signed webhooks and auto-merge."],
  ["apps/payroll/README.md", "tools/payroll", "Private payroll", "Batched private payouts, audit bundles, payee proofs."],
  ["apps/verifier/README.md", "tools/verifier", "Verifier page", "Check receipts and payment proofs in the browser."],
  ["packages/paywall/README.md", "tools/paywall", "Agent payments (HTTP 402)", "Pay-per-call APIs with private payments."],
  ["apps/agent-mcp/README.md", "tools/agent-mcp", "Agent wallet (MCP)", "A private wallet for AI agents, with spend limits."],
  ["apps/paywall-demo/README.md", "tools/paywall-demo", "Paid API demo", "A pay-per-call forecast API behind the paywall."],
  ["packages/leakscan/README.md", "tools/leakscan", "Leak analyzer", "Score how linkable public pool activity is."],
  ["apps/leaks/README.md", "tools/leak-report", "Pool leak report", "The daily aggregate report, and how it's built."],
  ["packages/derivation-guard/README.md", "tools/derivation-guard", "Derivation guard", "Refuse phishing requests for the key-derivation signature."],
  ["apps/derivation-guard-extension/README.md", "tools/derivation-guard-extension", "Derivation guard extension", "A browser extension that asks before a site gets that signature."],
  ["zk/gadgets/README.md", "tools/zk-gadgets", "zk-gadgets", "Building blocks and a test harness for SPP ZK programs."],
  ["zk/template/README.md", "tools/zk-template", "ZK program template", "A ZK program, its circuits, keys and client, ready to copy."],
  ["zk/milestone-escrow/README.md", "tools/milestone-escrow", "Milestone escrow", "Private tranches released by M of N approvers, refund after a deadline."],
  ["apps/checkout-demo/README.md", "tools/checkout-demo", "Checkout demo", "Next.js shop, NestJS API and ringd, end to end."],
  ["docs/platform-notes.md", "background/platform-notes", "Platform notes", "What Helius Privacy provides and its constraints."],
  ["docs/spikes/m0-sdk-findings.md", "background/sdk-findings", "SDK findings", "What we learned building on the zolana SDK."],
  ["docs/spikes/z0-zk-dsl.md", "background/zk-dsl", "ZK program DSL", "Upstream's Rust ZK DSL, and what Z0 built and ran on it."],
  ["docs/roadmap.md", "background/roadmap", "Roadmap", "Milestones and what is done."],
];
const SLUG = new Map(PAGES.map(([src, slug]) => [src, slug]));

/** Link from the page at `fromSlug` to the page at `toSlug`, relative to the page's URL. */
function pageLink(fromSlug, toSlug) {
  const rel = posix.relative(`/${fromSlug}/`, `/${toSlug}/`);
  return rel === "" ? "./" : `${rel}/`;
}

function rewriteLinks(markdown, srcPath, fromSlug) {
  return markdown.replace(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g, (whole, target) => {
    const [path, anchor = ""] = target.split("#");
    if (path === "") return whole;
    const repoPath = normalize(posix.join(posix.dirname(srcPath), path)).replace(/\\/g, "/").replace(/\/$/, "");
    const hash = anchor ? `#${anchor}` : "";
    const direct = SLUG.get(repoPath) ?? SLUG.get(`${repoPath}/README.md`);
    if (direct) return `](${pageLink(fromSlug, direct)}${hash})`;
    return `](${GITHUB}${repoPath}${hash})`;
  });
}

function stripH1(markdown) {
  return markdown.replace(/^\s*# [^\n]*\n+/, "");
}

const yaml = (s) => JSON.stringify(s);

for (const [src, slug, title, description] of PAGES) {
  const body = rewriteLinks(stripH1(readFileSync(join(repo, src), "utf8")), src, slug);
  const target = join(out, `${slug}.md`);
  rmSync(target, { force: true });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `---\ntitle: ${yaml(title)}\ndescription: ${yaml(description)}\neditUrl: ${yaml(GITHUB.replace("/blob/", "/edit/") + src)}\n---\n\n` +
      `<!-- Generated from ${src} by scripts/sync.mjs. Edit the source, not this file. -->\n\n${body}`,
  );
}
console.log(`synced ${PAGES.length} pages into ${relative(process.cwd(), out)}`);
