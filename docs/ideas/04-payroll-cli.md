# 4. Private payroll & batch disbursement CLI

**Status:** Selected · **Type:** Client-only (TS or Rust CLI) · **Uses:** [RingPay receipts](01-ringpay.md), [ringd](02-ringd.md) (optional)

## Problem

Paying a team, contributors, or grant recipients in stablecoins on Solana publishes every salary to the world. Helius lists payroll as a flagship use case, but no open tooling exists for running a pay cycle privately.

## Solution

```
payroll.csv  ->  ringpay-payroll plan  ->  plan.json (review)  ->  ringpay-payroll run  ->  receipts/ + audit-bundle.zip
```

### `plan`
- Input CSV: `address, mint, amount, memo?`.
- **Registry check** for every recipient. Unregistered addresses are flagged. The operator can choose: skip, pay via **public withdrawal** (explicitly opted in per row), or send them an onboarding link.
- **Batching:** pack recipients into transactions using the large-output variants (1→16 outputs means up to 15 payees + 1 change per tx; also 2→16, 4→16, 5→16, 8→16). The planner minimizes transaction count while respecting tx size (~4 KB) and the treasury's UTXO layout.
- **Pre-flight:** check treasury private balance per mint, suggest merges or splits so batches can run **concurrently** (one UTXO per batch avoids conflicts).
- Outputs a deterministic, reviewable `plan.json` (and a human-readable summary).

### `run`
- Executes batches (in parallel where UTXOs allow), with resume-on-failure (idempotent per batch, tracked by signature).
- Encrypted memo per payee (e.g. "Payroll 2026-11, invoice #12").

### Outputs
- **Per-payee receipt** (RingPay format), so each employee can prove income to a landlord or bank without exposing anyone else.
- **Audit bundle**: CSV of all payments + every transaction viewing key, for the company's accountant/auditor (selective disclosure of exactly this pay cycle).

## Helius primitives used

Large-output transaction variants, user registry, encrypted memo, concurrent UTXO spending, merge, transaction viewing keys.

## MVP

1. CSV parse + registry check + plan output.
2. Single-batch run on localnet (1→16).
3. Multi-batch concurrent run + resume.
4. Receipts + audit bundle.

## Risks / open questions

- Whether the SDK lets callers **choose the variant / output count** explicitly, or we must build the transaction lower-level.
- Sender (treasury) and recipients are public in the Default Ring: observers learn *who* is on payroll, just not *how much*. An anonymous Custom Ring hides this. Document it, and design so the ring is configurable.
- Treasury signing: support a local keypair first; Squads / multisig later (upstream `jorrit/feat-min-multisig` branch is relevant).
