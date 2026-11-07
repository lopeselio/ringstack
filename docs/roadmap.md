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
  gadgets/         # Rust gadgets on spr-program (idea 7)
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
- [x] ringd: HMAC webhooks with retry + idempotency (`ringd-id`, `@ringstack/ringd-client` `verifyWebhook`).

## Milestone 2: RingPay + payroll
- [x] `ringpay:` URI spec + parser; memo schema with `order` ([spec](../spec/ringpay-uri.md); `payRequest` pays a request and returns a receipt; `ringpay:e2e`).
- [x] Checkout demo: request → payment → ringd webhook → order marked paid ([apps/checkout-demo](../apps/checkout-demo): Next.js shop + NestJS/Fastify API; run through in the browser on localnet).
- [x] Payroll `plan` (CSV, registry check, batching) and `run` (concurrent, resumable) ([apps/payroll](../apps/payroll); `payroll e2e`).
- [x] Payroll audit bundle: per-run receipts for the accountant, verifiable with no keys (`payroll audit` / `verify-audit`).
- [x] Payroll per-payee proof: the payee proves their own output from their own wallet (`ringproof1:`, [spec](../spec/payment-proof.md); `payroll prove` / `verify-proof`, verifier page).
- [x] ringd auto-merge without the spending key (key file + separate fee payer; memo UTXOs included).

## Milestone 3: Devnet release
- [x] Run everything against devnet; document known privacy limits ([docs/devnet.md](devnet.md); upgraded to zolana 0.8, nightly devnet CI).
- [x] Docs site ([apps/docs](../apps/docs), Astro Starlight, generated from the repo docs), live at https://lopeselio.github.io/ringstack/.
- [ ] Demo video.

## Backlog builds
- [x] #3 Private agent payments: HTTP 402 paywall (`@ringstack/paywall`), MCP agent wallet with spend limits, demo API; verified on devnet.
- [x] #6 Derivation-signature guard: `@ringstack/derivation-guard` (dependency-free detector, test vectors, page guard for Wallet Standard and injected providers) and a Chromium extension.
- [x] #5 Privacy leak analyzer: `@ringstack/leakscan` (scan, aggregate stats, withdrawal advisor) and a daily public report at https://lopeselio.github.io/ringstack/leaks/.

## Track Z: zk-gadgets (parallel, longer)
Re-scoped 2026-11-06 from Go/gnark to upstream's Rust ZK DSL (`spr-program` 0.8), which already covers UTXO hashing, conservation and range checks ([Z0 findings](spikes/z0-zk-dsl.md)).

- [x] Z0: Build and run upstream `sdk-tests/timelock-escrow` on `spr-program` 0.8: circuit prove/verify, `cargo build-sbf`, verifier modules `--check`; baseline 14,880 / 5,638 constraints.
- [x] Z1: [`zk/gadgets`](../zk/gadgets) crate and harness: negative cases must fail by rule name *and* in R1CS, free-variable check, constraint counts; CI runs fmt, clippy and tests.
- [x] Z2: `threshold` (77 constraints), `allowlist` (1,220 for 16 members), `timelock` (program side) with negative tests and pinned counts. `terms` became a tested pattern, since binding a term is one `assert_equal`. The free-variable check found that `threshold` alone leaves unused approver slots free; its contract requires binding the set.
- [x] Z3: [Template](../zk/template) (program + circuits + verifier modules + keys + TS client) that builds outside upstream's workspace; devnet e2e passes against program `3bzWnoteJaH7kD6Jron7Lb1ABfQxLGSqcEzRr3Zy6cAi` (lock with a program proof, onchain timelock refusal, release).
- [x] Z4: [Milestone escrow](../zk/milestone-escrow): 2-of-3 releases per tranche, refund after a deadline; devnet e2e passes against `2XdkS7kQQcuCXQBhQv634B8PhDqFbpTPecHqMavwtMBR`, including onchain refusals for unsigned approvers, an already-expired escrow, an early refund and a late release; the payee can build releases with the escrow's shared viewing key.
- [ ] Z5: assurance.
  - [x] No free private variables in any program circuit, across witness shapes.
  - [x] Property tests against plain-Rust models for `threshold`, `allowlist` and escrow release, natively and in R1CS (rejections must leave the R1CS unsatisfied), and for `timelock`'s program-side checks at the deadline; mutation runs confirm they catch dropped checks.
  - [ ] Picus uniqueness check: circuits export in Picus's format (`zk/scripts/picus.sh`); not yet run, since Picus is not installed here.
  - [ ] External review: the brief is written ([review request](security/zk-review-request.md)); not yet sent to a reviewer.

## Cross-cutting risks
- Alpha API churn: track `helius-labs/zolana` releases; isolate SDK calls behind `core`.
- Devnet-only: no mainnet claims anywhere.
- No local stack for zolana 0.8 until Helius publishes binaries; integration tests run on devnet.
- Prover is a remote TEE by default; note the trust assumption and adopt local proving when it lands upstream.
