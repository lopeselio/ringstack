# helius-privacy

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

## Background

- [Platform notes](docs/platform-notes.md) — what Helius Privacy provides, its primitives, constraints, and version pinning.

## License

TBD (intended: Apache-2.0, matching zolana).
