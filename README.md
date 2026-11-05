# ringstack

Open-source tooling built on [Helius Privacy](https://www.helius.dev/privacy) (Solana Rings, powered by [zolana](https://github.com/helius-labs/zolana)).

> Helius Privacy is **beta and devnet-only**. Programs are under audit. Nothing here is production-ready.

## Selected builds

| # | Project | What it is | Difficulty |
|---|---------|-----------|------------|
| 1 | [RingPay](docs/ideas/01-ringpay.md) | Private payment requests + verifiable receipts | Client-only |
| 2 | [ringd](docs/ideas/02-ringd.md) | Self-hosted sync daemon with private webhooks | Client-only |
| 4 | [Private payroll CLI](docs/ideas/04-payroll-cli.md) | CSV → batched private transfers + audit bundle | Client-only |
| 7 | [zk-gadgets](docs/ideas/07-zk-gadgets.md) | Circuit gadget library + template for SPP ZK programs | ZK program (hard) |

Build order and milestones: [docs/roadmap.md](docs/roadmap.md).

## Backlog

| # | Idea |
|---|------|
| 3 | [Private agent payments (x402-style)](docs/ideas/03-agent-payments.md) |
| 5 | [Privacy leak analyzer](docs/ideas/05-leak-analyzer.md) |
| 6 | [Derivation-signature phishing guard](docs/ideas/06-derivation-guard.md) |
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
```

See [docs/devnet.md](docs/devnet.md) for setup, results and the trust model, and [docs/privacy.md](docs/privacy.md) for **privacy limits**. There is no local stack for zolana 0.8 yet: Helius publishes no 0.8 binaries, and the `scripts/` local network installs v0.6.0-alpha, which the 0.8 SDK refuses (details in the same doc).

## Documentation site

```bash
pnpm --filter @ringstack/docs dev      # http://localhost:4321
```

[apps/docs](apps/docs) builds a searchable site from the docs below and the app READMEs.

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
