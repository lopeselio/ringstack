# 5. Privacy leak analyzer

**Status:** Backlog · **Type:** Client-only / research tool (no keys required)

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
