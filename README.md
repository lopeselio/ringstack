# ringstack

Open-source tooling built on [Helius Privacy](https://www.helius.dev/privacy) (Solana Rings, powered by [zolana](https://github.com/helius-labs/zolana)).

**Docs: https://lopeselio.github.io/ringstack/**

> Helius Privacy is **beta and devnet-only**. Programs are under audit. Nothing here is production-ready.

## Projects

| # | Project | What it is | Status |
|---|---------|-----------|--------|
| 1 | [RingPay](docs/ideas/01-ringpay.md) | Private payment requests, receipts and payee proofs ([verifier](https://lopeselio.github.io/ringstack/verify/)) | Built, devnet |
| 2 | [ringd](apps/ringd) | Self-hosted payment watcher with signed webhooks and auto-merge | Built, devnet |
| 4 | [Private payroll](apps/payroll) | CSV → batched private payouts, audit bundle, payee proofs | Built, devnet |
| 3 | [Agent payments](packages/paywall) | HTTP 402 paywall + [MCP agent wallet](apps/agent-mcp) with spend limits ([live demo API](https://ringstack-paywall-demo.azurewebsites.net)) | Built, devnet |
| 5 | [Leak analyzer](packages/leakscan) | Linkability scoring, withdrawal advisor, [daily public report](https://lopeselio.github.io/ringstack/leaks/) | Built, devnet |
| 6 | [Derivation guard](packages/derivation-guard) | Refuses phishing requests for the key-derivation signature: detector for wallets, test vectors, [browser extension](apps/derivation-guard-extension) | Built |
| 7 | [zk-gadgets](docs/ideas/07-zk-gadgets.md) | Building blocks + template for SPP ZK programs on upstream's Rust DSL | In progress ([Z0](docs/spikes/z0-zk-dsl.md), [Z1–Z2: harness and gadgets](zk/gadgets) done) |

Build order and milestones: [docs/roadmap.md](docs/roadmap.md).

## Backlog

| # | Idea |
|---|------|
| 8 | [Sealed-bid auctions & milestone escrow](docs/ideas/08-sealed-bid-milestone-escrow.md) |
| 9 | [Hidden-balance game economies](docs/ideas/09-game-economies.md) |
| 10 | [Custom Ring templates & auditor console](docs/ideas/10-custom-ring-console.md) |

## Getting started

```bash
nvm use                      # Node 24
pnpm install
pnpm typecheck && pnpm test  # unit tests, no network needed
```

Integration tests run on **devnet** (zolana 0.8). Put your Helius `API_KEY` in the root `.env`, fund a devnet keypair for test wallets, then:

```bash
export ZOLANA_NETWORK=devnet ZOLANA_FUNDER_KEYPAIR=.devnet/funder.json
pnpm --filter @ringstack/core e2e      # smoke, receipts, memos, wallet session, RingPay
pnpm --filter @ringstack/ringd e2e     # events, signed webhooks, auto-merge
pnpm --filter @ringstack/payroll e2e   # batches, resume, audit bundle, per-payee proof
pnpm --filter @ringstack/paywall-demo e2e   # HTTP 402 private payments with spend limits
pnpm --filter @ringstack/agent-mcp smoke    # the MCP agent wallet over stdio
```

See [docs/devnet.md](docs/devnet.md) for setup, results and the trust model, and [docs/privacy.md](docs/privacy.md) for **privacy limits**. There is no local stack for zolana 0.8 yet: Helius publishes no 0.8 binaries, and the `scripts/` local network installs v0.6.0-alpha, which the 0.8 SDK refuses (details in the same doc).

## Documentation site

Published at **https://lopeselio.github.io/ringstack/** on every push to `main` that touches the docs (`.github/workflows/docs.yml`). [apps/docs](apps/docs) builds it from the docs below and the app READMEs. To work on it locally:

```bash
pnpm --filter @ringstack/docs dev      # http://localhost:4321/ringstack/
```

## Background

- [Devnet: setup and results](docs/devnet.md)
- [Privacy limits](docs/privacy.md)
- [Platform notes](docs/platform-notes.md) — what Helius Privacy provides, its primitives, constraints, and version pinning.
- [Milestone 0 SDK findings](docs/spikes/m0-sdk-findings.md) — receipts, batching, memos, versions.
- [Receipt spec](spec/receipt.md)
- [RingPay payment request URI spec](spec/ringpay-uri.md)
- [Payment proof spec](spec/payment-proof.md): a payee proves one output without revealing the rest
- [Checkout demo](apps/checkout-demo/README.md): Next.js shop + NestJS API + ringd, end to end on localnet
- [Private payroll CLI](apps/payroll/README.md)

## License

[Apache License 2.0](LICENSE), matching [zolana](https://github.com/helius-labs/zolana).
