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
- [ ] Pin `zolana` **v0.6.0-alpha** (TS `@heliuslabs/zolana`, Rust crates). Confirm program IDs on devnet.
- [ ] Localnet script: `zolana dev start` + funded test wallets + SPL mint + interface PDA.
- [ ] Shared `core`: client factory (localnet/devnet), shielded keypair from file, register + enable merge, deposit/transfer/withdraw helpers.
- [ ] Spike: locate the **transaction viewing key** API and verify single-tx decryption works (unblocks receipts).
- [ ] Spike: can the SDK force a specific transfer **variant** (1→16)? (unblocks payroll batching).
- [ ] CI: lint, typecheck, localnet integration tests.

## Milestone 1: Receipts + ringd MVP
- [ ] Receipt format spec + encode/decode/verify in `core`.
- [ ] Static verifier app.
- [ ] ringd: watch → decrypt → SQLite → print/log events.
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
