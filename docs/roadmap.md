# Roadmap

Selected: **1 RingPay**, **2 ringd**, **4 payroll CLI**, **7 zk-gadgets**.

Projects 1, 2, and 4 share a client foundation and ship together as a stack. Project 7 is an independent track.

## Proposed repo layout (monorepo)

```
packages/
  core/            # shared TS: zolana client setup, keys, registry, receipts, ringpay URI
  ringd-client/    # typed webhook verification + API client
apps/
  verifier/        # static receipt verifier (idea 1)
  checkout-demo/   # merchant demo (idea 1 + 2)
crates/
  ringd/           # sync daemon (idea 2)
  payroll/         # CLI (idea 4), or TS under packages/ if SDK coverage is better
zk/
  gadgets/         # gnark gadgets (idea 7)
  template/        # program + circuit + prover starter
  examples/milestone-escrow/
spec/
  ringpay-uri.md
  receipt.md
```

## Milestone 0: Foundation
- [x] Pin `zolana` **v0.6.0-alpha** (TS `@heliuslabs/zolana@0.6.0-alpha`, Node 24).
- [x] Localnet scripts: `scripts/install-zolana.sh` (checksum-verified CLI) + `scripts/localnet.sh`.
- [x] Run localnet + `pnpm --filter @ringstack/core smoke` end to end (deposit → confidential transfer → decrypt passes on v0.6.0-alpha localnet).
- [x] Shared `core`: network config, keypair loaders, send helper, receipt codec.
- [x] `core`: register + enable merge, deposit/transfer/withdraw/merge helpers (`RingSession`, `session:e2e`).
- [x] Check: transaction viewing key receipts work end to end on localnet (`receipt:e2e`, [findings](spikes/m0-sdk-findings.md)).
- [x] Check: encrypted transfer memos via `signTransferWithMemos` (`memo:e2e`, [findings](spikes/m0-sdk-findings.md)).
- [x] Check: payroll batching via `createMultiTransfer`, max 15 payees/tx ([findings](spikes/m0-sdk-findings.md)).
- [x] CI: typecheck + unit tests; localnet integration tests (`localnet` job runs `core` e2e against `zolana dev start`).

## Milestone 1: Receipts + ringd MVP
- [x] Receipt format spec + encode/decode/issue/open in `core`.
- [x] Static verifier app (`apps/verifier`): registry lookup verifies outputs automatically; `?to=` marks the payee.
- [x] ringd: watch → decrypt → SQLite → print/log events (`apps/ringd`, TypeScript; read-only key file, `ringd e2e`).
- [ ] ringd: HMAC webhooks with retry + idempotency.

## Milestone 2: RingPay + payroll
- [ ] `ringpay:` URI spec + parser; memo schema with `order`.
- [ ] Checkout demo: request → payment → ringd webhook → order marked paid.
- [ ] Payroll `plan` (CSV, registry check, batching) and `run` (concurrent, resumable).
- [ ] Payroll receipts + audit bundle.
- [ ] ringd auto-merge.

## Milestone 3: Devnet release
- [ ] Run everything against devnet; document known privacy limits (public sender/recipient in confidential rings; public deposit/withdraw edges).
- [ ] Docs site / READMEs, demo video.

## Track Z: zk-gadgets (parallel, longer)
- [ ] Z0: Build and run upstream `escrow-program` locally (Go ≥1.27.1, `cargo build-sbf`).
- [ ] Z1: Extract `utxo` + `conservation` gadgets; upstream escrow tests still pass.
- [ ] Z2: `range`, `timelock`, `threshold` gadgets with negative tests + constraint counts.
- [ ] Z3: Template (program + circuit + setup + prover + SDK) running on localnet.
- [ ] Z4: Milestone escrow reference program.
- [ ] Z5: Property/fuzz testing; request external review.

## Cross-cutting risks
- Alpha API churn: track `helius-labs/zolana` releases; isolate SDK calls behind `core`.
- Devnet-only: no mainnet claims anywhere.
- Prover is a remote TEE by default; note the trust assumption and adopt local proving when it lands upstream.
