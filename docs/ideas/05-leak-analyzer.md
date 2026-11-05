# 5. Privacy leak analyzer

**Status:** Built (devnet): [`@ringstack/leakscan`](../../packages/leakscan), [daily report](https://lopeselio.github.io/ringstack/leaks/) · **Type:** Client-only / research tool (no keys required)

> **As built:** SOL deposits and withdrawals only, read from vault balance changes. Three signals (unique amount, round trip, reused recipient). The report publishes aggregates only, per the ethics note below; the event cache with addresses stays in the private CI cache.

## Problem
Deposits and withdrawals are public (address, asset, amount). Users who deposit 1,234.56 USDC and withdraw 1,234.56 USDC an hour later are trivially linkable. In confidential rings, sender/recipient graphs are public too.

## Solution
- Scan public SPP deposit/withdraw events and score linkability (amount matching, timing windows, address reuse, round-trip patterns).
- Estimate the effective **anonymity set** per ring and per asset over time.
- Wallet-side "hygiene advisor" library: before a withdrawal, warn about matching amounts and recent deposits; suggest splitting, delaying, or using an on-ramp to fund the private balance directly.
- Public dashboard + open dataset.

## Primitives
Public onchain SPP instructions only, plus optional local history for the advisor.

## Open questions
- Ethics and positioning: frame it as defensive (helping users), publish aggregate stats only.
